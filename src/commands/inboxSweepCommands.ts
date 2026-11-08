/**
 * Inbox sweep (F6) and the optional Google Tasks export: commands, the two guided setups and the
 * rename tracking for the ledger.
 *
 *  - "Sweep inbox": estimate and confirm, guard and extract, review, then commit through the outbox
 *    (`sweepCommit`). Source notes are never modified.
 *  - "Send approved tasks to Google Tasks": exports only what the report already holds.
 *
 * Deviation from the plan: progress is a Notice with a Cancel button instead of ProgressReporter
 * (a new flow there needs typed phase strings for one short loop); the setup flows are built from the
 * shared GuidedSetupModal inside this file instead of three modal classes.
 */
import { actionName } from '../core/actionRegistry';
import { Notice, Setting, TFile, TAbstractFile } from 'obsidian';
import type AIOrganiserPlugin from '../main';
import { Result, ok, err } from '../core/result';
import { describeError, formatGuidance } from '../core/friendlyErrors';
import { PLUGIN_SECRET_IDS } from '../core/secretIds';
import { normalisePath, isInsideOrEqual } from '../core/protectedPaths';
import { isFeatureEnabled } from '../services/featureService';
import { pluginContext, summarizeText } from '../services/llmFacade';
import { validateScriptUrl } from '../services/appsScriptClient';
import { logger } from '../utils/logger';
import { estimateSweep, runSweep, type NoteProposals, type SweepDeps } from '../services/inboxSweep/sweepService';
import { commitReview, heldInboxCount, refreshStatuses, repairApprovals, sendApproved, sweepRunPolicy, type CommitInput } from '../services/inboxSweep/sweepCommit';
import { freezeHeldMirror, isCaptureActive, isCaptureCorrupt, isHeldMirrorLoaded, unfreezeHeldMirror } from '../services/captureInbox/heldMirror';
import { renameApprovals, renameLedger } from '../services/inboxSweep/sweepLedger';
import { renameReportedItems, reportedKeysFor } from '../services/inboxSweep/sweepItemIdentity';
import { validateReportPath } from '../services/inboxSweep/sweepReport';
import { resolveSweepContexts } from '../services/inboxSweep/sweepContexts';
import { reviewRoutingFor } from '../services/inboxSweep/reviewRouting';
import { getProjectService } from '../services/projects/projectService';
import { propertiesAreReadable } from '../services/inboxSweep/sweepGuard';
import { configuredListIds, selectTasksScript, tasksConfigKey } from '../services/inboxSweep/tasksScriptSelect';
import { ensureTasksSecret } from '../services/inboxSweep/tasksConnection';
import { renderConnectDevice } from '../ui/settings/TasksConnectDevice';
import { copyAutomaticScript, copyCombinedScript } from './googleScriptCommands';
import { approveConfiguredLists, approveLists } from '../services/inboxSweep/tasksAutoLists';
import { LIST_CONFIG_CAPABILITY } from '../services/googleScript/tasksModuleV3';
import { normaliseTasksLists, type TasksListConfig } from '../services/inboxSweep/tasksRouting';
import { classifyTasksScript, fetchTaskLists, pingTasksScript, type TaskList } from '../services/inboxSweep/tasksExportService';
import { GuidedSetupModal } from '../ui/modals/GuidedSetupModal';
import { ConfirmationModal } from '../ui/modals/ConfirmationModal';
import { InboxSweepReviewModal, type QuickTask } from '../ui/modals/InboxSweepReviewModal';
import { draftFromSettings, exclusionCount, lines, propertyLines, previewScope, renderInboxFolders, renderKeepOut, validateKeepOut } from '../ui/setup/inboxScopeSteps';
import { refreshProcessViews } from '../ui/views/processRefresh';
import { plural } from '../utils/plural';
import { runPendingFiling } from '../services/inboxSweep/sweepFiling';

// ─── Deps over the live vault ───────────────────────────────────────────────

function inboxFiles(plugin: AIOrganiserPlugin): TFile[] {
    const s = plugin.settings;
    const folders = s.sweepInboxFolders.map(normalisePath).filter(Boolean);
    const report = normalisePath(s.sweepReportPath);
    return plugin.app.vault
        .getMarkdownFiles()
        .filter((f) => f.path !== report && folders.some((folder) => isInsideOrEqual(normalisePath(f.path), folder)))
        .sort((a, b) => b.stat.mtime - a.stat.mtime);
}

export function buildSweepDeps(plugin: AIOrganiserPlugin, signal?: AbortSignal): SweepDeps {
    return {
        candidates: () => inboxFiles(plugin).map((f) => f.path),
        readText: async (path) => {
            const file = plugin.app.vault.getAbstractFileByPath(path);
            if (!(file instanceof TFile)) return null;
            try {
                return await plugin.app.vault.read(file);
            } catch {
                return null;
            }
        },
        complete: async (prompt, sig) => {
            const res = await summarizeText(pluginContext(plugin), prompt, { signal: sig ?? signal, label: 'inbox-sweep', disableThinking: true });
            return res.success && typeof res.content === 'string' ? ok(res.content) : err('sweep-run-failed');
        },
        policy: () => sweepRunPolicy(plugin),
        ledger: () => plugin.settings.sweepLedger,
        contexts: () => resolveSweepContexts(plugin.settings),
        reportedKeys: (path) => reportedKeysFor(path, plugin.settings.sweepReportedItems, plugin.settings.sweepApprovals),
        currentPath: (path) => (plugin.app.vault.getAbstractFileByPath(path) instanceof TFile ? path : null),
        // Hand-backs have their own review only while AI workspaces are on; off, the sweep reads every note exactly as it always did.
        skipHandbacks: () => isFeatureEnabled(plugin.settings, 'ai-workspaces'),
        // Reading the user chose to leave to the capture inbox; empty folders and the switch off = every note, as before.
        scope: () => ({ skipFolders: plugin.settings.sweepSkipFolders, skipSourceLinked: plugin.settings.sweepSkipSourceLinked }),
    };
}

// ─── Preconditions ──────────────────────────────────────────────────────────

/** A stable code for the first thing missing, or null when a sweep may start. Fails closed. */
export function sweepBlocker(plugin: AIOrganiserPlugin): string | null {
    const s = plugin.settings;
    if (s.sweepInboxFolders.length === 0) return 'sweep-no-folders';
    const anyExclusion = s.sweepExcludedFolders.length + s.sweepExcludedTags.length + s.sweepExcludedProperties.length + s.sweepExcludedTerms.length > 0;
    if (!anyExclusion && !s.sweepNothingToExclude) return 'sweep-keepout-required';
    if (!propertiesAreReadable(s.sweepExcludedProperties)) return 'sweep-property-invalid';
    if (!validateReportPath(s.sweepReportPath, s.protectedFolders).ok) return 'sweep-report-invalid';
    if (!plugin.llmService) return 'sweep-no-provider';
    // The capture inbox holds raw captures out of the sweep; until it has loaded it cannot say which.
    if (isCaptureActive() && isCaptureCorrupt()) return 'capture-journal-corrupt';
    if (isCaptureActive() && !isHeldMirrorLoaded()) return 'sweep-capture-loading';
    return null;
}

const guidanceNotice = (plugin: AIOrganiserPlugin, code: string, ms = 9000): void => { new Notice(formatGuidance(describeError(plugin.t, code)), ms); };

/** A send that failed or held items says where to send again: settings has no send button, the picker does. */
export function withSendAgain(t: AIOrganiserPlugin['t'], text: string): string {
    return `${text} ${t.inboxSweep.sendAgainHint}`;
}
const sendGuidanceNotice = (plugin: AIOrganiserPlugin, code: string, ms = 9000): void => { new Notice(withSendAgain(plugin.t, formatGuidance(describeError(plugin.t, code))), ms); };

let privacyNoticeShown = false;

function confirm(plugin: AIOrganiserPlugin, title: string, body: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
        let answered = false;
        const modal = new ConfirmationModal(plugin.app, title, body, () => { answered = true; resolve(true); }, plugin);
        const close = modal.onClose.bind(modal);
        modal.onClose = () => { close(); if (!answered) resolve(false); };
        modal.open();
    });
}

/** A Notice with a Cancel button; hide it when the work ends. */
function cancellableNotice(text: string, label: string, onCancel: () => void): Notice {
    const notice = new Notice('', 0);
    notice.messageEl.empty();
    notice.messageEl.createSpan({ text });
    const btn = notice.messageEl.createEl('button', { text: label });
    btn.addEventListener('click', onCancel);
    return notice;
}

// ─── Sweep ──────────────────────────────────────────────────────────────────

let sweeping = false;

export async function runInboxSweep(plugin: AIOrganiserPlugin): Promise<void> {
    const t = plugin.t.inboxSweep;
    if (sweeping) { new Notice(t.alreadyRunning, 5000); return; }
    const blocker = sweepBlocker(plugin);
    if (blocker) { guidanceNotice(plugin, blocker); return; }
    sweeping = true;
    // The set of held captures is frozen for the length of the run, so the policy cannot change under it.
    freezeHeldMirror();
    const ctl = new AbortController();
    try {
        // Finish anything an earlier run left half done before starting a new one.
        const repaired = await repairApprovals(plugin);
        if (repaired.error) { new Notice(t.reportConflictNotice.replace('{path}', repaired.path ?? ''), 10000); return; }

        const deps = buildSweepDeps(plugin, ctl.signal);
        const limits = { maxNotes: plugin.settings.sweepMaxNotes, maxChars: plugin.settings.sweepMaxChars };
        const estimated = await estimateSweep(deps, limits);
        if (!estimated.ok) { guidanceNotice(plugin, estimated.error); return; }
        const estimate = estimated.value;
        // The held set is frozen for this run, so this is the number the run really leaves out for review.
        const held = heldInboxCount(plugin);
        if (estimate.notes === 0) { new Notice(held > 0 ? plural(t.nothingToSweepHeld, held, 'held').replace('{held}', String(held)) : t.nothingToSweep, 9000); return; }
        const cloud = plugin.settings.serviceType === 'cloud';
        const body = [
            plural(t.confirmBody, estimate.notes, 'notes').replace('{chars}', estimate.chars.toLocaleString()),
            cloud && !privacyNoticeShown ? t.privacyNotice : '',
        ].filter(Boolean).join('\n\n');
        if (!(await confirm(plugin, t.confirmTitle, body))) return;
        if (cloud) privacyNoticeShown = true;

        const working = cancellableNotice(t.working, plugin.t.modals.cancel, () => ctl.abort());
        let result: Awaited<ReturnType<typeof runSweep>>;
        try {
            result = await runSweep(deps, { ...limits, signal: ctl.signal, onProgress: (done, total) => working.messageEl.firstElementChild?.setText(`${t.working} ${done}/${total}`) });
        } finally {
            working.hide();
        }
        if (!result.ok) { new Notice(result.error === 'cancelled' ? t.cancelledNotice : formatGuidance(describeError(plugin.t, result.error)), 6000); return; }
        const r = result.value;
        // Held captures are counted as left out by the guard; they are reported as what they are.
        const kept = Math.max(0, Object.values(r.excluded).reduce((a, b) => a + (b ?? 0), 0) - held);
        const heldLine = held > 0 ? ` ${plural(t.summaryHeld, held, 'held').replace('{held}', String(held))}` : '';
        new Notice(`${plural(t.summaryNotice, r.notes.length, 'notes').replace('{kept}', String(kept)).replace('{failed}', String(r.failed))}${heldLine}`, 7000);
        // AI hand-backs have their own review: said once, so a note that is missing from the sweep is explained.
        if (r.skippedHandbacks) new Notice(plural(t.handbackSkipped, r.skippedHandbacks), 9000);
        if (r.skippedReading) new Notice(plural(t.readingSkipped, r.skippedReading), 9000);
        if (r.notes.length === 0) return;
        await review(plugin, r.notes, r.contexts);
    } catch (e) {
        logger.error('Sweep', 'Sweep failed', e);
        guidanceNotice(plugin, 'unknown');
    } finally {
        sweeping = false;
        unfreezeHeldMirror();
    }
}

/** The sweep review for proposals from any source (a sweep run, or an AI hand-back's next actions). */
export function review(plugin: AIOrganiserPlugin, notes: NoteProposals[], contexts: readonly string[], projectId?: string, quick?: QuickTask): Promise<CommitInput | null> {
    // Destination controls only while Google Tasks export is on and the setup has something to choose; the project only when the service resolves one.
    const routing = isFeatureEnabled(plugin.settings, 'google-tasks-export') ? reviewRoutingFor(plugin.settings) : null;
    const service = getProjectService(plugin);
    const projectOf = (path: string): string | null => {
        if (projectId) return projectId;
        const found = service?.resolveSourceProject(path);
        return found?.kind === 'project' ? found.aioId : null;
    };
    return new Promise<CommitInput | null>((resolve) => {
        new InboxSweepReviewModal(plugin.app, plugin, notes, (result: CommitInput | null) => {
            if (!result) { resolve(null); return; }
            // The approval is only reported back when the commit really saved it: a rejected or failed commit resolves null.
            commit(plugin, result)
                .then((outcome) => {
                    refreshProcessViews(plugin.app);
                    // The caller is told as soon as the approval is saved; sending to Google is a separate, optional step after that.
                    resolve(outcome.saved ? result : null);
                    // Filing waits for the tasks: after the send when there is one, at once when there is nothing to send.
                    if (outcome.send) void runSendApproved(plugin);
                    else if (outcome.saved) void runPendingFiling(plugin);
                })
                .catch((e: unknown) => { logger.error('Sweep', 'Commit failed', e); guidanceNotice(plugin, 'unknown'); resolve(null); });
        }, contexts, routing, projectOf, quick ?? null).open();
    });
}

async function commit(plugin: AIOrganiserPlugin, input: CommitInput): Promise<{ saved: boolean; send: boolean }> {
    const t = plugin.t.inboxSweep;
    const out = await commitReview(plugin, input);
    if (out.error) {
        new Notice(out.stoppedAt === 'persist' ? formatGuidance(describeError(plugin.t, out.error)) : t.commitStopped.replace('{reason}', formatGuidance(describeError(plugin.t, out.error))), 10000);
        // The approval is saved once persisted; a later step that stopped is finished by recovery, so only a failed persist is a failure.
        return { saved: out.stoppedAt !== 'persist', send: false };
    }
    const added = input.tasks.length - (out.duplicates ?? 0);
    // Nothing added and nothing marked (a filing choice only): the filing says what happened, so no notice here.
    if (added > 0) new Notice(plural(t.addedNotice, added).replace('{path}', plugin.settings.sweepReportPath), 6000);
    else if (input.dispositions.some((d) => d.markSwept)) new Notice(t.markedNotice, 6000);
    if (out.duplicates) new Notice(plural(t.duplicatesSkipped, out.duplicates), 6000);
    return { saved: true, send: added > 0 && isFeatureEnabled(plugin.settings, 'google-tasks-export') && !!plugin.settings.tasksListId };
}

// ─── Google Tasks ───────────────────────────────────────────────────────────

/** A held task on automatic lists: a button, because approving a list is the person's decision and an export never makes it. */
function offerApproveLists(plugin: AIOrganiserPlugin): void {
    const notice = cancellableNotice(withSendAgain(plugin.t, formatGuidance(describeError(plugin.t, 'tasks-list-auto-not-approved'))), plugin.t.googleTasks.approveLists, () => {
        notice.hide();
        void approveConfiguredLists(plugin).then((res) => {
            if (res.ok) new Notice(plugin.t.googleTasks.listsApproved, 8000); else guidanceNotice(plugin, res.error);
        });
    });
}

let sendingApproved = false;

export async function runSendApproved(plugin: AIOrganiserPlugin): Promise<void> {
    const t = plugin.t.inboxSweep;
    if (sendingApproved) { new Notice(t.alreadyRunning, 5000); return; }
    sendingApproved = true;
    const ctl = new AbortController();
    const working = cancellableNotice(t.sending, plugin.t.modals.cancel, () => ctl.abort());
    try {
        const res = await sendApproved(plugin, ctl.signal);
        if (!res.ok) { sendGuidanceNotice(plugin, res.error); return; }
        const s = res.value;
        if (s.extraApproved) guidanceNotice(plugin, 'tasks-script-approves-extra', 15000);
        if (s.error) { sendGuidanceNotice(plugin, s.error); return; }
        // Notes whose tasks are now safe are filed as the person chose in the review.
        void runPendingFiling(plugin);
        new Notice(t.sentNotice.replace('{exported}', String(s.exported)).replace('{pending}', String(s.pending)).replace('{blocked}', String(s.blocked.length)), 8000);
        // Items that were not sent are never silent: each distinct reason is said once, with what to do next.
        for (const reason of new Set((s.held ?? []).map((h) => h.reason))) {
            if (reason === 'tasks-list-not-approved' && plugin.settings.tasksAutoLists) offerApproveLists(plugin);
            else sendGuidanceNotice(plugin, reason, 12000);
        }
    } catch (e) {
        logger.error('Sweep', 'Send failed', e);
        sendGuidanceNotice(plugin, 'unknown');
    } finally {
        working.hide();
        sendingApproved = false;
    }
}

/** Refresh the completion of exported tasks (read-only). */
export async function runRefreshStatus(plugin: AIOrganiserPlugin): Promise<void> {
    const t = plugin.t.inboxSweep;
    if (sendingApproved) { new Notice(t.alreadyRunning, 5000); return; }
    sendingApproved = true;
    const ctl = new AbortController();
    const working = cancellableNotice(t.refreshing, plugin.t.modals.cancel, () => ctl.abort());
    try {
        const res = await refreshStatuses(plugin, ctl.signal);
        if (!res.ok) { guidanceNotice(plugin, res.error); return; }
        new Notice(t.refreshedNotice.replace('{checked}', String(res.value.checked)).replace('{failed}', String(res.value.failed)), 8000);
        if (res.value.ticked > 0) new Notice(plural(t.refreshedTicked, res.value.ticked).replace('{path}', plugin.settings.sweepReportPath), 8000);
    } catch (e) {
        logger.error('Sweep', 'Status refresh failed', e);
        guidanceNotice(plugin, 'unknown');
    } finally {
        working.hide();
        sendingApproved = false;
    }
}

// ─── Guided setup: inbox sweep ──────────────────────────────────────────────

export function openInboxSweepSetup(plugin: AIOrganiserPlugin, onDone?: () => void): void {
    const t = plugin.t;
    const c = t.inboxSweep;
    const s = plugin.settings;
    // The inbox and keep-out questions are shared with the capture inbox (`inboxScopeSteps`).
    const draft = { ...draftFromSettings(s), report: s.sweepReportPath };

    new GuidedSetupModal(plugin.app, t, {
        title: c.wizardTitle,
        steps: [
            {
                id: 'folders',
                title: c.stepFolders,
                validate: () => {
                    if (draft.inbox.length === 0) return err('sweep-no-folders');
                    return validateReportPath(draft.report, s.protectedFolders).ok ? ok(undefined) : err('sweep-report-invalid');
                },
                render: (el) => {
                    el.createEl('p', { text: c.foldersHelp });
                    renderInboxFolders(plugin, el, draft);
                    new Setting(el).setName(c.reportName).setDesc(c.reportDesc).addText((tx) => {
                        tx.setValue(draft.report).onChange((v) => { draft.report = v; });
                        tx.inputEl.setAttribute('aria-label', c.reportName);
                    });
                },
            },
            {
                id: 'keepout',
                title: c.stepKeepOut,
                validate: () => validateKeepOut(draft, 'sweep-keepout-required'),
                render: (el) => renderKeepOut(plugin, el, draft, c),
            },
            {
                id: 'preview',
                title: c.stepPreview,
                render: async (el) => {
                    el.createEl('p', { text: c.previewHelp });
                    const box = el.createDiv({ attr: { role: 'status' } });
                    box.setText(c.previewWorking);
                    // Judged under the policy a run uses, so captures held for review are not counted as notes the sweep would read.
                    const { allowed, kept } = await previewScope(plugin, draft, sweepRunPolicy(plugin));
                    const held = Math.min(heldInboxCount(plugin, draft.inbox), kept);
                    box.setText(plural(c.previewResult, allowed, 'allowed').replace('{allowed}', String(allowed)).replace('{kept}', String(kept - held)) + (held > 0 ? ` ${plural(c.previewHeld, held, 'held').replace('{held}', String(held))}` : ''));
                },
            },
        ],
        onFinish: async (): Promise<Result<void>> => {
            // Validate first, change nothing until everything is known to be usable.
            const path = validateReportPath(draft.report, s.protectedFolders);
            if (!path.ok) return err(path.error);
            const before = {
                inbox: s.sweepInboxFolders, excludedFolders: s.sweepExcludedFolders, tags: s.sweepExcludedTags, props: s.sweepExcludedProperties,
                terms: s.sweepExcludedTerms, nothing: s.sweepNothingToExclude, report: s.sweepReportPath, done: s.featureSetupCompletedAt['inbox-sweep'],
            };
            const set = {
                inbox: draft.inbox, excludedFolders: draft.excludedFolders,
                tags: lines(draft.tags).map((x) => x.replace(/^#/, '')), props: propertyLines(draft.properties), terms: lines(draft.terms),
                nothing: exclusionCount(draft) === 0 && draft.nothing, report: path.value, done: new Date().toISOString(),
            };
            s.sweepInboxFolders = set.inbox;
            s.sweepExcludedFolders = set.excludedFolders;
            s.sweepExcludedTags = set.tags;
            s.sweepExcludedProperties = set.props;
            s.sweepExcludedTerms = set.terms;
            s.sweepNothingToExclude = set.nothing;
            s.sweepReportPath = set.report;
            s.featureSetupCompletedAt['inbox-sweep'] = set.done;
            try {
                await plugin.saveSettings();
            } catch (e) {
                // Not saved: put back only what THIS setup set, and only if nothing else (a rename) changed it since.
                logger.error('Sweep', 'Could not save the sweep setup', e);
                if (s.sweepInboxFolders === set.inbox) s.sweepInboxFolders = before.inbox;
                if (s.sweepExcludedFolders === set.excludedFolders) s.sweepExcludedFolders = before.excludedFolders;
                if (s.sweepExcludedTags === set.tags) s.sweepExcludedTags = before.tags;
                if (s.sweepExcludedProperties === set.props) s.sweepExcludedProperties = before.props;
                if (s.sweepExcludedTerms === set.terms) s.sweepExcludedTerms = before.terms;
                if (s.sweepNothingToExclude === set.nothing) s.sweepNothingToExclude = before.nothing;
                if (s.sweepReportPath === set.report) s.sweepReportPath = before.report;
                if (s.featureSetupCompletedAt['inbox-sweep'] === set.done) {
                    if (before.done === undefined) delete s.featureSetupCompletedAt['inbox-sweep']; else s.featureSetupCompletedAt['inbox-sweep'] = before.done;
                }
                return err('write-failed');
            }
            new Notice(c.setupSaved, 8000);
            onDone?.();
            return ok(undefined);
        },
    }).open();
}

// ─── Guided setup: Google Tasks ─────────────────────────────────────────────

export function openTasksSetup(plugin: AIOrganiserPlugin, onDone?: () => void): void {
    const t = plugin.t;
    const c = t.googleTasks;
    const s = plugin.settings;
    const draft = {
        url: s.tasksScriptUrl,
        lists: [] as TaskList[],
        listId: s.tasksListId,
        status: c.notTested,
        operational: false,
        /** The deployed script is the combined Google script (learned from a test); unknown until one ran */
        combined: false,
        /** The person's last copy here was the combined script. A test of the deployed script outranks it. */
        copiedCombined: false,
        /** The deployed script keeps its lists in its properties (learned from a test) */
        automatic: s.tasksAutoLists,
        /** The person's last copy here was the automatic script. A test of the deployed script outranks it. */
        copiedAutomatic: false,
        /** Other lists ticked for an automatic script, besides the main one */
        extra: new Set(s.tasksLists.map((l) => l.id)),
        /** Why the last check said not ready: the guidance Finish shows */
        notReady: 'tasks-wizard-unchecked',
    };
    const listName = (): string => draft.lists.find((l) => l.id === draft.listId)?.title ?? s.tasksListName;
    const endpoint = async (): Promise<Result<{ url: string; secret: string }>> => {
        const url = validateScriptUrl(draft.url);
        if (!url.ok) return err(url.error);
        const secret = await plugin.secretStorageService.getSecret(PLUGIN_SECRET_IDS.GOOGLE_TASKS);
        return secret ? ok({ url: url.value, secret }) : err('tasks-no-secret');
    };
    const copyScript = async (approvedListId: string | null): Promise<void> => {
        const stored = await ensureTasksSecret(plugin);
        if (!stored.ok) { guidanceNotice(plugin, stored.error); return; }
        await navigator.clipboard.writeText(selectTasksScript(s, stored.value.secret, approvedListId).text);
        new Notice(c.scriptCopied + (stored.value.created ? ` ${c.secretCreated}` : ''), 8000);
    };
    const copyCombined = async (redeploy = true): Promise<void> => {
        await copyCombinedScript(plugin, draft.listId || undefined, redeploy);
    };
    const wantsCombined = (): boolean => draft.combined || draft.copiedCombined;
    const wantsAutomatic = (): boolean => draft.automatic || draft.copiedAutomatic;
    /** What Finish approves on an automatic script: the main list first, at most the cap. */
    const chosenLists = (): TasksListConfig[] => {
        const titleOf = (id: string): string => draft.lists.find((l) => l.id === id)?.title ?? s.tasksLists.find((l) => l.id === id)?.title ?? '';
        const dated = (id: string): boolean => s.tasksLists.find((l) => l.id === id)?.needsDate === true;
        const ids = [draft.listId, ...[...draft.extra].filter((id) => id !== draft.listId)];
        return normaliseTasksLists(ids.map((id) => ({ id, title: id === draft.listId ? listName() : titleOf(id), needsDate: dated(id) })));
    };
    /** No saved link: nothing is deployed that this window could overwrite, so it can lead with the combined script. A saved link keeps the window as it was. */
    const fresh = s.tasksScriptUrl.trim() === '';
    /** One check of the deployed script: used by Test connection and Test again, so both learn whether it is the combined one. */
    const verify = async (status: HTMLElement, forList: boolean): Promise<void> => {
        status.setText(c.testing);
        const ep = await endpoint();
        // A check that could not reach the script clears readiness; the deployment kind stays (not reaching a script says nothing about its kind, and a different link already reset it).
        const unreached = (code: string): void => { draft.operational = false; draft.notReady = 'tasks-wizard-unchecked'; status.setText(formatGuidance(describeError(t, code))); };
        if (!ep.ok) { unreached(ep.error); return; }
        const ping = await pingTasksScript(ep.value);
        if (!ping.ok) { unreached(ping.error); return; }
        draft.combined = ping.value.combined === true;
        draft.copiedCombined = false;
        draft.automatic = ping.value.capabilities?.includes(LIST_CONFIG_CAPABILITY) === true;
        draft.copiedAutomatic = false;
        if (draft.automatic) {
            // Nothing to paste: Finish approves the chosen lists.
            draft.operational = true;
            draft.status = c.connectedAutomatic;
            status.setText(draft.status);
            return;
        }
        if (!forList) { draft.status = draft.combined ? c.connectedCombined : c.connected; status.setText(draft.status); return; }
        const state = await classifyTasksScript(ping.value, draft.listId, configuredListIds({ tasksListId: draft.listId, tasksLists: s.tasksLists }));
        draft.operational = state === 'operational';
        draft.notReady = state === 'setup' ? 'tasks-wizard-setup' : state === 'outdated' ? 'script-outdated' : state === 'lists-outdated' ? 'tasks-script-lists-outdated' : 'tasks-wizard-wrong-list';
        status.setText(state === 'operational' ? c.operationalLine.replace('{list}', listName()) : state === 'setup' ? c.stillSetup : state === 'outdated' ? formatGuidance(describeError(t, 'script-outdated')) : state === 'lists-outdated' ? formatGuidance(describeError(t, 'tasks-script-lists-outdated')) : c.wrongList);
    };
    const run = (task: () => Promise<void>, line?: HTMLElement): void => {
        task().catch((e: unknown) => {
            logger.error('Sweep', 'Tasks setup step failed', e);
            const message = formatGuidance(describeError(t, 'unknown'));
            if (line) line.setText(message); else new Notice(message, 8000);
        });
    };
    /** A link in the window with no secret here means a script already exists, and a script with a new secret would stop every other device. */
    const noSecretForLink = async (): Promise<boolean> => draft.url.trim() !== '' && !(await plugin.secretStorageService.getSecret(PLUGIN_SECRET_IDS.GOOGLE_TASKS));
    const copying = (task: () => Promise<void>): void => run(async () => {
        if (await noSecretForLink()) { guidanceNotice(plugin, 'tasks-no-secret'); return; }
        await task();
    });

    new GuidedSetupModal(plugin.app, t, {
        title: c.wizardTitle,
        steps: [
            {
                id: 'script',
                title: c.stepScript,
                validate: () => (validateScriptUrl(draft.url).ok ? ok(undefined) : err('script-invalid-endpoint')),
                render: (el) => {
                    el.createEl('p', { text: c.scriptIntro });
                    const lead = el.createDiv({ cls: 'ai-organiser-capture-warning', attr: { role: 'status' } });
                    if (fresh) {
                        el.createEl('p', { text: c.freshIntro });
                        el.createEl('p', { text: c.freshAlreadyDeployed, cls: 'setting-item-description' });
                        for (const line of [c.step1, c.step2Automatic, c.step3Combined, c.step4]) el.createEl('p', { text: line });
                        new Setting(el).addButton((b) => b.setButtonText(c.copyAutomaticScript).setCta().onClick(() => copying(async () => { await copyAutomaticScript(plugin, c.automaticCopied); draft.copiedAutomatic = true; draft.copiedCombined = false; })));
                        el.createEl('p', { text: c.automaticTradeoff, cls: 'setting-item-description' });
                        el.createEl('p', { text: c.keepLockedNote, cls: 'setting-item-description' });
                        new Setting(el)
                            .addButton((b) => b.setButtonText(c.keepLockedCombined).onClick(() => copying(async () => { await copyCombined(false); draft.copiedCombined = true; draft.copiedAutomatic = false; draft.automatic = false; })))
                            .addButton((b) => b.setButtonText(c.keepLockedTasksOnly).onClick(() => copying(async () => { draft.copiedAutomatic = false; draft.automatic = false; if (draft.combined) { await copyCombined(); return; } await copyScript(null); draft.copiedCombined = false; })));
                    } else {
                        el.createEl('p', { text: c.combinedHint, cls: 'setting-item-description' });
                        for (const line of [c.step1, c.step2, c.step3, c.step4]) el.createEl('p', { text: line });
                        new Setting(el).addButton((b) => b.setButtonText(c.copySetupScript).setCta().onClick(() => copying(() => (draft.automatic ? copyAutomaticScript(plugin, t.googleScript.copiedRedeploy) : draft.combined ? copyCombined() : copyScript(null)))));
                    }
                    const status = el.createDiv({ cls: 'setting-item-description', attr: { role: 'status' } });
                    status.setText(draft.status);
                    let linkInput: { setValue: (v: string) => unknown } | null = null;
                    new Setting(el).setName(c.scriptUrlName).setDesc(c.scriptUrlDesc).addText((tx) => {
                        linkInput = tx;
                        tx.setValue(draft.url).onChange((v) => {
                            // What was learned belongs to the link it was learned from: a different link starts unchecked.
                            if (v.trim() !== draft.url) { draft.operational = false; draft.combined = false; draft.automatic = false; draft.notReady = 'tasks-wizard-unchecked'; draft.status = c.notTested; }
                            draft.url = v.trim();
                        });
                        tx.inputEl.setAttribute('aria-label', c.scriptUrlName);
                    }).addButton((b) => b.setButtonText(c.testConnection).onClick(() => run(() => verify(status, false), status)));
                    const connect = renderConnectDevice(el, plugin, {
                        link: () => draft.url,
                        listId: () => draft.listId,
                        run,
                        onConnected: (connected) => {
                            lead.setText('');
                            draft.url = connected.url;
                            linkInput?.setValue(connected.url);
                            draft.listId = s.tasksListId;
                            draft.copiedAutomatic = false;
                            draft.copiedCombined = false;
                            onDone?.();
                            // The same check Test connection runs, so the later steps know what is deployed.
                            run(() => verify(status, draft.listId !== ''), status);
                        },
                    });
                    // This device has a link and no secret: connecting is the way forward, and a new script is not.
                    run(async () => {
                        if (!(await noSecretForLink())) return;
                        lead.setText(formatGuidance(describeError(t, 'tasks-no-secret')));
                        connect.open = true;
                    });
                },
            },
            {
                id: 'list',
                title: c.stepList,
                validate: () => (draft.listId ? ok(undefined) : err('tasks-wizard-no-list')),
                render: (el) => {
                    el.createEl('p', { text: c.listHelp });
                    const status = el.createDiv({ cls: 'setting-item-description', attr: { role: 'status' } });
                    const holder = el.createDiv();
                    const showLists = (): void => {
                        holder.empty();
                        new Setting(holder).setName(c.listName).addDropdown((d) => {
                            for (const l of draft.lists) d.addOption(l.id, l.title);
                            // What the dropdown shows is what is chosen: with no valid choice yet, the first list is chosen.
                            if (!draft.lists.some((l) => l.id === draft.listId)) { draft.listId = draft.lists[0]?.id ?? ''; if (!wantsAutomatic()) draft.operational = false; }
                            d.setValue(draft.listId).onChange((v) => { draft.listId = v; if (!wantsAutomatic()) draft.operational = false; if (wantsAutomatic()) showLists(); });
                        });
                        // An automatic script takes every list at Finish; a locked one is limited to its text, so its other lists stay under Your lists.
                        if (wantsAutomatic()) {
                            for (const list of draft.lists.filter((l) => l.id !== draft.listId)) {
                                new Setting(holder).setName(list.title).setDesc(c.alsoUseList).addToggle((tg) => tg.setValue(draft.extra.has(list.id)).onChange((on) => { if (on) draft.extra.add(list.id); else draft.extra.delete(list.id); }));
                            }
                        }
                    };
                    if (draft.lists.length > 0) showLists();
                    new Setting(el).addButton((b) => b.setButtonText(c.loadLists).onClick(() => run(async () => {
                        status.setText(c.testing);
                        const ep = await endpoint();
                        if (!ep.ok) { status.setText(formatGuidance(describeError(t, ep.error))); return; }
                        const lists = await fetchTaskLists(ep.value);
                        if (!lists.ok) { status.setText(formatGuidance(describeError(t, lists.error))); return; }
                        draft.lists = lists.value;
                        status.setText(lists.value.length === 0 ? c.noLists : '');
                        showLists();
                    }, status)));
                },
            },
            {
                id: 'finish',
                title: c.stepFinish,
                validate: () => (wantsAutomatic() || draft.operational ? ok(undefined) : err(draft.notReady)),
                render: (el) => {
                    if (wantsAutomatic()) {
                        el.createEl('p', { text: c.finishIntroAutomatic.replace('{lists}', chosenLists().map((l) => l.title || l.id).join(', ')) });
                        return;
                    }
                    el.createEl('p', { text: (wantsCombined() ? c.finishIntroCombined : c.finishIntro).replace('{list}', listName()) });
                    // The combined deployment is never overwritten by the standalone script: the primary button follows what the last test found.
                    new Setting(el).addButton((b) => b.setButtonText(wantsCombined() ? c.copyFinalCombined : c.copyFinalScript).setCta().onClick(() => copying(() => (wantsCombined() ? copyCombined() : copyScript(draft.listId)))));
                    if (!wantsCombined()) {
                        el.createEl('p', { text: c.standaloneNote, cls: 'setting-item-description' });
                        new Setting(el).addButton((b) => b.setButtonText(c.copyCombinedInstead).onClick(() => copying(() => copyCombined())));
                    }
                    const status = el.createDiv({ cls: 'setting-item-description', attr: { role: 'status' } });
                    status.setText(draft.operational ? c.operationalLine.replace('{list}', listName()) : c.notReady);
                    new Setting(el).addButton((b) => b.setButtonText(c.testAgain).onClick(() => run(() => verify(status, true), status)));
                },
            },
        ],
        onFinish: async (): Promise<Result<void>> => {
            const before = { url: s.tasksScriptUrl, listId: s.tasksListId, listName: s.tasksListName, lastTest: s.tasksLastTest, done: s.featureSetupCompletedAt['google-tasks'], lists: s.tasksLists, auto: s.tasksAutoLists, revision: s.tasksListsRevision };
            const set = { url: draft.url, listId: draft.listId, listName: listName(), lastTest: { ok: true as const, configHash: tasksConfigKey(draft.url, draft.listId), at: new Date().toISOString() }, done: new Date().toISOString() };
            // Finish is the person's action that approves the lists on an automatic script, and the plugin confirms with a ping before saving anything.
            if (wantsAutomatic()) {
                const ep = await endpoint();
                if (!ep.ok) return err(ep.error);
                const lists = chosenLists();
                const approved = await approveLists({
                    ...ep.value, main: draft.listId, ids: lists.map((l) => l.id), knownRevision: s.tasksListsRevision,
                    onStale: async (remote) => { s.tasksListsRevision = remote; await plugin.saveSettings(); },
                });
                if (!approved.ok) return err(approved.error);
                s.tasksLists = lists;
                s.tasksAutoLists = true;
                s.tasksListsRevision = approved.value;
            } else {
                s.tasksAutoLists = false;
                s.tasksListsRevision = null;
            }
            s.tasksScriptUrl = set.url;
            s.tasksListId = set.listId;
            s.tasksListName = set.listName;
            s.tasksLastTest = set.lastTest;
            s.featureSetupCompletedAt['google-tasks'] = set.done;
            try {
                await plugin.saveSettings();
            } catch (e) {
                // Not saved: put back only what THIS setup set, and only where nothing else changed it since.
                logger.error('Sweep', 'Could not save the Google Tasks setup', e);
                if (s.tasksScriptUrl === set.url) s.tasksScriptUrl = before.url;
                if (s.tasksListId === set.listId) s.tasksListId = before.listId;
                if (s.tasksListName === set.listName) s.tasksListName = before.listName;
                if (s.tasksLastTest === set.lastTest) s.tasksLastTest = before.lastTest;
                s.tasksLists = before.lists;
                s.tasksAutoLists = before.auto;
                s.tasksListsRevision = before.revision;
                if (s.featureSetupCompletedAt['google-tasks'] === set.done) {
                    if (before.done === undefined) delete s.featureSetupCompletedAt['google-tasks']; else s.featureSetupCompletedAt['google-tasks'] = before.done;
                }
                return err('write-failed');
            }
            new Notice(t.googleTasks.setupSaved.replace('{list}', set.listName || draft.listId), 8000);
            onDone?.();
            return ok(undefined);
        },
    }).open();
}

export { tasksConfigKey };

// ─── Registration ───────────────────────────────────────────────────────────

/** Keep the ledger and open approvals attached to notes that are moved or renamed. */
function registerRenameTracking(plugin: AIOrganiserPlugin): void {
    plugin.registerEvent(plugin.app.vault.on('rename', (file: TAbstractFile, oldPath: string) => {
        const s = plugin.settings;
        const ledger = renameLedger(s.sweepLedger, oldPath, file.path);
        const approvals = renameApprovals(s.sweepApprovals, oldPath, file.path);
        const reportedItems = renameReportedItems(s.sweepReportedItems, oldPath, file.path);
        const oldNorm = normalisePath(oldPath);
        const moved = (f: string): string => (isInsideOrEqual(normalisePath(f), oldNorm) ? normalisePath(file.path) + normalisePath(f).slice(oldNorm.length) : f);
        const inbox = s.sweepInboxFolders.map(moved);
        const excluded = s.sweepExcludedFolders.map(moved);
        const report = moved(s.sweepReportPath);
        const reportMoved = report !== s.sweepReportPath;
        // Every rename-sensitive setting is looked at on its own before deciding nothing changed.
        const changed = ledger.changed || approvals.changed || reportedItems.changed || reportMoved
            || inbox.some((f, i) => f !== s.sweepInboxFolders[i]) || excluded.some((f, i) => f !== s.sweepExcludedFolders[i]);
        if (!changed) return;
        // The live data is remapped immediately; saving happens in order afterwards.
        s.sweepLedger = ledger.ledger;
        s.sweepApprovals = approvals.records;
        s.sweepReportedItems = reportedItems.items;
        s.sweepInboxFolders = inbox;
        s.sweepExcludedFolders = excluded;
        if (reportMoved) s.sweepReportPath = report;
        void plugin.saveSettings().catch((e: unknown) => logger.error('Sweep', 'Could not save a renamed sweep path', e));
    }));
}

export function registerInboxSweepCommands(plugin: AIOrganiserPlugin): void {
    const t = plugin.t;
    plugin.addCommand({ id: 'sweep-inbox', name: actionName(t, 'sweep-inbox'), icon: 'inbox', callback: () => { void runInboxSweep(plugin); } });
    plugin.addCommand({ id: 'setup-inbox-sweep', name: actionName(t, 'setup-inbox-sweep'), icon: 'sparkles', callback: () => openInboxSweepSetup(plugin) });
    registerRenameTracking(plugin);
}

export function registerGoogleTasksCommands(plugin: AIOrganiserPlugin): void {
    const t = plugin.t;
    plugin.addCommand({ id: 'send-tasks-to-google', name: actionName(t, 'send-tasks-to-google'), icon: 'send', callback: () => { void runSendApproved(plugin); } });
    plugin.addCommand({ id: 'refresh-task-status', name: actionName(t, 'refresh-task-status'), icon: 'refresh-cw', callback: () => { void runRefreshStatus(plugin); } });
    plugin.addCommand({ id: 'setup-google-tasks', name: actionName(t, 'setup-google-tasks'), icon: 'list-checks', callback: () => openTasksSetup(plugin) });
}
