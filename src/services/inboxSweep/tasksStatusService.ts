/**
 * Read-only completion read-back for exported Google tasks. The plugin never edits, re-dates or completes a Google task; this
 * asks the user's own script whether a task it created is still open, completed or deleted.
 *
 * The script answers only for tasks it exported (it looks up its own receipt; a supplied task id is ignored). `remoteStatus` and
 * `checkedAt` change ONLY on a confirmed answer (`ok` or `not-found`); on any failure the previous observation is kept with its
 * old `checkedAt`, and an observation older than 7 days is treated as unknown. Batches of at most 100, one list per request.
 */
import { Result, ok, err, type BatchResult } from '../../core/result';
import { callScript, type ScriptTransport } from '../appsScriptClient';
import { MAX_STATUS_ITEMS } from '../googleScript/googleScriptBuilder';
import { logger } from '../../utils/logger';
import type { ApprovalRecord, ApprovedTask, RemoteStatus } from './sweepLedger';

/** An observation older than this is unknown again. */
export const STATUS_STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export type StatusOutcome = 'ok' | 'not-found' | 'error' | 'retry' | 'unknown-receipt';

export interface StatusItemResult {
    exportId: string;
    outcome: StatusOutcome;
}

export interface StatusDeps {
    url: string;
    secret: string;
    transport?: ScriptTransport;
    signal?: AbortSignal;
    /** The list a task without a frozen target was sent to */
    mainListId: string;
    now(): number;
    /** Save the record after every batch; a failure stops the refresh (what was read is not durably known) */
    persist(record: ApprovalRecord): Promise<Result<void>>;
}

/** What a task's completion is known to be right now: its last observation, or `unknown` when none or stale. */
export function effectiveRemoteStatus(task: Pick<ApprovedTask, 'remoteStatus' | 'checkedAt'>, now: number): RemoteStatus | 'unknown' {
    if (!task.remoteStatus || task.checkedAt === undefined || now - task.checkedAt > STATUS_STALE_AFTER_MS) return 'unknown';
    return task.remoteStatus;
}

/** Exported tasks the read-back can ask about, by list. */
export function statusTargets(record: ApprovalRecord, mainListId: string): Map<string, ApprovedTask[]> {
    const out = new Map<string, ApprovedTask[]>();
    for (const task of record.tasks) {
        if (task.state !== 'exported') continue;
        const listId = task.target?.listId ?? mainListId;
        if (listId === '') continue;
        out.set(listId, [...(out.get(listId) ?? []), task]);
    }
    return out;
}

const OUTCOMES: readonly StatusOutcome[] = ['ok', 'not-found', 'error', 'retry', 'unknown-receipt'];

interface Decoded { exportId: string; outcome: StatusOutcome; status?: 'needsAction' | 'completed' }

/** Every answer names a task of THIS batch, once, and every task of the batch is answered. Anything else cannot be trusted. */
function decodeStatus(value: unknown, batchIds: ReadonlySet<string>): Decoded[] | null {
    const results = (value as { results?: unknown } | null)?.results;
    if (!Array.isArray(results)) return null;
    const out: Decoded[] = [];
    const seen = new Set<string>();
    for (const r of results) {
        if (!r || typeof r !== 'object') return null;
        const x = r as { exportId?: unknown; outcome?: unknown; status?: unknown };
        if (typeof x.exportId !== 'string' || !batchIds.has(x.exportId) || seen.has(x.exportId)) return null;
        if (!OUTCOMES.includes(x.outcome as StatusOutcome)) return null;
        seen.add(x.exportId);
        const status = x.status === 'completed' || x.status === 'needsAction' ? x.status : undefined;
        // An `ok` answer must say which state it saw.
        if (x.outcome === 'ok' && !status) return null;
        out.push({ exportId: x.exportId, outcome: x.outcome as StatusOutcome, status });
    }
    return seen.size === batchIds.size ? out : null;
}

export interface RefreshOutcome {
    record: ApprovalRecord;
    batch: BatchResult<StatusItemResult>;
}

/**
 * Ask the script about every exported task. A request-level failure (auth, not approved, service off, busy, a bad answer) is
 * `err` with the code of what was already read kept in the record. Per-task failures are partial results, never an exception.
 */
export async function refreshTaskStatus(start: ApprovalRecord, deps: StatusDeps): Promise<Result<RefreshOutcome>> {
    let record = start;
    const items: StatusItemResult[] = [];
    const errors: BatchResult<StatusItemResult>['errors'] = [];
    try {
        for (const [listId, tasks] of statusTargets(record, deps.mainListId)) {
            for (let i = 0; i < tasks.length; i += MAX_STATUS_ITEMS) {
                if (deps.signal?.aborted) return err('cancelled');
                const batch = tasks.slice(i, i + MAX_STATUS_ITEMS);
                const res = await callScript<unknown>({ url: deps.url, secret: deps.secret, transport: deps.transport, signal: deps.signal, body: { op: 'status', listId, items: batch.map((t) => ({ exportId: t.id })) } });
                if (!res.ok) return err(res.error);
                const decoded = decodeStatus(res.value, new Set(batch.map((t) => t.id)));
                if (!decoded) return err('script-bad-response');
                const at = deps.now();
                const byId = new Map(decoded.map((d) => [d.exportId, d]));
                record = {
                    ...record,
                    tasks: record.tasks.map((t) => {
                        const d = byId.get(t.id);
                        if (!d) return t;
                        if (d.outcome === 'ok' && d.status) return { ...t, remoteStatus: d.status, checkedAt: at };
                        if (d.outcome === 'not-found') return { ...t, remoteStatus: 'deleted' as const, checkedAt: at };
                        return t;
                    }),
                };
                for (const d of decoded) {
                    items.push({ exportId: d.exportId, outcome: d.outcome });
                    if (d.outcome !== 'ok' && d.outcome !== 'not-found') errors.push({ source: d.exportId, error: d.outcome });
                }
                const saved = await deps.persist(record);
                if (!saved.ok) return err(saved.error);
            }
        }
        return ok({ record, batch: { items, errors, warnings: [], isPartial: errors.length > 0 && errors.length < items.length } });
    } catch (e) {
        logger.warn('Sweep', 'Task status refresh failed', e);
        return err('script-network');
    }
}
