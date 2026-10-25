/**
 * Committing a reviewed sweep: the durable approval record (outbox) and its four ordered steps.
 *
 *   1. persist the record (approved tasks and the source dispositions) in plugin data;
 *   2. write this run's section into the report note (skipped when there are zero approved tasks);
 *   3. mark the items `reported`, and mark swept the sources whose disposition says so;
 *   4. export only `reported` items to Google Tasks (a separate, optional step).
 *
 * Every step is repeatable. After a crash `repairApprovals` reads the report note, compares the
 * task ids actually present with the record, and finishes whatever is missing; a section that is
 * partial, has extras or is malformed is a conflict that stops, names the note and writes nothing.
 * Source notes are never modified.
 */
import { TFile } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import { Result, ok, err } from '../../core/result';
import { PLUGIN_SECRET_IDS } from '../../core/secretIds';
import { assertWritable } from '../../core/protectedPaths';
import { isFeatureEnabled } from '../featureService';
import { applyNoteEdit } from '../noteEdit/applyNoteEdit';
import { validateScriptUrl } from '../appsScriptClient';
import { logger } from '../../utils/logger';
import { buildSnapshot } from './noteSnapshot';
import { guardSnapshot, policyRevisionOf, type SweepPolicy } from './sweepGuard';
import {
    applyDispositions,
    dropAlreadyReported,
    markReported,
    newApproval,
    pendingApprovals,
    pruneApprovals,
    recordReportedItems,
    type ApprovalRecord,
    type Disposition,
} from './sweepLedger';
import { appendSection, reconcileReport, renderSection, validateReportPath, RUN_ID_PATTERN } from './sweepReport';
import { exportApproved, type ExportSummary, type SourceCheck } from './tasksExportService';
import { heldMirrorPaths, isCaptureActive, isHeldMirrorLoaded } from '../captureInbox/heldMirror';
import { withHeldPaths } from '../captureInbox/capturePolicy';

/**
 * Approval mutations run one at a time. A rollback after a failed save restores a snapshot, which is
 * only safe if no other commit slipped in between; serialising removes that window.
 */
let exclusive: Promise<unknown> = Promise.resolve();
function runExclusive<T>(job: () => Promise<T>): Promise<T> {
    const run = exclusive.then(job, job);
    exclusive = run.catch(() => undefined);
    return run;
}

export function sweepPolicy(plugin: AIOrganiserPlugin): SweepPolicy {
    const s = plugin.settings;
    return {
        excludedFolders: s.sweepExcludedFolders,
        excludedTags: s.sweepExcludedTags,
        excludedProperties: s.sweepExcludedProperties,
        excludedTerms: s.sweepExcludedTerms,
        protectedFolders: s.protectedFolders,
        maxNoteChars: Math.max(s.sweepMaxChars, 20_000),
    };
}

/**
 * The policy the SWEEP runs under: the base policy, plus every note the capture inbox still holds (not yet
 * accepted), so the sweep waits for Accept instead of reading a raw note whose text is about to change.
 * Fails closed: if the capture feature is on but its journal has not loaded, the whole inbox is held out.
 * With the capture feature off this is exactly `sweepPolicy`.
 */
export function sweepRunPolicy(plugin: AIOrganiserPlugin): SweepPolicy {
    const base = sweepPolicy(plugin);
    if (!isCaptureActive()) return base;
    if (!isHeldMirrorLoaded()) return { ...base, excludedFolders: [...base.excludedFolders, ...plugin.settings.sweepInboxFolders] };
    return withHeldPaths(base, heldMirrorPaths());
}

export function newRunId(): string {
    return `run-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function newTaskId(): string {
    return `aio-${crypto.randomUUID()}`;
}

async function save(plugin: AIOrganiserPlugin): Promise<Result<void>> {
    try {
        await plugin.saveSettings();
        return ok(undefined);
    } catch (e) {
        logger.error('Sweep', 'Could not save sweep data', e);
        return err('write-failed');
    }
}

function replaceRecord(plugin: AIOrganiserPlugin, record: ApprovalRecord): void {
    const list = plugin.settings.sweepApprovals;
    const i = list.findIndex((r) => r.runId === record.runId);
    if (i === -1) list.push(record);
    else list[i] = record;
}

/**
 * Save a record durably. The live settings only keep the new state when the save succeeded; on
 * failure they are put back, so recovery decisions (which read the live settings) never rest on a
 * checkpoint that was not written.
 */
/**
 * What an export changes in a record is the state of its tasks. Merge only that into the record as it is
 * NOW, so a rename or another commit that touched the same record during the network calls is kept.
 */
export function mergeExportStates(current: ApprovalRecord | undefined, incoming: ApprovalRecord): ApprovalRecord {
    if (!current) return incoming;
    return {
        ...current,
        tasks: current.tasks.map((t) => {
            const next = incoming.tasks.find((x) => x.id === t.id);
            // Only an export outcome moves a task, and only a task that is waiting to be exported (or is being
            // retried): one the live record already has as exported stays exported, and one the export did not
            // reach keeps the state it has now.
            const outcome = next && (next.state === 'exported' || next.state === 'failed');
            const waiting = t.state === 'reported' || t.state === 'failed';
            if (!next || !outcome || !waiting) return t;
            return { ...t, state: next.state, error: next.error };
        }),
    };
}

async function saveRecord(plugin: AIOrganiserPlugin, record: ApprovalRecord): Promise<Result<void>> {
    const before = [...plugin.settings.sweepApprovals];
    replaceRecord(plugin, record);
    const saved = await save(plugin);
    if (!saved.ok) plugin.settings.sweepApprovals = before;
    return saved;
}

// ─── Report note ────────────────────────────────────────────────────────────

async function writeSection(plugin: AIOrganiserPlugin, record: ApprovalRecord): Promise<Result<void>> {
    const path = validateReportPath(record.reportPath, plugin.settings.protectedFolders);
    if (!path.ok) return err(path.error);
    const section = renderSection(record.runId, record.createdAt, record.tasks.map((t) => ({ id: t.id, text: t.text, context: t.context, sourcePath: t.sourcePath })));
    if (!section.ok) return err(section.error);
    const vault = plugin.app.vault;
    const existing = vault.getAbstractFileByPath(path.value);
    try {
        if (!existing) {
            if (!assertWritable(plugin.settings.protectedFolders, 'create', path.value).ok) return err('protected-path');
            const slash = path.value.lastIndexOf('/');
            if (slash > 0 && !vault.getAbstractFileByPath(path.value.slice(0, slash))) await vault.createFolder(path.value.slice(0, slash));
            await vault.create(path.value, `# Inbox sweep report\n\n${section.value}\n`);
            return ok(undefined);
        }
        if (!(existing instanceof TFile)) return err('sweep-report-invalid');
        const baseline = await vault.read(existing);
        const res = await applyNoteEdit(plugin, {
            kind: 'composite',
            filePath: path.value,
            baseline,
            recompute: (latest) => {
                const next = appendSection(latest, record.runId, section.value);
                return next.ok ? ok({ content: next.value }) : err('sweep-report-conflict');
            },
        }, { review: false });
        return res.ok ? ok(undefined) : err(res.error);
    } catch (e) {
        logger.error('Sweep', 'Could not write the sweep report', e);
        return err('write-failed');
    }
}

// ─── The four steps ─────────────────────────────────────────────────────────

export interface CommitInput {
    tasks: ReadonlyArray<{ id: string; text: string; context: string; sourcePath: string; sourceHash: string; keys?: string[] }>;
    dispositions: readonly Disposition[];
}

export interface CommitOutcome {
    record: ApprovalRecord;
    /** Approved tasks left out because the same item was already added from that note (or repeated in the batch) */
    duplicates?: number;
    /** Set when a step stopped; the record is saved and a later run can finish it */
    stoppedAt?: 'persist' | 'report' | 'ledger';
    error?: string;
}

/** Steps 1 to 3 for a freshly reviewed run. */
export function commitReview(plugin: AIOrganiserPlugin, input: CommitInput): Promise<CommitOutcome> {
    return runExclusive(() => commitReviewGuarded(plugin, input));
}

async function commitReviewGuarded(plugin: AIOrganiserPlugin, input: CommitInput): Promise<CommitOutcome> {
    try {
        return await commitReviewUnsafe(plugin, input);
    } catch (e) {
        logger.error('Sweep', 'Commit failed', e);
        const record = newApproval({ runId: newRunId(), now: new Date().toISOString(), reportPath: plugin.settings.sweepReportPath, tasks: input.tasks, dispositions: input.dispositions });
        return { record, stoppedAt: 'persist', error: 'write-failed' };
    }
}

async function commitReviewUnsafe(plugin: AIOrganiserPlugin, rawInput: CommitInput): Promise<CommitOutcome> {
    // An item already added from its note is never added twice: not to the report, not to the export.
    const { kept, dropped } = dropAlreadyReported(rawInput.tasks, plugin.settings.sweepReportedItems, plugin.settings.sweepApprovals);
    const input: CommitInput = { ...rawInput, tasks: kept };
    const out = await commitFiltered(plugin, input);
    return dropped > 0 ? { ...out, duplicates: dropped } : out;
}

async function commitFiltered(plugin: AIOrganiserPlugin, input: CommitInput): Promise<CommitOutcome> {
    const path = validateReportPath(plugin.settings.sweepReportPath, plugin.settings.protectedFolders);
    const runId = newRunId();
    let record = newApproval({
        runId,
        now: new Date().toISOString(),
        reportPath: path.ok ? path.value : plugin.settings.sweepReportPath,
        listId: isFeatureEnabled(plugin.settings, 'google-tasks-export') ? plugin.settings.tasksListId || undefined : undefined,
        tasks: input.tasks,
        dispositions: input.dispositions,
    });
    if (!RUN_ID_PATTERN.test(runId)) return { record, stoppedAt: 'persist', error: 'invalid-run-id' };
    if (!path.ok && input.tasks.length > 0) return { record, stoppedAt: 'persist', error: path.error };

    // 1. persist before anything else: edited proposals cannot be regenerated
    const saved = await saveRecord(plugin, record);
    if (!saved.ok) return { record, stoppedAt: 'persist', error: saved.error };
    return finishLocked(plugin, record);
}

/** The same as `finishRecord`, for callers that already hold the exclusive lock. */
const finishLocked = (plugin: AIOrganiserPlugin, record: ApprovalRecord): Promise<CommitOutcome> => finishUnsafe(plugin, record);

/** Steps 2 and 3, repeatable. Used by the first commit and by recovery. Never throws. */
export function finishRecord(plugin: AIOrganiserPlugin, start: ApprovalRecord): Promise<CommitOutcome> {
    return runExclusive(() => finishUnsafe(plugin, start));
}

async function finishUnsafe(plugin: AIOrganiserPlugin, start: ApprovalRecord): Promise<CommitOutcome> {
    let record = start;
    let stage: 'report' | 'ledger' = 'report';
    try {
        if (!record.reportDone) {
            const existing = plugin.app.vault.getAbstractFileByPath(record.reportPath);
            let state: 'done' | 'redo' | 'conflict' = 'redo';
            if (existing instanceof TFile) {
                state = reconcileReport(await plugin.app.vault.read(existing), record.runId, record.tasks.map((t) => t.id));
            }
            if (state === 'conflict') return { record, stoppedAt: 'report', error: 'sweep-report-conflict' };
            if (state === 'redo') {
                const written = await writeSection(plugin, record);
                if (!written.ok) return { record, stoppedAt: 'report', error: written.error };
            }
            const next = markReported(record);
            const saved = await saveRecord(plugin, next);
            if (!saved.ok) return { record, stoppedAt: 'report', error: saved.error };
            record = next;
        }
        if (!record.ledgerDone) {
            stage = 'ledger';
            const next = { ...record, ledgerDone: true };
            const ledgerBefore = plugin.settings.sweepLedger;
            const itemsBefore = plugin.settings.sweepReportedItems;
            const ledgerApplied = applyDispositions(ledgerBefore, record, new Date().toISOString());
            plugin.settings.sweepLedger = ledgerApplied;
            const itemsApplied = recordReportedItems(itemsBefore, record);
            plugin.settings.sweepReportedItems = itemsApplied;
            const saved = await saveRecord(plugin, next);
            if (!saved.ok) {
                // A rename that remapped a map while the save was pending owns the live value: do not overwrite it.
                if (plugin.settings.sweepLedger === ledgerApplied) plugin.settings.sweepLedger = ledgerBefore;
                // A rename that remapped the map while the save was pending owns the live value: do not overwrite it.
                if (plugin.settings.sweepReportedItems === itemsApplied) plugin.settings.sweepReportedItems = itemsBefore;
                return { record, stoppedAt: 'ledger', error: saved.error };
            }
            record = next;
        }
        return { record };
    } catch (e) {
        logger.error('Sweep', 'Could not finish the approval record', e);
        return { record, stoppedAt: stage, error: 'write-failed' };
    }
}

/** After a crash or an offline moment: finish every unfinished record. Returns the first problem found. */
export function repairApprovals(plugin: AIOrganiserPlugin): Promise<{ repaired: number; error?: string; path?: string }> {
    return runExclusive(() => repairUnsafe(plugin));
}

async function repairUnsafe(plugin: AIOrganiserPlugin): Promise<{ repaired: number; error?: string; path?: string }> {
    let repaired = 0;
    try {
        for (const record of [...plugin.settings.sweepApprovals]) {
            if (record.reportDone && record.ledgerDone) continue;
            const out = await finishLocked(plugin, record);
            if (out.error) return { repaired, error: out.error, path: record.reportPath };
            repaired++;
        }
    } catch (e) {
        logger.error('Sweep', 'Repair failed', e);
        return { repaired, error: 'write-failed' };
    }
    return { repaired };
}

// ─── Step 4: Google Tasks ───────────────────────────────────────────────────

/** Re-run the guard on a task's CURRENT source note. */
export async function checkSource(plugin: AIOrganiserPlugin, sourcePath: string, sourceHash: string): Promise<SourceCheck> {
    const file = plugin.app.vault.getAbstractFileByPath(sourcePath);
    if (!(file instanceof TFile)) return 'missing';
    let text: string;
    try {
        text = await plugin.app.vault.read(file);
    } catch {
        return 'missing';
    }
    const policy = sweepPolicy(plugin);
    const revision = await policyRevisionOf(policy);
    const snap = await buildSnapshot(file.path, text, revision);
    if (!guardSnapshot(snap, policy, revision).allowed) return 'excluded';
    return snap.contentHash === sourceHash ? 'ok' : 'changed';
}

export async function sendApproved(plugin: AIOrganiserPlugin, signal?: AbortSignal): Promise<Result<ExportSummary>> {
    const s = plugin.settings;
    if (!isFeatureEnabled(s, 'google-tasks-export')) return err('tasks-not-ready');
    if (s.tasksListId === '') return err('tasks-no-list');
    const url = validateScriptUrl(s.tasksScriptUrl);
    if (!url.ok) return err(url.error);
    let secret: string | null = null;
    try {
        secret = await plugin.secretStorageService.getSecret(PLUGIN_SECRET_IDS.GOOGLE_TASKS);
    } catch {
        secret = null;
    }
    if (!secret) return err('no-secret');

    const repaired = await repairApprovals(plugin);
    if (repaired.error) return err(repaired.error);
    const open = pendingApprovals(s.sweepApprovals, true);
    const total: ExportSummary = { exported: 0, failed: 0, blocked: [], pending: 0 };
    for (const rec of open) {
        const out = await exportApproved(rec, {
            url: url.value,
            secret,
            signal,
            listId: s.tasksListId,
            checkSource: (task) => checkSource(plugin, task.sourcePath, task.sourceHash),
            persist: (r) => runExclusive(() => saveRecord(plugin, mergeExportStates(plugin.settings.sweepApprovals.find((x) => x.runId === r.runId), r))),
        });
        total.exported += out.summary.exported;
        total.failed += out.summary.failed;
        total.pending += out.summary.pending;
        total.blocked.push(...out.summary.blocked);
        if (out.summary.error) { total.error = out.summary.error; break; }
    }
    const finalSave = await runExclusive(async () => {
        const beforePrune = s.sweepApprovals;
        s.sweepApprovals = pruneApprovals(s.sweepApprovals);
        const saved = await save(plugin);
        if (!saved.ok) s.sweepApprovals = beforePrune;
        return saved;
    });
    if (!finalSave.ok) return err(finalSave.error);
    return ok(total);
}
