/**
 * SVG-asset layer — the SINGLE place SVG markup is built, colour-guarded,
 * base64-encoded, and embedded as a pptxgenjs image. Owns icon + gradient
 * vector assets so neither renderer hand-rolls a data URI (the source of the
 * H3 "raw <svg> is not a valid addImage payload" gap).
 *
 * Pure (PPTX-agnostic via a minimal `SlideLike` shape). No Obsidian.
 *
 * Plan: docs/plans/presentation-renderer-fidelity.md (D4 — incl. Gemini's
 * mandatory `xmlns`, encode-inside-error-boundary, and per-pass dedup cache).
 */

import { PRESENTATION_ICONS } from './iconRegistry';
import { IR_RENDER_SPEC } from './irRenderSpec';

/** Minimal pptxgenjs slide surface this module needs (structural typing). */
export interface SvgImageSlide {
    addImage(opts: Record<string, unknown>): void;
}

/** Per-export-pass memo cache (icon `name|color` + gradient stop-tuple → data URI).
 *  Created once per `renderDeckToPptx` call and threaded in as a PARAMETER so the
 *  functions here stay stateless (no module-level mutable state). */
export type SvgAssetCache = Map<string, string>;
export const createSvgAssetCache = (): SvgAssetCache => new Map();

/** Validate a 6-digit hex colour (no '#'); throws on anything else so malformed
 *  colour never reaches embedded SVG markup (audit M3). */
export function assertHexColor(c: string): string {
    // Optional LEADING '#' only — a '#' anywhere else is invalid (audit L3).
    const m = /^#?([0-9A-Fa-f]{6})$/.exec(c);
    if (!m) throw new Error(`invalid hex colour: ${JSON.stringify(c)}`);
    return m[1];
}

/** UTF-8-safe base64 (matches the existing irToPptx pattern). */
function base64(s: string): string {
    if (typeof Buffer !== 'undefined') return Buffer.from(s, 'utf-8').toString('base64');
    const bytes = new TextEncoder().encode(s);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
}

/**
 * Build stroke-icon SVG markup. The `xmlns` namespace is MANDATORY — Office
 * OOXML strictly validates embedded SVG and rejects namespace-less markup
 * (Gemini HIGH). Colour is hex-guarded (M3).
 */
export function renderIconSvgMarkup(name: string, hexColor: string, sizePx = 24): string {
    const path = PRESENTATION_ICONS[name];
    if (!path) throw new Error(`unknown icon: ${name}`);
    const color = `#${assertHexColor(hexColor)}`;
    const sw = IR_RENDER_SPEC.icon.strokeWidth;
    const s = Math.max(1, Math.round(sizePx));
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 24 24" `
        + `fill="none" stroke="${color}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">`
        + `<path d="${path}"/></svg>`;
}

export interface GradientOpts { from: string; to: string; angleDeg: number; w: number; h: number }

/**
 * Build a full-bleed linear-gradient SVG (vector — no banding seams, the failure
 * mode the PPTX solid-fill comment documents). `xmlns` mandatory; colours guarded.
 * `angleDeg` is mapped to x1/y1→x2/y2 on the objectBoundingBox.
 */
export function gradientSvgMarkup(opts: GradientOpts): string {
    const from = `#${assertHexColor(opts.from)}`;
    const to = `#${assertHexColor(opts.to)}`;
    // Match the CSS `linear-gradient(Adeg, …)` convention so HTML and PPTX point
    // the SAME way (audit M3): CSS 0deg = up, 90deg = right, clockwise. In SVG's
    // y-down box the direction vector is (sin A, −cos A); the gradient line runs
    // through the box centre. (CSS 135deg ⇒ top-left → bottom-right.)
    const rad = (opts.angleDeg * Math.PI) / 180;
    const dx = Math.sin(rad) / 2;
    const dy = -Math.cos(rad) / 2;
    const x1 = (0.5 - dx).toFixed(4);
    const y1 = (0.5 - dy).toFixed(4);
    const x2 = (0.5 + dx).toFixed(4);
    const y2 = (0.5 + dy).toFixed(4);
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${opts.w}" height="${opts.h}" `
        + `viewBox="0 0 ${opts.w} ${opts.h}" preserveAspectRatio="none">`
        + `<defs><linearGradient id="g" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">`
        + `<stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/>`
        + `</linearGradient></defs>`
        + `<rect width="${opts.w}" height="${opts.h}" fill="url(#g)"/></svg>`;
}

/** Markup → `data:image/svg+xml;base64,…`. Optional dedup cache (audit M2/L1). */
export function svgMarkupToDataUri(markup: string, cache?: SvgAssetCache): string {
    if (cache) {
        const hit = cache.get(markup);
        if (hit) return hit;
    }
    const uri = `data:image/svg+xml;base64,${base64(markup)}`;
    cache?.set(markup, uri);
    return uri;
}

export interface SvgBox { x: number; y: number; w: number; h: number }

/**
 * Encode `markup` and `addImage` it inside ONE try, so a throw at EITHER the
 * encode or the addImage step runs `fallback()` (Gemini MEDIUM — the error
 * boundary must enclose encoding). Never throws.
 */
export function addSvgImageSafe(
    slide: SvgImageSlide,
    markup: string,
    box: SvgBox,
    fallback: () => void,
    cache?: SvgAssetCache,
): void {
    try {
        const data = svgMarkupToDataUri(markup, cache);
        slide.addImage({ data, x: box.x, y: box.y, w: box.w, h: box.h });
    } catch {
        // Guard the fallback too — a throwing fallback must NOT crash the render
        // (honours the documented "never throws" contract — audit M10).
        try { fallback(); } catch { /* swallow */ }
    }
}
