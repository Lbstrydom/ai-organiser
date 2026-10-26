/**
 * The operation summary: one small record per long-running operation (a sweep export, an agenda write, a filing, a
 * hand-back...). Domain journals stay authoritative; a summary only lets the weekly review and the Process view see what is
 * unfinished, in one place. Pure: parsing, pruning, reconciling with a journal and the cross-device rules.
 */

export type OperationKind = 'sweep-export' | 'agenda-write' | 'filing' | 'reconcile' | 'handback' | 'project-create' | 'release';
export type OperationStatus = 'planned' | 'running' | 'needs-attention' | 'done' | 'rolled-back' | 'failed';

export const OPERATION_KINDS: readonly OperationKind[] = ['sweep-export', 'agenda-write', 'filing', 'reconcile', 'handback', 'project-create', 'release'];
export const OPERATION_STATUSES: readonly OperationStatus[] = ['planned', 'running', 'needs-attention', 'done', 'rolled-back', 'failed'];

export interface OperationSummary {
    opId: string;
    kind: OperationKind;
    projectId?: string;
    status: OperationStatus;
    createdAt: number;
    updatedAt: number;
    /** A random id per installation: who is working on it */
    device: string;
    /** Where the authoritative journal lives and the key of this operation in it */
    recovery: { journal: string; key: string };
    /** Resource keys the operation holds or touches (`project:<id>`, `path:<p>`...), for overlap checks */
    resources?: string[];
}

/** Finished entries older than this are pruned; unfinished ones never are. */
export const PRUNE_FINISHED_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
/** Another device's unfinished operation may be taken over only after this long without an update. */
export const TAKEOVER_AFTER_MS = 24 * 60 * 60 * 1000;
/** The Process view warns when another device's operation was seen this recently. */
export const OTHER_DEVICE_WARN_MS = 60 * 60 * 1000;

const FINISHED: ReadonlySet<OperationStatus> = new Set(['done', 'rolled-back']);
export const isFinished = (s: OperationSummary): boolean => FINISHED.has(s.status);

const OP_ID = /^[A-Za-z0-9_-]{6,64}$/;
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

/** Decode a stored summary. Anything malformed is null (never trusted, never repaired by guessing). */
export function parseSummary(raw: unknown): OperationSummary | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    const createdAt = num(r.createdAt);
    const updatedAt = num(r.updatedAt);
    const rec = r.recovery && typeof r.recovery === 'object' ? (r.recovery as Record<string, unknown>) : null;
    if (typeof r.opId !== 'string' || !OP_ID.test(r.opId)) return null;
    if (!OPERATION_KINDS.includes(r.kind as OperationKind) || !OPERATION_STATUSES.includes(r.status as OperationStatus)) return null;
    if (createdAt === null || updatedAt === null || typeof r.device !== 'string' || r.device === '') return null;
    if (!rec || typeof rec.journal !== 'string' || typeof rec.key !== 'string') return null;
    const resources = Array.isArray(r.resources) ? r.resources.filter((x): x is string => typeof x === 'string').slice(0, 32) : undefined;
    return {
        opId: r.opId,
        kind: r.kind as OperationKind,
        ...(typeof r.projectId === 'string' ? { projectId: r.projectId } : {}),
        status: r.status as OperationStatus,
        createdAt,
        updatedAt,
        device: r.device,
        recovery: { journal: rec.journal, key: rec.key },
        ...(resources && resources.length > 0 ? { resources } : {}),
    };
}

/** Drop finished entries older than the retention window. Unfinished entries are always kept. */
export function pruneSummaries(list: readonly OperationSummary[], now: number): OperationSummary[] {
    return list.filter((s) => !isFinished(s) || now - s.updatedAt <= PRUNE_FINISHED_AFTER_MS);
}

/** What a domain journal says about an operation right now. */
export type JournalProbe =
    | { state: 'found'; status: OperationStatus; updatedAt: number }
    | { state: 'missing' }
    | { state: 'unreadable' };

export type Reconciled =
    | { kind: 'ok'; summary: OperationSummary }
    /** The journal moved on past the summary (a crash between the two writes): the summary is repaired from the journal */
    | { kind: 'repaired'; summary: OperationSummary }
    /** A summary whose journal is gone: shown, never trusted */
    | { kind: 'orphaned'; summary: OperationSummary }
    /** A journal that cannot be read: surfaced in the weekly review, never trusted */
    | { kind: 'unreadable'; summary: OperationSummary };

/** The journal is authoritative: a step newer than the summary repairs it; the reverse never does. */
export function reconcileWithJournal(summary: OperationSummary, probe: JournalProbe): Reconciled {
    if (probe.state === 'missing') return { kind: 'orphaned', summary };
    if (probe.state === 'unreadable') return { kind: 'unreadable', summary };
    if (probe.updatedAt > summary.updatedAt && (probe.status !== summary.status)) {
        return { kind: 'repaired', summary: { ...summary, status: probe.status, updatedAt: probe.updatedAt } };
    }
    return { kind: 'ok', summary };
}

export type OperationView =
    | 'mine-live'
    /** Mine, unfinished, but not running in this session: recover it */
    | 'interrupted'
    | 'other-device'
    /** Another device's, unfinished for 24 h or more: eligible for an explicit take-over */
    | 'takeover-eligible'
    | 'finished';

export interface ViewContext {
    device: string;
    now: number;
    /** Operations running in this session right now */
    live: ReadonlySet<string>;
}

export function viewOf(s: OperationSummary, ctx: ViewContext): OperationView {
    if (isFinished(s)) return 'finished';
    if (s.device === ctx.device) return ctx.live.has(s.opId) ? 'mine-live' : 'interrupted';
    return ctx.now - s.updatedAt >= TAKEOVER_AFTER_MS ? 'takeover-eligible' : 'other-device';
}

/**
 * Another device's unfinished operation blocks an overlapping one here: same resource key. An operation without resource
 * keys overlaps nothing (it cannot say what it touches), so it never blocks by accident.
 */
export function blockedBy(list: readonly OperationSummary[], wanted: readonly string[], ctx: ViewContext): OperationSummary[] {
    if (wanted.length === 0) return [];
    return list.filter((s) => {
        const view = viewOf(s, ctx);
        if (view !== 'other-device' && view !== 'takeover-eligible') return false;
        return (s.resources ?? []).some((r) => wanted.includes(r));
    });
}

/** True when another device's operation was updated within the last hour (the Process view warns). */
export function otherDeviceRecentlyActive(list: readonly OperationSummary[], ctx: ViewContext): boolean {
    return list.some((s) => s.device !== ctx.device && !isFinished(s) && ctx.now - s.updatedAt < OTHER_DEVICE_WARN_MS);
}

/**
 * Take over another device's operation. Allowed only after 24 hours without an update, and only when the user confirms the
 * plugin is not running there. The summary then records the new owner, and an original device that resumes later reads the
 * owner field and stops (as timely as sync is).
 */
export function takeOver(s: OperationSummary, ctx: ViewContext, confirmedNotRunningElsewhere: boolean): { ok: true; summary: OperationSummary } | { ok: false; error: 'operation-takeover-too-soon' | 'operation-takeover-unconfirmed' | 'operation-not-takeover' } {
    if (isFinished(s) || s.device === ctx.device) return { ok: false, error: 'operation-not-takeover' };
    if (ctx.now - s.updatedAt < TAKEOVER_AFTER_MS) return { ok: false, error: 'operation-takeover-too-soon' };
    if (!confirmedNotRunningElsewhere) return { ok: false, error: 'operation-takeover-unconfirmed' };
    return { ok: true, summary: { ...s, device: ctx.device, updatedAt: ctx.now } };
}

/** An original device that finds the owner changed must stop. */
export const ownsOperation = (s: OperationSummary | null, device: string): boolean => !!s && s.device === device;
