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
import { sanitizeInline } from './sweepReport';

export interface TasksPing {
    scriptVersion: number;
    approvedListId: string | null;
    listHash: string;
}

export type TasksScriptState = 'setup' | 'operational' | 'outdated' | 'list-mismatch';

interface Endpoint {
    url: string;
    secret: string;
    transport?: ScriptTransport;
    signal?: AbortSignal;
}

export async function pingTasksScript(endpoint: Endpoint): Promise<Result<TasksPing>> {
    const res = await callScript<{ scriptVersion?: unknown; approvedListId?: unknown; listHash?: unknown }>({ ...endpoint, body: { op: 'ping' }, maxAttempts: 2 });
    if (!res.ok) return err(res.error);
    const v = res.value;
    if (typeof v.scriptVersion !== 'number' || typeof v.listHash !== 'string') return err('script-bad-response');
    const approved = typeof v.approvedListId === 'string' && v.approvedListId !== '' ? v.approvedListId : null;
    return ok({ scriptVersion: v.scriptVersion, approvedListId: approved, listHash: v.listHash });
}

/**
 * What a ping says about the deployed script, compared with the list the user chose. The status
 * stays "needs attention" until the operational script (approved list = the chosen list) is live.
 */
export async function classifyTasksScript(ping: TasksPing, chosenListId: string | null): Promise<TasksScriptState> {
    if (ping.scriptVersion < TASKS_SCRIPT_MIN_SUPPORTED) return 'outdated';
    if (ping.listHash !== (await approvedListHashOf(ping.approvedListId))) return 'outdated';
    if (ping.approvedListId === null) return 'setup';
    return chosenListId !== null && ping.approvedListId === chosenListId ? 'operational' : 'list-mismatch';
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
        const l = raw as { id?: unknown; title?: unknown };
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
}

export interface ExportSummary {
    exported: number;
    failed: number;
    blocked: Array<{ id: string; reason: SourceCheck }>;
    /** Items the script asked to retry that were still unfinished after the last pass */
    pending: number;
    /** Set when a request failed outright (nothing about the remaining items is known) */
    error?: string;
}

function toWire(task: ApprovedTask): { exportId: string; title: string; notes: string } {
    const title = sanitizeInline(task.context ? `${task.text} ${task.context}` : task.text, 300);
    return { exportId: task.id, title, notes: `From note: ${sanitizeInline(task.sourcePath, 200)}` };
}

function decodeResults(value: unknown): ExportResult[] | null {
    const results = (value as { results?: unknown } | null)?.results;
    if (!Array.isArray(results)) return null;
    const out: ExportResult[] = [];
    for (const r of results) {
        const x = r as { exportId?: unknown; status?: unknown };
        if (typeof x.exportId !== 'string') return null;
        if (x.status !== 'created' && x.status !== 'exists' && x.status !== 'error' && x.status !== 'retry' && x.status !== 'conflict') return null;
        out.push({ exportId: x.exportId, status: x.status });
    }
    return out;
}

export async function exportApproved(start: ApprovalRecord, deps: ExportDeps): Promise<{ record: ApprovalRecord; summary: ExportSummary }> {
    let record = start;
    const summary: ExportSummary = { exported: 0, failed: 0, blocked: [], pending: 0 };
    const blockedIds = new Set<string>();
    const passes = Math.max(1, deps.maxPasses ?? 3);

    for (let pass = 0; pass < passes; pass++) {
        const todo: ApprovedTask[] = [];
        for (const task of exportable(record)) {
            if (blockedIds.has(task.id)) continue;
            const check = await deps.checkSource(task);
            if (check !== 'ok') { blockedIds.add(task.id); summary.blocked.push({ id: task.id, reason: check }); continue; }
            todo.push(task);
        }
        if (todo.length === 0) break;
        let retried = 0;
        for (let i = 0; i < todo.length; i += MAX_TASKS_PER_REQUEST) {
            if (deps.signal?.aborted) { summary.error = 'cancelled'; return { record, summary: finalise(record, summary) }; }
            const batch = todo.slice(i, i + MAX_TASKS_PER_REQUEST);
            const res = await callScript<unknown>({ url: deps.url, secret: deps.secret, transport: deps.transport, signal: deps.signal, body: { op: 'upsert', listId: deps.listId, tasks: batch.map(toWire) } });
            if (!res.ok) { summary.error = res.error; return { record, summary: finalise(record, summary) }; }
            const results = decodeResults(res.value);
            if (!results) { summary.error = 'script-bad-response'; return { record, summary: finalise(record, summary) }; }
            record = applyExportResults(record, results);
            retried += results.filter((r) => r.status === 'retry').length;
            const persisted = await deps.persist(record);
            if (!persisted.ok) { summary.error = persisted.error; return { record, summary: finalise(record, summary) }; }
        }
        if (retried === 0) break;
    }
    return { record, summary: finalise(record, summary) };
}

function finalise(record: ApprovalRecord, summary: ExportSummary): ExportSummary {
    return {
        ...summary,
        exported: record.tasks.filter((t) => t.state === 'exported').length,
        failed: record.tasks.filter((t) => t.state === 'failed').length,
        pending: record.tasks.filter((t) => t.state === 'reported').length,
    };
}

export { TASKS_SCRIPT_VERSION };
