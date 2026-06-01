import { describe, it, expect } from 'vitest';
import {
    PRESENTATION_ICONS,
    ICON_CATEGORIES,
    buildIconReference,
    isKnownIcon,
    LEGACY_EMOJI_MAP,
    resolvePresentationIcon,
} from '../src/services/presentationIr/iconRegistry';

describe('iconRegistry — data integrity', () => {
    it('has at least 40 icons, each a non-empty path string', () => {
        const names = Object.keys(PRESENTATION_ICONS);
        expect(names.length).toBeGreaterThanOrEqual(40);
        for (const [name, path] of Object.entries(PRESENTATION_ICONS)) {
            expect(typeof path, name).toBe('string');
            expect(path.length, name).toBeGreaterThan(0);
        }
    });

    it('every categorised icon exists in the registry, and vice versa', () => {
        const categorised = new Set(Object.values(ICON_CATEGORIES).flat());
        for (const name of categorised) expect(PRESENTATION_ICONS, name).toHaveProperty(name);
        for (const name of Object.keys(PRESENTATION_ICONS)) expect(categorised.has(name), name).toBe(true);
    });

    it('every legacy-emoji target is a known icon', () => {
        for (const [emoji, target] of Object.entries(LEGACY_EMOJI_MAP)) {
            expect(isKnownIcon(target), `${emoji} → ${target}`).toBe(true);
        }
    });
});

describe('buildIconReference', () => {
    it('lists categories and their icon names', () => {
        const ref = buildIconReference();
        expect(ref).toContain('data & analytics');
        expect(ref).toContain('trending-up');
        expect(ref).toContain('dollar-sign');
    });
});

describe('resolvePresentationIcon — symmetric resolution (D3)', () => {
    it('exact registry name → svg', () => {
        expect(resolvePresentationIcon('trending-up')).toEqual({ kind: 'svg', name: 'trending-up' });
    });
    it('trims whitespace before matching', () => {
        expect(resolvePresentationIcon('  rocket  ')).toEqual({ kind: 'svg', name: 'rocket' });
    });
    it('curated legacy emoji → mapped svg name', () => {
        expect(resolvePresentationIcon('📈')).toEqual({ kind: 'svg', name: 'trending-up' });
        expect(resolvePresentationIcon('💰')).toEqual({ kind: 'svg', name: 'dollar-sign' });
        expect(resolvePresentationIcon('✅')).toEqual({ kind: 'svg', name: 'check-circle' });
    });
    it('tolerates LLM casing / separator / prefix variance (M18)', () => {
        expect(resolvePresentationIcon('Trending Up')).toEqual({ kind: 'svg', name: 'trending-up' });
        expect(resolvePresentationIcon('trending_up')).toEqual({ kind: 'svg', name: 'trending-up' });
        expect(resolvePresentationIcon('icon-trending-up')).toEqual({ kind: 'svg', name: 'trending-up' });
        expect(resolvePresentationIcon('DOLLAR-SIGN')).toEqual({ kind: 'svg', name: 'dollar-sign' });
    });
    it('unknown string → none', () => {
        expect(resolvePresentationIcon('not-an-icon')).toEqual({ kind: 'none' });
    });
    it('uncurated emoji → none (never raw)', () => {
        expect(resolvePresentationIcon('🦄')).toEqual({ kind: 'none' });
    });
    it('empty / undefined / null → none', () => {
        expect(resolvePresentationIcon('')).toEqual({ kind: 'none' });
        expect(resolvePresentationIcon(undefined)).toEqual({ kind: 'none' });
        expect(resolvePresentationIcon(null)).toEqual({ kind: 'none' });
    });
});
