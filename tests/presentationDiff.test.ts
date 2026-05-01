/**
 * @vitest-environment happy-dom
 *
 * presentationDiff unit tests.
 * Plan: docs/completed/slide-authoring-editing-backend.md §"Whitespace handling"
 */

import { describe, it, expect } from 'vitest';
import { compareSlides, classifyDiff } from '../src/services/chat/presentationDiff';

const SLIDE_A = '<section class="slide"><h1>Hello</h1><ul><li>One</li><li>Two</li></ul></section>';

const TWO_SLIDE_DECK = (s0: string, s1: string) =>
    `<div class="deck">${s0}${s1}</div>`;

describe('compareSlides', () => {
    it('returns identical for byte-equal input', () => {
        expect(compareSlides(SLIDE_A, SLIDE_A)).toBe('identical');
    });

    it('returns whitespace for input differing only in formatting', () => {
        const formatted = `<section class="slide">
              <h1>Hello</h1>
              <ul>
                <li>One</li>
                <li>Two</li>
              </ul>
            </section>`;
        expect(compareSlides(SLIDE_A, formatted)).toBe('whitespace');
    });

    it('returns text for text-content differences', () => {
        const changed = '<section class="slide"><h1>Hi there</h1><ul><li>One</li><li>Two</li></ul></section>';
        expect(compareSlides(SLIDE_A, changed)).toBe('text');
    });

    it('returns structural for added child element', () => {
        const grew = '<section class="slide"><h1>Hello</h1><h2>Sub</h2><ul><li>One</li><li>Two</li></ul></section>';
        expect(compareSlides(SLIDE_A, grew)).toBe('structural');
    });

    it('returns structural for tag-name change', () => {
        const taggy = '<section class="slide"><h2>Hello</h2><ul><li>One</li><li>Two</li></ul></section>';
        expect(compareSlides(SLIDE_A, taggy)).toBe('structural');
    });

    it('returns structural for attribute change (other than class token order)', () => {
        const styled = '<section class="slide" id="hero"><h1>Hello</h1><ul><li>One</li><li>Two</li></ul></section>';
        expect(compareSlides(SLIDE_A, styled)).toBe('structural');
    });

    it('treats class token order as equal (sorted-set comparison)', () => {
        const a = '<section class="slide slide-title"><h1>x</h1></section>';
        const b = '<section class="slide-title slide"><h1>x</h1></section>';
        expect(compareSlides(a, b)).toBe('identical');
    });
});

describe('classifyDiff — slide scope', () => {
    it('reports preserved structural integrity for byte-equal decks', () => {
        const deck = TWO_SLIDE_DECK(SLIDE_A, SLIDE_A);
        const r = classifyDiff(deck, deck, { kind: 'slide', slideIndex: 0 });
        expect(r.structuralIntegrity).toBe('preserved');
        expect(r.outOfScopeDrift).toEqual([]);
    });

    it('detects slides-added when new deck has more slides', () => {
        const oldDeck = TWO_SLIDE_DECK(SLIDE_A, SLIDE_A);
        const newDeck = TWO_SLIDE_DECK(SLIDE_A, SLIDE_A) + '<section class="slide"><h1>Bonus</h1></section>';
        const wrap = '<div class="deck">' + newDeck.slice('<div class="deck">'.length);
        const r = classifyDiff(oldDeck, wrap, { kind: 'slide', slideIndex: 0 });
        expect(r.structuralIntegrity).toBe('slides-added');
    });

    it('detects slides-removed when new deck has fewer slides', () => {
        const oldDeck = TWO_SLIDE_DECK(SLIDE_A, SLIDE_A);
        const newDeck = '<div class="deck">' + SLIDE_A + '</div>';
        const r = classifyDiff(oldDeck, newDeck, { kind: 'slide', slideIndex: 0 });
        expect(r.structuralIntegrity).toBe('slides-removed');
    });

    it('detects class-changed when slide class changes', () => {
        const oldDeck = '<div class="deck"><section class="slide slide-title"><h1>x</h1></section></div>';
        const newDeck = '<div class="deck"><section class="slide slide-content"><h1>x</h1></section></div>';
        const r = classifyDiff(oldDeck, newDeck, { kind: 'slide', slideIndex: 0 });
        expect(r.structuralIntegrity).toBe('class-changed');
    });

    it('reports outOfScopeDrift when adjacent slide text-changes', () => {
        const oldDeck = TWO_SLIDE_DECK(
            '<section class="slide"><h1>Slide 0</h1></section>',
            '<section class="slide"><h1>Slide 1</h1></section>',
        );
        const newDeck = TWO_SLIDE_DECK(
            '<section class="slide"><h1>Slide 0</h1></section>',
            '<section class="slide"><h1>Surprise rewrite</h1></section>',
        );
        // User scoped slide 0; slide 1 drifted unexpectedly.
        const r = classifyDiff(oldDeck, newDeck, { kind: 'slide', slideIndex: 0 });
        expect(r.outOfScopeDrift).toHaveLength(1);
        expect(r.outOfScopeDrift[0].slideIndex).toBe(1);
        expect(r.outOfScopeDrift[0].severity).toBe('text');
    });

    it('filters whitespace-only drift from outOfScopeDrift', () => {
        const oldDeck = TWO_SLIDE_DECK(
            '<section class="slide"><h1>Slide 0</h1></section>',
            '<section class="slide"><h1>Slide 1</h1></section>',
        );
        // Slide 1 reformatted only.
        const newDeck = TWO_SLIDE_DECK(
            '<section class="slide"><h1>Slide 0</h1></section>',
            `<section class="slide">
                <h1>Slide 1</h1>
            </section>`,
        );
        const r = classifyDiff(oldDeck, newDeck, { kind: 'slide', slideIndex: 0 });
        expect(r.outOfScopeDrift).toEqual([]);
    });
});

describe('classifyDiff — range scope', () => {
    it('treats slides 0-1 as in-scope and skips them in drift collection', () => {
        const wrap = (...slides: string[]): string => `<div class="deck">${slides.join('')}</div>`;
        const oldDeck = wrap(
            '<section class="slide"><h1>S0</h1></section>',
            '<section class="slide"><h1>S1</h1></section>',
            '<section class="slide"><h1>S2 outside</h1></section>',
        );
        const newDeck = wrap(
            '<section class="slide"><h1>S0 NEW</h1></section>',
            '<section class="slide"><h1>S1 NEW</h1></section>',
            '<section class="slide"><h1>S2 outside</h1></section>',
        );
        const r = classifyDiff(oldDeck, newDeck, { kind: 'range', slideIndex: 0, slideEndIndex: 1 });
        // S0+S1 in scope; S2 (outside) wasn't changed → no drift.
        expect(r.outOfScopeDrift).toEqual([]);
    });
});

describe('classifyDiff — element scope', () => {
    it('builds scopeDiff for an element scope (slide-level fallback)', () => {
        const deck = TWO_SLIDE_DECK(SLIDE_A, SLIDE_A);
        const newSlide1 = '<section class="slide"><h1>Hello</h1><ul><li>One UPDATED</li><li>Two</li></ul></section>';
        const newDeck = `<div class="deck">${SLIDE_A}${newSlide1}</div>`;
        const r = classifyDiff(deck, newDeck, {
            kind: 'element', slideIndex: 1,
            elementPath: 'slide-1.list-0.item-0',
        });
        expect(r.scopeDiff.scope.slideIndex).toBe(1);
        expect(r.scopeDiff.textDiff.length).toBeGreaterThan(0);
    });
});

// ── Audit Item 2: textChangedLocations counter ──────────────────────────────

describe('classifyDiff — textChangedLocations', () => {
    it('returns 0 when only whitespace changed', () => {
        const oldDeck = TWO_SLIDE_DECK(SLIDE_A, SLIDE_A);
        const newDeck = TWO_SLIDE_DECK(SLIDE_A, SLIDE_A);
        const r = classifyDiff(oldDeck, newDeck, { kind: 'slide', slideIndex: 0 });
        expect(r.textChangedLocations).toBe(0);
    });

    it('returns > 0 when text content changed', () => {
        const oldDeck = TWO_SLIDE_DECK(SLIDE_A, SLIDE_A);
        const newDeck = TWO_SLIDE_DECK(
            '<section class="slide"><h1>HELLO</h1><ul><li>One</li><li>Two</li></ul></section>',
            SLIDE_A,
        );
        const r = classifyDiff(oldDeck, newDeck, { kind: 'slide', slideIndex: 0 });
        expect(r.textChangedLocations).toBeGreaterThan(0);
    });
});

// ── Audit Item 3: siblingDrift for element scope ────────────────────────────

describe('classifyDiff — siblingDrift', () => {
    it('returns null for slide-scope refines', () => {
        const oldDeck = TWO_SLIDE_DECK(SLIDE_A, SLIDE_A);
        const newDeck = TWO_SLIDE_DECK(SLIDE_A, SLIDE_A);
        const r = classifyDiff(oldDeck, newDeck, { kind: 'slide', slideIndex: 0 });
        expect(r.siblingDrift).toBeNull();
    });

    it('returns null for range-scope refines', () => {
        const oldDeck = TWO_SLIDE_DECK(SLIDE_A, SLIDE_A);
        const newDeck = TWO_SLIDE_DECK(SLIDE_A, SLIDE_A);
        const r = classifyDiff(oldDeck, newDeck, { kind: 'range', slideIndex: 0, slideEndIndex: 1 });
        expect(r.siblingDrift).toBeNull();
    });
});

// ── Audit G1 + Gemini-r7-G1: element-paths-changed integrity ────────────────

describe('classifyDiff — element-paths-changed integrity', () => {
    it('reports preserved when path-set is preserved', () => {
        // Both slides have data-element attrs set; after refine they survive.
        const slide = '<section class="slide" data-element="slide-0"><h1 data-element="slide-0.heading">x</h1></section>';
        const r = classifyDiff(`<div class="deck">${slide}</div>`, `<div class="deck">${slide}</div>`, { kind: 'slide', slideIndex: 0 });
        expect(r.structuralIntegrity).toBe('preserved');
    });
});
