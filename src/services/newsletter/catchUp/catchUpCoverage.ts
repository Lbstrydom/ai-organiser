/**
 * Catch-up coverage — the pure rules.
 *
 * No I/O, no Obsidian: which days are pending, what an episode already covers, how long the
 * next episode may be, and what "caught up" may honestly say are all decided here from plain
 * values, so every edge case is a unit test rather than a vault experiment.
 */

import {
    CATCHUP_BASE_CAP_MINS,
    CATCHUP_BIG_CAP_MINS,
    CATCHUP_BIG_THRESHOLD_DAYS,
    CATCHUP_MAX_CEILING_MINS,
    CATCHUP_MAX_LOOKBACK_DAYS,
    CATCHUP_MIN_CEILING_MINS,
    CATCHUP_MIN_LOOKBACK_DAYS,
    EPISODE_FM,
    WHOLE_DAY,
    WORDS_PER_MINUTE,
    type BucketInfo,
    type CaughtUpState,
    type Coverage,
    type CoverageMap,
    type EpisodeMeta,
    type LengthPlan,
    type PendingEntry,
    type PendingResult,
    type PendingRunKind,
    type UnresolvedEntry,
} from './catchUpTypes';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Average characters per spoken English word, spaces included — for cost previews only. */
const CHARS_PER_WORD = 6;

// ── Dates ────────────────────────────────────────────────────────────────────

/** Shift a YYYY-MM-DD by whole days using LOCAL calendar arithmetic (matches the bucket keys). */
export function shiftDate(dateStr: string, days: number): string {
    const [y, m, d] = dateStr.split('-').map(Number);
    const dt = new Date(y, m - 1, d + days);
    const mm = String(dt.getMonth() + 1).padStart(2, '0');
    const dd = String(dt.getDate()).padStart(2, '0');
    return `${dt.getFullYear()}-${mm}-${dd}`;
}

export function isDateStr(value: unknown): value is string {
    return typeof value === 'string' && DATE_RE.test(value);
}

/**
 * The effective lookback as a COUNT of calendar dates, today included: N = 1 is today only,
 * N = 7 is today and the six days before it. Clamped to the supported range, and to the
 * retention period when one is set (older digests are gone, so they cannot be covered).
 */
export function effectiveLookbackDays(setting: unknown, retentionDays: unknown): number {
    const n = Number(setting);
    let days = Number.isFinite(n) ? Math.floor(n) : 7;
    days = Math.min(CATCHUP_MAX_LOOKBACK_DAYS, Math.max(CATCHUP_MIN_LOOKBACK_DAYS, days));
    const retention = Number(retentionDays);
    if (Number.isFinite(retention) && retention > 0) days = Math.min(days, Math.max(CATCHUP_MIN_LOOKBACK_DAYS, Math.floor(retention)));
    return days;
}

/** The window's calendar dates, ascending, ending at `today`. */
export function windowDates(today: string, lookbackDays: number): string[] {
    const out: string[] = [];
    for (let i = lookbackDays - 1; i >= 0; i--) out.push(shiftDate(today, -i));
    return out;
}

// ── Coverage values ──────────────────────────────────────────────────────────

/**
 * Order-independent merge. `absent` (undefined) is the identity; `whole` absorbs every other
 * value; two revisions keep the higher one. The result never depends on episode order.
 */
export function mergeCoverage(a: Coverage | undefined, b: Coverage | undefined): Coverage | undefined {
    if (!a) return b;
    if (!b) return a;
    if (a.kind === 'whole' || b.kind === 'whole') return { kind: 'whole' };
    return { kind: 'revision', rev: Math.max(a.rev, b.rev) };
}

export function mergeCoverageMaps(...maps: CoverageMap[]): CoverageMap {
    const out: CoverageMap = {};
    for (const map of maps) {
        for (const [date, cov] of Object.entries(map)) {
            const merged = mergeCoverage(out[date], cov);
            if (merged) out[date] = merged;
        }
    }
    return out;
}

/** Serialise a coverage value for frontmatter: a positive integer, or the string "whole". */
export function coverageToFrontmatter(cov: Coverage): number | string {
    return cov.kind === 'whole' ? WHOLE_DAY : cov.rev;
}

/** Parse one frontmatter coverage value. Zero, negatives, fractions and garbage are rejected. */
export function parseCoverageValue(raw: unknown): Coverage | null {
    if (raw === WHOLE_DAY) return { kind: 'whole' };
    const n = typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : raw;
    if (typeof n === 'number' && Number.isInteger(n) && n >= 1) return { kind: 'revision', rev: n };
    return null;
}

/** Parse a frontmatter coverage map, dropping every entry that is not a real date with a valid value. */
export function parseCoverageMap(raw: unknown): CoverageMap {
    const out: CoverageMap = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    for (const [date, value] of Object.entries(raw as Record<string, unknown>)) {
        if (!isDateStr(date)) continue;
        const cov = parseCoverageValue(value);
        if (cov) out[date] = cov;
    }
    return out;
}

/**
 * Does a legacy daily audio count as coverage? Only when there is EVIDENCE it was heard, and only
 * as far as that evidence reaches. `consumedRev` is the reader's consumption watermark for the day
 * (null when there is none). A daily audio that merely EXISTS proves nothing: a Daily install that
 * switches mode would otherwise see every earlier day silently "covered" and offered no catch-up.
 *
 *  - story memory off, or no watermark  -> null (the day is offered)
 *  - narrated revision r is known       -> revision(min(r, watermark)): stories the audio narrated
 *                                          but the watermark does not reach stay a delta
 *  - provenance gone                    -> revision(watermark): never wider than what was heard
 */
export function legacyHeard(legacy: Coverage | null, consumedRev: number | null, memoryOn: boolean): Coverage | null {
    if (!legacy || !memoryOn) return null;
    if (consumedRev === null || !Number.isInteger(consumedRev) || consumedRev < 1) return null;
    return { kind: 'revision', rev: legacy.kind === 'revision' ? Math.min(legacy.rev, consumedRev) : consumedRev };
}

// ── Episodes ─────────────────────────────────────────────────────────────────

/** Episode note names are `Catch-up <from>[ to <to>] <id>.md`; the window is readable without opening the file. */
export function parseEpisodeName(name: string): { from: string; to: string; id: string } | null {
    const m = /^Catch-up (\d{4}-\d{2}-\d{2})(?: to (\d{4}-\d{2}-\d{2}))? (\S+)\.md$/.exec(name);
    if (!m) return null;
    return { from: m[1], to: m[2] ?? m[1], id: m[3] };
}

export function buildEpisodeName(from: string, to: string, id: string): string {
    return from === to ? `Catch-up ${from} ${id}.md` : `Catch-up ${from} to ${to} ${id}.md`;
}

/**
 * The ONE contract for an episode's audio reference: a bare file name `catchup-….mp3`, never a
 * path. The parser, the loader and the listen resolver all rely on it, so a note that points at
 * `../Secret/x.mp3` or at a non-audio name covers nothing instead of reaching outside the folder.
 */
export function isEpisodeAudioName(value: unknown): value is string {
    return typeof value === 'string' && /^catchup-[A-Za-z0-9._-]+\.mp3$/.test(value) && !value.includes('..');
}

function asString(v: unknown): string | null {
    return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

/** The removal marker as a date string, tolerating the Date js-yaml makes of an unquoted timestamp. */
function removedMarker(raw: unknown): { audioRemoved?: string } {
    const value = raw instanceof Date && !Number.isNaN(raw.getTime()) ? raw.toISOString().slice(0, 10) : raw;
    return isDateStr(value) ? { audioRemoved: value } : {};
}

/** The newest day an episode covers: its `to`, or a later coverage key. */
export function newestCoveredDate(meta: Pick<EpisodeMeta, 'to' | 'coverage'>): string {
    return Object.keys(meta.coverage).reduce((newest, d) => (d > newest ? d : newest), meta.to);
}

/** Validate an episode note's frontmatter. Anything malformed covers nothing. */
export function parseEpisodeFrontmatter(fm: Record<string, unknown> | null | undefined, notePath: string): EpisodeMeta | null {
    if (!fm || fm[EPISODE_FM.type] !== EPISODE_FM.typeValue) return null;
    const id = asString(fm[EPISODE_FM.id]);
    const audioRaw = asString(fm[EPISODE_FM.audio]);
    const audio = isEpisodeAudioName(audioRaw) ? audioRaw : null;
    const from = fm[EPISODE_FM.from];
    const to = fm[EPISODE_FM.to];
    if (!id || !audio || !isDateStr(from) || !isDateStr(to)) return null;
    const coverage = parseCoverageMap(fm[EPISODE_FM.coverage]);
    if (Object.keys(coverage).length === 0) return null;
    const minutes = Number(fm[EPISODE_FM.minutes]);
    const sources = Number(fm[EPISODE_FM.sources]);
    return {
        id, from, to, coverage, audio,
        ...removedMarker(fm[EPISODE_FM.audioRemoved]),
        fingerprint: asString(fm[EPISODE_FM.fingerprint]) ?? '',
        minutes: Number.isFinite(minutes) ? minutes : 0,
        sources: Number.isFinite(sources) ? sources : 0,
        notePath,
    };
}

/** Coverage from the episodes that still exist and still have their audio. Order-independent. */
export function deriveCoverage(episodes: readonly EpisodeMeta[]): CoverageMap {
    return mergeCoverageMaps(...episodes.map((e) => e.coverage));
}

/**
 * Episodes the reader has not acknowledged and that fall inside the window.
 *
 * Keys on the DURABLE ack map, not the 7-day consumption watermark: the watermark decides
 * whether the prompt may omit a story, it is not the authority on whether an episode was
 * heard, and it expires (and does not exist at all with story memory off).
 */
export function unheardEpisodes(
    episodes: readonly EpisodeMeta[],
    acks: Readonly<Record<string, unknown>>,
    windowStart: string,
): EpisodeMeta[] {
    // An episode whose audio was removed has nothing left to listen to, so it can never be unheard.
    return episodes.filter((e) => e.to >= windowStart && !e.audioRemoved && !(e.id in acks));
}

// ── Length ───────────────────────────────────────────────────────────────────

/**
 * The episode length cap. Aims for 15 minutes; once 4 or more days are pending the cap rises
 * to 20. The user's ceiling always wins when lower. Never linear in the number of days: more
 * days means more compression and selection, not more airtime.
 */
export function effectiveCapMinutes(pendingDays: number, ceiling: unknown): number {
    const c = Number(ceiling);
    const userCeiling = Number.isFinite(c)
        ? Math.min(CATCHUP_MAX_CEILING_MINS, Math.max(CATCHUP_MIN_CEILING_MINS, Math.floor(c)))
        : CATCHUP_MAX_CEILING_MINS;
    const tier = pendingDays >= CATCHUP_BIG_THRESHOLD_DAYS ? CATCHUP_BIG_CAP_MINS : CATCHUP_BASE_CAP_MINS;
    return Math.min(userCeiling, tier);
}

export function lengthPlan(pendingDays: number, ceiling: unknown): LengthPlan {
    const capMinutes = effectiveCapMinutes(pendingDays, ceiling);
    return { capMinutes, wordBudget: capMinutes * WORDS_PER_MINUTE };
}

/** Preview numbers only — the real cost is known once the script exists. */
export function estimateSpokenChars(capMinutes: number): number {
    return capMinutes * WORDS_PER_MINUTE * CHARS_PER_WORD;
}

// ── Pending ──────────────────────────────────────────────────────────────────

export interface ComputePendingInput {
    window: readonly string[];
    buckets: Readonly<Record<string, BucketInfo | undefined>>;
    /** Coverage derived from episode notes. */
    coverage: Readonly<CoverageMap>;
    memoryOn: boolean;
    kind: PendingRunKind;
}

/**
 * Decide, for every date in the window, whether there is something to narrate.
 *
 *  - no stored brief            -> reported neutrally ("no newsletters stored"), never guessed at
 *  - open bucket                -> skipped for automatic runs and whenever story memory is off
 *  - never covered              -> FULL
 *  - covered `whole`            -> covered; no delta is ever possible
 *  - covered at revision n      -> DELTA only when the CURRENT revision is known and higher.
 *                                  Unknown (memory off / aged out of the ledger) or lower
 *                                  (memory was purged and restarted) is treated as `whole`: a
 *                                  late addition may be missed, a story is never re-told.
 *
 * Legacy daily audio contributes coverage by provenance (`BucketInfo.legacy`), merged with the
 * episodes' coverage by the same order-independent rule.
 */
export function computePending(input: ComputePendingInput): PendingResult {
    const entries: PendingEntry[] = [];
    const unresolved: UnresolvedEntry[] = [];
    const noStoredDates: string[] = [];
    const coveredDates: string[] = [];
    const openDates: string[] = [];

    for (const date of input.window) {
        const bucket = input.buckets[date];
        if (!bucket || !bucket.hasBrief) { noStoredDates.push(date); continue; }

        if (!bucket.closed && (input.kind === 'auto' || !input.memoryOn)) { openDates.push(date); continue; }

        const written: Coverage = input.memoryOn && bucket.revision !== null && bucket.revision >= 1
            ? { kind: 'revision', rev: bucket.revision }
            : { kind: 'whole' };

        const cov = mergeCoverage(input.coverage[date], bucket.legacy ?? undefined);
        if (!cov) { entries.push({ date, kind: 'full', coverage: written }); continue; }
        if (cov.kind === 'whole') { coveredDates.push(date); continue; }

        const current = input.memoryOn ? bucket.revision : null;
        if (current === null || current <= cov.rev) { coveredDates.push(date); continue; }

        if (bucket.parseFailed) { unresolved.push({ date, reason: 'unitemisable' }); continue; }
        entries.push({ date, kind: 'delta', coverage: written, sinceRevision: cov.rev });
    }

    return { entries, unresolved, noStoredDates, coveredDates, openDates };
}

export interface CaughtUpInput {
    pending: PendingResult;
    /** `to` of the latest episode that still exists, or null when there is none. */
    latestEpisodeTo: string | null;
    /** Oldest window date that has a stored brief, or null. */
    oldestStoredDate: string | null;
}

/**
 * What the modal may honestly claim. "Caught up" requires BOTH the actionable and the
 * unresolved lists to be empty AND no provable gap. A gap is provable only from the episode
 * record: the latest episode ended more than one day before the oldest stored digest, so days
 * in between existed after the last audio and are gone.
 */
export function deriveCaughtUpState(input: CaughtUpInput): CaughtUpState {
    if (input.pending.entries.length > 0) return 'pending';
    if (input.pending.unresolved.length > 0) return 'unresolved-only';
    if (hasProvableGap(input.latestEpisodeTo, input.oldestStoredDate)) return 'gap';
    return 'caught-up';
}

export function hasProvableGap(latestEpisodeTo: string | null, oldestStoredDate: string | null): boolean {
    if (!latestEpisodeTo || !oldestStoredDate) return false;
    return shiftDate(latestEpisodeTo, 1) < oldestStoredDate;
}

/**
 * Pending days whose digest the retention sweep will remove within two days. A digest dated D
 * is pruned once D falls before `today - retentionDays`; it is "about to expire" when D is within
 * two days of that line. Retention 0 keeps everything, so nothing expires.
 */
export function expiringPending(entryDates: readonly string[], today: string, retentionDays: number): string[] {
    if (!(retentionDays > 0)) return [];
    const horizon = shiftDate(today, -(Math.floor(retentionDays) - 2));
    return entryDates.filter((d) => d < horizon);
}

/** FNV-1a: not a security hash, a cheap deterministic change detector (8 hex digits). */
export function fnv1a(text: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
}

/** A short, stable signature of the coverage a plan would write — compared at Generate time. */
export function coverageSignature(entries: readonly PendingEntry[]): string {
    const text = entries
        .map((e) => `${e.date}:${e.kind}:${e.coverage.kind === 'whole' ? 'w' : e.coverage.rev}:${e.sinceRevision ?? ''}`)
        .sort()
        .join('|');
    return fnv1a(text);
}
