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
    /** Max total gist characters per list. */
    maxChars?: number;
}

const DEFAULT_MAX_STORIES = 25;
const DEFAULT_MAX_CHARS = 2500;

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
    const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
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
        heard: cap(sortNewestFirst(heard), maxStories, maxChars),
        continuing: cap(sortNewestFirst(continuing), maxStories, maxChars),
        unheard: cap(sortNewestFirst(unheard), maxStories, maxChars),
    };
}

function sortNewestFirst(list: RecallStory[]): RecallStory[] {
    return [...list].sort((a, b) => {
        if (a.bucketDate !== b.bucketDate) return a.bucketDate < b.bucketDate ? 1 : -1;
        return b.contentRevision - a.contentRevision;
    });
}

function cap(list: RecallStory[], maxStories: number, maxChars: number): RecallStory[] {
    const out: RecallStory[] = [];
    let chars = 0;
    for (const s of list) {
        if (out.length >= maxStories) break;
        const cost = s.title.length + s.gist.length;
        if (chars + cost > maxChars && out.length > 0) break;
        out.push(s);
        chars += cost;
    }
    return out;
}

/** True when there is nothing worth putting in the prompt. */
export function isRecallEmpty(sel: RecallSelection): boolean {
    return sel.heard.length === 0 && sel.continuing.length === 0 && sel.unheard.length === 0;
}
