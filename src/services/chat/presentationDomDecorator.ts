/**
 * Presentation DOM Decorator
 *
 * Pure DOM utilities for the targeted slide editing feature. No LLM, no
 * Obsidian APIs — uses DOMParser from the hosting environment (Obsidian
 * supplies `window.DOMParser`; tests use `happy-dom`).
 *
 * Plan: docs/completed/slide-authoring-editing.md +
 *       docs/completed/slide-authoring-editing-backend.md
 *
 * Critical separation enforced here:
 *   - CANONICAL HTML — what the handler holds, save/export/diff/prompt all read it.
 *     No editor instrumentation.
 *   - PROJECTED HTML — `projectForEditor(canonical)` adds `data-element` attributes
 *     for iframe selection resolution. Consumed only by SlideIframePreview.
 *
 * `compareSlides` (in presentationDiff.ts) operates on canonical, so editor
 * instrumentation never shows up as drift.
 */

import type { SelectionScope, EditMode } from './presentationTypes';
import { SLIDE_SELECTOR } from './presentationConstants';

// ── Projection: canonical → editor-projected ────────────────────────────────

/**
 * Add `data-element` attributes to addressable subtrees for iframe selection.
 * Returns a NEW HTML string. Input is never mutated. Idempotent — running
 * twice produces the same output as running once (existing data-element
 * attributes are overwritten, not stacked).
 *
 * Element identity scheme:
 *   .deck                       → 'deck'
 *   section.slide (Nth)         → 'slide-N' (0-based DOM order)
 *   slide.h1                    → 'slide-N.heading'
 *   slide.h2                    → 'slide-N.subheading'
 *   slide.ul / slide.ol (Kth)   → 'slide-N.list-K' (0-based among lists in slide)
 *   slide.li                    → 'slide-N.list-K.item-J' (J = position within owner list)
 *   slide.img (Pth)             → 'slide-N.image-P'
 *   slide.figure (Pth)          → 'slide-N.figure-P'
 *   slide.table (Pth)           → 'slide-N.table-P'
 *   slide.callout (Pth)         → 'slide-N.callout-P'
 *   slide.col-container (Pth)   → 'slide-N.col-container-P'
 *   slide.col (Pth)             → 'slide-N.col-P'
 *   slide.stats-grid (Pth)      → 'slide-N.stats-grid-P'
 *   slide.blockquote (Pth)      → 'slide-N.quote-P'
 *   slide.pre / slide.code (Pth)→ 'slide-N.code-P'
 *   slide.aside.speaker-notes   → 'slide-N.speaker-notes'
 */
export function projectForEditor(canonicalHtml: string): string {
    const parser = new DOMParser();
    const doc = parser.parseFromString(canonicalHtml, 'text/html');

    const deck = doc.querySelector('.deck');
    if (deck) deck.setAttribute('data-element', 'deck');

    const slides = Array.from(doc.querySelectorAll(SLIDE_SELECTOR));
    for (let n = 0; n < slides.length; n++) {
        const slide = slides[n];
        slide.setAttribute('data-element', `slide-${n}`);
        decorateSlideElements(slide, n);
    }

    return serializePreservingWrapper(canonicalHtml, doc);
}

/** Decorate addressable elements within a single slide. */
function decorateSlideElements(slide: Element, slideIndex: number): void {
    // Track per-kind counters within the slide (separate from list-item counters).
    const counters: Record<string, number> = {};

    // Lists need special handling — items reference their parent list's index.
    const lists = Array.from(slide.querySelectorAll('ul, ol'));
    for (let k = 0; k < lists.length; k++) {
        lists[k].setAttribute('data-element', `slide-${slideIndex}.list-${k}`);
        const items = Array.from(lists[k].querySelectorAll(':scope > li'));
        for (let j = 0; j < items.length; j++) {
            items[j].setAttribute('data-element', `slide-${slideIndex}.list-${k}.item-${j}`);
        }
    }
    counters.list = lists.length;

    // Headings are unique per slide (h1) or limited (h2). Tag the first of each.
    const h1 = slide.querySelector('h1');
    if (h1 && !h1.hasAttribute('data-element')) {
        h1.setAttribute('data-element', `slide-${slideIndex}.heading`);
    }
    const h2 = slide.querySelector('h2');
    if (h2 && !h2.hasAttribute('data-element')) {
        h2.setAttribute('data-element', `slide-${slideIndex}.subheading`);
    }

    // Other addressable kinds — index per-kind in DOM order.
    decorateByKind(slide, slideIndex, 'image', 'img', counters);
    decorateByKind(slide, slideIndex, 'figure', 'figure', counters);
    decorateByKind(slide, slideIndex, 'table', 'table', counters);
    decorateByKind(slide, slideIndex, 'callout', '.callout, .stat-card', counters);
    decorateByKind(slide, slideIndex, 'col-container', '.col-container', counters);
    decorateByKind(slide, slideIndex, 'col', '.col', counters);
    decorateByKind(slide, slideIndex, 'stats-grid', '.stats-grid', counters);
    decorateByKind(slide, slideIndex, 'quote', 'blockquote', counters);
    // `pre` only, not `pre, code` — `<code>` inside `<pre>` would otherwise
    // double-decorate the same code block as both `code-0` (the <pre>) and
    // `code-1` (the inner <code>), forking element-paths over a single
    // semantic target. Inline `<code>` (outside `<pre>`) is phrasing
    // content, not a scoped editing target. (Gemini final-gate R5 finding.)
    decorateByKind(slide, slideIndex, 'code', 'pre', counters);

    // Speaker notes are typically unique per slide — tag without index.
    const notes = slide.querySelector('aside.speaker-notes');
    if (notes && !notes.hasAttribute('data-element')) {
        notes.setAttribute('data-element', `slide-${slideIndex}.speaker-notes`);
    }
}

function decorateByKind(
    slide: Element,
    slideIndex: number,
    kindLabel: string,
    selector: string,
    counters: Record<string, number>,
): void {
    const elements = Array.from(slide.querySelectorAll(selector));
    let p = 0;
    for (const el of elements) {
        if (el.hasAttribute('data-element')) continue;
        el.setAttribute('data-element', `slide-${slideIndex}.${kindLabel}-${p}`);
        p++;
    }
    counters[kindLabel] = (counters[kindLabel] ?? 0) + p;
}

/**
 * Inverse of `projectForEditor` — strips all `data-element` attributes.
 * Defensive: runs after every LLM response in case the model echoed back
 * `data-element` attributes from the prompt context (the prompt sends
 * canonical HTML so this is mostly belt-and-braces).
 *
 * **Input contract**: this function is meant for FULL HTML documents — what
 * the LLM emits, what `wrapInDocument` produces. It re-parses via DOMParser
 * which silently strips context-dependent fragments (`<tr>` outside
 * `<table>`, `<col>`, etc.). Callers that need to strip annotations from a
 * single element subtree should clone the node and walk its descendants
 * directly (see `extractScopedFragment` for the pattern), NOT round-trip
 * through this function. (Gemini final-gate finding 2026-04-25.)
 */
export function stripEditorAnnotations(html: string): string {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const annotated = doc.querySelectorAll('[data-element]');
    for (const el of Array.from(annotated)) {
        el.removeAttribute('data-element');
    }
    return serializePreservingWrapper(html, doc);
}

/**
 * Serialise a DOMParser-parsed doc back to HTML, preserving whatever wrapper
 * structure the input had (R2-H4 fix, 2026-04-25). DOMParser always builds
 * a full `<html><head></head><body></body></html>` tree even when given a
 * fragment, so we detect what the input actually had and serialise to match:
 *
 *  - Input was a full document (`<!DOCTYPE>` / `<html>` / `<body>`)
 *      → serialise the whole `documentElement` (or prepend doctype if present)
 *  - Input was a body fragment (`<div class="deck">…</div>`)
 *      → serialise only `body.innerHTML`
 *
 * Without this, calling `projectForEditor` on a wrapped document would
 * silently drop the `<head>`, `<style>`, and CSP injection produced by
 * `wrapInDocument` upstream.
 */
function serializePreservingWrapper(originalHtml: string, doc: Document): string {
    const lower = originalHtml.toLowerCase();
    const hasFullDocument = lower.includes('<!doctype') || lower.includes('<html');
    if (!hasFullDocument) {
        return doc.body.innerHTML;
    }
    const root = doc.documentElement;
    if (!root) return doc.body.innerHTML;
    // Preserve the doctype if present in the input.
    const doctypeMatch = /^\s*<!doctype[^>]*>/i.exec(originalHtml);
    const doctype = doctypeMatch ? doctypeMatch[0] : '';
    return `${doctype}${root.outerHTML}`;
}

// ── Scoped fragment extraction ──────────────────────────────────────────────

/**
 * Extract the affected DOM subtree for a given selection scope. Used to
 * build the prompt context for content-mode edits — sending only what the
 * LLM should touch makes byte-for-byte preservation structurally trivial.
 *
 * Returns the outer HTML of the extracted region, or empty string if scope
 * doesn't resolve.
 *
 * Element scope is **fail-closed** (H4 fix, 2026-04-25): missing
 * `elementPath` or path that doesn't resolve in the projection returns
 * empty string rather than silently falling back to the whole slide. The
 * caller must check for empty and surface a clear error rather than
 * widening scope unintentionally.
 *
 * Element extraction projects the WHOLE deck (H8 fix, 2026-04-25) so
 * element paths like `slide-2.list-0.item-0` resolve correctly regardless
 * of the slide's position. Projecting only the single slide produced
 * `slide-0.*` paths and broke non-zero-indexed slide lookups.
 */
export function extractScopedFragment(canonicalHtml: string, scope: SelectionScope): string {
    const parser = new DOMParser();
    const doc = parser.parseFromString(canonicalHtml, 'text/html');
    const slides = Array.from(doc.querySelectorAll(SLIDE_SELECTOR));

    if (scope.slideIndex < 0 || scope.slideIndex >= slides.length) return '';

    if (scope.kind === 'range') {
        const end = scope.slideEndIndex ?? scope.slideIndex;
        if (end < scope.slideIndex || end >= slides.length) return '';
        return slides.slice(scope.slideIndex, end + 1)
            .map(s => s.outerHTML)
            .join('\n\n');
    }

    if (scope.kind === 'slide') {
        return slides[scope.slideIndex].outerHTML;
    }

    // 'element' — fail-closed semantics.
    if (!scope.elementPath) return '';

    // Project the WHOLE deck so element paths use the correct slide index.
    // Projecting only the single slide would re-number it as slide-0 and
    // break path lookups for any non-zero slide.
    const projectedDeck = projectForEditor(canonicalHtml);
    const projDoc = parser.parseFromString(projectedDeck, 'text/html');
    const target = projDoc.querySelector(`[data-element="${cssAttrEscape(scope.elementPath)}"]`);
    if (!target) return '';  // fail-closed: caller must handle empty

    // Strip projection annotations from the matched fragment before returning,
    // so the LLM sees canonical content. Clone + walk descendants to remove
    // attributes — avoids innerHTML writes which the SDL lint rule rejects.
    const clone = target.cloneNode(true) as HTMLElement;
    delete clone.dataset.element;
    clone.querySelectorAll<HTMLElement>('[data-element]').forEach(e => {
        delete e.dataset.element;
    });
    return clone.outerHTML;
}

/** Escape a value for use inside a CSS attribute selector. */
function cssAttrEscape(value: string): string {
    return value.replaceAll(/["\\]/g, '\\$&');
}

// ── Deck context summaries ──────────────────────────────────────────────────

/**
 * Compact text summary of the deck for content-mode edits. Lets the LLM
 * understand "this is a Q3 board update with sections X, Y, Z" without
 * shipping the full HTML.
 */
export function buildDeckContextSummary(canonicalHtml: string): string {
    const parser = new DOMParser();
    const doc = parser.parseFromString(canonicalHtml, 'text/html');
    const slides = Array.from(doc.querySelectorAll(SLIDE_SELECTOR));
    if (slides.length === 0) return 'Empty deck.';

    const titleEl = doc.querySelector('.deck h1, .slide-title h1');
    const title = titleEl?.textContent?.trim() ?? '(untitled)';

    const sectionHeadings = slides
        .map(s => s.querySelector('h1, h2')?.textContent?.trim() ?? '')
        .filter(Boolean);

    return [
        `Deck: ${slides.length} slides.`,
        `Title: "${title}".`,
        sectionHeadings.length
            ? `Section headings (in order): ${sectionHeadings.map(h => `"${h}"`).join(', ')}.`
            : null,
    ].filter(Boolean).join('\n');
}

/**
 * Compact design-language token sheet for design-mode edits on large decks.
 * Captures colours, layouts, spacing patterns observed across the deck so
 * a scoped design change can stay consistent without seeing all content.
 *
 * Output is text — no full HTML — so the LLM sees the design vocabulary
 * without the bulk of the slide bodies.
 */
export function buildDesignSummary(canonicalHtml: string): string {
    const parser = new DOMParser();
    const doc = parser.parseFromString(canonicalHtml, 'text/html');
    const slides = Array.from(doc.querySelectorAll(SLIDE_SELECTOR));
    if (slides.length === 0) return 'Empty deck.';

    // Layout patterns
    const layouts: Record<string, number> = {};
    for (const s of slides) {
        const cls = (s.getAttribute('class') ?? '')
            .split(/\s+/)
            .filter(c => c.startsWith('slide-'));
        for (const c of cls) layouts[c] = (layouts[c] ?? 0) + 1;
    }

    // Components used
    const components = {
        colContainer: doc.querySelectorAll('.col-container').length,
        statsGrid: doc.querySelectorAll('.stats-grid').length,
        callout: doc.querySelectorAll('.callout, .stat-card').length,
        table: doc.querySelectorAll('table').length,
        figure: doc.querySelectorAll('figure').length,
        image: doc.querySelectorAll('img').length,
    };

    const layoutLine = Object.entries(layouts)
        .map(([k, n]) => `${k} (${n})`)
        .join(', ');
    const componentLine = Object.entries(components)
        .filter(([, n]) => n > 0)
        .map(([k, n]) => `${k} (${n})`)
        .join(', ');

    return [
        `Deck design summary: ${slides.length} slides.`,
        `Layout types: ${layoutLine || '(none)'}.`,
        `Components: ${componentLine || '(none)'}.`,
        'Use the existing CSS classes — do not introduce new ones.',
        'Match the deck\'s visual rhythm for the scoped change.',
    ].join('\n');
}

// ── Token budget preflight ──────────────────────────────────────────────────

/**
 * Estimate the prompt size (in chars) for a scoped edit BEFORE actually
 * building the prompt. Used to gate calls.
 *
 * **Must match what the prompt builders actually emit.** Both
 * `buildScopedContentEditPrompt` and `buildScopedDesignEditPrompt` embed the
 * FULL canonical HTML in `<current_html>` (architectural decision after
 * Gemini v4 round — the LLM cannot preserve byte-for-byte slides it never
 * saw). The estimator must therefore count `canonicalHtml.length` directly,
 * NOT a fragment-plus-summary approximation, otherwise large decks pass the
 * preflight gate and then get silently truncated by `sanitizeHtmlForPrompt`
 * at the 120 KB cap — re-introducing the orchestration paradox the v4 round
 * supposedly closed. (Gemini final-gate finding R5, 2026-04-25.)
 *
 * Approximations are intentional for token math — exact token counts vary
 * by tokenizer. Char count is a stable proxy.
 */
export function estimateScopedPromptChars(
    canonicalHtml: string,
    _scope: SelectionScope,
    _mode: EditMode,
    extras: { references?: string; webResearch?: string; userRequest?: string } = {},
): number {
    const SYSTEM_PROMPT_OVERHEAD = 6_000;
    const extra =
        (extras.references?.length ?? 0)
        + (extras.webResearch?.length ?? 0)
        + (extras.userRequest?.length ?? 0);

    // Both content and design modes ship full canonical HTML plus the
    // scoped fragment as a separate <scoped_fragment> block. The fragment
    // is a subtree of the canonical HTML, so we approximate the doubled
    // serialisation cost by counting canonicalHtml twice — overcounts
    // slightly (which is the safe direction for a budget gate).
    return SYSTEM_PROMPT_OVERHEAD + canonicalHtml.length * 2 + extra;
}
