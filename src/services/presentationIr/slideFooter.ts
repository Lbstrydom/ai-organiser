/**
 * Slide footer lines — the ONE place that decides what a slide's `footnotes` and
 * `sources` look like as text, shared by `irToHtml` and `irToPptx` so the preview
 * and the export print the same lines (HTML/PPTX parity by construction).
 *
 * Also owns the "does this slide show figures without saying where they are from?"
 * check used by the storyboard translator and the tests.
 *
 * Pure — no Obsidian, no pptxgenjs, no DOM.
 */

import type { Block, SlideDeckIr, SlideIr } from './slideIr';

/** The joined source line is capped so a long list cannot grow the footer without bound. */
const MAX_SOURCE_LINE = 240;

/** Default label printed before the sources; callers may localise it. */
export const DEFAULT_SOURCE_LABEL = 'Source';

/**
 * Footer lines for a content slide, top to bottom: each footnote on its own line,
 * then ONE "Source: a; b" line. Empty when the slide carries neither.
 */
export function slideFooterLines(slide: Pick<SlideIr, 'footnotes' | 'sources'>, sourceLabel: string = DEFAULT_SOURCE_LABEL): string[] {
    const lines: string[] = [...(slide.footnotes ?? [])];
    const sources = slide.sources ?? [];
    if (sources.length > 0) {
        const line = `${sourceLabel.trim() || DEFAULT_SOURCE_LABEL}: ${sources.join('; ')}`;
        lines.push(line.length > MAX_SOURCE_LINE ? `${line.slice(0, MAX_SOURCE_LINE - 1).trimEnd()}…` : line);
    }
    return lines;
}

/** Block kinds whose point is to show figures. A table is not on the list: it may
 *  hold exact values OR plain text, and the storyboard translator decides from the
 *  evidence ids, not from the block shape. */
const FIGURE_KINDS: ReadonlySet<Block['kind']> = new Set(['stat-grid', 'bar-chart', 'waterfall', 'line-chart']);

function flatten(blocks: readonly Block[]): Block[] {
    return blocks.flatMap((b) => (b.kind === 'two-column' ? [b, ...flatten(b.left), ...flatten(b.right)] : [b]));
}

/** True when the slide contains a figure block (stat grid, bar chart, waterfall, line chart).
 *  Deliberately about BLOCKS: numbers in prose or tables are the translator's call (it reads the
 *  evidence ids), so this diagnostic stays conservative and never flags plain text. */
export function slideShowsFigures(slide: SlideIr): boolean {
    return flatten(slide.blocks).some((b) => FIGURE_KINDS.has(b.kind));
}

/** Indices of content slides that show figures but name no source: neither a slide
 *  `sources` line nor a `source` on every bar chart. Never invents a source — it only
 *  reports the gap. */
export function deckSourceGaps(deck: SlideDeckIr): number[] {
    const gaps: number[] = [];
    deck.slides.forEach((slide, i) => {
        if (slide.type !== 'content' || !slideShowsFigures(slide)) return;
        if ((slide.sources ?? []).length > 0) return;
        const blocks = flatten(slide.blocks);
        const charts = blocks.filter((b): b is Extract<Block, { kind: 'bar-chart' }> => b.kind === 'bar-chart');
        const onlyBarCharts = blocks.every((b) => !FIGURE_KINDS.has(b.kind) || b.kind === 'bar-chart');
        if (onlyBarCharts && charts.length > 0 && charts.every((c) => Boolean(c.source))) return;
        gaps.push(i);
    });
    return gaps;
}
