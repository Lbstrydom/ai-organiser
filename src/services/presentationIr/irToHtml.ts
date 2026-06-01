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
import { sanitizeSvgMarkup } from '../chat/presentationSanitizer';
import type { Block, FidelityNotice, LeafBlock, SlideDeckIr, SlideIr } from './slideIr';

export interface HtmlRenderOutput {
    html: string;
    notices: FidelityNotice[];
}

const SLIDE_W = 1920;
const SLIDE_H = 1080;

const esc = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const hx = (hex: string): string => `#${hex.replace('#', '')}`;
/** 8-digit hex tint (alpha) for light card/callout fills over a white slide. */
const tint = (hex: string, alpha = '22'): string => `${hx(hex)}${alpha}`;

/**
 * Defense-in-depth strip for raw `custom.html` so the renderer output is safe
 * even when consumed directly (audit H2/H5). The service still runs the full
 * `sanitizePresentation` allowlist on top. Non-stateful `String.replace`.
 */
function stripDangerousHtml(html: string): string {
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<script[^>]*>/gi, '')
        .replace(/[\s/]on\w+\s*=\s*"[^"]*"/gi, '')
        .replace(/[\s/]on\w+\s*=\s*'[^']*'/gi, '')
        .replace(/[\s/]on\w+\s*=\s*[^\s>]+/gi, '')
        .replace(/javascript:/gi, '');
}

export function renderDeckToHtml(deck: SlideDeckIr, theme: ExportTheme): Result<HtmlRenderOutput> {
    try {
        const notices: FidelityNotice[] = [];
        const sections = deck.slides
            .map((slide, i) => renderSlide(slide, i, theme, notices))
            .join('\n');
        const title = deck.title ? ` data-title="${esc(deck.title)}"` : '';
        return ok({ html: `<div class="deck"${title}>\n${sections}\n</div>`, notices });
    } catch (e) {
        return err(`irToHtml failed: ${e instanceof Error ? e.message : String(e)}`);
    }
}

/** Common fixed-canvas box for every slide. `class="slide"` so the preview can
 *  count + scale it; all visual styling is inline so it never collides with
 *  whatever theme CSS the wrapper injects. */
function slideOpen(index: number, inlineExtra: string): string {
    const base = `position:relative;width:${SLIDE_W}px;height:${SLIDE_H}px;overflow:hidden;box-sizing:border-box;`;
    return `<section data-slide data-slide-index="${index}" class="slide" style="${base}${inlineExtra}">`;
}

function renderSlide(slide: SlideIr, index: number, theme: ExportTheme, notices: FidelityNotice[]): string {
    const font = theme.fontFace;
    const parts: string[] = [];

    if (slide.type === 'title' || slide.type === 'section' || slide.type === 'closing') {
        const bg = slide.type === 'section'
            ? hx(theme.sectionBg)
            : `linear-gradient(135deg, ${hx(theme.primaryColor)} 0%, ${hx(theme.sectionBg)} 100%)`;
        parts.push(slideOpen(index,
            `background:${bg};color:#fff;font-family:${font};display:flex;flex-direction:column;`
            + `justify-content:center;align-items:flex-start;padding:120px 140px;`));
        if (slide.title) parts.push(`<h1 style="font-size:84px;font-weight:800;color:#fff;line-height:1.1;margin:0;">${esc(slide.title)}</h1>`);
        if (slide.subtitle) parts.push(`<p style="font-size:38px;color:#fff;opacity:0.85;margin:28px 0 0 0;font-weight:300;">${esc(slide.subtitle)}</p>`);
    } else {
        parts.push(slideOpen(index,
            `background:#ffffff;color:${hx(theme.bodyColor)};font-family:${font};display:flex;flex-direction:column;padding:90px 110px;`));
        if (slide.title) {
            parts.push(`<h1 style="font-size:54px;font-weight:800;color:${hx(theme.primaryColor)};line-height:1.15;margin:0;">${esc(slide.title)}</h1>`);
            parts.push(`<div style="width:130px;height:8px;background:${hx(theme.accentColor)};border-radius:4px;margin:18px 0 0 0;"></div>`);
        }
        if (slide.subtitle) parts.push(`<p style="font-size:32px;color:${hx(theme.bodyColor)};opacity:0.8;margin:18px 0 0 0;">${esc(slide.subtitle)}</p>`);
        parts.push('<div style="flex:1;margin-top:36px;display:flex;flex-direction:column;gap:28px;min-height:0;">');
        for (const block of slide.blocks) parts.push(renderBlock(block, index, theme, notices));
        parts.push('</div>');
    }

    if (slide.notes) parts.push(`<aside class="speaker-notes" style="display:none;">${esc(slide.notes)}</aside>`);
    parts.push('</section>');
    return parts.join('\n');
}

function renderBlock(block: Block, slideIndex: number, theme: ExportTheme, notices: FidelityNotice[]): string {
    const primary = hx(theme.primaryColor);
    const accent = hx(theme.accentColor);
    const body = hx(theme.bodyColor);
    const font = theme.fontFace;

    switch (block.kind) {
        case 'heading': {
            const size = block.level === 1 ? 48 : block.level === 2 ? 40 : 32;
            return `<h${block.level} style="font-size:${size}px;font-weight:700;color:${primary};margin:0;">${esc(block.text)}</h${block.level}>`;
        }
        case 'paragraph':
            return `<p style="font-size:30px;line-height:1.45;color:${body};margin:0;">${block.emphasis ? `<strong style="color:${primary};">${esc(block.text)}</strong>` : esc(block.text)}</p>`;
        case 'bullets': {
            const tag = block.ordered ? 'ol' : 'ul';
            const items = block.items.map(it => `<li style="font-size:30px;line-height:1.4;color:${body};margin-bottom:14px;">${esc(it)}</li>`).join('');
            return `<${tag} style="margin:0;padding-left:48px;">${items}</${tag}>`;
        }
        case 'caption':
            return `<div style="font-size:24px;color:${body};opacity:0.65;">${esc(block.text)}</div>`;
        case 'callout':
            return `<div style="background:${tint(theme.accentColor)};border-left:10px solid ${accent};border-radius:0 12px 12px 0;padding:28px 36px;">`
                + `<p style="font-size:30px;line-height:1.4;color:${body};margin:0;">${esc(block.text)}</p>`
                + (block.cite ? `<div style="font-size:24px;color:${body};opacity:0.7;margin-top:10px;">— ${esc(block.cite)}</div>` : '')
                + '</div>';
        case 'stat-grid': {
            const cards = block.cards.map(c =>
                `<div style="flex:1;background:${tint(theme.accentColor)};border:2px solid ${tint(theme.accentColor, '55')};border-radius:18px;padding:40px 28px;text-align:center;">`
                + `<div style="font-size:64px;font-weight:800;color:${primary};line-height:1.05;">${esc(c.value)}</div>`
                + `<div style="font-size:26px;color:${body};opacity:0.85;margin-top:14px;line-height:1.3;">${esc(c.label)}</div></div>`,
            ).join('');
            return `<div style="display:flex;gap:32px;">${cards}</div>`;
        }
        case 'bar-chart': {
            const max = Math.max(...block.bars.map(b => b.pct), 1);
            const rows = block.bars.map(bar => {
                const fill = bar.color ? hx(bar.color) : accent;
                const w = (bar.pct / max) * 100;
                return `<div style="display:flex;align-items:center;gap:24px;">`
                    + `<div style="width:200px;font-size:30px;font-weight:600;color:${primary};text-align:right;">${esc(bar.label)}</div>`
                    + `<div style="flex:1;background:#eef0f2;border-radius:8px;height:56px;display:flex;align-items:center;">`
                    + `<div style="width:${w}%;min-width:64px;background:${fill};height:100%;border-radius:8px;display:flex;align-items:center;padding-left:20px;box-sizing:border-box;">`
                    + `<span style="font-size:26px;font-weight:700;color:#fff;">${bar.pct}%</span></div></div></div>`;
            }).join('');
            const cap = block.caption ? `<div style="font-size:24px;color:${body};opacity:0.65;margin-top:6px;">${esc(block.caption)}</div>` : '';
            return `<div style="display:flex;flex-direction:column;gap:20px;">${rows}${cap}</div>`;
        }
        case 'process-flow': {
            const steps = block.steps.map((s, i) =>
                `<div style="flex:1;background:${tint(theme.accentColor)};border:2px solid ${tint(theme.accentColor, '55')};border-radius:14px;padding:28px 18px;text-align:center;">`
                + `<div style="font-size:30px;font-weight:700;color:${primary};">${esc(s.title)}</div>`
                + (s.sub ? `<div style="font-size:23px;color:${body};opacity:0.8;margin-top:8px;line-height:1.3;">${esc(s.sub)}</div>` : '')
                + '</div>'
                + (i < block.steps.length - 1 ? `<div style="display:flex;align-items:center;font-size:36px;color:${accent};">&#9654;</div>` : ''),
            ).join('');
            return `<div style="display:flex;gap:14px;align-items:stretch;">${steps}</div>`;
        }
        case 'table': {
            const head = `<thead><tr>${block.headers.map(h => `<th style="background:${primary};color:#fff;padding:18px 24px;text-align:left;font-size:28px;font-weight:700;">${esc(h)}</th>`).join('')}</tr></thead>`;
            const rowsHtml = block.rows.map((r, ri) => `<tr style="background:${ri % 2 ? '#f6f8fa' : '#fff'};">${r.map(c => `<td style="padding:16px 24px;border-bottom:1px solid #e2e8f0;font-size:28px;color:${body};">${esc(c)}</td>`).join('')}</tr>`).join('');
            const cap = block.caption ? `<div style="font-size:24px;color:${body};opacity:0.65;margin-bottom:10px;">${esc(block.caption)}</div>` : '';
            return `${cap}<table style="width:100%;border-collapse:collapse;">${head}<tbody>${rowsHtml}</tbody></table>`;
        }
        case 'image':
            return `<div style="display:flex;justify-content:center;"><img src="${esc(block.dataUri)}" alt="${esc(block.alt ?? '')}" style="max-width:100%;max-height:560px;" /></div>`;
        case 'svg': {
            const clean = sanitizeSvgMarkup(block.svg);
            if (!clean) {
                notices.push({ slideIndex, blockKind: 'svg', severity: 'substantive', description: 'SVG could not be sanitized; omitted from HTML.' });
                return `<div style="font-size:28px;color:${body};opacity:0.6;">${esc(block.alt ?? 'Diagram')}</div>`;
            }
            return `<div style="display:flex;justify-content:center;max-height:600px;">${clean}</div>`;
        }
        case 'two-column': {
            const col = (blocks: LeafBlock[]): string =>
                `<div class="ir-col" style="flex:1;display:flex;flex-direction:column;gap:24px;min-width:0;">${blocks.map(b => renderBlock(b, slideIndex, theme, notices)).join('')}</div>`;
            return `<div class="ir-cols" style="display:flex;gap:56px;flex:1;min-height:0;">${col(block.left)}${col(block.right)}</div>`;
        }
        case 'custom': {
            // Precedence IDENTICAL to PPTX (plan G3): image wins; else inline sanitized html.
            if (block.image) return `<div style="display:flex;justify-content:center;"><img src="${esc(block.image)}" alt="${esc(block.fallbackText ?? '')}" style="max-width:100%;" /></div>`;
            if (block.html) return `<div style="font-size:28px;color:${body};font-family:${font};">${stripDangerousHtml(block.html)}</div>`;
            return `<div style="font-size:28px;color:${body};">${esc(block.fallbackText ?? '')}</div>`;
        }
    }
}
