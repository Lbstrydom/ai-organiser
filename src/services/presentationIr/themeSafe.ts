/**
 * Theme-value boundary validators (debt plan D2). The renderers interpolate
 * `ExportTheme` colours/fonts straight into HTML style attributes and PPTX
 * colour options; a malformed value would otherwise reach the output unchecked.
 * These are the LENIENT boundary variant of `svgAsset.assertHexColor` — they
 * DEGRADE to a fallback (never throw — the renderers are pure + `Result`-typed)
 * and report `ok:false` so the caller can record a `FidelityNotice`.
 *
 * Pure — no Obsidian, no pptxgenjs.
 */

import type { ExportTheme } from '../export/exportTheme';

/** Result of validating a colour at the renderer boundary. `hex` is the
 *  canonical 6-digit form WITHOUT `#` (the PPTX form; HTML callers prepend `#`).
 *  `ok:false` means the input was malformed and `fallback` was substituted. */
export interface SafeHexResult { hex: string; ok: boolean }

const HEX6 = /^#?([0-9A-Fa-f]{6})$/;

/**
 * Validate a theme colour. Accepts an optional leading `#`; anything else
 * degrades to `fallback`. Both `c` and `fallback` are normalised to 6-hex
 * (no `#`). If `fallback` itself is malformed, a safe neutral (`000000`) is used
 * so the renderer always gets a usable colour.
 */
export function safeHex(c: string, fallback: string): SafeHexResult {
    const m = HEX6.exec(c ?? '');
    if (m) return { hex: m[1].toUpperCase(), ok: true };
    const fb = HEX6.exec(fallback ?? '');
    return { hex: (fb ? fb[1] : '000000').toUpperCase(), ok: false };
}

/**
 * Sanitise a font-family name for safe interpolation into a CSS `font-family`
 * value and a PPTX `fontFace`. Allowlist — letters/digits/space/comma/period/
 * hyphen cover font names and CSS font stacks ("Noto Sans, system-ui,
 * sans-serif"); everything else (quotes, `;`, braces, `<>`, backslash, control
 * chars) is stripped. Falls back to a system stack when nothing usable remains.
 */
export function safeFont(name: string): string {
    const cleaned = (name ?? '')
        .replace(/[^A-Za-z0-9 ,.-]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    return cleaned.length > 0 ? cleaned : 'sans-serif';
}

/**
 * Normalise an `ExportTheme` ONCE at a renderer's entry so every downstream
 * colour/font interpolation is already validated (the theme comes from settings
 * / brand-guideline config, NOT the Zod-validated IR). Invalid values degrade to
 * the navy-gold defaults; `onInvalid(field)` fires per bad field so the caller
 * can record a notice. Colours stay in the `ExportTheme` convention (6-hex, no
 * `#`). `slide.background` is already schema-validated, so it is not touched here.
 */
export function sanitizeExportTheme(theme: ExportTheme, onInvalid?: (field: string) => void): ExportTheme {
    const fix = (field: string, val: string, fb: string): string => {
        const r = safeHex(val, fb);
        if (!r.ok) onInvalid?.(field);
        return r.hex;
    };
    return {
        ...theme,
        primaryColor: fix('primaryColor', theme.primaryColor, '1A3A5C'),
        accentColor: fix('accentColor', theme.accentColor, 'F5C842'),
        sectionBg: fix('sectionBg', theme.sectionBg, '1D6B4A'),
        bodyColor: fix('bodyColor', theme.bodyColor, '2D4A5A'),
        fontFace: fixFont(theme.fontFace, onInvalid),
    };
}

/** safeFont + observability — fires `onInvalid('fontFace')` when DANGEROUS chars
 *  were stripped (not merely whitespace normalised), so font sanitisation is as
 *  visible as colour fallback (audit M8). */
function fixFont(raw: string, onInvalid?: (field: string) => void): string {
    const clean = safeFont(raw);
    const wsNormalised = (raw ?? '').replace(/\s+/g, ' ').trim();
    if (clean !== wsNormalised) onInvalid?.('fontFace');
    return clean;
}
