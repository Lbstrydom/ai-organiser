import { describe, it, expect } from 'vitest';
import { selectRecall, isRecallEmpty } from '../src/services/newsletter/newsletterRecall';
import {
    MEMORY_SCHEMA_VERSION,
    type ConsumptionState,
    type LedgerStory,
    type StoryLedger,
} from '../src/services/newsletter/newsletterMemoryTypes';

const MON = '2026-08-31';
const TUE = '2026-09-01';
const WED = '2026-09-02';
const LONG_AGO = '2026-08-01';

function story(key: string, contentRevision = 1, firstRevision = contentRevision): LedgerStory {
    return { key, title: key.toUpperCase(), gist: `gist for ${key}`, firstRevision, contentRevision };
}

function ledger(
    buckets: Record<string, { revision: number; stories: LedgerStory[]; parseFailedAt?: number }>,
): StoryLedger {
    const out: StoryLedger = { version: MEMORY_SCHEMA_VERSION, buckets: {} };
    for (const [date, b] of Object.entries(buckets)) {
        out.buckets[date] = {
            revision: b.revision,
            updatedAt: 0,
            stories: b.stories,
            audio: {},
            ...(b.parseFailedAt ? { parseFailedAt: b.parseFailedAt } : {}),
        };
    }
    return out;
}

function consumed(map: Record<string, number>): ConsumptionState {
    const state: ConsumptionState = { version: MEMORY_SCHEMA_VERSION, consumed: {} };
    for (const [date, revision] of Object.entries(map)) {
        state.consumed[date] = { firstAt: 1, lastAt: 1, firstVia: 'audio', lastVia: 'audio', revision };
    }
    return state;
}

const keys = (list: { key: string }[]) => list.map((s) => s.key).sort();

describe('selectRecall — the catch-up matrix', () => {
    it('(a) everything consumed and nothing new lands in heard', () => {
        const sel = selectRecall(
            ledger({ [MON]: { revision: 1, stories: [story('a'), story('b')] } }),
            consumed({ [MON]: 1 }),
            TUE,
        );
        expect(keys(sel.heard)).toEqual(['a', 'b']);
        expect(sel.continuing).toHaveLength(0);
        expect(sel.unheard).toHaveLength(0);
    });

    it('(b) nothing consumed lands entirely in unheard', () => {
        const sel = selectRecall(
            ledger({ [MON]: { revision: 1, stories: [story('a'), story('b')] } }),
            consumed({}),
            TUE,
        );
        expect(keys(sel.unheard)).toEqual(['a', 'b']);
        expect(sel.heard).toHaveLength(0);
    });

    it('(c) a mixed window splits correctly', () => {
        const sel = selectRecall(
            ledger({
                [MON]: { revision: 1, stories: [story('a')] },
                [TUE]: { revision: 1, stories: [story('b')] },
            }),
            consumed({ [MON]: 1 }),
            WED,
        );
        expect(keys(sel.heard)).toEqual(['a']);
        expect(keys(sel.unheard)).toEqual(['b']);
    });

    it('(d) catching up moves previously-unheard stories into heard', () => {
        // The user is behind, binge-listens, and the next brief must adapt.
        const l = ledger({
            [MON]: { revision: 1, stories: [story('a')] },
            [TUE]: { revision: 1, stories: [story('b')] },
        });
        const before = selectRecall(l, consumed({}), WED);
        expect(keys(before.unheard)).toEqual(['a', 'b']);

        const after = selectRecall(l, consumed({ [MON]: 1, [TUE]: 1 }), WED);
        expect(keys(after.heard)).toEqual(['a', 'b']);
        expect(after.unheard).toHaveLength(0);
    });

    it('(e) a story added AFTER the bucket was consumed stays unheard', () => {
        // The revision regression: the user listened at revision 1; story 'b'
        // arrived at revision 2 and must not be treated as heard.
        const sel = selectRecall(
            ledger({ [TUE]: { revision: 2, stories: [story('a', 1), story('b', 2)] } }),
            consumed({ [TUE]: 1 }),
            TUE,
        );
        expect(keys(sel.heard)).toEqual(['a']);
        expect(keys(sel.unheard)).toEqual(['b']);
    });

    it('(e2) an update to an ALREADY-HEARD story is continuing, never unheard', () => {
        // The two-state regression. A story heard on Monday that gains an
        // unconsumed update on Tuesday must not be re-explained from scratch;
        // the reader already has the background.
        const sel = selectRecall(
            ledger({
                [MON]: { revision: 1, stories: [story('a', 1)] },
                [TUE]: { revision: 2, stories: [story('a', 2)] },
            }),
            consumed({ [MON]: 1 }),
            WED,
        );
        expect(keys(sel.continuing)).toEqual(['a']);
        expect(sel.unheard).toHaveLength(0);
        expect(sel.heard).toHaveLength(0);
    });

    it('(e3) a story that EXISTED when heard and changed since is continuing, IN ONE BUCKET', () => {
        // The two-revision regression, and the subtlest case in the whole
        // feature. Within a single live bucket the merge overwrites the entry,
        // so the revision-1 version is gone. With only contentRevision the
        // story would look brand-new and the reader would get the whole thing
        // re-explained instead of just the new development.
        const sel = selectRecall(
            ledger({ [TUE]: { revision: 2, stories: [story('a', 2, 1)] } }),
            consumed({ [TUE]: 1 }),
            TUE,
        );
        expect(keys(sel.continuing)).toEqual(['a']);
        expect(sel.unheard).toHaveLength(0);
        expect(sel.heard).toHaveLength(0);
    });

    it('(e4) a story that did NOT exist when heard is unheard, not continuing', () => {
        const sel = selectRecall(
            ledger({ [TUE]: { revision: 2, stories: [story('b', 2, 2)] } }),
            consumed({ [TUE]: 1 }),
            TUE,
        );
        expect(keys(sel.unheard)).toEqual(['b']);
        expect(sel.continuing).toHaveLength(0);
    });

    it('(f) a key never appears in more than one list', () => {
        const sel = selectRecall(
            ledger({
                [MON]: { revision: 1, stories: [story('a', 1)] },
                [TUE]: { revision: 2, stories: [story('a', 2)] },
            }),
            consumed({ [MON]: 1 }),
            WED,
        );
        const all = [...sel.heard, ...sel.continuing, ...sel.unheard].map((s) => s.key);
        expect(all).toEqual([...new Set(all)]);
    });

    it('(g) respects the story cap', () => {
        const many = Array.from({ length: 40 }, (_, i) => story(`k${i}`));
        const sel = selectRecall(
            ledger({ [MON]: { revision: 1, stories: many } }),
            consumed({}),
            TUE,
            { maxStories: 5, maxChars: 100_000 },
        );
        expect(sel.unheard).toHaveLength(5);
    });

    it('(g2) respects the character cap but always keeps at least one', () => {
        const sel = selectRecall(
            ledger({ [MON]: { revision: 1, stories: [story('a'), story('b'), story('c')] } }),
            consumed({}),
            TUE,
            { maxChars: 1 },
        );
        expect(sel.unheard).toHaveLength(1);
    });

    it('(h) the CURRENT bucket is recalled and flagged, so the morning is not retold', () => {
        // The same-day regression: excluding the current bucket would make the
        // afternoon brief repeat everything the reader heard this morning.
        const sel = selectRecall(
            ledger({ [TUE]: { revision: 1, stories: [story('a', 1)] } }),
            consumed({ [TUE]: 1 }),
            TUE,
        );
        expect(keys(sel.heard)).toEqual(['a']);
        expect(sel.heard[0].isCurrentBucket).toBe(true);
        expect(sel.heard[0].bucketDate).toBe(TUE);
    });

    it('(h2) marks a previous-day story as not-current', () => {
        const sel = selectRecall(
            ledger({ [MON]: { revision: 1, stories: [story('a')] } }),
            consumed({ [MON]: 1 }),
            TUE,
        );
        expect(sel.heard[0].isCurrentBucket).toBe(false);
    });

    it('(i) excludes buckets outside the window regardless of consumption', () => {
        const sel = selectRecall(
            ledger({ [LONG_AGO]: { revision: 1, stories: [story('old')] } }),
            consumed({ [LONG_AGO]: 1 }),
            WED,
            { windowDays: 7 },
        );
        expect(isRecallEmpty(sel)).toBe(true);
    });

    it('(i2) never recalls a bucket after the current one', () => {
        const sel = selectRecall(
            ledger({ [WED]: { revision: 1, stories: [story('future')] } }),
            consumed({}),
            TUE,
        );
        expect(isRecallEmpty(sel)).toBe(true);
    });

    it('(j) a bucket whose brief failed to parse contributes nothing', () => {
        // Its story list is stale, so asserting the reader heard it would be
        // worse than having no memory for that day.
        const sel = selectRecall(
            ledger({ [MON]: { revision: 1, stories: [story('a')], parseFailedAt: 123 } }),
            consumed({ [MON]: 1 }),
            TUE,
        );
        expect(isRecallEmpty(sel)).toBe(true);
    });

    it('an empty ledger yields an empty selection', () => {
        expect(isRecallEmpty(selectRecall(ledger({}), consumed({}), TUE))).toBe(true);
    });

    it('the newest occurrence supplies the display title and gist', () => {
        const l = ledger({
            [MON]: { revision: 1, stories: [{ key: 'a', title: 'Old title', gist: 'old', firstRevision: 1, contentRevision: 1 }] },
            [TUE]: { revision: 1, stories: [{ key: 'a', title: 'New title', gist: 'new', firstRevision: 1, contentRevision: 1 }] },
        });
        const sel = selectRecall(l, consumed({ [MON]: 1, [TUE]: 1 }), WED);
        expect(sel.heard[0].title).toBe('New title');
        expect(sel.heard[0].gist).toBe('new');
    });
});
