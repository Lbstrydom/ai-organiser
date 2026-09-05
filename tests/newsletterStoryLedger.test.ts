import { describe, it, expect } from 'vitest';
import {
    parseBriefStories,
    storyKey,
    mergeBucketRevision,
    pruneLedger,
    shiftDateStr,
    coerceLedger,
} from '../src/services/newsletter/newsletterStoryLedger';
import {
    MEMORY_SCHEMA_VERSION,
    MAX_STORIES_PER_BUCKET,
    type LedgerStory,
    type StoryLedger,
} from '../src/services/newsletter/newsletterMemoryTypes';

/** The exact shape buildDailyBriefPrompt's <output_format> documents. */
const REAL_BRIEF = `### Geopolitics
- **Iran-Israel conflict**: Iran's army chief vowed retaliation after strikes killed senior officials. (Sources: Newsletter A, Newsletter B)
- **Ukraine funding**: EU ministers agreed a new tranche.

### Tech & AI
- **Disney leadership**: Josh D'Amaro succeeds Bob Iger as CEO.`;

describe('storyKey', () => {
    it('collides on reworded titles for the same story', () => {
        expect(storyKey('Iran-Israel conflict escalates'))
            .toBe(storyKey('Escalating Iran/Israel conflict'));
    });

    it('does not collide across genuinely different stories', () => {
        expect(storyKey('Iran-Israel conflict')).not.toBe(storyKey('Disney leadership change'));
    });

    it('folds diacritics so accented place names match', () => {
        expect(storyKey('Zürich housing')).toBe(storyKey('Zurich housing'));
    });

    it('drops stopwords and short tokens', () => {
        expect(storyKey('The new EU deal for Ukraine')).toBe(storyKey('EU deal Ukraine'));
    });

    it('matches across simple inflections', () => {
        expect(storyKey('Prices surge')).toBe(storyKey('Surging prices'));
        expect(storyKey('Talks stalled')).toBe(storyKey('Talks stalling'));
    });

    it('never returns an empty key for a non-empty title', () => {
        // A title of only short/stopword tokens must still be storable — an
        // empty key would silently drop the story from the ledger, so it could
        // never be remembered and would be retold every day.
        expect(storyKey('EU')).not.toBe('');
        expect(storyKey('The new AI')).not.toBe('');
        expect(storyKey('EU')).not.toBe(storyKey('AI'));
    });
});

describe('parseBriefStories', () => {
    it('extracts every bold-title bullet from the documented format', () => {
        const r = parseBriefStories(REAL_BRIEF);
        expect(r.kind).toBe('parsed');
        if (r.kind !== 'parsed') return;
        expect(r.stories.map((s) => s.title)).toEqual([
            'Iran-Israel conflict', 'Ukraine funding', 'Disney leadership',
        ]);
    });

    it('strips the source attribution from the gist', () => {
        const r = parseBriefStories(REAL_BRIEF);
        if (r.kind !== 'parsed') throw new Error('expected parsed');
        expect(r.stories[0].gist).not.toMatch(/Sources/);
        expect(r.stories[0].gist).toContain('vowed retaliation');
    });

    it('ignores theme headings and callouts', () => {
        const r = parseBriefStories('### Geopolitics\n> [!note] excluded\n- **A**: one');
        if (r.kind !== 'parsed') throw new Error('expected parsed');
        expect(r.stories).toHaveLength(1);
    });

    it('treats empty input as a genuine empty parse', () => {
        expect(parseBriefStories('   ')).toEqual({ kind: 'parsed', stories: [] });
    });

    it('treats substantial prose with no bullets as UNRECOGNISED, not empty', () => {
        // The data-loss regression: an empty parse here would bump the revision
        // and replace the bucket with nothing.
        const prose = 'Today there was a great deal of news across the world, and here is a long paragraph about it.';
        expect(parseBriefStories(prose)).toEqual({ kind: 'unrecognised' });
    });

    it('treats a numbered list as unrecognised', () => {
        const numbered = '1. **Iran-Israel conflict**: something happened today that matters a great deal\n2. **Ukraine**: more news';
        expect(parseBriefStories(numbered)).toEqual({ kind: 'unrecognised' });
    });

    it('disambiguates a key collision instead of dropping the second story', () => {
        // Two DIFFERENT bullets can normalise to the same token set. Dropping
        // the second would silently lose it from the ledger, so it would never
        // be remembered and would be retold every day.
        const r = parseBriefStories('- **Iran-Israel conflict**: a\n- **Conflict Iran Israel**: b');
        if (r.kind !== 'parsed') throw new Error('expected parsed');
        expect(r.stories).toHaveLength(2);
        expect(new Set(r.stories.map((x) => x.key)).size).toBe(2);
        expect(r.stories[1].key).toMatch(/~2$/);
        expect(r.stories.map((x) => x.gist)).toEqual(['a', 'b']);
    });
});

describe('mergeBucketRevision', () => {
    const prev: LedgerStory[] = [
        { key: 'a', title: 'A', gist: 'original gist', firstRevision: 1, contentRevision: 1 },
        { key: 'b', title: 'B', gist: 'b gist', firstRevision: 1, contentRevision: 1 },
    ];

    it('keeps contentRevision when the gist is unchanged', () => {
        const out = mergeBucketRevision(prev, [{ key: 'a', title: 'A', gist: 'original gist' }], 2);
        expect(out.find((s) => s.key === 'a')?.contentRevision).toBe(1);
    });

    it('ignores whitespace and case when comparing gists', () => {
        const out = mergeBucketRevision(prev, [{ key: 'a', title: 'A', gist: '  Original   GIST ' }], 2);
        expect(out.find((s) => s.key === 'a')?.contentRevision).toBe(1);
    });

    it('RE-STAMPS a surviving key whose gist changed', () => {
        // The delta-amnesia regression: without the re-stamp, a new development
        // on an already-heard story is born already-consumed and can never be
        // surfaced to the reader.
        const out = mergeBucketRevision(prev, [{ key: 'a', title: 'A', gist: 'a genuinely new development' }], 2);
        expect(out.find((s) => s.key === 'a')?.contentRevision).toBe(2);
    });

    it('stamps a brand-new key with the new revision', () => {
        const out = mergeBucketRevision(prev, [{ key: 'c', title: 'C', gist: 'c' }], 2);
        expect(out.find((s) => s.key === 'c')?.contentRevision).toBe(2);
    });

    it('RETAINS a key the new brief omitted', () => {
        // The omission-loop regression: the afternoon brief correctly omits an
        // already-heard story, and dropping it here would erase the record that
        // it was ever told, so tomorrow it would be retold from scratch.
        const out = mergeBucketRevision(prev, [{ key: 'a', title: 'A', gist: 'original gist' }], 2);
        expect(out.map((s) => s.key).sort()).toEqual(['a', 'b']);
        expect(out.find((s) => s.key === 'b')?.contentRevision).toBe(1);
    });

    it('caps the bucket, evicting the least-recently-changed first', () => {
        const many: LedgerStory[] = Array.from({ length: MAX_STORIES_PER_BUCKET + 5 }, (_, i) => ({
            key: `k${i}`, title: `T${i}`, gist: 'g', firstRevision: i, contentRevision: i,
        }));
        const out = mergeBucketRevision(many, [], 99);
        expect(out).toHaveLength(MAX_STORIES_PER_BUCKET);
        expect(out.some((s) => s.key === 'k0')).toBe(false);
    });
});

describe('pruneLedger', () => {
    const ledger: StoryLedger = {
        version: MEMORY_SCHEMA_VERSION,
        buckets: {
            '2026-09-04': { revision: 1, updatedAt: 0, stories: [], audio: {} },
            '2026-08-28': { revision: 1, updatedAt: 0, stories: [], audio: {} },
            '2026-08-20': { revision: 1, updatedAt: 0, stories: [], audio: {} },
        },
    };

    it('keeps buckets inside the window and drops those outside', () => {
        const out = pruneLedger(ledger, '2026-09-04', 7);
        expect(Object.keys(out.buckets).sort()).toEqual(['2026-08-28', '2026-09-04']);
    });

    it('keeps the exact window boundary', () => {
        const out = pruneLedger(ledger, '2026-09-04', 7);
        expect(out.buckets['2026-08-28']).toBeDefined();
    });
});

describe('shiftDateStr', () => {
    it('handles month boundaries', () => {
        expect(shiftDateStr('2026-09-04', -7)).toBe('2026-08-28');
        expect(shiftDateStr('2026-03-01', -1)).toBe('2026-02-28');
    });
});

describe('coerceLedger', () => {
    it('discards an unknown schema version', () => {
        expect(coerceLedger({ version: 99, buckets: { x: {} } }).buckets).toEqual({});
    });

    it('returns an empty ledger for garbage', () => {
        expect(coerceLedger('nope').buckets).toEqual({});
        expect(coerceLedger(null).buckets).toEqual({});
    });

    it('drops malformed stories but keeps the bucket', () => {
        const out = coerceLedger({
            version: MEMORY_SCHEMA_VERSION,
            buckets: { '2026-09-04': { revision: 2, stories: [{ key: 'a' }, { key: 'b', title: 'B', gist: 'g', firstRevision: 1, contentRevision: 1 }] } },
        });
        expect(out.buckets['2026-09-04'].stories).toHaveLength(1);
        expect(out.buckets['2026-09-04'].audio).toEqual({});
    });

    it('preserves parseFailedAt', () => {
        const out = coerceLedger({
            version: MEMORY_SCHEMA_VERSION,
            buckets: { '2026-09-04': { revision: 1, stories: [], audio: {}, parseFailedAt: 123 } },
        });
        expect(out.buckets['2026-09-04'].parseFailedAt).toBe(123);
    });
});
