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
    markReported,
    newApproval,
    pendingApprovals,
    pruneApprovals,
    type ApprovalRecord,
    type Disposition,
} from './sweepLedger';
import { appendSection, reconcileReport, renderSection, validateReportPath, RUN_ID_PATTERN } from './sweepReport';
import { exportApproved, type ExportSummary, type SourceCheck } from './tasksExportService';

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
    tasks: ReadonlyArray<{ id: string; text: string; context: string; sourcePath: string; sourceHash: string }>;
    dispositions: readonly Disposition[];
}

export interface CommitOutcome {
    record: ApprovalRecord;
    /** Set when a step stopped; the record is saved and a later run can finish it */
    stoppedAt?: 'persist' | 'report' | 'ledger';
    error?: string;
}

/** Steps 1 to 3 for a freshly reviewed run. */
export async function commitReview(plugin: AIOrganiserPlugin, input: CommitInput): Promise<CommitOutcome> {
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
    replaceRecord(plugin, record);
    const saved = await save(plugin);
    if (!saved.ok) return { record, stoppedAt: 'persist', error: saved.error };
    return finishRecord(plugin, record);
}

/** Steps 2 and 3, repeatable. Used by the first commit and by recovery. */
export async function finishRecord(plugin: AIOrganiserPlugin, start: ApprovalRecord): Promise<CommitOutcome> {
    let record = start;
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
        record = markReported(record);
        replaceRecord(plugin, record);
        const saved = await save(plugin);
        if (!saved.ok) return { record, stoppedAt: 'report', error: saved.error };
    }
    if (!record.ledgerDone) {
        plugin.settings.sweepLedger = applyDispositions(plugin.settings.sweepLedger, record, new Date().toISOString());
        record = { ...record, ledgerDone: true };
        replaceRecord(plugin, record);
        const saved = await save(plugin);
        if (!saved.ok) return { record, stoppedAt: 'ledger', error: saved.error };
    }
    return { record };
}

/** After a crash or an offline moment: finish every unfinished record. Returns the first problem found. */
export async function repairApprovals(plugin: AIOrganiserPlugin): Promise<{ repaired: number; error?: string; path?: string }> {
    let repaired = 0;
    for (const record of [...plugin.settings.sweepApprovals]) {
        if (record.reportDone && record.ledgerDone) continue;
        const out = await finishRecord(plugin, record);
        if (out.error) return { repaired, error: out.error, path: record.reportPath };
        repaired++;
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
            persist: async (r) => { replaceRecord(plugin, r); await save(plugin); },
        });
        replaceRecord(plugin, out.record);
        total.exported += out.summary.exported;
        total.failed += out.summary.failed;
        total.pending += out.summary.pending;
        total.blocked.push(...out.summary.blocked);
        if (out.summary.error) { total.error = out.summary.error; break; }
    }
    s.sweepApprovals = pruneApprovals(s.sweepApprovals);
    await save(plugin);
    return ok(total);
}
