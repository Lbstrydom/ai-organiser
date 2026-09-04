/**
 * Newsletter Recall — the pure join of "what was published" and "what was heard".
 *
 * No I/O, no Obsidian: the entire catch-up semantic is unit-testable with plain
 * objects, which matters because this is where every subtle failure lives.
 *
 * The classification is THREE-way, not two. "The reader knows the background"
 * and "there is an update the reader has not seen" are independent facts.
 * Collapsing them means a story heard on Monday that gains an update on Tuesday
 * is either wrongly suppressed (losing the update) or wrongly re-explained from
 * scratch (the original complaint).
 */

import {
    MEMORY_WINDOW_DAYS,
    type ConsumptionState,
    type RecallSelection,
    type RecallStory,
    type StoryLedger,
} from './newsletterMemoryTypes';
import { consumedRevision } from './newsletterConsumption';
import { shiftDateStr } from './newsletterStoryLedger';
import { keyTokens, findSimilarKey } from './newsletterStoryIdentity';

export interface RecallOptions {
    /** Rolling window in days. */
    windowDays?: number;
    /** Max stories per list, newest first. */
    maxStories?: number;
    /** Override the per-list character budget. Omit to use the per-list defaults,
     *  which differ because `heard` renders title-only and the others do not. */
    maxChars?: number;
}

/**
 * Caps differ per list because the lists are not equally expensive, and getting
 * this wrong silently guts the feature.
 *
 * Measured on a real corpus: 7 days holds roughly 150-250 stories at ~200 chars
 * of title+gist each. A flat 2500-char cap therefore showed the model about 12
 * of them — 8% of what the reader had actually heard — so a story running all
 * week never appeared in the window and was treated as brand new.
 *
 * The fix is to charge each list for what it actually RENDERS. A `heard` entry
 * only has to be recognisable, so it renders as a title alone and costs ~55
 * chars; `continuing` and `unheard` need the gist to be useful and cost ~200.
 * That buys a full week of recognition for less than the old cap spent on 12
 * full entries.
 */
const DEFAULT_MAX_STORIES = 250;
/** `heard` renders title-only, so this buys ~150 recognisable entries. */
const DEFAULT_HEARD_MAX_CHARS = 9_000;
/** `continuing` and `unheard` render the gist too — fewer, but complete. */
const DEFAULT_DETAILED_MAX_CHARS = 4_000;

interface Accumulated {
    /** Any occurrence of this key, in any in-window bucket, was consumed. */
    hasBackground: boolean;
    /** The newest occurrence carries content the reader has not heard. */
    hasUnheardUpdate: boolean;
    /** The newest occurrence — supplies title, gist and bucket context. */
    newest: RecallStory;
}

/**
 * Classify every in-window story into exactly one of heard / continuing / unheard.
 *
 * Spans buckets UP TO AND INCLUDING `currentBucketStr`, using that bucket's
 * pre-generation snapshot. Excluding the current bucket would defeat the whole
 * revision model — the stories the reader heard this morning would not be
 * recognised when the afternoon brief is built, and the afternoon would retell
 * the morning.
 */
export function selectRecall(
    ledger: StoryLedger,
    consumption: ConsumptionState,
    currentBucketStr: string,
    opts: RecallOptions = {},
): RecallSelection {
    const windowDays = opts.windowDays ?? MEMORY_WINDOW_DAYS;
    const maxStories = opts.maxStories ?? DEFAULT_MAX_STORIES;
    const heardChars = opts.maxChars ?? DEFAULT_HEARD_MAX_CHARS;
    const detailChars = opts.maxChars ?? DEFAULT_DETAILED_MAX_CHARS;
    const cutoff = shiftDateStr(currentBucketStr, -windowDays);

    // Newest bucket first, so the first occurrence we see for a key is the newest.
    const dates = Object.keys(ledger.buckets)
        .filter((d) => d >= cutoff && d <= currentBucketStr)
        .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));

    const acc = new Map<string, Accumulated>();
    // Token sets alongside the accumulator, so a reworded headline can be
    // recognised as the SAME running story. Exact key equality misses almost
    // every real continuation — see newsletterStoryIdentity for the measurement.
    const accTokens = new Map<string, Set<string>>();

    for (const date of dates) {
        const bucket = ledger.buckets[date];
        // A bucket whose brief could not be parsed holds a stale story list.
        // Feeding it to the prompt would assert the reader has heard things the
        // current brief no longer contains, which is worse than no memory.
        if (bucket.parseFailedAt !== undefined) continue;

        const consumedRev = consumedRevision(consumption, date);

        for (const story of bucket.stories) {
            // Two INDEPENDENT questions, which is why the ledger keeps two
            // revisions. "Did this story exist when they listened?" gives the
            // background; "has its content changed since?" gives the update.
            // Using contentRevision for both would make a story that existed at
            // revision 1 and changed at revision 2 look brand-new, so the reader
            // would get the whole thing re-explained instead of just the delta.
            const existedWhenHeard = consumedRev !== null && story.firstRevision <= consumedRev;
            const contentHeard = consumedRev !== null && story.contentRevision <= consumedRev;

            const tokens = keyTokens(story.key);
            const matchKey = acc.has(story.key)
                ? story.key
                : findSimilarKey(tokens, accTokens);
            const existing = matchKey ? acc.get(matchKey) : undefined;

            if (existing) {
                // Newest already captured; older occurrences only contribute
                // background. This is what stops a Monday-heard story from being
                // re-explained when Tuesday adds an update.
                existing.hasBackground ||= existedWhenHeard;
                continue;
            }

            accTokens.set(story.key, tokens);
            acc.set(story.key, {
                hasBackground: existedWhenHeard,
                hasUnheardUpdate: !contentHeard,
                newest: {
                    ...story,
                    bucketDate: date,
                    isCurrentBucket: date === currentBucketStr,
                },
            });
        }
    }

    const heard: RecallStory[] = [];
    const continuing: RecallStory[] = [];
    const unheard: RecallStory[] = [];

    for (const entry of acc.values()) {
        if (!entry.hasBackground) unheard.push(entry.newest);
        else if (entry.hasUnheardUpdate) continuing.push(entry.newest);
        else heard.push(entry.newest);
    }

    return {
        heard: cap(sortNewestFirst(heard), maxStories, heardChars, titleCost),
        continuing: cap(sortNewestFirst(continuing), maxStories, detailChars, fullCost),
        unheard: cap(sortNewestFirst(unheard), maxStories, detailChars, fullCost),
    };
}

function sortNewestFirst(list: RecallStory[]): RecallStory[] {
    return [...list].sort((a, b) => {
        if (a.bucketDate !== b.bucketDate) return a.bucketDate < b.bucketDate ? 1 : -1;
        return b.contentRevision - a.contentRevision;
    });
}

/**
 * Trim a list to its budget.
 *
 * `costOf` must match what the PROMPT actually renders for that list, or the
 * budget is fiction — charging a title-only list for its gists is what
 * truncated a week of memory down to twelve entries.
 */
function cap(
    list: RecallStory[],
    maxStories: number,
    maxChars: number,
    costOf: (s: RecallStory) => number,
): RecallStory[] {
    const out: RecallStory[] = [];
    let chars = 0;
    for (const s of list) {
        if (out.length >= maxStories) break;
        const cost = costOf(s);
        if (chars + cost > maxChars && out.length > 0) break;
        out.push(s);
        chars += cost;
    }
    return out;
}

/** `heard` renders as `[date] title` only. */
const titleCost = (s: RecallStory) => s.title.length + 14;
/** `continuing` / `unheard` render `[date] title: gist`. */
const fullCost = (s: RecallStory) => s.title.length + s.gist.length + 14;

/** True when there is nothing worth putting in the prompt. */
export function isRecallEmpty(sel: RecallSelection): boolean {
    return sel.heard.length === 0 && sel.continuing.length === 0 && sel.unheard.length === 0;
}
