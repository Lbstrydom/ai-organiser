/**
 * What the queue modal and the status bar show, derived from the journal. Pure.
 */
import type { CaptureEntry, CaptureJournal, CaptureSource, CaptureStage, CaptureState, SkipReason } from './captureTypes';
import { MAX_AWAITING_REVIEW } from './captureTypes';
import { awaitingCount } from './captureJournal';

export interface QueueRow {
    id: string;
    title: string;
    state: CaptureState;
    source?: CaptureSource;
    ageMs: number;
    failedStage?: CaptureStage;
    attempts: number;
    needsConfirm: boolean;
    /** The review window can be opened (to review, or to create the organised note after Accept) */
    reviewable: boolean;
    retriable: boolean;
    skippable: boolean;
    /** Marked processed: hidden unless asked for, so its Undo stays reachable */
    processed: boolean;
    /** For a capture that is still settling: about how many seconds are left (never negative) */
    settleSeconds?: number;
    /** The last failure, in one line, for a failed capture */
    errorText?: string;
    /** The note already had text, so its audio was not transcribed (the review can transcribe it anyway) */
    audioNotTranscribed: boolean;
    /** Settling because a file it refers to has not arrived (no countdown applies) */
    waitingForAttachment: boolean;
}

/** Entries the user can still act on or is waiting for; finished work is not listed. */
const LISTED: ReadonlySet<CaptureState> = new Set([
    'awaiting_review', 'failed', 'accept_pending_write', 'accepted', 'waiting_for_stable', 'ready', 'processing', 'new',
]);

/** Awaiting review first, then problems, then what is still moving. */
const ORDER: Record<string, number> = { awaiting_review: 0, failed: 1, accept_pending_write: 2, accepted: 3, organised: 3, processing: 4, waiting_for_stable: 5, ready: 6, new: 7 };

export function rowTitle(entry: CaptureEntry): string {
    const path = entry.companionPath ?? entry.id;
    const name = path.slice(path.lastIndexOf('/') + 1);
    return name.replace(/\.[^.]+$/, '') || name;
}

/** An organised note whose original still sits in the inbox: listed until the user marks it processed. */
const stillInInbox = (e: CaptureEntry): boolean => e.state === 'organised' && e.processedAt === undefined;

const isProcessed = (e: CaptureEntry): boolean => (e.state === 'accepted' || e.state === 'organised') && e.processedAt !== undefined;

/** Captures the user marked processed (their rows come back with `includeProcessed`, so the mark can be undone). */
export function processedCount(journal: CaptureJournal): number {
    return Object.values(journal.entries).filter(isProcessed).length;
}

/**
 * About how many seconds until a capture has stayed unchanged for the whole settling window: the window runs from the
 * newest change any of its files was last seen to make. Never negative.
 */
export function settleSeconds(entry: Pick<CaptureEntry, 'observed'>, now: number, stabilityMs: number): number {
    const seen = Object.values(entry.observed ?? {});
    const since = seen.length > 0 ? Math.max(...seen.map((o) => o.at)) : now;
    return Math.max(0, Math.ceil((stabilityMs - (now - since)) / 1000));
}

export function buildQueue(journal: CaptureJournal, now: number, opts: { includeProcessed?: boolean; stabilityMs?: number } = {}): QueueRow[] {
    return Object.values(journal.entries)
        .filter((e) => (isProcessed(e) ? !!opts.includeProcessed : LISTED.has(e.state) || stillInInbox(e)))
        .map((e): QueueRow => ({
            id: e.id,
            title: rowTitle(e),
            state: e.state,
            source: e.source,
            ageMs: Math.max(0, now - e.createdAt),
            failedStage: e.failedStage,
            attempts: e.attempts,
            needsConfirm: !!e.needsConfirm,
            // A capture edited while it was being reviewed waits for "Process again", which lives in the review window.
            reviewable: e.state === 'awaiting_review' || e.state === 'accepted' || e.state === 'organised' || (e.state === 'waiting_for_stable' && !!e.needsConfirm),
            retriable: e.state === 'failed',
            processed: isProcessed(e),
            settleSeconds: e.state === 'waiting_for_stable' && !e.needsConfirm && e.waitReason !== 'attachment' && opts.stabilityMs !== undefined ? settleSeconds(e, now, opts.stabilityMs) : undefined,
            waitingForAttachment: e.state === 'waiting_for_stable' && !e.needsConfirm && e.waitReason === 'attachment',
            errorText: e.state === 'failed' ? e.errorText : undefined,
            audioNotTranscribed: e.state === 'awaiting_review' && e.source === 'note-text' && (e.attachments ?? []).some((a) => a.kind === 'audio'),
            skippable: e.state === 'awaiting_review' || e.state === 'failed' || (e.state === 'waiting_for_stable' && !!e.needsConfirm),
        }))
        .sort((a, b) => Number(a.processed) - Number(b.processed) || (ORDER[a.state] ?? 9) - (ORDER[b.state] ?? 9) || a.ageMs - b.ageMs);
}

/** Rows that are only waiting (settling or in line): they need nothing from the user, so a long run of them is summarised. */
export const isWaitingRow = (row: QueueRow): boolean => (row.state === 'new' || row.state === 'ready' || (row.state === 'waiting_for_stable' && !row.needsConfirm));

/** How many waiting rows are listed one by one before the rest are summarised. */
export const MAX_WAITING_SHOWN = 3;

/** Rows the user can act on come first and in full; waiting rows are capped so ten reviewable captures are never buried under twenty-seven waiting ones. */
export function splitQueue(rows: readonly QueueRow[]): { act: QueueRow[]; waiting: QueueRow[]; waitingHidden: number } {
    const act = rows.filter((r) => !isWaitingRow(r));
    const waitingAll = rows.filter(isWaitingRow);
    return { act, waiting: waitingAll.slice(0, MAX_WAITING_SHOWN), waitingHidden: Math.max(0, waitingAll.length - MAX_WAITING_SHOWN) };
}

export interface QueueCounts {
    toReview: number;
    /** Failed captures (they need the user: Retry or Skip) */
    failed: number;
    /** Still settling: the file may be syncing */
    settling: number;
    /** Settled and in line for the next "Process now" */
    ready: number;
    /** Settling, ready or working: anything on its way */
    waiting: number;
    /** Processing is paused because too many captures wait for review */
    backpressure: boolean;
}

export function queueCounts(journal: CaptureJournal): QueueCounts {
    const entries = Object.values(journal.entries);
    return {
        toReview: entries.filter((e) => e.state === 'awaiting_review' || (e.state === 'waiting_for_stable' && !!e.needsConfirm)).length,
        failed: entries.filter((e) => e.state === 'failed').length,
        settling: entries.filter((e) => e.state === 'waiting_for_stable' && !e.needsConfirm || e.state === 'new').length,
        ready: entries.filter((e) => e.state === 'ready').length,
        waiting: entries.filter((e) => e.state === 'new' || (e.state === 'waiting_for_stable' && !e.needsConfirm) || e.state === 'ready' || e.state === 'processing').length,
        backpressure: awaitingCount(journal) >= MAX_AWAITING_REVIEW,
    };
}

export interface SkippedRow {
    id: string;
    name: string;
    reason: SkipReason;
    /** The extension, for naming an unsupported format */
    extension: string;
    ageMs: number;
    /** A limit, a setting or a file can change: asking again can give another answer */
    retryable: boolean;
}

/** Skips that asking again can change. A kept-out capture stays kept out; "already" ones are settled; "nothing to read" is judged after a paid call, so asking again would only pay again. */
const RETRYABLE: ReadonlySet<SkipReason> = new Set<SkipReason>(['too-large', 'unsupported', 'invalid-media', 'digitisation-off', 'attachment-missing']);

export interface SkippedSummary {
    rows: SkippedRow[];
    /** Kept out by the user's rules or a protected folder: counted, not listed */
    excluded: number;
}

/** The captures that were set aside, newest first, so the user can see why. Kept-out ones are only counted. */
export function skippedSummary(journal: CaptureJournal, now: number): SkippedSummary {
    const rows: SkippedRow[] = [];
    let excluded = 0;
    for (const t of Object.values(journal.tombstones)) {
        if (t.state !== 'skipped' || !t.reason) continue;
        if (t.reason === 'excluded') { excluded++; continue; }
        const slash = t.id.lastIndexOf('/');
        const name = t.id.slice(slash + 1);
        const dot = name.lastIndexOf('.');
        rows.push({ id: t.id, name, reason: t.reason, extension: dot > 0 ? name.slice(dot + 1).toLowerCase() : '', ageMs: Math.max(0, now - t.at), retryable: RETRYABLE.has(t.reason) });
    }
    rows.sort((a, b) => a.ageMs - b.ageMs);
    return { rows, excluded };
}

/** "3 minutes", "2 hours", "yesterday"-free: a short age for a row. */
export function formatAge(ms: number): string {
    const minutes = Math.floor(ms / 60_000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    if (hours < 48) return `${hours} h`;
    return `${Math.floor(hours / 24)} d`;
}
