/**
 * Protected-folder shield — the pure matcher. Roots only, same matching rules as the write guards.
 */
import { describe, it, expect } from 'vitest';
import {
    buildBadgeIndex,
    isBadged,
    PROTECTED_FOLDER_CLASS,
    PROTECTED_SHIELD_CLASS,
    EXPLORER_FOLDER_TITLE_SELECTOR,
} from '../src/core/protectedFolderBadge';
import { DEFAULT_SETTINGS } from '../src/core/settings';
import { isInsideOrEqual } from '../src/core/protectedPaths';

describe('buildBadgeIndex / isBadged', () => {
    it('badges a protected root and nothing else', () => {
        const idx = buildBadgeIndex(['Course/Alpha']);
        expect(isBadged(idx, 'Course/Alpha')).toBe(true);
        expect(isBadged(idx, 'Course')).toBe(false);
        expect(isBadged(idx, 'Course/Beta')).toBe(false);
    });

    it('does not badge descendants of a protected root', () => {
        const idx = buildBadgeIndex(['Course/Alpha']);
        expect(isBadged(idx, 'Course/Alpha/Week 1')).toBe(false);
    });

    it('is prefix-safe: A/B does not badge A/BC', () => {
        const idx = buildBadgeIndex(['A/B']);
        expect(isBadged(idx, 'A/BC')).toBe(false);
        expect(isBadged(idx, 'A/B')).toBe(true);
    });

    it('is case-insensitive and slash-normalised, like the write guards', () => {
        const idx = buildBadgeIndex(['course\\ALPHA/']);
        expect(isBadged(idx, 'Course/Alpha')).toBe(true);
        expect(isBadged(idx, '/course/alpha/')).toBe(true);
    });

    it('agrees with the enforcement matcher on equality', () => {
        const list = ['Projects/Alpha', 'Notes/Archive'];
        const idx = buildBadgeIndex(list);
        for (const p of ['Projects/Alpha', 'projects/alpha', 'Notes/Archive/', 'Notes', 'Projects/Alpha2']) {
            const root = list.some((f) => isInsideOrEqual(p, f) && isInsideOrEqual(f, p));
            expect(isBadged(idx, p)).toBe(root);
        }
    });

    it('badges nested protected roots independently', () => {
        const idx = buildBadgeIndex(['A', 'A/B']);
        expect(isBadged(idx, 'A')).toBe(true);
        expect(isBadged(idx, 'A/B')).toBe(true);
        expect(isBadged(idx, 'A/C')).toBe(false);
    });

    it('an empty list badges nothing (the inert path)', () => {
        expect(buildBadgeIndex([]).size).toBe(0);
        expect(buildBadgeIndex(undefined).size).toBe(0);
        expect(buildBadgeIndex({ protectedFolders: [] }).size).toBe(0);
        expect(isBadged(buildBadgeIndex([]), 'Anything')).toBe(false);
    });

    it('never badges the vault root, an empty path or a missing path', () => {
        const idx = buildBadgeIndex(['', '/', 'Real']);
        expect(idx.size).toBe(1);
        expect(isBadged(idx, '/')).toBe(false);
        expect(isBadged(idx, '')).toBe(false);
        expect(isBadged(idx, null)).toBe(false);
        expect(isBadged(idx, undefined)).toBe(false);
    });

    it('accepts the settings object shape', () => {
        const idx = buildBadgeIndex({ protectedFolders: ['X/Y'] });
        expect(isBadged(idx, 'X/Y')).toBe(true);
    });

    it('de-duplicates entries that differ only by case or slashes', () => {
        expect(buildBadgeIndex(['Foo/Bar', 'foo/bar/', '\\Foo\\Bar']).size).toBe(1);
    });
});

describe('constants and setting default', () => {
    it('uses the ai-organiser prefix for every class', () => {
        expect(PROTECTED_FOLDER_CLASS.startsWith('ai-organiser-')).toBe(true);
        expect(PROTECTED_SHIELD_CLASS.startsWith('ai-organiser-')).toBe(true);
        expect(PROTECTED_FOLDER_CLASS).not.toBe(PROTECTED_SHIELD_CLASS);
    });

    it('targets the explorer folder title that carries data-path', () => {
        expect(EXPLORER_FOLDER_TITLE_SELECTOR).toBe('.nav-folder-title[data-path]');
    });

    it('the shield defaults on, and the protected list defaults empty (inert for new installs)', () => {
        expect(DEFAULT_SETTINGS.showProtectedFolderShield).toBe(true);
        expect(DEFAULT_SETTINGS.protectedFolders).toEqual([]);
    });
});
