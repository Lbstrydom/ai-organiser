/**
 * Catch-up audio — shared types and constants.
 *
 * Neutral module with ZERO imports (same discipline as `newsletterMemoryTypes.ts`): the pure
 * coverage rules, the vault IO and the orchestration all import downward into it.
 *
 * The central modelling decision: coverage is an EXPLICIT union, not a number. An absent entry
 * (never covered), `whole` (the day is covered and no revision is known) and `revision(n)`
 * (covered up to ledger revision n, n >= 1) are different facts. A zero default would make a
 * never-covered memory-off day look covered, so zero is never a valid revision and is never
 * written.
 */

/** Sub-folder of the newsletter output root that holds episode notes and their audio. */
export const CATCHUP_FOLDER = 'Catch-up';

/** Frontmatter keys of an episode note. The note IS the coverage record. */
export const EPISODE_FM = {
    type: 'aio_type',
    typeValue: 'newsletter-catchup',
    id: 'catchup_id',
    from: 'catchup_from',
    to: 'catchup_to',
    coverage: 'catchup_coverage',
    audio: 'catchup_audio',
    fingerprint: 'catchup_fingerprint',
    minutes: 'catchup_minutes',
    sources: 'catchup_sources',
} as const;

/** Written in a coverage map when a day is covered but no revision is known. */
export const WHOLE_DAY = 'whole';

/** Episode length: aims for 15 minutes, up to the user's ceiling once this many days are pending. */
export const CATCHUP_BASE_CAP_MINS = 15;
export const CATCHUP_BIG_CAP_MINS = 20;
export const CATCHUP_BIG_THRESHOLD_DAYS = 4;

/** Hard bounds of the user-facing settings. */
export const CATCHUP_MIN_CEILING_MINS = 5;
export const CATCHUP_MAX_CEILING_MINS = 20;
export const CATCHUP_MIN_LOOKBACK_DAYS = 1;
export const CATCHUP_MAX_LOOKBACK_DAYS = 14;

/** Spoken-word budget, matching the daily podcast prompt's words-per-minute. */
export const WORDS_PER_MINUTE = 130;
/** Narration estimator rate (characters spoken per second), as used by the audio narration cost estimate. */
export const SPEAKING_CHARS_PER_SECOND = 14;
/** A script may exceed its word budget by this factor before it is shortened. */
export const SCRIPT_OVERRUN_FACTOR = 1.15;

export type Coverage =
    | { kind: 'whole' }
    | { kind: 'revision'; rev: number };

/** Bucket date (YYYY-MM-DD) -> coverage. A missing key means "never covered". */
export type CoverageMap = Record<string, Coverage>;

/** A parsed, validated episode note. */
export interface EpisodeMeta {
    id: string;
    from: string;
    to: string;
    coverage: CoverageMap;
    audio: string;
    fingerprint: string;
    minutes: number;
    sources: number;
    notePath: string;
}

/** What the selection layer knows about one bucket (one day) inside the window. */
export interface BucketInfo {
    date: string;
    /** A digest exists and carries a usable brief. */
    hasBrief: boolean;
    /** The bucket has fully closed (the next day's cutoff has passed). */
    closed: boolean;
    /** Current ledger revision, or null when unknown (memory off, or aged out of the ledger). */
    revision: number | null;
    /** The ledger could not itemise this bucket's stories. */
    parseFailed: boolean;
    /** Coverage inferred from legacy daily audio PROVENANCE, or null when none. */
    legacy: Coverage | null;
}

export type PendingKind = PendingEntry['kind'];

/**
 * One actionable day: something to narrate. Kind-discriminated so a delta CANNOT exist without
 * the revision threshold that defines it, and a full day cannot carry one.
 */
export type PendingEntry =
    | {
        date: string;
        kind: 'full';
        /** Coverage this entry will have once the episode is committed. */
        coverage: Coverage;
        sinceRevision?: undefined;
    }
    | {
        date: string;
        kind: 'delta';
        coverage: Coverage;
        /** Stories with `contentRevision` above this are new. */
        sinceRevision: number;
    };

/** A day that has new material we cannot itemise. Never generated, never advanced, never "caught up". */
export interface UnresolvedEntry {
    date: string;
    reason: 'unitemisable';
}

export interface PendingResult {
    entries: PendingEntry[];
    unresolved: UnresolvedEntry[];
    /** Window dates with no stored digest/brief. Reported neutrally — the cause is unknowable. */
    noStoredDates: string[];
    /** Window dates whose stored material is already covered. */
    coveredDates: string[];
    /** Window dates skipped because they are still open (automatic runs, or memory off). */
    openDates: string[];
}

export type PendingRunKind = 'manual' | 'auto';

/** What "caught up" may honestly say. */
export type CaughtUpState =
    | 'pending'            // something to narrate
    | 'unresolved-only'    // nothing to narrate, but updates could not be checked
    | 'gap'                // nothing pending, but a provable stretch of history is gone
    | 'caught-up';

export interface LengthPlan {
    capMinutes: number;
    wordBudget: number;
}

/** A pending day plus what the script needs to narrate it. */
export type CatchUpPlanEntry = PendingEntry & {
    /** Text handed to the script prompt: a whole brief (full) or itemised late additions (delta). */
    text: string;
    /** Newsletters behind this day, for the preview. */
    newsletters: number;
    /** Story titles for the episode note. */
    titles: string[];
};

export interface CatchUpPlan {
    entries: CatchUpPlanEntry[];
    unresolved: UnresolvedEntry[];
    noStoredDates: string[];
    windowDates: string[];
    length: LengthPlan;
    from: string;
    to: string;
    createdAt: number;
    /** Stable hash of the coverage this plan claims — compared at Generate to detect a changed world. */
    planHash: string;
}
