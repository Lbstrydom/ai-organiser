/**
 * Newsletter Read Signal — "the reader read this brief".
 *
 * A second consumption channel, stored apart from the heard watermark
 * (`newsletterConsumption.ts`) so reading can never suppress audio the reader has not heard.
 *
 * Credit is by CONTENT IDENTITY, not by revision. A rendered note carries no revision, and a
 * revision number is meaningless against another device's ledger (two devices can both reach
 * "revision 3" with different stories). So a mark names the stories that were actually displayed,
 * the commit matches them to the ledger bucket, and only content-identical stories earn credit.
 * The store keeps `[hash(key), hash(gist)]` pairs: no timestamps, no titles, no text.
 *
 * Everything here is pure except `loadReadState`, `commitReadObservation` and `clearReadState`,
 * which go through the one plugin-data writer.
 */

import type { Plugin } from 'obsidian';
import { updatePluginData, loadPluginData } from '../../core/pluginDataStore';
import { err, ok, type Result } from '../../core/result';
import {
    MEMORY_SCHEMA_VERSION,
    MEMORY_WINDOW_DAYS,
    MAX_STORIES_PER_BUCKET,
    READ_SIGNALS,
    emptyReadState,
    type LedgerBucket,
    type LedgerStory,
    type ParsedStory,
    type ReadCommitOutcome,
    type ReadObservation,
    type ReadProjections,
    type ReadRecord,
    type ReadSignal,
    type ReadState,
} from './newsletterMemoryTypes';
import { keyTokens, findSimilarKey } from './newsletterStoryIdentity';
import { STORY_LEDGER_DATA_KEY, coerceLedger, gistFingerprint, parseBriefStories, shiftDateStr } from './newsletterStoryLedger';
import { CONSUMED_DATA_KEY, coerceConsumption, consumedRevision } from './newsletterConsumption';

export const READ_DATA_KEY = 'newsletter-read-briefs';

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The most credit pairs one bucket keeps. The writer and the decoder both apply it, so what is saved is what is read. */
export const MAX_CREDITED_PER_BUCKET = MAX_STORIES_PER_BUCKET;

/**
 * THE retention policy for a bucket's credit. A ledger story has exactly one current gist, so only the
 * newest pair per story key can ever match: an older text of the same story is dropped, which also stops
 * historical gist versions accumulating. When still over the cap the OLDEST pairs go. Pure and idempotent.
 */
export function compactCredited(pairs: ReadonlyArray<readonly [string, string]>): Array<[string, string]> {
    const latest = new Map<string, string>();
    for (const [k, g] of pairs) {
        latest.delete(k); // re-insert so Map order tracks recency
        latest.set(k, g);
    }
    const out: Array<[string, string]> = [...latest.entries()].map(([k, g]) => [k, g]);
    return out.length > MAX_CREDITED_PER_BUCKET ? out.slice(out.length - MAX_CREDITED_PER_BUCKET) : out;
}
const HASH_RE = /^[0-9a-f]{12}$/;

/** Markers of the managed block `mergeOrPrependBrief` writes into the digest note. */
export const BRIEF_START_MARKER = '<!-- DAILY_BRIEF_START -->';
export const BRIEF_END_MARKER = '<!-- DAILY_BRIEF_END -->';

// ── The two seams Louis may want to change cheaply ───────────────────────────

/**
 * SEAM 1 — scope of effect. Does a read of bucket `date` influence the brief for `currentBucketStr`?
 *
 * Prior days only: the digest note is also the day's archive and is rewritten on every fetch, so a
 * same-day read compressing the afternoon regeneration would leave the reader's own note without
 * the stories they read that morning. Flip `READ_CREDITS_CURRENT_BUCKET` to widen it.
 */
export const READ_CREDITS_CURRENT_BUCKET = false;

export function readAppliesToBucket(date: string, currentBucketStr: string): boolean {
    if (date < currentBucketStr) return true;
    return READ_CREDITS_CURRENT_BUCKET && date === currentBucketStr;
}

// ── Hashing ──────────────────────────────────────────────────────────────────

/** 48-bit string hash (cyrb53, truncated) as 12 hex chars. Not security: identity of a story text. */
export function hashPart(input: string): string {
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < input.length; i++) {
        const ch = input.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    const value = (h2 >>> 0) * 0x10000 + ((h1 >>> 0) & 0xffff);
    return value.toString(16).padStart(12, '0').slice(-12);
}

/** The credit pair for a ledger story. */
export function creditPair(story: Pick<LedgerStory, 'key' | 'gist'>): [string, string] {
    return [hashPart(story.key), hashPart(gistFingerprint(story.gist))];
}

// ── Store: coerce / prune / projections ─────────────────────────────────────

function isReadSignal(value: unknown): value is ReadSignal {
    return typeof value === 'string' && (READ_SIGNALS as readonly string[]).includes(value);
}

/** Coerce whatever is on disk into a valid state. Unknown version = discard (re-derivable). */
export function coerceReadState(raw: unknown): ReadState {
    if (!raw || typeof raw !== 'object') return emptyReadState();
    const obj = raw as Partial<ReadState>;
    if (obj.version !== MEMORY_SCHEMA_VERSION) return emptyReadState();
    if (!obj.read || typeof obj.read !== 'object') return emptyReadState();

    const read: Record<string, ReadRecord> = {};
    for (const [date, value] of Object.entries(obj.read)) {
        if (!DATE_KEY_RE.test(date) || !value || typeof value !== 'object') continue;
        const r = value as Partial<ReadRecord>;
        const credited: Array<[string, string]> = [];
        const seen = new Set<string>();
        if (Array.isArray(r.credited)) {
            for (const pair of r.credited) {
                if (!Array.isArray(pair) || pair.length !== 2) continue;
                const [k, g] = pair as unknown[];
                if (typeof k !== 'string' || typeof g !== 'string' || !HASH_RE.test(k) || !HASH_RE.test(g)) continue;
                const id = `${k}.${g}`;
                if (seen.has(id)) continue;
                seen.add(id);
                credited.push([k, g]);
            }
        }
        if (credited.length === 0) continue;
        read[date] = { via: isReadSignal(r.via) ? r.via : 'explicit', credited: compactCredited(credited) };
    }
    return { version: MEMORY_SCHEMA_VERSION, read };
}

/** Drop records outside the rolling window. Pure. */
export function pruneReadState(state: ReadState, todayStr: string, windowDays = MEMORY_WINDOW_DAYS): ReadState {
    const cutoff = shiftDateStr(todayStr, -windowDays);
    const read: Record<string, ReadRecord> = {};
    for (const [date, rec] of Object.entries(state.read)) {
        if (date >= cutoff) read[date] = rec;
    }
    return { version: MEMORY_SCHEMA_VERSION, read };
}

/** The two membership sets for ONE bucket date, or undefined when nothing was read. Per bucket, never a union. */
export function readProjectionsForBucket(read: ReadState | undefined, date: string): ReadProjections | undefined {
    const rec = read?.read[date];
    if (!rec || rec.credited.length === 0) return undefined;
    const keys = new Set<string>();
    const texts = new Set<string>();
    for (const [k, g] of rec.credited) {
        keys.add(k);
        texts.add(`${k}.${g}`);
    }
    return { keys, texts };
}

export async function loadReadState(plugin: Plugin): Promise<ReadState> {
    const data = await loadPluginData(plugin);
    return coerceReadState(data[READ_DATA_KEY]);
}

// ── Observation: what the reader saw ─────────────────────────────────────────

/** The managed Daily Brief block of a digest note, or null. */
export function extractBriefBlock(noteText: string): string | null {
    const start = noteText.indexOf(BRIEF_START_MARKER);
    if (start < 0) return null;
    const end = noteText.indexOf(BRIEF_END_MARKER, start);
    if (end < 0) return null;
    return noteText.slice(start + BRIEF_START_MARKER.length, end);
}

/** Hash of the displayed brief block: a different value means different text on screen. */
export function briefTextHash(block: string): string {
    return hashPart(block.trim());
}

/**
 * Build an observation from the note text a render was produced from. Returns null when there is
 * no brief block, the brief does not parse, or it holds no stories — nothing the reader could have read.
 */
export function buildObservation(date: string, noteText: string): { observation: ReadObservation; textHash: string } | null {
    const block = extractBriefBlock(noteText);
    if (block === null) return null;
    const parsed = parseBriefStories(block);
    if (parsed.kind !== 'parsed' || parsed.stories.length === 0) return null;
    return { observation: { date, displayed: parsed.stories }, textHash: briefTextHash(block) };
}

// ── Credit: displayed ↔ ledger, by content ───────────────────────────────────

export interface CreditedStory {
    story: LedgerStory;
    pair: [string, string];
}

/**
 * Which ledger stories did the reader actually see? A ledger story is credited only when a
 * displayed story matches it (key equality first, then the merge's similarity matcher, used ONLY
 * to locate) AND the displayed gist equals the ledger's gist. Content equality is the proof: an
 * older note against a newer ledger, a divergent ledger, a surviving title with a moved-on gist and
 * a story the model omitted all fail to match and earn nothing.
 */
export function buildReadCredit(bucket: LedgerBucket | undefined, displayed: readonly ParsedStory[]): CreditedStory[] {
    if (!bucket || displayed.length === 0) return [];
    const byKey = new Map<string, LedgerStory>();
    const tokensByKey = new Map<string, Set<string>>();
    for (const s of bucket.stories) {
        byKey.set(s.key, s);
        tokensByKey.set(s.key, keyTokens(s.key));
    }
    const credited = new Map<string, CreditedStory>();
    for (const d of displayed) {
        const matchKey = byKey.has(d.key) ? d.key : findSimilarKey(keyTokens(d.key), tokensByKey);
        const story = matchKey ? byKey.get(matchKey) : undefined;
        if (!story) continue;
        if (gistFingerprint(story.gist) !== gistFingerprint(d.gist)) continue;
        credited.set(story.key, { story, pair: creditPair(story) });
    }
    return [...credited.values()];
}

/**
 * How many credited pairs are genuinely new: not already in the read store, and not already heard.
 * Idempotent: marking the same brief twice reports 0 the second time.
 */
export function countNewlyRead(
    existing: ReadRecord | undefined,
    credited: readonly CreditedStory[],
    heardRevision: number | null,
): number {
    const have = new Set((existing?.credited ?? []).map(([k, g]) => `${k}.${g}`));
    let n = 0;
    for (const c of credited) {
        if (have.has(`${c.pair[0]}.${c.pair[1]}`)) continue;
        if (heardRevision !== null && c.story.contentRevision <= heardRevision) continue;
        n++;
    }
    return n;
}

// ── Commit ───────────────────────────────────────────────────────────────────

/**
 * Eligibility re-checked INSIDE the serialized write, so a mode switch, purge or unload that
 * happened after a session qualified cannot be undone by that session committing late.
 */
export interface ReadCommitGuard {
    /** Live check: story memory on and read mode not `off`. */
    eligible: () => boolean;
    /** The collection generation the observation was captured under. */
    generation: number;
    /** The current collection generation (bumped on mode change, purge, unload). */
    currentGeneration: () => number;
}

export async function commitReadObservation(
    plugin: Plugin,
    observation: ReadObservation,
    via: ReadSignal,
    guard: ReadCommitGuard,
    todayStr: string,
): Promise<Result<ReadCommitOutcome>> {
    try {
        if (!DATE_KEY_RE.test(observation.date)) return ok({ kind: 'refused', code: 'not-a-digest-note' });
        const outcome = await updatePluginData<ReadCommitOutcome>(plugin, (data) => {
            if (!guard.eligible()) return { changed: false, value: { kind: 'refused', code: 'mode-off' } };
            if (guard.generation !== guard.currentGeneration()) {
                return { changed: false, value: { kind: 'refused', code: 'invalidated' } };
            }
            const ledger = coerceLedger(data[STORY_LEDGER_DATA_KEY]);
            const credited = buildReadCredit(ledger.buckets[observation.date], observation.displayed);
            if (credited.length === 0) return { changed: false, value: { kind: 'refused', code: 'no-matching-stories' } };

            const state = pruneReadState(coerceReadState(data[READ_DATA_KEY]), todayStr);
            const existing = state.read[observation.date];
            const heard = consumedRevision(coerceConsumption(data[CONSUMED_DATA_KEY]), observation.date);
            const newly = countNewlyRead(existing, credited, heard);

            const before = existing?.credited ?? [];
            const merged = compactCredited([...before, ...credited.map((c) => c.pair)]);
            const same = merged.length === before.length && merged.every(([k, g], i) => before[i][0] === k && before[i][1] === g);
            if (same) return { changed: false, value: { kind: 'noop' } };

            state.read[observation.date] = { via: existing?.via ?? via, credited: merged };
            data[READ_DATA_KEY] = state;
            return { changed: true, value: { kind: 'credited', stories: credited.length, newly } };
        });
        return ok(outcome ?? { kind: 'noop' });
    } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
    }
}

// ── Collection generation ────────────────────────────────────────────────────
//
// In-memory only. Bumped on a mode change, a purge, story memory switching off and unload. A
// session captures it when it starts; the commit re-checks it inside the serialized write, so a
// session that qualified before the bump can neither commit after mode-off/unload nor undo a purge.

let collectionGeneration = 0;

export function currentReadGeneration(): number {
    return collectionGeneration;
}

export function bumpReadGeneration(): number {
    collectionGeneration += 1;
    return collectionGeneration;
}

/** Remove all read data. Used by "Forget what I've read" and when the read mode is switched off. */
export async function clearReadState(plugin: Plugin): Promise<Result<boolean>> {
    try {
        const changed = await updatePluginData<boolean>(plugin, (data) => {
            if (!(READ_DATA_KEY in data)) return { changed: false, value: false };
            delete data[READ_DATA_KEY];
            return { changed: true, value: true };
        });
        return ok(changed === true);
    } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
    }
}

// ── Where the brief sits in the note (for the Reading-view detector) ─────────

export interface BriefLocation {
    /** 0-based line of the start marker. */
    startLine: number;
    /** 0-based line of the end marker. */
    endLine: number;
    /** 0-based line of the last story bullet inside the block. */
    lastStoryLine: number;
}

const STORY_LINE_RE = /^\s*[-*]\s+\*\*.+?\*\*/;

/** Locate the Daily Brief block and its last story line in the whole-note text, or null. */
export function locateBrief(noteText: string): BriefLocation | null {
    const lines = noteText.split('\n');
    const startLine = lines.findIndex((l) => l.includes(BRIEF_START_MARKER));
    if (startLine < 0) return null;
    let endLine = -1;
    for (let i = startLine + 1; i < lines.length; i++) {
        if (lines[i].includes(BRIEF_END_MARKER)) { endLine = i; break; }
    }
    if (endLine < 0) return null;
    let lastStoryLine = -1;
    for (let i = startLine + 1; i < endLine; i++) {
        if (STORY_LINE_RE.test(lines[i])) lastStoryLine = i;
    }
    return lastStoryLine < 0 ? null : { startLine, endLine, lastStoryLine };
}
