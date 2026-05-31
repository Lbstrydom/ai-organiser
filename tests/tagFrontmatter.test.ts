/**
 * Unit tests for `normaliseFrontmatterTags` — the defensive coercion
 * helper that lets vault-wide passes survive user-authored YAML quirks
 * in the frontmatter `tags` field.
 *
 * Reproduces the production failures that the helper was extracted to
 * fix (was a `tagArray.some((t: string) => t.replace(...))` chain that
 * crashed on numeric / null entries inside VectorStoreService and
 * SelectionService).
 */

import { describe, it, expect } from 'vitest';
import { normaliseFrontmatterTags } from '../src/utils/tagFrontmatter';

describe('normaliseFrontmatterTags — input shapes', () => {
    it('returns [] for undefined', () => {
        expect(normaliseFrontmatterTags(undefined)).toEqual([]);
    });

    it('returns [] for null', () => {
        expect(normaliseFrontmatterTags(null)).toEqual([]);
    });

    it('returns [] for empty array', () => {
        expect(normaliseFrontmatterTags([])).toEqual([]);
    });

    it('wraps a single string into an array', () => {
        expect(normaliseFrontmatterTags('research')).toEqual(['research']);
    });

    it('passes an array of strings through (order preserved)', () => {
        expect(normaliseFrontmatterTags(['research', 'meeting', 'q4']))
            .toEqual(['research', 'meeting', 'q4']);
    });
});

describe('normaliseFrontmatterTags — # prefix stripping', () => {
    it('strips leading # from a single value', () => {
        expect(normaliseFrontmatterTags('#research')).toEqual(['research']);
    });

    it('strips leading # from every entry in an array', () => {
        expect(normaliseFrontmatterTags(['#research', 'meeting', '#q4']))
            .toEqual(['research', 'meeting', 'q4']);
    });

    it('strips only the leading # (preserves inner #)', () => {
        expect(normaliseFrontmatterTags('topic#sub')).toEqual(['topic#sub']);
    });

    it('strips at most one # (## stays as #)', () => {
        // Behaviour matches the original `replace(/^#/, '')` regex.
        expect(normaliseFrontmatterTags('##draft')).toEqual(['#draft']);
    });
});

describe('normaliseFrontmatterTags — defensive coercion (the actual bug fix)', () => {
    it('coerces a single numeric value (tags: 2026) without throwing', () => {
        // This was the reproducer: VectorStoreService.getFileTags called
        // .replace on a number and aborted the indexing pass.
        expect(normaliseFrontmatterTags(2026)).toEqual(['2026']);
    });

    it('coerces numeric entries inside an array', () => {
        expect(normaliseFrontmatterTags([2026, 'meeting', 99])).toEqual(['2026', 'meeting', '99']);
    });

    it('coerces a single boolean value', () => {
        expect(normaliseFrontmatterTags(true)).toEqual(['true']);
    });

    it('skips null entries inside an array', () => {
        // YAML `tags:\n  - foo\n  -\n  - bar` parses the middle entry as null.
        expect(normaliseFrontmatterTags(['foo', null, 'bar'])).toEqual(['foo', 'bar']);
    });

    it('skips undefined entries inside an array', () => {
        expect(normaliseFrontmatterTags(['foo', undefined, 'bar'])).toEqual(['foo', 'bar']);
    });

    it('handles a fully mixed heterogeneous array (the worst-case real user input)', () => {
        expect(normaliseFrontmatterTags(['#research', 2026, null, true, '#meeting', undefined]))
            .toEqual(['research', '2026', 'true', 'meeting']);
    });

    it('coerces objects to their default string form (rare but does not throw)', () => {
        // Object frontmatter `tags: {key: value}` parses as an object —
        // default String(obj) is "[object Object]". Stripping leading
        // `#` returns the same value. We don't try to be clever; the
        // contract is "do not throw", not "do something useful".
        expect(normaliseFrontmatterTags({ key: 'value' })).toEqual(['[object Object]']);
    });
});
