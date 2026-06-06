/**
 * IR → HTML renderer. Deterministic, pure (string building only — no DOM
 * mutation, no Obsidian). Produces a self-contained `<section data-slide>`-per-
 * slide deck body for the preview iframe.
 *
 * PLATFORM-ROBUST SIZING: every slide is a FIXED 1920×1080 canvas (the preview
 * scales the whole iframe as one unit; PPTX is likewise a fixed 13.33×7.5in
 * canvas). All internal sizing uses ABSOLUTE px tied to that canvas — never
 * `rem`/`vw`/`%`, which would respond to the host's root font-size / viewport
 * and break the fixed-canvas model across platforms. Colours come from the
 * `ExportTheme` (the same theme the PPTX renderer uses) so preview ≈ export.
 * Fonts are ~2× the PPTX point sizes (1pt ≈ 2px at the 1920px/13.33in canvas
 * density), keeping the preview proportional to the exported deck.
 *
 * The returned `html` is a deck BODY string. `presentationHtmlService` is the
 * only thing that assigns `this.html`, and it always pipes this through
 * `sanitizePresentation → wrapInDocument → injectCSP` first (plan H1).
 */

import type { Result } from '../../core/result';
import { ok, err } from '../../core/result';
import type { ExportTheme } from '../export/exportTheme';
import { sanitizeSvgMarkup, stripDangerousHtml } from '../../utils/svgSanitize';
import type { Block, FidelityNotice, LeafBlock, SlideDeckIr, SlideIr } from './slideIr';
import { contrastTextColor, stripBulletPrefix } from './slideIr';
import { IR_RENDER_SPEC, PX_PER_IN, ptToPx, inToPx } from './irRenderSpec';
import { SLIDE_W, SLIDE_H, COL_GAP, CONTENT_WIDTH } from './irLayout';
import { resolvePresentationIcon } from './iconRegistry';
import { renderIconSvgMarkup } from './svgAsset';
import { slideFailureNotice, DEFAULT_PLACEHOLDER_LABEL } from './renderIsolation';
import { sanitizeExportTheme, serializeCssFontFamily } from './themeSafe';

export interface RenderHtmlOptions {
    /** Localised label for a slide that fails to render (caller injects via
     *  plugin.t — the renderer stays Obsidian-free). Default English. */
    placeholderLabel?: string;
}

/** Inline vector icon (resolved symmetrically with PPTX). Empty string when the
 *  icon resolves to `none`, so an unknown/dropped icon is absent in BOTH. */
function iconHtml(raw: string | undefined, theme: ExportTheme, sizePx: number): string {
    const r = resolvePresentationIcon(raw);
    if (r.kind !== 'svg') return '';
    const color = IR_RENDER_SPEC.icon.colorRole === 'primary' ? theme.primaryColor : theme.accentColor;
    return `<div style="display:flex;justify-content:center;margin-bottom:12px;">${renderIconSvgMarkup(r.name, color, sizePx)}</div>`;
}

export interface HtmlRenderOutput {
    html: string;
    notices: FidelityNotice[];
}

const esc = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const hx = (hex: string): string => `#${hex.replace('#', '')}`;
/** CSS `font-family` value for the deck: the always-populated quoted `fontStack`,
 *  or a serialized bare `fontFace` as a defensive fallback (brand-font-embedding). */
const cssFont = (theme: ExportTheme): string => theme.fontStack ?? serializeCssFontFamily(theme.fontFace);
/** 8-digit hex tint (alpha) for light card/callout fills over a white slide. */
const tint = (hex: string, alpha = '22'): string => `${hx(hex)}${alpha}`;

export function renderDeckToHtml(deck: SlideDeckIr, rawTheme: ExportTheme, opts: RenderHtmlOptions = {}): Result<HtmlRenderOutput> {
    // Same validity contract as renderDeckToPptx (audit M6/M19 — the two
    // renderers must agree on what a renderable deck is).
    if (!deck || !Array.isArray(deck.slides) || deck.slides.length === 0) return err('empty-deck');
    const placeholderLabel = opts.placeholderLabel ?? DEFAULT_PLACEHOLDER_LABEL;
    try {
        const notices: FidelityNotice[] = [];
        // D2 — validate the theme ONCE at the boundary; every downstream colour/
        // font interpolation then uses already-safe values (the theme is config-
        // sourced, not Zod-validated).
        const theme = sanitizeExportTheme(rawTheme, f =>
            notices.push({ slideIndex: 0, blockKind: 'paragraph', severity: 'info', description: `theme.${f} invalid; using fallback` }));
        // D1 — per-slide isolation: one bad slide degrades to a placeholder
        // section + a notice instead of failing the WHOLE deck (parity with the
        // PPTX per-slide isolation).
        let builtCount = 0;
        const sections = deck.slides
            .map((slide, i) => {
                try {
                    const html = renderSlide(slide, i, theme, notices);
                    builtCount++;
                    return html;
                } catch (e) {
                    notices.push(slideFailureNotice(i, 'build', e));
                    return placeholderSection(i, theme, placeholderLabel);
                }
            })
            .join('\n');
        // Nothing rendered → don't return an all-placeholder doc as success
        // (parity with renderDeckToPptx's builtCount guard — audit H5).
        if (builtCount === 0) return err('fatal: every slide failed to render');
        const title = deck.title ? ` data-title="${esc(deck.title)}"` : '';
        return ok({ html: `<div class="deck"${title}>\n${sections}\n</div>`, notices });
    } catch (e) {
        return err(`irToHtml failed: ${e instanceof Error ? e.message : String(e)}`);
    }
}

/** User-visible placeholder section for a slide that failed to build (D1). */
function placeholderSection(index: number, theme: ExportTheme, label: string): string {
    const body = hx(theme.bodyColor);
    return slideOpen(index, `background:#ffffff;color:${body};font-family:${cssFont(theme)};display:flex;align-items:center;justify-content:center;padding:90px 110px;`)
        + `<div style="border:2px dashed ${body}66;border-radius:16px;padding:60px;font-size:32px;font-style:italic;color:${body};opacity:0.7;text-align:center;max-width:60%;">${esc(label)}</div>`
        + '</section>';
}

/** Common fixed-canvas box for every slide. `class="slide"` so the preview can
 *  count + scale it; all visual styling is inline so it never collides with
 *  whatever theme CSS the wrapper injects. */
function slideOpen(index: number, inlineExtra: string): string {
    const base = `position:relative;width:${SLIDE_W}px;height:${SLIDE_H}px;overflow:hidden;box-sizing:border-box;`;
    return `<section data-slide data-slide-index="${index}" class="slide" style="${base}${inlineExtra}">`;
}

function renderSlide(slide: SlideIr, index: number, theme: ExportTheme, notices: FidelityNotice[]): string {
    const font = cssFont(theme);
    const parts: string[] = [];

    if (slide.type === 'title' || slide.type === 'section' || slide.type === 'closing') {
        // #4 — same gradient-vs-solid decision as PPTX (shared spec). Per-slide
        // background override wins → solid with auto-contrast text.
        const sb = IR_RENDER_SPEC.slideBackground(slide, theme);
        const bg = sb.kind === 'gradient'
            ? `linear-gradient(${sb.angleDeg}deg, ${hx(sb.from)} 0%, ${hx(sb.to)} 100%)`
            : hx(sb.color);
        const fg = slide.background ? hx(contrastTextColor(slide.background)) : '#fff';
        parts.push(slideOpen(index,
            `background:${bg};color:${fg};font-family:${font};display:flex;flex-direction:column;`
            + `justify-content:center;align-items:flex-start;padding:120px 140px;`));
        const heroTitlePx = ptToPx(slide.type === 'title' ? IR_RENDER_SPEC.font.heroTitlePt : IR_RENDER_SPEC.font.sectionTitlePt);
        if (slide.title) parts.push(`<h1 style="font-size:${heroTitlePx}px;font-weight:800;color:${fg};line-height:1.1;margin:0;">${esc(slide.title)}</h1>`);
        if (slide.subtitle) parts.push(`<p style="font-size:${ptToPx(IR_RENDER_SPEC.font.heroSubtitlePt)}px;color:${fg};opacity:0.85;margin:28px 0 0 0;font-weight:300;">${esc(slide.subtitle)}</p>`);
    } else {
        const bg = slide.background ? hx(slide.background) : '#ffffff';
        const titleColor = slide.background ? hx(contrastTextColor(slide.background)) : hx(theme.primaryColor);
        const bodyColor = slide.background ? hx(contrastTextColor(slide.background)) : hx(theme.bodyColor);
        parts.push(slideOpen(index,
            `background:${bg};color:${bodyColor};font-family:${font};display:flex;flex-direction:column;padding:90px 110px;`));
        if (slide.title) {
            parts.push(`<h1 style="font-size:${ptToPx(IR_RENDER_SPEC.font.slideTitlePt)}px;font-weight:800;color:${titleColor};line-height:1.15;margin:0;">${esc(slide.title)}</h1>`);
            const u = IR_RENDER_SPEC.accentUnderline;   // #2 — same motif/geometry as PPTX
            parts.push(`<div style="width:${Math.round(u.widthIn * PX_PER_IN)}px;height:${Math.round(u.heightIn * PX_PER_IN)}px;background:${hx(theme.accentColor)};border-radius:4px;margin:${Math.round(u.gapBelowTitleIn * PX_PER_IN)}px 0 0 0;"></div>`);
        }
        if (slide.subtitle) parts.push(`<p style="font-size:${ptToPx(IR_RENDER_SPEC.font.heroSubtitlePt)}px;color:${bodyColor};opacity:0.8;margin:18px 0 0 0;">${esc(slide.subtitle)}</p>`);
        // #1 vertical fill: centre the body block-group in the available area so a
        // sparse slide doesn't leave the bottom half empty. `safe center` falls back
        // to top-alignment when content overflows, so tall slides never clip the top.
        parts.push(`<div style="flex:1;margin-top:36px;display:flex;flex-direction:column;justify-content:safe center;gap:${inToPx(IR_RENDER_SPEC.geometry.blockGapIn)}px;min-height:0;">`);
        for (const block of slide.blocks) parts.push(renderBlockSafe(block, index, theme, notices));
        parts.push('</div>');
    }

    if (slide.notes) parts.push(`<aside class="speaker-notes" style="display:none;">${esc(slide.notes)}</aside>`);
    parts.push('</section>');
    return parts.join('\n');
}

// ── Cluster C visual renderers (2×2 / harvey-rating / waterfall / line / pyramid) ──

const POS_HEX = '#2E7D32';
const NEG_HEX = '#C62828';
const capHtml = (caption: string | undefined, theme: ExportTheme): string =>
    caption ? `<div style="font-size:${ptToPx(IR_RENDER_SPEC.font.captionPt(theme))}px;color:${hx(theme.bodyColor)};opacity:0.65;margin-top:8px;">${esc(caption)}</div>` : '';

/** A harvey-ball cell: visible glyphs + a CLIP-FREE visually-hidden "N of M" text node
 *  (aria-* is stripped by the sanitizer — ALLOW_ARIA_ATTR:false; a real hidden text node
 *  survives and is read by assistive tech). Non-rating cells (labels) pass through. */
function ratingCellHtml(cell: string): string {
    const filled = (cell.match(/●/g) || []).length;
    const total = filled + (cell.match(/○/g) || []).length;
    if (total === 0) return esc(cell);
    return `${esc(cell)}<span style="position:absolute;width:1px;height:1px;overflow:hidden;white-space:nowrap;">${filled} of ${total}</span>`;
}

/** 2×2 matrix from a 3×3 styled table: header row = x-axis labels, first column =
 *  y-axis labels, the 4 data cells = quadrant regions (P1 a11y: real text nodes). */
function render2x2Html(block: Extract<Block, { kind: 'table' }>, theme: ExportTheme): string {
    const primary = hx(theme.primaryColor); const body = hx(theme.bodyColor);
    const [, xLow = '', xHigh = ''] = block.headers;
    const [yHigh = '', tl = '', tr = ''] = block.rows[0] ?? [];
    const [yLow = '', bl = '', br = ''] = block.rows[1] ?? [];
    const axis = (t: string) => `<div style="font-size:24px;font-weight:700;color:${primary};display:flex;align-items:center;justify-content:center;text-align:center;">${esc(t)}</div>`;
    const quad = (items: string) => `<div data-quadrant="true" style="background:${tint(theme.accentColor)};border:2px solid ${tint(theme.accentColor, '55')};border-radius:10px;padding:24px;font-size:26px;color:${body};display:flex;align-items:center;justify-content:center;text-align:center;">${esc(items)}</div>`;
    return `<div style="display:grid;grid-template-columns:80px 1fr 1fr;grid-template-rows:50px 1fr 1fr;gap:14px;flex:1;min-height:0;">`
        + `<div></div>${axis(xLow)}${axis(xHigh)}`
        + `${axis(yHigh)}${quad(tl)}${quad(tr)}`
        + `${axis(yLow)}${quad(bl)}${quad(br)}</div>${capHtml(block.caption, theme)}`;
}

function renderWaterfallHtml(block: Extract<Block, { kind: 'waterfall' }>, theme: ExportTheme): string {
    const primary = hx(theme.primaryColor); const body = hx(theme.bodyColor);
    interface Step { label: string; value: number; lo: number; hi: number; isPillar: boolean; }
    const steps: Step[] = [{ label: block.base.label, value: block.base.value, lo: Math.min(0, block.base.value), hi: Math.max(0, block.base.value), isPillar: true }];
    let run = block.base.value;
    for (const d of block.deltas) { const prev = run; run += d.value; steps.push({ label: d.label, value: d.value, lo: Math.min(prev, run), hi: Math.max(prev, run), isPillar: false }); }
    if (block.total) steps.push({ label: block.total.label, value: run, lo: Math.min(0, run), hi: Math.max(0, run), isPillar: true });
    const maxV = Math.max(1, ...steps.map(s => s.hi), ...steps.map(s => Math.abs(s.lo)));
    const chartH = 360;
    const unit = block.unit ? ` ${esc(block.unit)}` : '';
    const cols = steps.map(s => {
        const h = Math.max(2, ((s.hi - s.lo) / maxV) * chartH);
        const bottom = (s.lo / maxV) * chartH;
        const fill = s.isPillar ? primary : (s.value >= 0 ? POS_HEX : NEG_HEX);
        const sign = !s.isPillar && s.value >= 0 ? '+' : '';
        return `<div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;min-width:0;">`
            + `<div style="font-size:22px;color:${body};margin-bottom:4px;">${sign}${s.value}${unit}</div>`
            + `<div style="position:relative;width:100%;height:${chartH}px;">`
            + `<div style="position:absolute;bottom:${bottom.toFixed(1)}px;left:15%;width:70%;height:${h.toFixed(1)}px;background:${fill};border-radius:4px;"></div></div>`
            + `<div style="font-size:22px;color:${primary};font-weight:600;margin-top:8px;text-align:center;">${esc(s.label)}</div></div>`;
    }).join('');
    return `<div style="display:flex;gap:16px;align-items:flex-end;flex:1;min-height:0;">${cols}</div>${capHtml(block.caption, theme)}`;
}

function renderLineChartHtml(block: Extract<Block, { kind: 'line-chart' }>, theme: ExportTheme): string {
    const W = 1200, H = 380, padL = 70, padB = 50, padT = 24, padR = 24;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const allY = block.series.flatMap(s => s.points.map(p => p.y));
    const minY = Math.min(0, ...allY), maxY = Math.max(...allY, 1);
    const xs = block.series[0].points.map(p => p.x);
    const n = xs.length;
    const xAt = (i: number) => padL + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
    const yAt = (v: number) => padT + plotH - ((v - minY) / (maxY - minY || 1)) * plotH;
    const colors = [theme.accentColor, theme.primaryColor, '2E7D32', 'C62828'].map(c => hx(c));
    const axisColor = hx(theme.bodyColor);
    const lines = block.series.map((s, si) => {
        const col = colors[si % colors.length];
        const pts = s.points.map((p, i) => `${xAt(i).toFixed(1)},${yAt(p.y).toFixed(1)}`).join(' ');
        const dots = s.points.map((p, i) => `<circle cx="${xAt(i).toFixed(1)}" cy="${yAt(p.y).toFixed(1)}" r="4" fill="${col}"></circle>`).join('');
        return `<polyline points="${pts}" fill="none" stroke="${col}" stroke-width="3"></polyline>${dots}`;
    }).join('');
    const xTicks = xs.map((x, i) => `<text x="${xAt(i).toFixed(1)}" y="${H - padB + 28}" font-size="20" fill="${axisColor}" text-anchor="middle">${esc(x)}</text>`).join('');
    const legend = block.series.length > 1
        ? block.series.map((s, si) => `<text x="${padL + si * 220}" y="14" font-size="20" fill="${colors[si % colors.length]}">${esc(s.label)}</text>`).join('') : '';
    const svg = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;">`
        + `<line x1="${padL}" y1="${padT + plotH}" x2="${W - padR}" y2="${padT + plotH}" stroke="${axisColor}" stroke-width="1"></line>`
        + `<line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + plotH}" stroke="${axisColor}" stroke-width="1"></line>`
        + `${lines}${xTicks}${legend}</svg>`;
    return `<div style="flex:1;display:flex;flex-direction:column;justify-content:center;">${svg}${capHtml(block.caption, theme)}</div>`;
}

function renderPyramidHtml(block: Extract<Block, { kind: 'pyramid' }>, theme: ExportTheme): string {
    const accent = hx(theme.accentColor);
    const n = block.levels.length;
    const rows = block.levels.map((l, i) => {
        const widthPct = Math.round(45 + (i / Math.max(1, n - 1)) * 55);
        return `<div style="width:${widthPct}%;margin:0 auto 10px;background:${accent};color:#fff;padding:18px 24px;text-align:center;border-radius:6px;">`
            + `<div style="font-size:28px;font-weight:700;">${esc(l.label)}</div>`
            + (l.detail ? `<div style="font-size:22px;opacity:0.9;margin-top:4px;">${esc(l.detail)}</div>` : '')
            + '</div>';
    }).join('');
    return `<div style="display:flex;flex-direction:column;flex:1;justify-content:center;min-height:0;">${rows}${capHtml(block.caption, theme)}</div>`;
}

/** Per-block isolation (audit M6) — a single throwing block is dropped + noticed
 *  instead of sinking the whole slide, matching the PPTX `flowBlocks` contract. */
function renderBlockSafe(block: Block, slideIndex: number, theme: ExportTheme, notices: FidelityNotice[]): string {
    try {
        return renderBlock(block, slideIndex, theme, notices);
    } catch (e) {
        notices.push({ slideIndex, blockKind: block.kind, severity: 'substantive', description: `block "${block.kind}" failed: ${e instanceof Error ? e.message : String(e)}` });
        return '';
    }
}

function renderBlock(block: Block, slideIndex: number, theme: ExportTheme, notices: FidelityNotice[]): string {
    const primary = hx(theme.primaryColor);
    const accent = hx(theme.accentColor);
    const body = hx(theme.bodyColor);
    const font = cssFont(theme);

    switch (block.kind) {
        case 'heading': {
            const size = ptToPx(IR_RENDER_SPEC.font.headingPt(block.level));
            return `<h${block.level} style="font-size:${size}px;font-weight:700;color:${primary};margin:0;">${esc(block.text)}</h${block.level}>`;
        }
        case 'paragraph':
            return `<p style="font-size:${ptToPx(IR_RENDER_SPEC.font.paragraphPt(theme))}px;line-height:1.45;color:${body};margin:0;">${block.emphasis ? `<strong style="color:${primary};">${esc(block.text)}</strong>` : esc(block.text)}</p>`;
        case 'bullets': {
            const tag = block.ordered ? 'ol' : 'ul';
            const items = block.items.map(it => `<li style="font-size:${ptToPx(IR_RENDER_SPEC.font.paragraphPt(theme))}px;line-height:1.4;color:${body};margin-bottom:14px;">${esc(stripBulletPrefix(it))}</li>`).join('');
            return `<${tag} style="margin:0;padding-left:${inToPx(IR_RENDER_SPEC.geometry.bulletIndentIn)}px;">${items}</${tag}>`;
        }
        case 'caption':
            return `<div style="font-size:${ptToPx(IR_RENDER_SPEC.font.captionPt(theme))}px;color:${body};opacity:0.65;">${esc(block.text)}</div>`;
        case 'callout':
            return `<div style="background:${tint(theme.accentColor)};border-left:${Math.round(IR_RENDER_SPEC.calloutStripe.widthIn * PX_PER_IN)}px solid ${accent};border-radius:0 12px 12px 0;padding:28px 36px;">`
                + `<p style="font-size:${ptToPx(IR_RENDER_SPEC.font.paragraphPt(theme))}px;line-height:1.4;color:${body};margin:0;">${esc(block.text)}</p>`
                + (block.cite ? `<div style="font-size:${ptToPx(IR_RENDER_SPEC.font.captionPt(theme))}px;color:${body};opacity:0.7;margin-top:10px;">— ${esc(block.cite)}</div>` : '')
                + '</div>';
        case 'stat-grid': {
            const iconPx = Math.round(IR_RENDER_SPEC.icon.statCardSizeIn * PX_PER_IN);
            const cards = block.cards.map(c =>
                `<div style="flex:1;background:${tint(theme.accentColor)};border:2px solid ${tint(theme.accentColor, '55')};border-radius:${inToPx(IR_RENDER_SPEC.geometry.cardRadiusIn)}px;padding:40px 28px;text-align:center;">`
                + iconHtml(c.icon, theme, iconPx)
                + `<div style="font-size:${ptToPx(IR_RENDER_SPEC.statValueFontPt(block.cards.length))}px;font-weight:800;color:${primary};line-height:1.05;">${esc(c.value)}</div>`
                + `<div style="font-size:${ptToPx(IR_RENDER_SPEC.font.statLabelPt(theme))}px;color:${body};opacity:0.85;margin-top:14px;line-height:1.3;">${esc(c.label)}</div></div>`,
            ).join('');
            return `<div style="display:flex;gap:32px;">${cards}</div>`;
        }
        case 'bar-chart': {
            const max = Math.max(...block.bars.map(b => b.pct), 1);
            const rows = block.bars.map(bar => {
                const fill = bar.color ? hx(bar.color) : accent;
                const w = (bar.pct / max) * 100;
                return `<div style="display:flex;align-items:center;gap:24px;">`
                    + `<div style="width:280px;font-size:${ptToPx(IR_RENDER_SPEC.font.barLabelPt(theme))}px;font-weight:600;color:${primary};text-align:right;line-height:1.25;">${esc(bar.label)}</div>`
                    + `<div style="flex:1;background:#eef0f2;border-radius:8px;height:56px;display:flex;align-items:center;">`
                    + `<div style="width:${w}%;min-width:64px;background:${fill};height:100%;border-radius:8px;display:flex;align-items:center;padding-left:20px;box-sizing:border-box;">`
                    + `<span style="font-size:${ptToPx(IR_RENDER_SPEC.font.barPctPt(theme))}px;font-weight:700;color:#fff;">${bar.pct}%</span></div></div></div>`;
            }).join('');
            // #3 chart credibility: axis label/units + source footnote so an index
            // chart isn't an unlabelled set of bars.
            const capPx = ptToPx(IR_RENDER_SPEC.font.captionPt(theme));
            const axis = block.axisLabel ? `<div style="font-size:${capPx}px;color:${body};opacity:0.75;margin-top:4px;">${esc(block.axisLabel)}</div>` : '';
            const src = block.source ? `<div style="font-size:${ptToPx(IR_RENDER_SPEC.font.footerPt(theme))}px;color:${body};opacity:0.55;margin-top:2px;font-style:italic;">${esc(block.source)}</div>` : '';
            const cap = block.caption ? `<div style="font-size:${capPx}px;color:${body};opacity:0.65;margin-top:6px;">${esc(block.caption)}</div>` : '';
            return `<div style="display:flex;flex-direction:column;gap:20px;">${rows}${axis}${cap}${src}</div>`;
        }
        case 'process-flow': {
            const stepIconPx = Math.round(IR_RENDER_SPEC.icon.processStepSizeIn * PX_PER_IN);
            const steps = block.steps.map((s, i) =>
                `<div style="flex:1;background:${tint(theme.accentColor)};border:2px solid ${tint(theme.accentColor, '55')};border-radius:${inToPx(IR_RENDER_SPEC.geometry.stepRadiusIn)}px;padding:28px 18px;text-align:center;">`
                + iconHtml(s.icon, theme, stepIconPx)
                + `<div style="font-size:${ptToPx(IR_RENDER_SPEC.font.processStepPt(theme))}px;font-weight:700;color:${primary};">${esc(s.title)}</div>`
                + (s.sub ? `<div style="font-size:${ptToPx(IR_RENDER_SPEC.font.processStepPt(theme))}px;color:${body};opacity:0.8;margin-top:8px;line-height:1.3;">${esc(s.sub)}</div>` : '')
                + '</div>'
                + (i < block.steps.length - 1 ? `<div style="display:flex;align-items:center;font-size:${ptToPx(IR_RENDER_SPEC.font.chevronPt)}px;color:${accent};">&#9654;</div>` : ''),
            ).join('');
            return `<div style="display:flex;gap:14px;align-items:stretch;">${steps}</div>`;
        }
        case 'table': {
            if (block.style === 'matrix-2x2') return render2x2Html(block, theme);
            const isRating = block.style === 'rating';
            const headerFill = hx(IR_RENDER_SPEC.tableHeaderFill(theme));   // #1 — same fill as PPTX
            const head = `<thead><tr>${block.headers.map(h => `<th style="background:${headerFill};color:#fff;padding:18px 24px;text-align:left;font-size:${ptToPx(IR_RENDER_SPEC.font.tablePt(theme))}px;font-weight:700;">${esc(h)}</th>`).join('')}</tr></thead>`;
            const rowsHtml = block.rows.map((r, ri) => `<tr style="background:${ri % 2 ? '#f6f8fa' : '#fff'};">${r.map(c => `<td style="position:relative;padding:16px 24px;border-bottom:1px solid #e2e8f0;font-size:${ptToPx(IR_RENDER_SPEC.font.tablePt(theme))}px;color:${body};">${isRating ? ratingCellHtml(c) : esc(c)}</td>`).join('')}</tr>`).join('');
            const cap = block.caption ? `<div style="font-size:${ptToPx(IR_RENDER_SPEC.font.captionPt(theme))}px;color:${body};opacity:0.65;margin-bottom:10px;">${esc(block.caption)}</div>` : '';
            return `${cap}<table style="width:100%;border-collapse:collapse;">${head}<tbody>${rowsHtml}</tbody></table>`;
        }
        case 'waterfall':
            return renderWaterfallHtml(block, theme);
        case 'line-chart':
            return renderLineChartHtml(block, theme);
        case 'pyramid':
            return renderPyramidHtml(block, theme);
        case 'image':
            return `<div style="display:flex;justify-content:center;"><img src="${esc(block.dataUri)}" alt="${esc(block.alt ?? '')}" style="max-width:100%;max-height:${inToPx(CONTENT_WIDTH * IR_RENDER_SPEC.geometry.media.imageAspect)}px;" /></div>`;
        case 'svg': {
            const clean = sanitizeSvgMarkup(block.svg);
            if (!clean) {
                notices.push({ slideIndex, blockKind: 'svg', severity: 'substantive', description: 'SVG could not be sanitized; omitted from HTML.' });
                return `<div style="font-size:28px;color:${body};opacity:0.6;">${esc(block.alt ?? 'Diagram')}</div>`;
            }
            return `<div style="display:flex;justify-content:center;max-height:${inToPx(CONTENT_WIDTH * IR_RENDER_SPEC.geometry.media.svgAspect)}px;">${clean}</div>`;
        }
        case 'two-column': {
            const col = (blocks: LeafBlock[]): string =>
                `<div class="ir-col" style="flex:1;display:flex;flex-direction:column;gap:${inToPx(IR_RENDER_SPEC.geometry.colSubGapIn)}px;min-width:0;">${blocks.map(b => renderBlockSafe(b, slideIndex, theme, notices)).join('')}</div>`;
            return `<div class="ir-cols" style="display:flex;gap:${inToPx(COL_GAP)}px;flex:1;min-height:0;">${col(block.left)}${col(block.right)}</div>`;
        }
        case 'custom': {
            // Precedence IDENTICAL to PPTX (plan G3): image wins; else inline sanitized html.
            if (block.image) return `<div style="display:flex;justify-content:center;"><img src="${esc(block.image)}" alt="${esc(block.fallbackText ?? '')}" style="max-width:100%;" /></div>`;
            if (block.html) return `<div style="font-size:28px;color:${body};font-family:${font};">${stripDangerousHtml(block.html)}</div>`;
            return `<div style="font-size:28px;color:${body};">${esc(block.fallbackText ?? '')}</div>`;
        }
    }
}
