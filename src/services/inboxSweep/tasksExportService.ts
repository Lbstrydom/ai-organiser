/**
 * One-way export of approved sweep tasks to Google Tasks, over the shared Apps Script client.
 *
 * Only items the report already holds (`reported`) are sent, in batches of at most 25. Each item
 * carries its `aio-<uuid>` id, which the script uses to avoid duplicates, so a retry after any
 * failure is safe. The plugin never reads completion state back. Before sending, the guard is
 * re-run on each item's CURRENT source note, because the note may have moved or changed since the
 * sweep; a source that is now excluded, missing or changed blocks that item.
 */
import { Result, ok, err } from '../../core/result';
import { callScript, type ScriptTransport } from '../appsScriptClient';
import { approvedListHashOf, MAX_TASKS_PER_REQUEST, TASKS_SCRIPT_MIN_SUPPORTED, TASKS_SCRIPT_VERSION } from './tasksScriptTemplate';
import { applyExportResults, exportable, type ApprovalRecord, type ApprovedTask, type ExportResult } from './sweepLedger';
import { safeContext, sanitizeInline } from './sweepReport';
import { logger } from '../../utils/logger';
import { decideExport, isValidDue, listById, type ExportContext, type HoldReason, type TasksListConfig } from './tasksRouting';

export interface TasksPing {
    scriptVersion: number;
    approvedListId: string | null;
    listHash: string;
    /** v2 only: every list the script approves, and what it can do */
    approvedListIds?: string[];
    capabilities?: string[];
}

export type TasksScriptState = 'setup' | 'operational' | 'outdated' | 'list-mismatch' | 'lists-outdated';

interface Endpoint {
    url: string;
    secret: string;
    transport?: ScriptTransport;
    signal?: AbortSignal;
}

export async function pingTasksScript(endpoint: Endpoint): Promise<Result<TasksPing>> {
    const res = await callScript<{ scriptVersion?: unknown; approvedListId?: unknown; listHash?: unknown; approvedListIds?: unknown; capabilities?: unknown }>({ ...endpoint, body: { op: 'ping' }, maxAttempts: 2 });
    if (!res.ok) return err(res.error);
    const v = res.value;
    if (typeof v.scriptVersion !== 'number' || typeof v.listHash !== 'string') return err('script-bad-response');
    const approved = typeof v.approvedListId === 'string' && v.approvedListId !== '' ? v.approvedListId : null;
    const strings = (x: unknown): string[] | undefined => (Array.isArray(x) && x.every((i) => typeof i === 'string') ? x : undefined);
    const approvedListIds = strings(v.approvedListIds);
    const capabilities = strings(v.capabilities);
    return ok({ scriptVersion: v.scriptVersion, approvedListId: approved, listHash: v.listHash, ...(approvedListIds ? { approvedListIds } : {}), ...(capabilities ? { capabilities } : {}) });
}

/**
 * What a ping says about the deployed script, compared with the list the user chose. The status
 * stays "needs attention" until the operational script (approved list = the chosen list) is live.
 */
export async function classifyTasksScript(ping: TasksPing, chosenListId: string | null, configuredListIds: readonly string[] = []): Promise<TasksScriptState> {
    if (ping.scriptVersion < TASKS_SCRIPT_MIN_SUPPORTED) return 'outdated';
    if (ping.listHash !== (await approvedListHashOf(ping.approvedListId))) return 'outdated';
    if (ping.approvedListId === null) return 'setup';
    if (chosenListId === null || ping.approvedListId !== chosenListId) return 'list-mismatch';
    // More than one list is configured: the deployed script must approve every one (a v1 script approves only the main list).
    const approved = new Set(ping.approvedListIds ?? [ping.approvedListId]);
    return configuredListIds.some((id) => !approved.has(id)) ? 'lists-outdated' : 'operational';
}

export interface TaskList {
    id: string;
    title: string;
}

export async function fetchTaskLists(endpoint: Endpoint): Promise<Result<TaskList[]>> {
    const res = await callScript<{ lists?: unknown }>({ ...endpoint, body: { op: 'lists' }, maxAttempts: 2 });
    if (!res.ok) return err(res.error);
    if (!Array.isArray(res.value.lists)) return err('script-bad-response');
    const lists: TaskList[] = [];
    for (const raw of res.value.lists) {
        const l = (raw && typeof raw === 'object' ? raw : {}) as { id?: unknown; title?: unknown };
        if (typeof l.id !== 'string' || l.id === '' || typeof l.title !== 'string') return err('script-bad-response');
        lists.push({ id: l.id, title: l.title });
    }
    return ok(lists);
}

export type SourceCheck = 'ok' | 'excluded' | 'changed' | 'missing';

export interface ExportDeps extends Endpoint {
    listId: string;
    /** Re-run the guard on the item's current source note */
    checkSource(task: ApprovedTask): Promise<SourceCheck>;
    /** Persist the record after every batch. A failure stops the export: what was sent is not durably known. */
    persist(record: ApprovalRecord): Promise<Result<void>>;
    maxPasses?: number;
    /**
     * Routing: absent = every task goes to `listId` exactly as before (the legacy path, byte-identical). Present: each task is
     * decided by `decideExport`, tasks are grouped by their target list, and a task whose list the script does not approve is
     * HELD (never sent to another list).
     */
    routing?: ExportContext;
    /** The optional note link: given a source path, the `obsidian://` line added to a task's notes (default off) */
    noteLink?: (sourcePath: string) => string | null;
}

export interface ExportSummary {
    exported: number;
    failed: number;
    blocked: Array<{ id: string; reason: SourceCheck }>;
    /** Items the script asked to retry that were still unfinished after the last pass */
    pending: number;
    /** Set when a request failed outright (nothing about the remaining items is known) */
    error?: string;
    /** Tasks that were not sent and why (a date is missing, the script lacks the list...): visible, never silently dropped */
    held?: Array<{ id: string; reason: HoldReason }>;
}

export interface Wire {
    exportId: string;
    title: string;
    notes: string;
    due?: string;
}

/**
 * The outbound body of one task. `due` is added only when the target list needs a date and the task carries a valid one, so a
 * task sent to a list with no date requirement is byte-identical to what it always was. A frozen `wire` is replayed unchanged.
 */
export function toWire(task: ApprovedTask, list?: TasksListConfig | null, noteLink?: string | null): Wire {
    if (task.wire) return { exportId: task.id, ...task.wire };
    // The context is judged against the set the task was approved under, as the report is.
    const context = safeContext(task.context, task.contexts);
    const title = sanitizeInline(context ? `${task.text} ${context}` : task.text, 300);
    const notes = `From note: ${sanitizeInline(task.sourcePath, 200)}${noteLink ? `\n${noteLink}` : ''}`;
    return { exportId: task.id, title, notes, ...(list?.needsDate && isValidDue(task.due) ? { due: task.due } : {}) };
}

/** Decode an upsert answer. Every acknowledgement names a task of THIS batch, once, and every task of the batch is acknowledged. */
function decodeResults(value: unknown, batchIds: ReadonlySet<string>): ExportResult[] | null {
    const results = (value as { results?: unknown } | null)?.results;
    if (!Array.isArray(results)) return null;
    const out: ExportResult[] = [];
    const seen = new Set<string>();
    for (const r of results) {
        if (!r || typeof r !== 'object') return null;
        const x = r as { exportId?: unknown; status?: unknown };
        if (typeof x.exportId !== 'string' || !batchIds.has(x.exportId) || seen.has(x.exportId)) return null;
        seen.add(x.exportId);
        if (x.status !== 'created' && x.status !== 'exists' && x.status !== 'error' && x.status !== 'retry' && x.status !== 'conflict' && x.status !== 'target-conflict') return null;
        out.push({ exportId: x.exportId, status: x.status });
    }
    // An answer that skips a submitted task cannot be trusted to describe the batch.
    return seen.size === batchIds.size ? out : null;
}

export async function exportApproved(start: ApprovalRecord, deps: ExportDeps): Promise<{ record: ApprovalRecord; summary: ExportSummary }> {
    let record = start;
    const summary: ExportSummary = { exported: 0, failed: 0, blocked: [], pending: 0 };
    const blockedIds = new Set<string>();
    const held = new Map<string, HoldReason>();
    const passes = Math.max(1, deps.maxPasses ?? 3);
    const withHeld = (s: ExportSummary): ExportSummary => (held.size > 0 ? { ...s, held: [...held].map(([id, reason]) => ({ id, reason })) } : s);

    for (let pass = 0; pass < passes; pass++) {
        const todo = exportable(record).filter((t) => !blockedIds.has(t.id));
        if (todo.length === 0) break;
        // Which list each task goes to. Without routing every task goes to the one list, as it always did.
        const targets = new Map<string, string>();
        for (const task of todo) {
            if (!deps.routing) { targets.set(task.id, deps.listId); continue; }
            const decision = decideExport(task, deps.routing);
            if (decision.kind === 'send') { targets.set(task.id, decision.listId); held.delete(task.id); }
            else if (decision.kind === 'hold') held.set(task.id, decision.reason);
        }
        const sendable = todo.filter((t) => targets.has(t.id));
        if (sendable.length === 0) break;
        // Routed tasks get their target and payload frozen and saved BEFORE the first request, so every retry, crash replay and
        // post-redeploy send meets the same list with the same bytes.
        if (deps.routing) {
            let changed = false;
            record = {
                ...record,
                tasks: record.tasks.map((t) => {
                    const listId = targets.get(t.id);
                    if (!listId || t.routingMode !== 'routed' || (t.target && t.wire)) return t;
                    changed = true;
                    const wire = withoutId(toWire(t, listById(deps.routing!, listId), deps.noteLink?.(t.sourcePath) ?? null));
                    return { ...t, target: t.target ?? { listId }, wire: t.wire ?? wire };
                }),
            };
            if (changed) {
                const persisted = await persistRecord(deps, record);
                if (!persisted.ok) { summary.error = persisted.error; return { record, summary: withHeld(finalise(record, summary)) }; }
            }
        }
        const byList = new Map<string, ApprovedTask[]>();
        for (const task of sendable) byList.set(targets.get(task.id)!, [...(byList.get(targets.get(task.id)!) ?? []), record.tasks.find((t) => t.id === task.id) ?? task]);
        let retried = 0;
        for (const [listId, group] of byList) {
            for (let i = 0; i < group.length; i += MAX_TASKS_PER_REQUEST) {
                if (deps.signal?.aborted) { summary.error = 'cancelled'; return { record, summary: withHeld(finalise(record, summary)) }; }
                // Each task is checked against its source immediately before ITS batch is sent, not once up front:
                // earlier batches take time, and a note may have changed or been excluded meanwhile.
                const batch: ApprovedTask[] = [];
                for (const task of group.slice(i, i + MAX_TASKS_PER_REQUEST)) {
                    let check: SourceCheck;
                    try {
                        check = await deps.checkSource(task);
                    } catch (e) {
                        logger.warn('Sweep', 'Could not check a task against its note', e);
                        summary.error = 'unknown';
                        return { record, summary: withHeld(finalise(record, summary)) };
                    }
                    if (check === 'ok') batch.push(task);
                    else { blockedIds.add(task.id); summary.blocked.push({ id: task.id, reason: check }); }
                }
                if (batch.length === 0) continue;
                const list = deps.routing ? listById(deps.routing, listId) : null;
                const res = await callScript<unknown>({ url: deps.url, secret: deps.secret, transport: deps.transport, signal: deps.signal, body: { op: 'upsert', listId, tasks: batch.map((t) => toWire(t, list, deps.noteLink?.(t.sourcePath) ?? null)) } });
                if (!res.ok) { summary.error = res.error; return { record, summary: withHeld(finalise(record, summary)) }; }
                const results = decodeResults(res.value, new Set(batch.map((t) => t.id)));
                if (!results) { summary.error = 'script-bad-response'; return { record, summary: withHeld(finalise(record, summary)) }; }
                record = applyExportResults(record, results);
                retried += results.filter((r) => r.status === 'retry').length;
                const persisted = await persistRecord(deps, record);
                if (!persisted.ok) { summary.error = persisted.error; return { record, summary: withHeld(finalise(record, summary)) }; }
            }
        }
        if (retried === 0) break;
    }
    return { record, summary: withHeld(finalise(record, summary)) };
}

/** The payload without its export id (the id is the task's own). */
function withoutId(w: Wire): { title: string; notes: string; due?: string } {
    return { title: w.title, notes: w.notes, ...(w.due ? { due: w.due } : {}) };
}

async function persistRecord(deps: ExportDeps, record: ApprovalRecord): Promise<Result<void>> {
    try {
        return await deps.persist(record);
    } catch (e) {
        logger.warn('Sweep', 'Could not save the export result', e);
        return err('write-failed');
    }
}

function finalise(record: ApprovalRecord, summary: ExportSummary): ExportSummary {
    return {
        ...summary,
        exported: record.tasks.filter((t) => t.state === 'exported').length,
        failed: record.tasks.filter((t) => t.state === 'failed').length,
        pending: record.tasks.filter((t) => t.state === 'reported' || t.state === 'routed').length,
    };
}

export { TASKS_SCRIPT_VERSION };
