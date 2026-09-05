/**
 * Newsletter Story Memory — shared types.
 *
 * Neutral module with zero imports: the ledger store, the consumption store, the
 * pure recall join and the prompt builders all import downward into it, so none
 * of them has to depend on another.
 *
 * The central idea: "the reader has already been told this" is a JOIN of two
 * independent facts — what was PUBLISHED (the ledger) and what was CONSUMED (the
 * watermark). Keeping them apart is what makes catch-up expressible at all.
 */

/** Schema version for both persisted stores. An unknown version is discarded and
 *  rebuilt rather than migrated — the data is fully re-derivable and at most a
 *  window old, so a migration ladder would be dead weight. */
export const MEMORY_SCHEMA_VERSION = 1;

/** Rolling window, in days, for both stores. */
export const MEMORY_WINDOW_DAYS = 7;

/** Hard cap on stories retained per bucket. The merge is a union (an omitted
 *  story is retained), so without a cap a long live day could grow unbounded. */
export const MAX_STORIES_PER_BUCKET = 60;

/** Max characters kept for a story's one-line gist. */
export const MAX_GIST_CHARS = 200;

/** One story as recorded in a bucket's ledger entry. */
export interface LedgerStory {
    /** Normalised token-set key; the identity used for cross-day matching. */
    key: string;
    /** Display title, verbatim from the brief. */
    title: string;
    /** One-line summary, capped at MAX_GIST_CHARS. */
    gist: string;
    /**
     * The bucket revision at which this story FIRST APPEARED in this bucket.
     *
     * Answers "did this story exist when the reader listened?" — i.e. do they
     * have the background. Never re-stamped.
     */
    firstRevision: number;
    /**
     * The bucket revision at which this story's CONTENT last materially changed.
     *
     * Answers "is there something here the reader has not heard?". Re-stamped by
     * `mergeBucketRevision` whenever the gist changes, so a new development on an
     * already-heard story is born unconsumed and can actually be surfaced.
     *
     * BOTH fields are needed. With only `contentRevision`, a story that existed
     * at revision 1 (heard) and changed at revision 2 would look brand-new,
     * because the revision-1 entry is overwritten by the merge — so the reader
     * would get the whole story re-explained instead of just the update.
     */
    contentRevision: number;
}

/** One day's ledger entry. */
export interface LedgerBucket {
    /** Monotonically increasing; bumped on each successful brief synthesis. */
    revision: number;
    updatedAt: number;
    stories: LedgerStory[];
    /**
     * Audio basename -> the ledger revision that recording was rendered FROM.
     *
     * Audio generation is a long async pipeline, so the ledger can advance while
     * a recording renders. Playing a stale recording must consume only the
     * revision it actually contains, which is why the mapping is stamped with a
     * revision captured BEFORE the pipeline starts rather than read at write time.
     */
    audio: Record<string, number>;
    /**
     * Set when the brief text could not be parsed into stories. The bucket's
     * stories are preserved (no data loss), but recall EXCLUDES the bucket until
     * a successful parse clears this — otherwise a format drift would keep
     * feeding a stale story list into the prompt for a whole window.
     */
    parseFailedAt?: number;
}

export interface StoryLedger {
    version: number;
    buckets: Record<string, LedgerBucket>;
}

/** How a consumption record came to exist. */
export type ConsumptionSignal = 'audio' | 'manual';

/**
 * One bucket's consumption record.
 *
 * `revision` is a high-water mark: a story counts as heard when its
 * `contentRevision` is at or below it. First/last are tracked separately so an
 * advance never erases when the reader first engaged with the day.
 */
export interface ConsumptionRecord {
    firstAt: number;
    lastAt: number;
    firstVia: ConsumptionSignal;
    lastVia: ConsumptionSignal;
    revision: number;
}

export interface ConsumptionState {
    version: number;
    consumed: Record<string, ConsumptionRecord>;
}

/** A ledger story plus the context recall needs to describe it. */
export interface RecallStory extends LedgerStory {
    /** Bucket this occurrence came from. */
    bucketDate: string;
    /** True when it came from the bucket currently being regenerated, so the
     *  prompt can say "earlier today" rather than "on a previous day". */
    isCurrentBucket: boolean;
}

/**
 * The three-state classification.
 *
 * Two states are not enough. "The reader knows the background" and "there is an
 * update the reader has not seen" are independent facts, and collapsing them
 * makes a continuing story either wrongly suppressed or wrongly re-explained
 * from scratch.
 */
export interface RecallSelection {
    /** Background known, nothing new — omit unless today's sources add something. */
    heard: RecallStory[];
    /** Background known, unheard update — lead with the delta, do NOT restate it. */
    continuing: RecallStory[];
    /** Never heard any version — give the catch-up, do not suppress. */
    unheard: RecallStory[];
}

/** A story as parsed out of a generated brief, before it enters the ledger. */
export interface ParsedStory {
    key: string;
    title: string;
    gist: string;
}

/**
 * Parsing a brief has three outcomes, and conflating the last two destroys data.
 *
 * `parsed` with an empty list means the brief was genuinely empty. Substantial
 * text that yields no bullets is `unrecognised`: the prompt asks for a bullet
 * list, so prose or a numbered list is a format deviation, not a story-free day.
 * Treating it as an empty parse would replace the bucket with nothing.
 */
export type ParseBriefResult =
    | { kind: 'parsed'; stories: ParsedStory[] }
    | { kind: 'unrecognised' };

/**
 * The result of a catch-up request, as a discriminated union.
 *
 * Deliberately NOT `Result<CatchUpResult>` with an error string sentinel:
 * "story memory is off" and "nothing to do" are ordinary, expected outcomes,
 * not failures, and encoding them as error strings means a genuine error whose
 * message happened to match would be silently reclassified. The union makes
 * every state explicit and lets one formatter cover both call sites.
 */
export type CaughtUpOutcome =
    | { kind: 'ok'; buckets: number; stories: number; through: string }
    | { kind: 'noop' }
    | { kind: 'disabled' }
    | { kind: 'error'; error: string };

export function emptyLedger(): StoryLedger {
    return { version: MEMORY_SCHEMA_VERSION, buckets: {} };
}

export function emptyConsumption(): ConsumptionState {
    return { version: MEMORY_SCHEMA_VERSION, consumed: {} };
}
