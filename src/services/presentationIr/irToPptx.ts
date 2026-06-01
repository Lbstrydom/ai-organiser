/**
 * IR → PPTX renderer. Deterministic, never throws — returns `Result`. No DOM
 * parsing: every slide is composed from native pptxgenjs primitives
 * (text boxes, shapes, tables, charts, images) placed by the pure geometry in
 * `irLayout.ts`. This is the core fix for the HTML-reverse-engineering defect.
 *
 * Test/DI seam (plan M3): `opts.pptxModule` injects a pptxgenjs stub so tests
 * can assert which primitives each slide emitted without parsing the .pptx zip,
 * and can force per-block failures to prove isolation.
 *
 * Phase A renders synchronously, so the `custom`/`svg` escape hatch degrades to
 * a labelled placeholder. Phase B injects a canvas/iframe rasterizer (see
 * `RasterizeFn`) to turn those into images. Plan:
 * docs/plans/presentation-structured-ir.md
 */

import type { Result } from '../../core/result';
import { ok, err } from '../../core/result';
import type { ExportTheme } from '../export/exportTheme';
import { sanitizeSvgMarkup } from '../chat/presentationSanitizer';
import {
    CANVAS, MARGIN, CONTENT_TOP, CONTENT_WIDTH, FOOTER_Y,
    splitColumns, gridColumns, estimateTextHeight, tableColumnWidths,
} from './irLayout';
import type { Block, FidelityNotice, LeafBlock, SlideDeckIr, SlideIr } from './slideIr';
import { contrastTextColor } from './slideIr';
import { IR_RENDER_SPEC } from './irRenderSpec';

// ── Injected pptxgenjs surface (structural typing — avoids `any`) ────────────

interface SlideLike {
    background?: { color: string };
    addText(text: unknown, opts: Record<string, unknown>): void;
    addShape(shape: string, opts: Record<string, unknown>): void;
    addTable(rows: unknown[], opts: Record<string, unknown>): void;
    addChart(type: unknown, data: unknown, opts: Record<string, unknown>): void;
    addImage(opts: Record<string, unknown>): void;
    addNotes(notes: string): void;
}
interface PptxLike {
    layout: string;
    addSlide(): SlideLike;
    write(opts: { outputType: string }): Promise<unknown>;
}
type PptxCtor = new () => PptxLike;

/** Escape-hatch rasterizer (plan H4/G2). Input markup is ALREADY sanitized;
 *  target pixel dims let it wrap text + match aspect ratio. Returns a raster
 *  data-URI. Injected app-side (Phase B); absent in the pure core. */
export type RasterizeFn = (input: { html?: string; svg?: string; widthPx: number; heightPx: number }) => Promise<string>;

export interface RenderPptxOptions {
    barChartStyle?: 'native' | 'bars';
    /** Escape-hatch rasterizer for `custom.html` / fallback `svg` (plan H4). */
    rasterize?: RasterizeFn;
    /** Test seam — inject a pptxgenjs stub/class. Defaults to the real module. */
    pptxModule?: PptxCtor;
}

export interface PptxRenderOutput {
    buffer: ArrayBuffer;
    slideCount: number;
    notices: FidelityNotice[];
    downgrades: string[];
}

const hx = (hex: string): string => hex.replace('#', '');

interface RenderState {
    barStyle: 'native' | 'bars';
    theme: ExportTheme;
    rasterize?: RasterizeFn;
    notices: FidelityNotice[];
    downgrades: string[];
}

const PX_PER_IN = 96;

export async function renderDeckToPptx(
    deck: SlideDeckIr,
    theme: ExportTheme,
    opts: RenderPptxOptions = {},
): Promise<Result<PptxRenderOutput>> {
    // Defensive guard (audit M1) — dereference safely before the main try.
    if (!deck || !Array.isArray(deck.slides) || deck.slides.length === 0) return err('empty-deck');

    const state: RenderState = { barStyle: opts.barChartStyle ?? 'native', theme, rasterize: opts.rasterize, notices: [], downgrades: [] };

    let pres: PptxLike;
    try {
        const Ctor: PptxCtor = opts.pptxModule ?? ((await import('pptxgenjs')).default as unknown as PptxCtor);
        pres = new Ctor();
        pres.layout = 'LAYOUT_WIDE';
    } catch (e) {
        return err(`fatal: pptxgenjs init failed: ${msg(e)}`);
    }

    let slideCount = 0;
    for (let i = 0; i < deck.slides.length; i++) {
        try {
            await renderSlide(pres, deck.slides[i], i, state);
            slideCount++;
        } catch (e) {
            // Per-slide isolation — one bad slide never kills the deck.
            state.notices.push({ slideIndex: i, blockKind: 'paragraph', severity: 'substantive', description: `slide ${i} failed: ${msg(e)}` });
        }
    }

    // All slides failed → don't hand back a successful-looking empty export
    // (audit H4/M10).
    if (slideCount === 0) return err('fatal: every slide failed to render');

    try {
        const out = await pres.write({ outputType: 'arraybuffer' });
        const buffer = toArrayBuffer(out);
        if (!buffer) return err('fatal: pptxgenjs returned unexpected output type');
        return ok({ buffer, slideCount, notices: state.notices, downgrades: state.downgrades });
    } catch (e) {
        return err(`fatal: pptx write failed: ${msg(e)}`);
    }
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function toArrayBuffer(out: unknown): ArrayBuffer | null {
    if (out instanceof ArrayBuffer) return out;
    if (out instanceof Uint8Array) {
        const copy = new ArrayBuffer(out.byteLength);
        new Uint8Array(copy).set(out);
        return copy;
    }
    return null;
}

interface Box { x: number; y: number; w: number }

async function renderSlide(pres: PptxLike, slide: SlideIr, index: number, st: RenderState): Promise<void> {
    const { theme } = st;
    const s = pres.addSlide();

    if (slide.type === 'title' || slide.type === 'section' || slide.type === 'closing') {
        // Solid backgrounds. We previously tried approximating the HTML's
        // diagonal gradient (primary→sectionBg) by stacking 16, then 40
        // interpolated horizontal bands — but PowerPoint's rendering quantises
        // adjacent thin-rect boundaries into visible seams that no amount of
        // overlap fully hides, and pptxgenjs 4.0.1 has no per-shape gradient
        // fill in its public API (the `gradFill` XML in its runtime is
        // theme-boilerplate-only). Solid reads cleaner than a banded gradient
        // — and matches the original PowerPoint export anyway, since browsers
        // are the only place the CSS gradient was ever visible.
        // Per-slide background override (auto-contrast text) wins over the theme.
        const bg = slide.background ?? (slide.type === 'section' ? theme.sectionBg : theme.primaryColor);
        const fg = slide.background ? contrastTextColor(slide.background) : 'FFFFFF';
        s.background = { color: hx(bg) };
        const heroAlign = IR_RENDER_SPEC.titleLayout.align;   // #3 — left (matches HTML hero)
        s.addText(slide.title ?? '', {
            x: MARGIN, y: CANVAS.h / 2 - 1, w: CONTENT_WIDTH, h: 1.4,
            fontFace: theme.fontFace, fontSize: slide.type === 'title' ? 40 : 34,
            color: fg, bold: true, align: heroAlign, valign: 'middle',
        });
        if (slide.subtitle) {
            s.addText(slide.subtitle, {
                x: MARGIN, y: CANVAS.h / 2 + 0.5, w: CONTENT_WIDTH, h: 0.9,
                fontFace: theme.fontFace, fontSize: 18, color: fg, align: heroAlign, valign: 'middle',
            });
        }
        if (slide.notes) s.addNotes(slide.notes);
        return;
    }

    // Content slide: title + accent UNDERLINE (motif shared with HTML — #2) + blocks.
    // (The old full-width top bar was a PPTX-only motif that diverged from the
    // preview; both now draw a short underline beneath the title.)
    if (slide.title) {
        s.addText(slide.title, { x: MARGIN, y: 0.35, w: CONTENT_WIDTH, h: 0.6, fontFace: theme.fontFace, fontSize: 24, bold: true, color: hx(theme.primaryColor) });
        const u = IR_RENDER_SPEC.accentUnderline;
        s.addShape('rect', { x: MARGIN, y: 0.35 + 0.6 + u.gapBelowTitleIn * 0.5, w: u.widthIn, h: u.heightIn, fill: { color: hx(theme.accentColor) }, line: { width: 0 } });
    }
    await flowBlocks(s, slide.blocks, { x: MARGIN, y: CONTENT_TOP, w: CONTENT_WIDTH }, index, st);
    if (slide.notes) s.addNotes(slide.notes);
}

/** Place blocks top-to-bottom within a column box, advancing a y cursor. */
async function flowBlocks(s: SlideLike, blocks: Block[], box: Box, slideIndex: number, st: RenderState): Promise<void> {
    let y = box.y;
    for (const block of blocks) {
        if (y >= FOOTER_Y) {
            st.notices.push({ slideIndex, blockKind: block.kind, severity: 'substantive', description: `block "${block.kind}" clipped — content exceeds slide.` });
            continue;
        }
        try {
            y += await renderBlock(s, block, { x: box.x, y, w: box.w }, slideIndex, st) + 0.12;
        } catch (e) {
            st.notices.push({ slideIndex, blockKind: block.kind, severity: 'substantive', description: `block "${block.kind}" failed: ${msg(e)}` });
        }
    }
}

/** Clamp a block's height to the remaining content zone so it never runs off
 *  the slide; emit a clip notice when it had to be cut (audit H7). */
function clampH(natural: number, box: Box, kind: Block['kind'], slideIndex: number, st: RenderState): number {
    const remaining = FOOTER_Y - box.y;
    if (natural > remaining) {
        st.notices.push({ slideIndex, blockKind: kind, severity: 'substantive', description: `block "${kind}" clipped to fit slide.` });
        return Math.max(0.2, remaining);
    }
    return natural;
}

/** Render one block at `box`; return the height it consumed (inches). */
async function renderBlock(s: SlideLike, block: Block, box: Box, slideIndex: number, st: RenderState): Promise<number> {
    const { theme } = st;
    switch (block.kind) {
        case 'heading': {
            const size = block.level === 1 ? 22 : block.level === 2 ? 18 : 15;
            const h = clampH(estimateTextHeight(block.text, box.w, size), box, block.kind, slideIndex, st);
            s.addText(block.text, { x: box.x, y: box.y, w: box.w, h, fontFace: theme.fontFace, fontSize: size, bold: true, color: hx(theme.primaryColor), valign: 'top' });
            return h;
        }
        case 'paragraph': {
            const h = clampH(estimateTextHeight(block.text, box.w, theme.fontSize), box, block.kind, slideIndex, st);
            s.addText(block.text, { x: box.x, y: box.y, w: box.w, h, fontFace: theme.fontFace, fontSize: theme.fontSize, bold: Boolean(block.emphasis), color: hx(theme.bodyColor), valign: 'top' });
            return h;
        }
        case 'caption': {
            const h = clampH(estimateTextHeight(block.text, box.w, theme.fontSize - 2), box, block.kind, slideIndex, st);
            s.addText(block.text, { x: box.x, y: box.y, w: box.w, h, fontFace: theme.fontFace, fontSize: theme.fontSize - 2, italic: true, color: hx(theme.bodyColor), valign: 'top' });
            return h;
        }
        case 'bullets': {
            const lines = block.items.map(it => ({ text: it, options: { bullet: block.ordered ? { type: 'number' as const } : true } }));
            const h = clampH(Math.max(0.4, block.items.length * 0.32), box, block.kind, slideIndex, st);
            s.addText(lines, { x: box.x, y: box.y, w: box.w, h, fontFace: theme.fontFace, fontSize: theme.fontSize, color: hx(theme.bodyColor), valign: 'top' });
            return h;
        }
        case 'callout': {
            const h = clampH(estimateTextHeight(block.text, box.w - 0.4, theme.fontSize) + 0.3, box, block.kind, slideIndex, st);
            s.addShape('rect', { x: box.x, y: box.y, w: box.w, h, fill: { color: lighten(theme.accentColor) }, line: { color: hx(theme.accentColor), width: 1 } });
            s.addText(block.text + (block.cite ? `  — ${block.cite}` : ''), { x: box.x + 0.2, y: box.y + 0.1, w: box.w - 0.4, h: h - 0.2, fontFace: theme.fontFace, fontSize: theme.fontSize, color: hx(theme.bodyColor), valign: 'middle' });
            return h;
        }
        case 'stat-grid': {
            const cols = gridColumns(block.cards.length);
            const scale = box.w / CONTENT_WIDTH;
            const h = 1.3;
            block.cards.forEach((card, i) => {
                const col = cols[i];
                const x = box.x + (col.x - MARGIN) * scale;
                const w = col.w * scale;
                s.addShape('roundRect', { x, y: box.y, w, h, rectRadius: 0.08, fill: { color: lighten(theme.accentColor) }, line: { color: hx(theme.accentColor), width: 1 } });
                s.addText((card.icon ? `${card.icon}  ` : '') + card.value, { x, y: box.y + 0.15, w, h: 0.6, fontFace: theme.fontFace, fontSize: 22, bold: true, color: hx(theme.primaryColor), align: 'center', valign: 'middle' });
                s.addText(card.label, { x, y: box.y + 0.75, w, h: 0.45, fontFace: theme.fontFace, fontSize: 11, color: hx(theme.bodyColor), align: 'center', valign: 'top' });
            });
            return h;
        }
        case 'bar-chart':
            return renderBarChart(s, block, box, slideIndex, st);
        case 'process-flow': {
            const n = block.steps.length;
            // Widened from 0.15 → 0.28 to fit a chevron in each inter-step gap.
            const gap = 0.28;
            const stepW = (box.w - gap * (n - 1)) / n;
            const h = 1.0;
            const chevW = 0.28;
            block.steps.forEach((step, i) => {
                const x = box.x + i * (stepW + gap);
                s.addShape('roundRect', { x, y: box.y, w: stepW, h, rectRadius: 0.06, fill: { color: lighten(theme.accentColor) }, line: { color: hx(theme.accentColor), width: 1 } });
                s.addText((step.icon ? `${step.icon}\n` : '') + step.title + (step.sub ? `\n${step.sub}` : ''), { x, y: box.y, w: stepW, h, fontFace: theme.fontFace, fontSize: 11, bold: true, color: hx(theme.primaryColor), align: 'center', valign: 'middle' });
                // Flow chevron in the gap, matching the HTML's yellow `▶` indicator.
                // Vertically centred against the step cards, accent-coloured.
                if (i < n - 1) {
                    s.addText('▶', {
                        x: x + stepW + (gap - chevW) / 2,
                        y: box.y + (h - 0.4) / 2,
                        w: chevW, h: 0.4,
                        fontFace: theme.fontFace, fontSize: 18, bold: true,
                        color: hx(theme.accentColor), align: 'center', valign: 'middle',
                    });
                }
            });
            return h;
        }
        case 'table':
            return renderTable(s, block, box, slideIndex, st);
        case 'image': {
            const h = Math.min(FOOTER_Y - box.y, box.w * 0.5);
            s.addImage({ data: block.dataUri, x: box.x, y: box.y, w: box.w, h });
            return h;
        }
        case 'svg':
            return renderSvg(s, block, box, slideIndex, st);
        case 'two-column': {
            const { left, right } = splitColumns();
            await renderColumn(s, block.left, { x: left.x, y: box.y, w: left.w }, slideIndex, st);
            await renderColumn(s, block.right, { x: right.x, y: box.y, w: right.w }, slideIndex, st);
            return FOOTER_Y - box.y;     // columns consume the remaining zone
        }
        case 'custom':
            return renderCustom(s, block, box, slideIndex, st);
    }
}

async function renderColumn(s: SlideLike, blocks: LeafBlock[], box: Box, slideIndex: number, st: RenderState): Promise<void> {
    let y = box.y;
    for (const block of blocks) {
        if (y >= FOOTER_Y) {
            st.notices.push({ slideIndex, blockKind: block.kind, severity: 'substantive', description: `column block "${block.kind}" clipped.` });
            continue;
        }
        try {
            y += await renderBlock(s, block, { x: box.x, y, w: box.w }, slideIndex, st) + 0.1;
        } catch (e) {
            st.notices.push({ slideIndex, blockKind: block.kind, severity: 'substantive', description: `column block "${block.kind}" failed: ${msg(e)}` });
        }
    }
}

function renderBarChart(s: SlideLike, block: Extract<Block, { kind: 'bar-chart' }>, box: Box, slideIndex: number, st: RenderState): number {
    const { theme } = st;
    const h = Math.min(FOOTER_Y - box.y, Math.max(1.5, block.bars.length * 0.45));
    if (st.barStyle === 'native') {
        try {
            // PPT bar charts (horizontal `barDir: 'bar'`) plot the first label
            // at the BOTTOM of the chart by default; HTML preview reads the
            // other way (first label on TOP). `catAxisOrderReverse` is not in
            // pptxgenjs 4.0.x's type surface and is silently ignored — so
            // instead we reverse the data arrays ourselves before passing them
            // to addChart. Provider-agnostic, version-stable.
            const orderedBars = [...block.bars].reverse();
            s.addChart('bar', [{ name: 'Share', labels: orderedBars.map(b => b.label), values: orderedBars.map(b => b.pct) }], {
                x: box.x, y: box.y, w: box.w, h, barDir: 'bar', showLegend: false, showValue: true,
                // Labels INSIDE the end of the bar, matching the HTML preview's
                // `padding-left: 20px` placement. PPT default is `outEnd`.
                dataLabelPosition: 'inEnd',
                dataLabelFontSize: 11, dataLabelColor: 'FFFFFF', dataLabelFontBold: true,
                // Per-data-point colours from the IR. With a single series + N
                // bars, pptxgenjs maps `chartColors[i]` to the i-th bar, which
                // reproduces the HTML's light→dark green progression. Reversed
                // to match the reversed labels/values above.
                chartColors: orderedBars.map(b => (b.color ? hx(b.color) : hx(theme.accentColor))),
            });
            return h;
        } catch (e) {
            st.downgrades.push(`bar-chart native→bars fallback: ${msg(e)}`);
            st.notices.push({ slideIndex, blockKind: 'bar-chart', severity: 'info', description: 'native chart unavailable; rendered as shapes.' });
        }
    }
    // Deterministic manual bars (also the native-fallback target).
    const rowH = Math.min(0.36, (h - 0.1) / block.bars.length);
    const labelW = 1.2;
    block.bars.forEach((bar, i) => {
        const y = box.y + i * (rowH + 0.06);
        s.addText(bar.label, { x: box.x, y, w: labelW, h: rowH, fontFace: theme.fontFace, fontSize: 11, bold: true, color: hx(theme.primaryColor), align: 'right', valign: 'middle' });
        const trackX = box.x + labelW + 0.1;
        const trackW = box.w - labelW - 0.1;
        s.addShape('rect', { x: trackX, y, w: trackW, h: rowH, fill: { color: 'EEEEEE' }, line: { width: 0 } });
        s.addShape('rect', { x: trackX, y, w: Math.max(0.02, trackW * (bar.pct / 100)), h: rowH, fill: { color: bar.color ? hx(bar.color) : hx(theme.accentColor) }, line: { width: 0 } });
        s.addText(`${bar.pct}%`, { x: trackX + 0.05, y, w: trackW, h: rowH, fontFace: theme.fontFace, fontSize: 10, bold: true, color: 'FFFFFF', valign: 'middle' });
    });
    return h;
}

const TABLE_ROW_H = 0.35;

function renderTable(s: SlideLike, block: Extract<Block, { kind: 'table' }>, box: Box, slideIndex: number, st: RenderState): number {
    const theme = st.theme;
    const available = FOOTER_Y - box.y;
    // Slice rows to those that actually fit (G3) — drawing N rows into a
    // too-small height squashes them illegibly. +1 for the header row.
    const maxBodyRows = Math.max(1, Math.floor(available / TABLE_ROW_H) - 1);
    const shown = block.rows.slice(0, maxBodyRows);
    if (shown.length < block.rows.length) {
        st.notices.push({ slideIndex, blockKind: 'table', severity: 'substantive', description: `table truncated to ${shown.length}/${block.rows.length} rows to fit the slide.` });
    }
    const colW = tableColumnWidths(block.headers, shown, box.w);
    const header = block.headers.map(hh => ({ text: hh, options: { bold: true, color: 'FFFFFF', fill: { color: hx(IR_RENDER_SPEC.tableHeaderFill(theme)) } } }));
    const body = shown.map(r => r.map(c => ({ text: c, options: { color: hx(theme.bodyColor) } })));
    const h = Math.min(available, (body.length + 1) * TABLE_ROW_H);
    s.addTable([header, ...body], {
        x: box.x, y: box.y, w: box.w, colW,
        fontFace: theme.fontFace, fontSize: Math.max(9, theme.fontSize - 3),
        border: { type: 'solid', pt: 0.5, color: 'DDDDDD' }, autoPage: false, valign: 'middle',
    });
    return h;
}

async function renderSvg(s: SlideLike, block: Extract<Block, { kind: 'svg' }>, box: Box, slideIndex: number, st: RenderState): Promise<number> {
    const h = Math.min(FOOTER_Y - box.y, box.w * 0.45);
    const clean = sanitizeSvgMarkup(block.svg);
    // Proactively validate root attrs (G2) — pptxgenjs won't throw on a bad
    // base64 SVG, so we decide up-front whether to embed or fall back.
    const hasDims = /viewbox\s*=/i.test(clean) || (/\bwidth\s*=/i.test(clean) && /\bheight\s*=/i.test(clean));
    if (clean && hasDims) {
        s.addImage({ data: `data:image/svg+xml;base64,${base64(clean)}`, x: box.x, y: box.y, w: box.w, h });
        return h;
    }
    // No safe vector — rasterize the cleaned SVG if a rasterizer is injected.
    if (clean && st.rasterize) {
        const dataUri = await tryRasterize(st, { svg: clean, widthPx: box.w * PX_PER_IN, heightPx: h * PX_PER_IN });
        if (dataUri) { s.addImage({ data: dataUri, x: box.x, y: box.y, w: box.w, h }); return h; }
    }
    placeholder(s, block.alt ?? 'Diagram', box, h, st.theme);
    st.notices.push({ slideIndex, blockKind: 'svg', severity: 'substantive', description: clean ? 'SVG lacks viewBox/width+height; rendered as placeholder.' : 'SVG could not be sanitized.' });
    return h;
}

async function renderCustom(s: SlideLike, block: Extract<Block, { kind: 'custom' }>, box: Box, slideIndex: number, st: RenderState): Promise<number> {
    const h = Math.min(FOOTER_Y - box.y, box.w * 0.45);
    // Precedence IDENTICAL to HTML (plan G3): image wins.
    if (block.image) {
        s.addImage({ data: block.image, x: box.x, y: box.y, w: box.w, h });
        return h;
    }
    // html-only: rasterize when a rasterizer is injected (Phase B), else placeholder.
    if (block.html && st.rasterize) {
        const dataUri = await tryRasterize(st, { html: block.html, widthPx: box.w * PX_PER_IN, heightPx: h * PX_PER_IN });
        if (dataUri) { s.addImage({ data: dataUri, x: box.x, y: box.y, w: box.w, h }); return h; }
    }
    placeholder(s, block.fallbackText ?? 'Custom block (see HTML preview)', box, h, st.theme);
    st.notices.push({ slideIndex, blockKind: 'custom', severity: 'substantive', description: 'custom block rendered as placeholder (no rasterizer).' });
    return h;
}

/** Invoke the injected rasterizer, swallowing failures so the caller can fall
 *  back to a placeholder rather than dropping the block. */
async function tryRasterize(st: RenderState, input: { html?: string; svg?: string; widthPx: number; heightPx: number }): Promise<string | null> {
    if (!st.rasterize) return null;
    try {
        const uri = await st.rasterize(input);
        return uri && uri.startsWith('data:image/') ? uri : null;
    } catch (e) {
        st.downgrades.push(`rasterize failed: ${msg(e)}`);
        return null;
    }
}

function placeholder(s: SlideLike, label: string, box: Box, h: number, theme: ExportTheme): void {
    s.addShape('roundRect', { x: box.x, y: box.y, w: box.w, h, rectRadius: 0.06, fill: { color: 'F1F5F9' }, line: { color: hx(theme.bodyColor), width: 0.5, dashType: 'dash' } });
    s.addText(label, { x: box.x, y: box.y, w: box.w, h, fontFace: theme.fontFace, fontSize: 12, italic: true, color: hx(theme.bodyColor), align: 'center', valign: 'middle' });
}

function lighten(hex: string): string {
    const h = hex.replace('#', '');
    const mix = (c: number) => Math.round(c + (255 - c) * 0.85);
    const r = mix(parseInt(h.slice(0, 2), 16));
    const g = mix(parseInt(h.slice(2, 4), 16));
    const b = mix(parseInt(h.slice(4, 6), 16));
    return [r, g, b].map(c => c.toString(16).padStart(2, '0')).join('');
}


/** UTF-8-safe base64 (G1) — encodes to UTF-8 bytes BEFORE base64 so non-ASCII
 *  SVG content isn't corrupted. Prefers Node `Buffer` (Obsidian/Electron),
 *  falls back to a TextEncoder + btoa path in a pure browser. */
function base64(s: string): string {
    if (typeof Buffer !== 'undefined') return Buffer.from(s, 'utf-8').toString('base64');
    const bytes = new TextEncoder().encode(s);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
}
