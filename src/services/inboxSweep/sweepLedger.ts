/**
 * Sweep ledger and the durable approval record (the outbox). Pure functions over plain data that
 * the plugin stores in its own data file, never in a note.
 *
 * The ledger says which notes were swept and at what content hash, so a note is offered again only
 * when it changed. The approval record is written at "Add to sweep report" BEFORE anything else
 * happens, because edited proposals cannot be regenerated:
 *   1. persist the record (tasks and source dispositions);
 *   2. commit the report section (skipped when there are zero approved tasks);
 *   3. mark items `reported`, and mark the sources whose disposition says so as swept;
 *   4. export only `reported` items.
 */
import { isInsideOrEqual, normalisePath } from '../../core/protectedPaths';
import type { SweepItemKind } from '../prompts/sweepPrompts';
import type { Destination } from './tasksRouting';

export interface LedgerEntry {
    sha256: string;
    sweptAt: string;
    runId: string;
}

export type SweepLedger = Record<string, LedgerEntry>;

/**
 * `routed` and `kept` exist only for tasks approved with a destination (see `routingMode`): an older plugin never exports or
 * promotes a task in either state, so a routed task can never be sent undated or to the wrong list by it.
 */
export type TaskState = 'approved' | 'reported' | 'exported' | 'failed' | 'routed' | 'kept';

/** The last read of a task's completion in Google (read-only; the plugin never changes a Google task) */
export type RemoteStatus = 'needsAction' | 'completed' | 'deleted';

export interface ApprovedTask {
    id: string;
    text: string;
    context: string;
    sourcePath: string;
    sourceHash: string;
    state: TaskState;
    /** Stable code when the last export attempt failed */
    error?: string;
    /** Item identity (see `itemKeys`); absent on tasks approved before item identity existed */
    keys?: string[];
    /** The context set in force when the item was approved; absent for the built-in set, so an unconfigured record is byte-identical */
    contexts?: string[];
    /** Present (as 'routed') only for a task approved with a destination, a date or a list other than the legacy main one */
    routingMode?: 'routed';
    kind?: SweepItemKind;
    destination?: Destination;
    /** A calendar date YYYY-MM-DD, set only when the chosen list needs one */
    due?: string;
    /** Whether the chosen list needed a date when this was approved (a later change of the list setting never strips or demands one) */
    needsDateAtApproval?: boolean;
    /** Frozen before the first request: retries and replays always meet the same list */
    target?: { listId: string };
    /** The exact outbound payload, frozen with the target and replayed unchanged */
    wire?: { title: string; notes: string; due?: string };
    /** The project this action belongs to (from the project service), when it has one */
    projectId?: string;
    remoteStatus?: RemoteStatus;
    /** Epoch ms of the last completion read that reached the task */
    checkedAt?: number;
}


export interface Disposition {
    sourcePath: string;
    sourceHash: string;
    markSwept: boolean;
}

export interface ApprovalRecord {
    runId: string;
    createdAt: string;
    reportPath: string;
    listId?: string;
    tasks: ApprovedTask[];
    dispositions: Disposition[];
    /** The report section is known to be in the note (or there was nothing to write) */
    reportDone: boolean;
    /** The dispositions were applied to the ledger */
    ledgerDone: boolean;
}

export function isSwept(ledger: SweepLedger, path: string, hash: string): boolean {
    return ledger[path]?.sha256 === hash;
}

/** The state a task is created in: routed tasks start where an older plugin never acts on them. */
export function initialTaskState(task: Pick<ApprovedTask, 'routingMode' | 'destination'>): TaskState {
    if (task.routingMode !== 'routed') return 'approved';
    return task.destination?.type === 'report-only' ? 'kept' : 'routed';
}

export function newApproval(input: {
    runId: string;
    now: string;
    reportPath: string;
    listId?: string;
    tasks: ReadonlyArray<Omit<ApprovedTask, 'state'>>;
    dispositions: readonly Disposition[];
}): ApprovalRecord {
    return {
        runId: input.runId,
        createdAt: input.now,
        reportPath: input.reportPath,
        listId: input.listId,
        tasks: input.tasks.map((t) => ({ ...t, state: initialTaskState(t) })),
        dispositions: [...input.dispositions],
        reportDone: input.tasks.length === 0,
        ledgerDone: false,
    };
}

/** Step 3a: the report section is in the note, so approved items become reported. */
export function markReported(record: ApprovalRecord): ApprovalRecord {
    return {
        ...record,
        reportDone: true,
        tasks: record.tasks.map((t) => (t.state === 'approved' ? { ...t, state: 'reported' as const } : t)),
    };
}

/** Step 3b: apply the dispositions to the ledger. Pure: returns the new ledger. */
export function applyDispositions(ledger: SweepLedger, record: ApprovalRecord, now: string): SweepLedger {
    const next: SweepLedger = { ...ledger };
    for (const d of record.dispositions) {
        if (d.markSwept) next[d.sourcePath] = { sha256: d.sourceHash, sweptAt: now, runId: record.runId };
    }
    return next;
}

/** Items that may be sent to Google Tasks: reported and not yet exported. */
export function exportable(record: ApprovalRecord): ApprovedTask[] {
    return record.tasks.filter((t) => t.state === 'reported' || t.state === 'routed' || (t.state === 'failed' && t.error !== 'conflict'));
}

export interface ExportResult {
    exportId: string;
    status: 'created' | 'exists' | 'error' | 'retry' | 'conflict' | 'target-conflict';
}

/** Fold the script's per-item answers into the record. `retry` leaves the item as it was. */
export function applyExportResults(record: ApprovalRecord, results: readonly ExportResult[]): ApprovalRecord {
    const by = new Map(results.map((r) => [r.exportId, r.status]));
    return {
        ...record,
        tasks: record.tasks.map((t) => {
            const status = by.get(t.id);
            if (!status || status === 'retry') return t;
            if (status === 'created' || status === 'exists') return { ...t, state: 'exported' as const, error: undefined };
            // A routed task stays routed through every retryable outcome (only a confirmed result moves it); `conflict` is terminal.
            if (t.routingMode === 'routed' && status === 'error') return { ...t, error: 'export-failed' };
            const terminal = status === 'conflict' || status === 'target-conflict';
            return { ...t, state: 'failed' as const, error: terminal ? 'conflict' : 'export-failed' };
        }),
    };
}

/** True when nothing is left to do for this record. */
export function isComplete(record: ApprovalRecord): boolean {
    return record.reportDone && record.ledgerDone && record.tasks.every((t) => t.state === 'exported' || t.state === 'kept' || (t.state === 'failed' && t.error === 'conflict'));
}

/** Records that still have work: an unfinished report or ledger step, or tasks waiting to be exported. */
export function pendingApprovals(records: readonly ApprovalRecord[], exportEnabled: boolean): ApprovalRecord[] {
    return records.filter((r) => !r.reportDone || !r.ledgerDone || (exportEnabled && exportable(r).length > 0));
}

/** Keep the most recent finished records only; unfinished ones are never dropped. */
export function pruneApprovals(records: readonly ApprovalRecord[], keepFinished = 20): ApprovalRecord[] {
    const open = records.filter((r) => !isComplete(r));
    const done = records.filter(isComplete).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, keepFinished);
    return [...open, ...done];
}

// ─── Renames ────────────────────────────────────────────────────────────────

export function remap(path: string, oldPath: string, newPath: string): string {
    const p = normalisePath(path);
    const o = normalisePath(oldPath);
    if (p === o) return normalisePath(newPath);
    if (isInsideOrEqual(p, o)) return normalisePath(newPath) + p.slice(o.length);
    return path;
}

/** A file or folder was renamed: move the ledger keys with it. */
export function renameLedger(ledger: SweepLedger, oldPath: string, newPath: string): { ledger: SweepLedger; changed: boolean } {
    const out: SweepLedger = {};
    let changed = false;
    for (const [key, entry] of Object.entries(ledger)) {
        const next = remap(key, oldPath, newPath);
        if (next !== key) changed = true;
        out[next] = entry;
    }
    return { ledger: out, changed };
}


/** The same remap for the source paths inside open approval records. */
export function renameApprovals(records: readonly ApprovalRecord[], oldPath: string, newPath: string): { records: ApprovalRecord[]; changed: boolean } {
    let changed = false;
    const out = records.map((r) => {
        const tasks = r.tasks.map((t) => {
            const next = remap(t.sourcePath, oldPath, newPath);
            if (next !== t.sourcePath) changed = true;
            return next === t.sourcePath ? t : { ...t, sourcePath: next };
        });
        const dispositions = r.dispositions.map((d) => {
            const next = remap(d.sourcePath, oldPath, newPath);
            if (next !== d.sourcePath) changed = true;
            return next === d.sourcePath ? d : { ...d, sourcePath: next };
        });
        const reportPath = remap(r.reportPath, oldPath, newPath);
        if (reportPath !== r.reportPath) changed = true;
        return { ...r, tasks, dispositions, reportPath };
    });
    return { records: out, changed };
}
