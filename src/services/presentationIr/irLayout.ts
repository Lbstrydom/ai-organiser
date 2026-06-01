/**
 * Pure layout math for the IR→PPTX renderer — the single source of truth for
 * slide geometry (inches, 16:9 LAYOUT_WIDE canvas 13.33 × 7.5). No Obsidian,
 * no pptxgenjs — fully unit-testable (plan M1).
 */

export const CANVAS = { w: 13.33, h: 7.5 } as const;
export const MARGIN = 0.5;
export const CONTENT_TOP = 1.3;     // below the title/branded zone
export const FOOTER_Y = 7.1;        // reserved footer band start
export const COL_GAP = 0.3;

export const CONTENT_WIDTH = CANVAS.w - 2 * MARGIN;          // 12.33
export const CONTENT_HEIGHT = FOOTER_Y - CONTENT_TOP;        // 5.8

export interface Box { x: number; y: number; w: number; h: number }

/** Left/right column boxes for a two-column slide. */
export function splitColumns(): { left: { x: number; w: number }; right: { x: number; w: number } } {
    const w = (CONTENT_WIDTH - COL_GAP) / 2;
    return {
        left: { x: MARGIN, w },
        right: { x: MARGIN + w + COL_GAP, w },
    };
}

/** Evenly-spaced column slots across the content width (e.g. stat cards).
 *  Width is clamped to ≥ 0 so a pathological count never yields negative
 *  geometry (audit M2). */
export function gridColumns(n: number): { x: number; w: number }[] {
    if (n <= 0) return [];
    const w = Math.max(0, (CONTENT_WIDTH - COL_GAP * (n - 1)) / n);
    return Array.from({ length: n }, (_, i) => ({ x: MARGIN + i * (w + COL_GAP), w }));
}

/**
 * Estimate rendered text height (inches) for a given box width + font size.
 * Heuristic — deliberately conservative so blocks don't silently overlap.
 */
export function estimateTextHeight(textContent: string, widthIn: number, fontSizePt: number): number {
    const avgCharWidthIn = (fontSizePt * 0.5) / 72;          // ~0.5em per char at the given pt
    const safeWidth = Math.max(0.5, widthIn);
    const charsPerLine = Math.max(8, Math.floor(safeWidth / avgCharWidthIn));
    // Count wrapped lines per explicit newline so multi-line text isn't
    // under-measured (audit M4).
    const lines = textContent.split('\n').reduce(
        (acc, ln) => acc + Math.max(1, Math.ceil(ln.length / charsPerLine)), 0);
    const lineHeightIn = (fontSizePt * 1.35) / 72;
    return Math.max(1, lines) * lineHeightIn + 0.05;
}

/**
 * Proportional column widths for a table, normalized so their sum is EXACTLY
 * `contentWidth` (plan H4 — fixes the off-slide overflow). Weights derive from
 * each column's longest cell; there is NO per-column minimum (a hard min would
 * contradict the sum constraint when minWidth·cols > contentWidth — cells wrap
 * instead).
 */
export function tableColumnWidths(headers: string[], rows: string[][], contentWidth: number): number[] {
    const n = headers.length;
    if (n === 0) return [];
    if (contentWidth <= 0) return headers.map(() => 0);     // degenerate guard (M2)
    const weights = headers.map((h, c) => {
        let maxLen = h.length;
        for (const row of rows) {
            const cell = row[c] ?? '';
            if (cell.length > maxLen) maxLen = cell.length;
        }
        return Math.max(1, maxLen);
    });
    const total = weights.reduce((a, b) => a + b, 0);
    const widths = weights.map(w => (w / total) * contentWidth);
    // Absorb floating-point drift into the last column so the sum is exact.
    const sumExceptLast = widths.slice(0, -1).reduce((a, b) => a + b, 0);
    widths[n - 1] = contentWidth - sumExceptLast;
    return widths;
}

