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

// ── CSS font-family sanitize / serialize (brand-font-embedding H3 + R3-H1) ──
//
// TWO DISTINCT operations on a family name — never conflated (audit R3-H1):
//  · sanitizeCssFontFamily  → VALIDATION: a bare, unquoted, raw single family.
//  · serializeCssFontFamily → RENDER: a CSS token (bare generic, else quoted-once).
// Quoting happens EXACTLY ONCE, in serialize, so `fontFace` stays bare for PPTX
// while CSS gets a correctly-quoted token — no `''Noto Sans''`.

/** CSS generic font keywords — emitted BARE (quoting one would make it a literal
 *  family name, not the generic). Everything else is single-quoted on serialize. */
const GENERIC_FONT_KEYWORDS = new Set([
    'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui',
    'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'math', 'emoji', 'fangsong',
]);

/** Max chars for a single family name — bounds the emitted CSS. */
const MAX_FONT_FAMILY_CHARS = 64;

/**
 * Validate ONE family name → a bare, unquoted, raw name (or `''` if nothing
 * usable). Allowlist = Unicode letters/marks/numbers + space/`_`/`-` — so
 * international family names (CJK, accented, etc.) survive — while every CSS-
 * injection vector (comma/quote/brace/`;`/`<>`/`()`/backslash/controls) is
 * stripped. Whitespace collapsed; length-capped. This is what `ExportTheme.fontFace`
 * stores (PPTX needs the bare name — no quotes).
 */
export function sanitizeCssFontFamily(name: string): string {
    const cleaned = (name ?? '')
        .replace(/[^\p{L}\p{M}\p{N} _-]/gu, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, MAX_FONT_FAMILY_CHARS)
        .trim();
    return cleaned;
}

/**
 * Serialize ONE family name → a CSS `font-family` token. Generics stay bare; every
 * other (already-sanitized) name is wrapped in single quotes (the sanitizer has
 * stripped quotes/backslashes, so the result can't break out). Empty → `''`.
 */
export function serializeCssFontFamily(rawName: string): string {
    const s = sanitizeCssFontFamily(rawName);
    if (!s) return '';
    if (GENERIC_FONT_KEYWORDS.has(s.toLowerCase())) return s;
    return `'${s}'`;
}

/**
 * Sanitize + serialize a comma-separated family LIST → CSS-ready text
 * (`'Noto Sans', system-ui, sans-serif`). Each family validated + serialized +
 * de-duped (case-insensitive); a trailing generic (`sans-serif`) is ensured.
 * Empty/garbage → `sans-serif`. This is the value stored on `ExportTheme.fontStack`.
 */
export function sanitizeCssFontFamilyList(raw: string): string {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const part of (raw ?? '').split(',')) {
        const fam = sanitizeCssFontFamily(part);
        if (!fam) continue;
        const key = fam.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(serializeCssFontFamily(fam));
    }
    if (!out.some(t => GENERIC_FONT_KEYWORDS.has(t.toLowerCase()))) out.push('sans-serif');
    return out.length > 0 ? out.join(', ') : 'sans-serif';
}

/** First family of a (possibly list) raw value → bare sanitized name for PPTX. */
export function firstCssFontFamily(raw: string): string {
    return sanitizeCssFontFamily((raw ?? '').split(',')[0]) || 'sans-serif';
}

/** Coerce a font weight to an int in [1,1000]; invalid → 400. */
export function coerceFontWeight(w: unknown): number {
    const n = Math.round(Number(w));
    return Number.isFinite(n) && n >= 1 && n <= 1000 ? n : 400;
}

/** Coerce a font style to the CSS enum; anything else → `normal`. */
export function coerceFontStyle(s: unknown): 'normal' | 'italic' | 'oblique' {
    return s === 'italic' || s === 'oblique' ? s : 'normal';
}

/** Sane bounds for a body font size in points. Below ~6pt is illegible; above
 *  ~96pt overflows the slide. A non-finite/out-of-range value → 14 (the default). */
export const MIN_BODY_FONT_PT = 6;
export const MAX_BODY_FONT_PT = 96;
export function coerceBodyFontSize(pt: unknown): number {
    const n = Number(pt);
    if (!Number.isFinite(n)) return 14;
    return Math.min(MAX_BODY_FONT_PT, Math.max(MIN_BODY_FONT_PT, n));
}

/**
 * Normalise an `ExportTheme` ONCE at a renderer's entry so every downstream
 * colour/font interpolation is already validated (the theme comes from settings
 * / brand-guideline config, NOT the Zod-validated IR). Invalid values degrade to
 * the navy-gold defaults; `onInvalid(field)` fires per bad field so the caller
 * can record a notice. Colours stay in the `ExportTheme` convention (6-hex, no
 * `#`). `slide.background` is already schema-validated, so it is not touched here.
 *
 * FONT INVARIANT (brand-font-embedding Gemini-R1-H1): `fontStack` is ALWAYS
 * populated from the raw incoming value via the LIST sanitizer (off-brand
 * `fontFace` may itself be a stack like `Inter, sans-serif` — running the single-
 * family sanitizer on it would strip the comma and corrupt it). `fontFace` is set
 * to the first sanitized BARE family (for PPTX). `fontFaceCss` is passed through
 * unchanged (it is built by the brand loader from already-validated data-URIs).
 */
export function sanitizeExportTheme(theme: ExportTheme, onInvalid?: (field: string) => void): ExportTheme {
    const fix = (field: string, val: string, fb: string): string => {
        const r = safeHex(val, fb);
        if (!r.ok) onInvalid?.(field);
        return r.hex;
    };
    const rawStack = theme.fontStack ?? theme.fontFace;
    const fontStack = sanitizeCssFontFamilyList(rawStack);
    const fontFace = firstCssFontFamily(theme.fontFace);
    // Observability parity with colour fallback (audit M8): fire when the source
    // contained an INJECTION-class char the family sanitizer strips — i.e. anything
    // outside the sanitizer allowlist plus the benign list separators (comma) and
    // quotes. Uses the SAME allowlist the output is built from, so it can't misfire.
    if (/[^\p{L}\p{M}\p{N} ,_'"-]/u.test(theme.fontFace ?? '')) onInvalid?.('fontFace');
    return {
        ...theme,
        primaryColor: fix('primaryColor', theme.primaryColor, '1A3A5C'),
        accentColor: fix('accentColor', theme.accentColor, 'F5C842'),
        sectionBg: fix('sectionBg', theme.sectionBg, '1D6B4A'),
        bodyColor: fix('bodyColor', theme.bodyColor, '2D4A5A'),
        fontFace,
        fontStack,
        fontSize: coerceBodyFontSize(theme.fontSize),
    };
}
