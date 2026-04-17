import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock obsidian before importing the component
vi.mock('obsidian', () => ({
    TFile: class {},
    TFolder: class {},
}));

import {
    sanitizeCssSelector,
    generateNonce,
} from '../src/ui/components/SlideIframePreview';

// ── sanitizeCssSelector (M13 fix) ───────────────────────────────────────────

describe('sanitizeCssSelector', () => {
    it('accepts simple class selectors', () => {
        expect(sanitizeCssSelector('.slide-title')).toBe('.slide-title');
    });

    it('accepts compound selectors', () => {
        expect(sanitizeCssSelector('.deck .slide h1')).toBe('.deck .slide h1');
    });

    it('accepts attribute selectors', () => {
        expect(sanitizeCssSelector('[data-type="content"]')).toBe('[data-type="content"]');
    });

    it('rejects selectors containing {', () => {
        expect(sanitizeCssSelector('.slide { color: red }')).toBeNull();
    });

    it('rejects selectors containing }', () => {
        expect(sanitizeCssSelector('} body {')).toBeNull();
    });

    it('rejects selectors containing @', () => {
        expect(sanitizeCssSelector('@keyframes foo')).toBeNull();
    });

    it('rejects selectors containing ;', () => {
        expect(sanitizeCssSelector('.slide; color: red')).toBeNull();
    });

    it('rejects selectors containing //', () => {
        expect(sanitizeCssSelector('.slide // comment')).toBeNull();
    });

    it('rejects selectors containing /*', () => {
        expect(sanitizeCssSelector('.slide /* comment */ h1')).toBeNull();
    });

    it('rejects empty string', () => {
        expect(sanitizeCssSelector('')).toBeNull();
    });

    it('rejects whitespace-only string', () => {
        expect(sanitizeCssSelector('   ')).toBeNull();
    });

    it('rejects selectors longer than 200 chars (M6 fix — truncation changes meaning)', () => {
        const longSelector = '.slide-' + 'x'.repeat(300);
        expect(sanitizeCssSelector(longSelector)).toBeNull();
    });

    it('trims leading/trailing whitespace', () => {
        expect(sanitizeCssSelector('  .slide  ')).toBe('.slide');
    });

    it('accepts :pseudo-class selectors', () => {
        expect(sanitizeCssSelector('.slide:first-child')).toBe('.slide:first-child');
    });

    it('accepts element type selectors', () => {
        expect(sanitizeCssSelector('h1, h2')).toBe('h1, h2');
    });
});

// ── generateNonce ────────────────────────────────────────────────────────────

describe('generateNonce', () => {
    it('returns a 16-character hex string', () => {
        const nonce = generateNonce();
        expect(nonce).toMatch(/^[0-9a-f]{16}$/);
    });

    it('generates unique values each call', () => {
        const nonces = new Set(Array.from({ length: 20 }, () => generateNonce()));
        expect(nonces.size).toBe(20);
    });

    it('contains only hex characters (safe for injection)', () => {
        for (let i = 0; i < 10; i++) {
            const nonce = generateNonce();
            expect(nonce).toMatch(/^[0-9a-f]+$/);
        }
    });
});
