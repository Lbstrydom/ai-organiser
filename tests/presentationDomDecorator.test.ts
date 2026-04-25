/**
 * @vitest-environment happy-dom
 *
 * presentationDomDecorator unit tests.
 * Plan: docs/completed/slide-authoring-editing-backend.md §"Post-processor signature"
 */

import { describe, it, expect } from 'vitest';
import {
    projectForEditor,
    stripEditorAnnotations,
    extractScopedFragment,
    buildDeckContextSummary,
    buildDesignSummary,
    estimateScopedPromptChars,
} from '../src/services/chat/presentationDomDecorator';

const DECK_2_SLIDES = `
<div class="deck">
  <section class="slide slide-title">
    <h1>Q3 Update</h1>
    <h2>By Pat</h2>
    <aside class="speaker-notes">Open with the headline.</aside>
  </section>
  <section class="slide slide-content">
    <h1>Headline</h1>
    <ul>
      <li>Revenue +12%</li>
      <li>Margin held flat</li>
      <li>Capex up 4%</li>
    </ul>
    <img src="chart.png" alt="chart" />
    <table><tbody><tr><td>x</td></tr></tbody></table>
    <div class="callout">Important</div>
    <aside class="speaker-notes">Walk through bullets.</aside>
  </section>
</div>
`.trim();

describe('projectForEditor', () => {
    it('adds data-element to deck root', () => {
        const out = projectForEditor(DECK_2_SLIDES);
        expect(out).toContain('data-element="deck"');
    });

    it('adds data-element to each slide with 0-based indices', () => {
        const out = projectForEditor(DECK_2_SLIDES);
        expect(out).toContain('data-element="slide-0"');
        expect(out).toContain('data-element="slide-1"');
        expect(out).not.toContain('data-element="slide-2"');
    });

    it('marks first h1 / h2 in each slide as heading / subheading', () => {
        const out = projectForEditor(DECK_2_SLIDES);
        expect(out).toContain('data-element="slide-0.heading"');
        expect(out).toContain('data-element="slide-0.subheading"');
        expect(out).toContain('data-element="slide-1.heading"');
    });

    it('marks lists with index and items with parent-relative index', () => {
        const out = projectForEditor(DECK_2_SLIDES);
        expect(out).toContain('data-element="slide-1.list-0"');
        expect(out).toContain('data-element="slide-1.list-0.item-0"');
        expect(out).toContain('data-element="slide-1.list-0.item-1"');
        expect(out).toContain('data-element="slide-1.list-0.item-2"');
    });

    it('marks images, tables, callouts, speaker-notes', () => {
        const out = projectForEditor(DECK_2_SLIDES);
        expect(out).toContain('data-element="slide-1.image-0"');
        expect(out).toContain('data-element="slide-1.table-0"');
        expect(out).toContain('data-element="slide-1.callout-0"');
        expect(out).toContain('data-element="slide-0.speaker-notes"');
        expect(out).toContain('data-element="slide-1.speaker-notes"');
    });

    it('is idempotent — running twice produces the same output as once', () => {
        const once = projectForEditor(DECK_2_SLIDES);
        const twice = projectForEditor(once);
        expect(twice).toBe(once);
    });

    it('does NOT mutate the input string', () => {
        const original = DECK_2_SLIDES;
        projectForEditor(DECK_2_SLIDES);
        expect(original).toBe(DECK_2_SLIDES);
    });

    it('decorates `<pre>` once and does NOT also decorate inner `<code>` (R5 LOW-1 fix)', () => {
        // The earlier 'pre, code' selector forked the same code block into
        // two element-paths (`code-0` for the <pre>, `code-1` for the inner
        // <code>). The fix narrows to `pre`. This test pins that contract
        // to prevent re-introduction.
        const deck = '<div class="deck"><section class="slide"><pre><code>const x = 1;</code></pre></section></div>';
        const out = projectForEditor(deck);
        expect(out).toContain('data-element="slide-0.code-0"');
        expect(out).not.toContain('data-element="slide-0.code-1"');
        // The inner <code> should NOT have its own data-element attribute
        // (it's inside the <pre> we already decorated).
        const codeAttrs = out.match(/<code[^>]*>/g) ?? [];
        for (const tag of codeAttrs) {
            expect(tag).not.toContain('data-element');
        }
    });
});

describe('stripEditorAnnotations', () => {
    it('removes all data-element attributes', () => {
        const projected = projectForEditor(DECK_2_SLIDES);
        const stripped = stripEditorAnnotations(projected);
        expect(stripped).not.toContain('data-element');
    });

    it('preserves all other attributes and content', () => {
        const projected = projectForEditor(DECK_2_SLIDES);
        const stripped = stripEditorAnnotations(projected);
        expect(stripped).toContain('class="slide slide-content"');
        expect(stripped).toContain('Revenue +12%');
        expect(stripped).toContain('src="chart.png"');
    });
});

describe('Round-trip wrapper preservation (R2-H4 fix)', () => {
    const FULL_DOC = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
.deck { color: black; }
</style>
</head>
<body>
<div class="deck">
  <section class="slide"><h1>Title</h1></section>
</div>
</body>
</html>`;

    it('projectForEditor preserves <!DOCTYPE>, <head>, <style> when input is a full document', () => {
        const out = projectForEditor(FULL_DOC);
        expect(out.toLowerCase()).toContain('<!doctype html>');
        expect(out).toContain('<head>');
        expect(out).toContain('<style>');
        expect(out).toContain('.deck { color: black; }');
        expect(out).toContain('data-element="deck"');
        expect(out).toContain('data-element="slide-0"');
    });

    it('stripEditorAnnotations preserves <!DOCTYPE>, <head>, <style>', () => {
        const projected = projectForEditor(FULL_DOC);
        const stripped = stripEditorAnnotations(projected);
        expect(stripped.toLowerCase()).toContain('<!doctype html>');
        expect(stripped).toContain('<head>');
        expect(stripped).toContain('<style>');
        expect(stripped).not.toContain('data-element');
    });

    it('projectForEditor returns body fragment when input is a body fragment', () => {
        const out = projectForEditor(DECK_2_SLIDES);
        expect(out.toLowerCase()).not.toContain('<!doctype');
        expect(out.toLowerCase()).not.toContain('<html');
        expect(out.toLowerCase()).not.toContain('<head>');
        // But still has the deck content + projection annotations
        expect(out).toContain('class="deck"');
        expect(out).toContain('data-element="deck"');
    });
});

describe('extractScopedFragment', () => {
    it('returns empty string for out-of-bounds slide', () => {
        const out = extractScopedFragment(DECK_2_SLIDES, { kind: 'slide', slideIndex: 99 });
        expect(out).toBe('');
    });

    it('returns single slide outerHTML for slide scope', () => {
        const out = extractScopedFragment(DECK_2_SLIDES, { kind: 'slide', slideIndex: 0 });
        expect(out).toContain('<section');
        expect(out).toContain('Q3 Update');
        expect(out).not.toContain('Headline');  // slide 1 not included
    });

    it('returns concatenated slides for range scope', () => {
        const out = extractScopedFragment(DECK_2_SLIDES, { kind: 'range', slideIndex: 0, slideEndIndex: 1 });
        expect(out).toContain('Q3 Update');
        expect(out).toContain('Headline');
    });

    it('FAILS CLOSED for element scope when elementPath unspecified (H4 fix)', () => {
        const out = extractScopedFragment(DECK_2_SLIDES, { kind: 'element', slideIndex: 0 });
        expect(out).toBe('');
    });

    it('FAILS CLOSED for element scope when elementPath does not resolve (H4 fix)', () => {
        const out = extractScopedFragment(DECK_2_SLIDES, {
            kind: 'element', slideIndex: 0,
            elementPath: 'slide-99.list-0.item-0',
        });
        expect(out).toBe('');
    });

    it('returns target element fragment without data-element annotations', () => {
        const out = extractScopedFragment(DECK_2_SLIDES, {
            kind: 'element', slideIndex: 1,
            elementPath: 'slide-1.list-0.item-1',
        });
        expect(out).toContain('Margin held flat');
        expect(out).not.toContain('data-element');
    });

    it('resolves element scope on non-zero slides (H8 fix — projects whole deck)', () => {
        // Build a 3-slide deck where the target element is on slide 2.
        const deck = `<div class="deck">
          <section class="slide"><h1>Slide 0</h1></section>
          <section class="slide"><h1>Slide 1</h1></section>
          <section class="slide"><h1>Slide 2</h1><ul><li>Target</li><li>Other</li></ul></section>
        </div>`;
        const out = extractScopedFragment(deck, {
            kind: 'element', slideIndex: 2,
            elementPath: 'slide-2.list-0.item-0',
        });
        expect(out).toContain('Target');
        expect(out).not.toContain('Other');  // adjacent item, not in scope
        expect(out).not.toContain('data-element');
    });

    it('returns empty for invalid range', () => {
        const out = extractScopedFragment(DECK_2_SLIDES, { kind: 'range', slideIndex: 1, slideEndIndex: 0 });
        expect(out).toBe('');
    });
});

describe('buildDeckContextSummary', () => {
    it('reports slide count and section headings', () => {
        const out = buildDeckContextSummary(DECK_2_SLIDES);
        expect(out).toContain('2 slides');
        expect(out).toContain('Q3 Update');
        expect(out).toContain('Headline');
    });

    it('handles empty deck', () => {
        const out = buildDeckContextSummary('<div class="deck"></div>');
        expect(out).toBe('Empty deck.');
    });
});

describe('buildDesignSummary', () => {
    it('reports layout types and component counts', () => {
        const out = buildDesignSummary(DECK_2_SLIDES);
        expect(out).toContain('2 slides');
        expect(out).toContain('slide-title');
        expect(out).toContain('slide-content');
        expect(out).toContain('callout');
        expect(out).toContain('image');
    });

    it('handles empty deck', () => {
        const out = buildDesignSummary('<div class="deck"></div>');
        expect(out).toBe('Empty deck.');
    });
});

describe('estimateScopedPromptChars', () => {
    // Both content and design modes ship FULL canonical HTML to the LLM
    // (architectural decision after Gemini v4 round — see prompt builders).
    // The estimator must therefore reflect canonical HTML size, not a
    // fragment-plus-summary approximation. Tests below pin that contract.

    it('content mode counts canonical HTML size (not fragment)', () => {
        const chars = estimateScopedPromptChars(DECK_2_SLIDES, { kind: 'slide', slideIndex: 0 }, 'content');
        // System overhead 6000 + canonicalHtml * 2 (canonical + scoped fragment subtree)
        expect(chars).toBeGreaterThanOrEqual(DECK_2_SLIDES.length);
    });

    it('design mode counts canonical HTML size (not fragment)', () => {
        const chars = estimateScopedPromptChars(DECK_2_SLIDES, { kind: 'slide', slideIndex: 0 }, 'design');
        expect(chars).toBeGreaterThanOrEqual(DECK_2_SLIDES.length);
    });

    it('design mode on a large deck reports the actual prompt cost (not a summary stub)', () => {
        // R5 fix: estimator was previously underreporting for large decks
        // because it pretended design mode would fall back to a summary.
        // The real prompt builder always sends full HTML, so the gate
        // must reflect that — otherwise prompts get silently truncated by
        // sanitizeHtmlForPrompt at the 120 KB cap.
        const big = '<div class="deck">' + Array(50).fill(0).map((_, i) =>
            `<section class="slide slide-content"><h1>S${i}</h1><p>${'x'.repeat(900)}</p></section>`
        ).join('') + '</div>';
        const chars = estimateScopedPromptChars(big, { kind: 'slide', slideIndex: 0 }, 'design');
        // Should be AT LEAST as large as the deck — overcounting is the
        // safe direction for a budget gate.
        expect(chars).toBeGreaterThanOrEqual(big.length);
    });

    it('counts user request, references, and web research overhead', () => {
        const baseline = estimateScopedPromptChars(DECK_2_SLIDES, { kind: 'slide', slideIndex: 0 }, 'content');
        const withExtras = estimateScopedPromptChars(DECK_2_SLIDES, { kind: 'slide', slideIndex: 0 }, 'content', {
            userRequest: 'x'.repeat(500),
            references: 'y'.repeat(2000),
            webResearch: 'z'.repeat(1000),
        });
        expect(withExtras).toBeGreaterThanOrEqual(baseline + 3500);
    });
});
