/**
 * RichSlideJSON → pptxgenjs renderer.
 *
 * Takes parsed rich slides (from `htmlToRichSlideParser`) + the user's
 * `ExportTheme` and produces a `.pptx` ArrayBuffer. Each `SlideElement`
 * kind maps to a pptxgenjs primitive: text boxes, bulleted lists, tables,
 * stat-card compositions, images.
 *
 * Unlike the markdown generator (which flattens everything to bullet text),
 * this renderer preserves layout: two-column decks stay two-column, stat
 * grids render as a row of boxed stats, tables render with header styling,
 * speaker notes land on the speaker-notes pane.
 *
 * Phase 2 of the sister-repo backport.
 */

import type { ExportTheme } from '../export/markdownPptxGenerator';
import type { RichSlideJSON, SlideElement } from './richSlideTypes';

// ── Layout constants ─────────────────────────────────────────────────────

const SLIDE_WIDTH = 10;    // inches (default 16:9 pptxgenjs)
const SLIDE_HEIGHT = 5.625;
const MARGIN = 0.5;
const CONTENT_TOP = 1.2;
const CONTENT_WIDTH = SLIDE_WIDTH - 2 * MARGIN;
const CONTENT_HEIGHT = SLIDE_HEIGHT - CONTENT_TOP - MARGIN;

const COL_LEFT_X = MARGIN;
const COL_RIGHT_X = SLIDE_WIDTH / 2 + 0.1;
const COL_WIDTH = (SLIDE_WIDTH - 2 * MARGIN) / 2 - 0.1;

/**
 * Render a rich deck into a pptxgenjs ArrayBuffer. `deckTitle` is optional —
 * if provided and no title slide is present, one is synthesised.
 */
export async function renderRichPptx(
    slides: RichSlideJSON[],
    theme: ExportTheme,
    deckTitle?: string,
): Promise<ArrayBuffer> {
    const PptxGenJS = (await import('pptxgenjs')).default;
    const pres = new PptxGenJS();
    pres.layout = 'LAYOUT_WIDE';

    const hasTitle = slides.some(s => s.type === 'title');
    if (!hasTitle && deckTitle) {
        renderTitleSlide(pres, theme, { title: deckTitle });
    }

    for (const slide of slides) {
        switch (slide.type) {
            case 'title':
                renderTitleSlide(pres, theme, { title: slide.title || deckTitle || '', subtitle: slide.subtitle });
                break;
            case 'section':
                renderSectionSlide(pres, theme, slide);
                break;
            case 'closing':
                renderClosingSlide(pres, theme, slide);
                break;
            default:
                renderContentSlide(pres, theme, slide);
                break;
        }
    }

    // pptxgenjs `write` returns a Promise<ArrayBuffer | Uint8Array | string>
    // depending on `outputType`. We request arraybuffer explicitly.
    const out: unknown = await pres.write({ outputType: 'arraybuffer' });
    if (out instanceof ArrayBuffer) return out;
    if (out instanceof Uint8Array) {
        // Copy to a fresh ArrayBuffer to shed SharedArrayBuffer typing.
        const copy = new ArrayBuffer(out.byteLength);
        new Uint8Array(copy).set(out);
        return copy;
    }
    throw new Error('pptxgenjs write returned unexpected output type');
}

// ── Slide-type renderers ─────────────────────────────────────────────────

function renderTitleSlide(pres: PresLike, theme: ExportTheme, data: { title: string; subtitle?: string }): void {
    const s = pres.addSlide();
    s.background = { color: theme.primaryColor };
    s.addText(data.title || 'Untitled', {
        x: MARGIN, y: SLIDE_HEIGHT / 2 - 0.8, w: CONTENT_WIDTH, h: 1.3,
        fontFace: theme.fontFace, fontSize: 40, color: 'FFFFFF', bold: true, align: 'center', valign: 'middle',
    });
    if (data.subtitle) {
        s.addText(data.subtitle, {
            x: MARGIN, y: SLIDE_HEIGHT / 2 + 0.6, w: CONTENT_WIDTH, h: 0.6,
            fontFace: theme.fontFace, fontSize: 22, color: 'FFFFFF', align: 'center', valign: 'middle',
        });
    }
}

function renderSectionSlide(pres: PresLike, theme: ExportTheme, slide: RichSlideJSON): void {
    const s = pres.addSlide();
    s.background = { color: theme.sectionBg };
    if (slide.title) {
        s.addText(slide.title, {
            x: MARGIN, y: SLIDE_HEIGHT / 2 - 0.6, w: CONTENT_WIDTH, h: 1.2,
            fontFace: theme.fontFace, fontSize: 36, color: 'FFFFFF', bold: true, align: 'center', valign: 'middle',
        });
    }
    if (slide.speakerNotes) s.addNotes(slide.speakerNotes);
}

function renderClosingSlide(pres: PresLike, theme: ExportTheme, slide: RichSlideJSON): void {
    const s = pres.addSlide();
    s.background = { color: theme.primaryColor };
    s.addText(slide.title || 'Thank you', {
        x: MARGIN, y: SLIDE_HEIGHT / 2 - 0.8, w: CONTENT_WIDTH, h: 1.3,
        fontFace: theme.fontFace, fontSize: 40, color: 'FFFFFF', bold: true, align: 'center', valign: 'middle',
    });
    if (slide.subtitle) {
        s.addText(slide.subtitle, {
            x: MARGIN, y: SLIDE_HEIGHT / 2 + 0.6, w: CONTENT_WIDTH, h: 0.6,
            fontFace: theme.fontFace, fontSize: 22, color: 'FFFFFF', align: 'center', valign: 'middle',
        });
    }
    if (slide.speakerNotes) s.addNotes(slide.speakerNotes);
}

function renderContentSlide(pres: PresLike, theme: ExportTheme, slide: RichSlideJSON): void {
    const s = pres.addSlide();

    // Accent bar under the title for visual continuity with the markdown path.
    if (slide.title) {
        s.addText(slide.title, {
            x: MARGIN, y: MARGIN, w: CONTENT_WIDTH, h: 0.6,
            fontFace: theme.fontFace, fontSize: 28, color: theme.primaryColor, bold: true,
        });
        s.addShape('rect', {
            x: MARGIN, y: MARGIN + 0.55, w: 1, h: 0.06,
            fill: { color: theme.accentColor }, line: { color: theme.accentColor },
        });
    }

    if (slide.layout === 'two-column' && slide.leftColumn && slide.leftColumn.length > 0) {
        renderColumn(s, theme, slide.leftColumn, COL_LEFT_X, COL_WIDTH);
        renderColumn(s, theme, slide.elements, COL_RIGHT_X, COL_WIDTH);
    } else if (slide.layout === 'stats-grid') {
        renderStatsGrid(s, theme, slide.elements);
    } else {
        renderColumn(s, theme, slide.elements, MARGIN, CONTENT_WIDTH);
    }

    if (slide.speakerNotes) s.addNotes(slide.speakerNotes);
}

// ── Element renderers ────────────────────────────────────────────────────

function renderColumn(
    s: SlideLike,
    theme: ExportTheme,
    elements: SlideElement[],
    x: number,
    w: number,
): void {
    let y = CONTENT_TOP;
    const maxY = SLIDE_HEIGHT - MARGIN;

    for (const el of elements) {
        if (y >= maxY) break;
        const remainingH = maxY - y;
        const rendered = renderElement(s, theme, el, x, y, w, remainingH);
        y += rendered.consumedHeight + 0.1;
    }
}

interface RenderResult {
    consumedHeight: number;
}

function renderElement(
    s: SlideLike,
    theme: ExportTheme,
    el: SlideElement,
    x: number, y: number, w: number, maxH: number,
): RenderResult {
    switch (el.kind) {
        case 'text':
            return renderText(s, theme, el, x, y, w, maxH);
        case 'list':
            return renderList(s, theme, el, x, y, w, maxH);
        case 'table':
            return renderTable(s, theme, el, x, y, w, maxH);
        case 'stat-card':
            return renderStatCard(s, theme, el, x, y, w);
        case 'image':
            return renderImage(s, el, x, y, w, maxH);
        case 'spacer':
            return { consumedHeight: 0.2 };
    }
}

function renderText(s: SlideLike, theme: ExportTheme, el: { level: string; content: string }, x: number, y: number, w: number, maxH: number): RenderResult {
    const fontMap: Record<string, { size: number; bold: boolean; color: string }> = {
        h1: { size: 26, bold: true, color: theme.primaryColor },
        h2: { size: 22, bold: true, color: theme.primaryColor },
        h3: { size: 18, bold: true, color: theme.bodyColor },
        body: { size: theme.fontSize, bold: false, color: theme.bodyColor },
        caption: { size: Math.max(10, theme.fontSize - 2), bold: false, color: theme.bodyColor },
    };
    const style = fontMap[el.level] ?? fontMap.body;
    const h = Math.min(maxH, estimateTextHeight(el.content, w, style.size));
    s.addText(el.content, {
        x, y, w, h,
        fontFace: theme.fontFace, fontSize: style.size, color: style.color, bold: style.bold,
        valign: 'top',
    });
    return { consumedHeight: h };
}

function renderList(s: SlideLike, theme: ExportTheme, el: { items: string[]; ordered: boolean }, x: number, y: number, w: number, maxH: number): RenderResult {
    if (el.items.length === 0) return { consumedHeight: 0 };
    const lines = el.items.map(it => ({
        text: it,
        options: { bullet: el.ordered ? { type: 'number' as const } : true },
    }));
    const h = Math.min(maxH, Math.max(0.4, el.items.length * 0.35));
    s.addText(lines, {
        x, y, w, h,
        fontFace: theme.fontFace, fontSize: theme.fontSize, color: theme.bodyColor,
        valign: 'top',
    });
    return { consumedHeight: h };
}

function renderTable(s: SlideLike, theme: ExportTheme, el: { headers: string[]; rows: string[][] }, x: number, y: number, w: number, maxH: number): RenderResult {
    const headerCells = el.headers.map(h => ({
        text: h,
        options: { bold: true, color: 'FFFFFF', fill: { color: theme.accentColor } },
    }));
    const bodyCells = el.rows.map(r => r.map(c => ({ text: c, options: { color: theme.bodyColor } })));
    const tableData = el.headers.length > 0 ? [headerCells, ...bodyCells] : bodyCells;

    const rowCount = tableData.length;
    const h = Math.min(maxH, Math.max(0.5, rowCount * 0.35));

    s.addTable(tableData, {
        x, y, w, h,
        fontFace: theme.fontFace, fontSize: Math.max(10, theme.fontSize - 2),
        border: { type: 'solid', pt: 1, color: 'DDDDDD' },
    });
    return { consumedHeight: h };
}

function renderStatCard(s: SlideLike, theme: ExportTheme, el: { value: string; label: string }, x: number, y: number, w: number): RenderResult {
    s.addShape('roundRect', {
        x, y, w, h: 1.2,
        fill: { color: lightenedFill(theme.accentColor) }, line: { color: theme.accentColor, width: 1 },
        rectRadius: 0.08,
    });
    s.addText(el.value, {
        x, y: y + 0.1, w, h: 0.6,
        fontFace: theme.fontFace, fontSize: 24, color: theme.primaryColor, bold: true, align: 'center', valign: 'middle',
    });
    s.addText(el.label, {
        x, y: y + 0.7, w, h: 0.4,
        fontFace: theme.fontFace, fontSize: 12, color: theme.bodyColor, align: 'center', valign: 'middle',
    });
    return { consumedHeight: 1.2 };
}

function renderImage(s: SlideLike, el: { src: string; alt?: string }, x: number, y: number, w: number, maxH: number): RenderResult {
    const h = Math.min(maxH, w * 0.6);
    s.addImage({ data: el.src, x, y, w, h });
    return { consumedHeight: h };
}

function renderStatsGrid(s: SlideLike, theme: ExportTheme, elements: SlideElement[]): void {
    const cards = elements.filter(e => e.kind === 'stat-card');
    if (cards.length === 0) return;
    const cols = Math.min(4, cards.length);
    const cardW = (CONTENT_WIDTH - (cols - 1) * 0.2) / cols;
    const rows = Math.ceil(cards.length / cols);
    const cardH = 1.2;
    const totalH = rows * cardH + (rows - 1) * 0.2;
    const startY = CONTENT_TOP + (CONTENT_HEIGHT - totalH) / 2;

    for (let i = 0; i < cards.length; i++) {
        const r = Math.floor(i / cols);
        const c = i % cols;
        const x = MARGIN + c * (cardW + 0.2);
        const y = startY + r * (cardH + 0.2);
        const card = cards[i];
        if (card.kind !== 'stat-card') continue;
        renderStatCard(s, theme, card, x, y, cardW);
    }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function estimateTextHeight(text: string, width: number, fontSize: number): number {
    // ~7 inches of 12pt text fits ~75 chars/line; scale roughly.
    const charsPerLine = Math.max(20, Math.floor((width * 7) / (fontSize / 12)) * 10);
    const lines = Math.max(1, Math.ceil(text.length / charsPerLine));
    const lineHeight = (fontSize / 72) * 1.4;
    return lines * lineHeight + 0.1;
}

function lightenedFill(hex: string): string {
    // 10% tint by mixing with white.
    const h = hex.replace('#', '');
    const r = Number.parseInt(h.slice(0, 2), 16);
    const g = Number.parseInt(h.slice(2, 4), 16);
    const b = Number.parseInt(h.slice(4, 6), 16);
    const tint = (c: number) => Math.round(c + (255 - c) * 0.85);
    return [tint(r), tint(g), tint(b)].map(c => c.toString(16).padStart(2, '0')).join('');
}

// ── pptxgenjs structural types ───────────────────────────────────────────
// Re-use pptxgenjs's own types so our TextProps/ShapeProps shapes align
// exactly with the runtime API. Importing `type` only — the module load
// stays dynamic so consumers aren't forced to bundle pptxgenjs up-front.
import type PptxGenJSType from 'pptxgenjs';
type PresLike = PptxGenJSType;
type SlideLike = ReturnType<PptxGenJSType['addSlide']>;
