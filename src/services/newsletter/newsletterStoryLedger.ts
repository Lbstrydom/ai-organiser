/**
 * Newsletter Story Ledger — what has been PUBLISHED to the reader, per day.
 *
 * Derived by parsing the brief we already generated, so it costs no extra LLM
 * call: the brief IS the record of what the reader was told.
 *
 * The pure functions (parse, key, merge, prune) hold all the interesting logic
 * and are testable without Obsidian; only the thin persistence wrappers touch
 * the plugin.
 */

import type { Plugin } from 'obsidian';
import { updatePluginData, loadPluginData } from '../../core/pluginDataStore';
import { logger } from '../../utils/logger';
import { keyTokens, findSimilarKey } from './newsletterStoryIdentity';
import {
    MEMORY_SCHEMA_VERSION,
    MEMORY_WINDOW_DAYS,
    MAX_STORIES_PER_BUCKET,
    MAX_GIST_CHARS,
    emptyLedger,
    type LedgerBucket,
    type LedgerStory,
    type ParseBriefResult,
    type ParsedStory,
    type StoryLedger,
} from './newsletterMemoryTypes';

export const STORY_LEDGER_DATA_KEY = 'newsletter-story-ledger';

/** Bucket keys are YYYY-MM-DD. Anything else in the persisted object is
 *  corruption or tampering and is discarded rather than coerced. */
const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Below this, a brief with no bullets is treated as genuinely empty rather
 *  than as a format deviation. */
const MIN_RECOGNISABLE_CHARS = 50;

/** Dropped when building a story key so trivial rewording still matches. */
const STOPWORDS = new Set([
    'the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'over', 'after',
    'amid', 'its', 'his', 'her', 'their', 'has', 'have', 'was', 'were', 'are',
    'new', 'says', 'say', 'said', 'will', 'would', 'could', 'been', 'but', 'not',
]);

/**
 * Normalised token-set identity for a story title.
 *
 * A sorted set of significant tokens, not a slug: "Iran-Israel conflict
 * escalates" and "Escalating Iran/Israel conflict" collide ON PURPOSE, because
 * the model retitles continuing stories between revisions and a drifted key
 * would make a known story look brand new.
 *
 * The residual failure is asymmetric and safe: a key that drifts anyway looks
 * new, so the story is repeated — today's behaviour, not a new defect.
 */
export function storyKey(title: string): string {
    const normalised = title
        .toLowerCase()
        .normalize('NFD')
        // strip combining diacritics so "Zurich" and "Zürich" agree
        .replaceAll(/[̀-ͯ]/g, '')
        .replaceAll(/[^\p{L}\p{N}\s]/gu, ' ')
        .split(/\s+/)
        .filter(Boolean);

    const significant = normalised
        .filter((t) => t.length >= 3 && !STOPWORDS.has(t))
        .map(stem);

    // A title made entirely of short or stopword tokens ("EU", "AI", "UK deal")
    // must still get a key — returning '' here would silently drop the story
    // from the ledger, so it would never be remembered and always be retold.
    const tokens = significant.length > 0 ? significant : normalised;
    return [...new Set(tokens)].sort().join('-');
}

/**
 * Conservative English suffix stripping so inflections of the same headline
 * agree: "escalates" / "escalating" / "escalated" all reduce to "escalat".
 *
 * Only applied when the remaining stem stays at least 4 characters, which keeps
 * the collision risk negligible — two genuinely different stories would have to
 * share every stemmed significant token. Key drift only ever costs a repeat
 * (today's behaviour), so a missed stem is far cheaper than a false merge.
 */
function stem(token: string): string {
    let out = token;
    for (const suffix of ['ing', 'ed', 'es', 's']) {
        if (out.endsWith(suffix) && out.length - suffix.length >= 4) {
            out = out.slice(0, -suffix.length);
            break;
        }
    }
    // Drop a trailing silent 'e' so the base form and the inflected form agree:
    // "surging" strips to "surg", and without this "surge" would stay "surge"
    // and the two would never match. Applied to BOTH sides, so it is a
    // normalisation rather than a guess about which form is canonical.
    if (out.endsWith('e') && out.length >= 5) out = out.slice(0, -1);
    return out;
}

/** Normalise a gist for CHANGE DETECTION only (never for display). */
function gistFingerprint(gist: string): string {
    return gist.toLowerCase().replaceAll(/\s+/g, ' ').trim();
}

/** Matches the brief's documented output format: `- **Title**: gist`. */
const BULLET_RE = /^\s*[-*]\s+\*\*(.+?)\*\*\s*[:—-]?\s*(.*)$/;

/**
 * Extract stories from generated brief markdown.
 *
 * Returns a STATUS, not a bare array. An empty array from substantial text would
 * otherwise be indistinguishable from "the format changed", and the caller would
 * bump the revision and replace the bucket with nothing — destroying the very
 * memory this module exists to keep.
 */
export function parseBriefStories(md: string): ParseBriefResult {
    const text = (md ?? '').trim();
    if (text.length === 0) return { kind: 'parsed', stories: [] };

    const stories: ParsedStory[] = [];
    const seen = new Set<string>();

    for (const rawLine of text.split('\n')) {
        const line = rawLine.trim();
        if (line.length === 0 || line.startsWith('#') || line.startsWith('>')) continue;
        const m = BULLET_RE.exec(line);
        if (!m) continue;

        const title = m[1].trim();
        if (title.length === 0) continue;
        let key = storyKey(title);
        if (key.length === 0) continue;
        if (seen.has(key)) {
            // Two DIFFERENT stories can normalise to the same token set. Dropping
            // the second would silently lose it from the ledger, so it would never
            // be remembered and would be retold every day. Disambiguate instead.
            let n = 2;
            while (seen.has(`${key}~${n}`)) n++;
            key = `${key}~${n}`;
        }
        seen.add(key);

        // Drop the source attribution — it is provenance, not content, and
        // including it would make the gist churn as sources come and go.
        const gist = m[2].replaceAll(/\(Sources?:[^)]*\)/gi, '').trim().slice(0, MAX_GIST_CHARS);
        stories.push({ key, title, gist });
    }

    if (stories.length === 0 && text.length > MIN_RECOGNISABLE_CHARS) {
        return { kind: 'unrecognised' };
    }
    return { kind: 'parsed', stories };
}

/**
 * Merge a parsed brief into a bucket's story list.
 *
 * Three rules, each of which fixes a distinct failure:
 *
 *  - A NEW key is stamped with `nextRevision`.
 *  - A SURVIVING key keeps its `contentRevision` only while its gist is
 *    unchanged, and is otherwise RE-STAMPED. Without the re-stamp, a new
 *    development on an already-heard story is born already-consumed and can
 *    never be surfaced.
 *  - A key ABSENT from the new brief is RETAINED unchanged. The merge is a
 *    union, not a replace. The afternoon brief correctly OMITS stories the
 *    reader already heard; dropping them here would erase the record that they
 *    were ever told, and tomorrow they would be retold from scratch — exactly
 *    the amnesia this feature removes.
 */
export function mergeBucketRevision(
    prev: LedgerStory[],
    parsed: ParsedStory[],
    nextRevision: number,
): LedgerStory[] {
    const byKey = new Map<string, LedgerStory>();
    const tokensByKey = new Map<string, Set<string>>();
    for (const s of prev) {
        byKey.set(s.key, s);
        tokensByKey.set(s.key, keyTokens(s.key));
    }

    for (const p of parsed) {
        // Match a REWORDED headline back onto the story it continues. A running
        // story's headline gains and loses qualifiers between revisions, so
        // exact key equality would file each wording as a separate story and the
        // reader would be told it fresh every time.
        const tokens = keyTokens(p.key);
        const matchKey = byKey.has(p.key) ? p.key : findSimilarKey(tokens, tokensByKey);
        const existing = matchKey ? byKey.get(matchKey) : undefined;
        const changed = !existing || gistFingerprint(existing.gist) !== gistFingerprint(p.gist);

        // Keep the ORIGINAL key so the identity stays stable across revisions;
        // the newest title and gist are what the reader sees.
        const key = existing ? existing.key : p.key;
        byKey.set(key, {
            key,
            title: p.title,
            gist: p.gist,
            // firstRevision is never re-stamped: it records that the story
            // EXISTED, which is what tells recall the reader has the background.
            firstRevision: existing ? existing.firstRevision : nextRevision,
            contentRevision: changed ? nextRevision : existing.contentRevision,
        });
        tokensByKey.set(key, tokens);
    }

    const merged = [...byKey.values()];
    if (merged.length <= MAX_STORIES_PER_BUCKET) return merged;
    // Evict the least-recently-changed first.
    return merged
        .sort((a, b) => b.contentRevision - a.contentRevision)
        .slice(0, MAX_STORIES_PER_BUCKET);
}

/** Drop buckets outside the rolling window. Pure. */
export function pruneLedger(
    ledger: StoryLedger,
    todayStr: string,
    windowDays = MEMORY_WINDOW_DAYS,
): StoryLedger {
    const cutoff = shiftDateStr(todayStr, -windowDays);
    const buckets: Record<string, LedgerBucket> = {};
    for (const [date, bucket] of Object.entries(ledger.buckets)) {
        if (date >= cutoff) buckets[date] = bucket;
    }
    return { version: MEMORY_SCHEMA_VERSION, buckets };
}

/** Shift a YYYY-MM-DD string by whole days, in local time. Exported for reuse. */
export function shiftDateStr(dateStr: string, days: number): string {
    const [y, m, d] = dateStr.split('-').map(Number);
    const dt = new Date(y, m - 1, d + days);
    const mm = String(dt.getMonth() + 1).padStart(2, '0');
    const dd = String(dt.getDate()).padStart(2, '0');
    return `${dt.getFullYear()}-${mm}-${dd}`;
}

/** Coerce whatever is on disk into a valid ledger. Unknown version = discard. */
export function coerceLedger(raw: unknown): StoryLedger {
    if (!raw || typeof raw !== 'object') return emptyLedger();
    const obj = raw as Partial<StoryLedger>;
    if (obj.version !== MEMORY_SCHEMA_VERSION) return emptyLedger();
    if (!obj.buckets || typeof obj.buckets !== 'object') return emptyLedger();

    const buckets: Record<string, LedgerBucket> = {};
    for (const [date, value] of Object.entries(obj.buckets)) {
        if (!value || typeof value !== 'object') continue;
        const b = value as Partial<LedgerBucket>;
        if (!DATE_KEY_RE.test(date)) continue;
        buckets[date] = {
            revision: Number.isFinite(b.revision) ? (b.revision as number) : 0,
            updatedAt: typeof b.updatedAt === 'number' ? b.updatedAt : 0,
            stories: Array.isArray(b.stories) ? b.stories.filter(isLedgerStory) : [],
            audio: b.audio && typeof b.audio === 'object' ? { ...b.audio } : {},
            ...(typeof b.parseFailedAt === 'number' ? { parseFailedAt: b.parseFailedAt } : {}),
        };
    }
    return { version: MEMORY_SCHEMA_VERSION, buckets };
}

function isLedgerStory(v: unknown): v is LedgerStory {
    if (!v || typeof v !== 'object') return false;
    const s = v as Partial<LedgerStory>;
    return typeof s.key === 'string'
        && typeof s.title === 'string'
        && typeof s.gist === 'string'
        && Number.isFinite(s.contentRevision)
        && Number.isFinite(s.firstRevision);
}

export async function loadLedger(plugin: Plugin): Promise<StoryLedger> {
    const data = await loadPluginData(plugin);
    return coerceLedger(data[STORY_LEDGER_DATA_KEY]);
}

/**
 * Record a synthesised brief against its bucket.
 *
 * On `unrecognised`, the bucket's stories are LEFT INTACT (no data loss) and
 * `parseFailedAt` is set so recall skips the bucket — protecting the data without
 * feeding a stale story list into tomorrow's prompt.
 */
export async function recordBucketStories(
    plugin: Plugin,
    dateStr: string,
    result: ParseBriefResult,
    todayStr: string = dateStr,
): Promise<void> {
    if (result.kind === 'unrecognised') {
        logger.warn('Newsletter', `Brief for ${dateStr} did not match the expected bullet format — story memory for that day is paused until the next successful parse`);
    }
    await updatePluginData(plugin, (data) => {
        const ledger = pruneLedger(coerceLedger(data[STORY_LEDGER_DATA_KEY]), todayStr);
        const prev = ledger.buckets[dateStr];

        if (result.kind === 'unrecognised') {
            ledger.buckets[dateStr] = {
                revision: prev?.revision ?? 0,
                updatedAt: Date.now(),
                stories: prev?.stories ?? [],
                audio: prev?.audio ?? {},
                parseFailedAt: Date.now(),
            };
        } else {
            const nextRevision = (prev?.revision ?? 0) + 1;
            ledger.buckets[dateStr] = {
                revision: nextRevision,
                updatedAt: Date.now(),
                stories: mergeBucketRevision(prev?.stories ?? [], result.stories, nextRevision),
                audio: prev?.audio ?? {},
                // successful parse clears the pause
            };
        }
        data[STORY_LEDGER_DATA_KEY] = ledger;
        return { changed: true };
    });
}

/**
 * Stamp an audio artifact with the revision it was rendered FROM.
 *
 * The revision is supplied by the caller, captured BEFORE the podcast/TTS
 * pipeline starts. Reading it here instead would stamp a revision that advanced
 * mid-render onto an older recording, and playing that recording would mark
 * stories the reader never heard as consumed.
 */
export async function recordBriefAudio(
    plugin: Plugin,
    dateStr: string,
    basename: string,
    revision: number,
): Promise<void> {
    await updatePluginData(plugin, (data) => {
        const ledger = coerceLedger(data[STORY_LEDGER_DATA_KEY]);
        const bucket = ledger.buckets[dateStr];
        if (!bucket) return { changed: false };
        if (bucket.audio[basename] === revision) return { changed: false };
        bucket.audio[basename] = revision;
        data[STORY_LEDGER_DATA_KEY] = ledger;
        return { changed: true };
    });
}

/** Remove all story-memory data. Used when the feature is switched off. */
export async function clearStoryLedger(plugin: Plugin): Promise<void> {
    await updatePluginData(plugin, (data) => {
        if (!(STORY_LEDGER_DATA_KEY in data)) return { changed: false };
        delete data[STORY_LEDGER_DATA_KEY];
        return { changed: true };
    });
}
