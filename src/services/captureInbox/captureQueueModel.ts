/**
 * What the queue modal and the status bar show, derived from the journal. Pure.
 */
import type { CaptureEntry, CaptureJournal, CaptureSource, CaptureStage, CaptureState } from './captureTypes';
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
}

/** Entries the user can still act on or is waiting for; finished work is not listed. */
const LISTED: ReadonlySet<CaptureState> = new Set([
    'awaiting_review', 'failed', 'accept_pending_write', 'accepted', 'waiting_for_stable', 'ready', 'processing', 'new',
]);

/** Awaiting review first, then problems, then what is still moving. */
const ORDER: Record<string, number> = { awaiting_review: 0, failed: 1, accept_pending_write: 2, accepted: 3, organised: 3, processing: 4, ready: 5, waiting_for_stable: 6, new: 7 };

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

export function buildQueue(journal: CaptureJournal, now: number, opts: { includeProcessed?: boolean } = {}): QueueRow[] {
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
            skippable: e.state === 'awaiting_review' || e.state === 'failed' || (e.state === 'waiting_for_stable' && !!e.needsConfirm),
        }))
        .sort((a, b) => Number(a.processed) - Number(b.processed) || (ORDER[a.state] ?? 9) - (ORDER[b.state] ?? 9) || a.ageMs - b.ageMs);
}

export interface QueueCounts {
    toReview: number;
    waiting: number;
    /** Processing is paused because too many captures wait for review */
    backpressure: boolean;
}

export function queueCounts(journal: CaptureJournal): QueueCounts {
    const entries = Object.values(journal.entries);
    return {
        toReview: entries.filter((e) => e.state === 'awaiting_review').length,
        waiting: entries.filter((e) => e.state === 'waiting_for_stable' || e.state === 'ready' || e.state === 'processing').length,
        backpressure: awaitingCount(journal) >= MAX_AWAITING_REVIEW,
    };
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
