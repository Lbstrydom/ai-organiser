/**
 * Presentation sanitiser POLICY — the single source of allow/deny truth
 * (plan: presentation-sanitizer-hardening, Decision 2 / M1 / M6).
 *
 * Domain-NEUTRAL: pure data + pure predicates. NO DOM, NO DOMPurify, NO
 * Obsidian imports — so both `services/chat/presentationSanitizer` (the
 * DOMPurify engine) and `utils/svgSanitize` (the DOMParser SVG walk) import
 * *downward* into this module instead of maintaining parallel lists.
 *
 * DOMPurify matches tag names case-insensitively (it lowercases the parsed
 * nodeName before the ALLOWED_TAGS lookup), so SVG elements are listed
 * lowercase here (`lineargradient`) yet a parsed `<linearGradient>` still
 * matches and renders with its real casing.
 */

// ── Tag allowlist ────────────────────────────────────────────────────────────

/** SVG element subset (lowercase). Shared with `svgSanitize`. */
export const SVG_TAGS: ReadonlySet<string> = new Set([
    'svg', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon',
    'ellipse', 'g', 'defs', 'text', 'tspan', 'use', 'symbol',
    'clippath', 'lineargradient', 'radialgradient', 'stop', 'mask',
    'title', 'desc',
]);

/** Every allowed element (HTML + SVG), lowercase. Anything else is stripped. */
export const ALLOWED_TAGS: readonly string[] = [
    // Structure
    'div', 'section', 'article', 'header', 'footer', 'main', 'nav', 'aside',
    // Headings
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    // Text
    'p', 'span', 'strong', 'em', 'b', 'i', 'u', 'small', 'sub', 'sup',
    'blockquote', 'code', 'pre', 'br', 'hr',
    // Lists
    'ul', 'ol', 'li', 'dl', 'dt', 'dd',
    // Tables
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
    // Media (restricted URLs handled by hooks)
    'img', 'figure', 'figcaption',
    // Links
    'a',
    // SVG
    ...SVG_TAGS,
    // Misc
    'details', 'summary', 'mark',
];

/**
 * Tags we never want even though some are not "dangerous" per se. Passed to
 * DOMPurify `FORBID_TAGS` as belt-and-braces (the explicit ALLOWED_TAGS list
 * already excludes them; this makes intent auditable and removes `<style>`
 * elements — slides are inline-styled, stylesheet sanitisation is out of scope).
 */
export const FORBID_TAGS: readonly string[] = [
    'script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet',
    'form', 'input', 'textarea', 'select', 'button', 'link', 'meta', 'base',
    'style', 'foreignobject', 'image', 'animate', 'animatetransform', 'set',
];

// ── Attribute allowlist (flattened for DOMPurify's global ALLOWED_ATTR) ───────

// data-* and aria-* are inert (cannot execute) and the renderer uses arbitrary
// data-slide-index/data-num markers, so they are allowed wholesale via DOMPurify's
// ALLOW_DATA_ATTR / ALLOW_ARIA_ATTR flags (NOT enumerated here — enumerating a
// subset alongside the broad flags is dead policy and reads as drift; audit M3).
const GLOBAL_ATTRIBUTES = [
    'class', 'id', 'style', 'title', 'lang', 'dir', 'tabindex', 'hidden', 'role',
];

/** SVG presentation/geometry attributes (lowercase). Shared with `svgSanitize`. */
export const SVG_ATTRS: ReadonlySet<string> = new Set([
    'd', 'points', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry',
    'width', 'height', 'viewbox', 'preserveaspectratio',
    'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-linecap',
    'stroke-linejoin', 'stroke-dasharray', 'stroke-opacity', 'opacity',
    'transform', 'offset', 'stop-color', 'stop-opacity', 'gradientunits',
    'gradienttransform', 'text-anchor', 'dominant-baseline',
    'font-size', 'font-family', 'font-weight', 'xmlns',
    // URL-bearing SVG attrs — allowed into the parse, then constrained to
    // `#fragment` by the URL hook (use@href / use@xlink:href).
    'href', 'xlink:href',
]);

const HTML_TAG_ATTRIBUTES = [
    // a
    'href', 'target', 'rel',
    // img
    'src', 'alt', 'loading',
    // tables
    'colspan', 'rowspan', 'scope', 'span',
];

/** Flat union — DOMPurify applies ALLOWED_ATTR globally; per-element URL rules
 *  are enforced by the engine's hooks, not by this list. */
export const ALLOWED_ATTR: readonly string[] = Array.from(new Set([
    ...GLOBAL_ATTRIBUTES,
    ...HTML_TAG_ATTRIBUTES,
    ...SVG_ATTRS,
]));

// ── CSS allowlist ─────────────────────────────────────────────────────────────

export const ALLOWED_CSS_PROPERTIES: ReadonlySet<string> = new Set([
    'color', 'background-color', 'background',
    'font-size', 'font-weight', 'font-style', 'font-family',
    'text-align', 'text-decoration', 'text-transform', 'line-height', 'letter-spacing',
    'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
    'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
    'border', 'border-radius', 'border-color', 'border-width', 'border-style',
    'width', 'height', 'max-width', 'max-height', 'min-width', 'min-height',
    'display', 'flex', 'flex-direction', 'flex-wrap', 'justify-content', 'align-items', 'gap',
    'grid-template-columns', 'grid-template-rows', 'grid-gap',
    'position', 'top', 'right', 'bottom', 'left', 'z-index',
    'box-sizing',
    'opacity', 'visibility', 'overflow', 'overflow-x', 'overflow-y',
    'box-shadow', 'text-shadow', 'transform', 'transition',
    'white-space', 'word-break', 'vertical-align',
    'list-style', 'list-style-type',
    'background-image', 'background-size', 'background-position', 'background-repeat',
    'fill', 'stroke', 'stroke-width',
]);

/** CSS value constructs that load resources / execute, beyond plain `url()`. */
export const DANGEROUS_CSS_VALUE_PATTERNS: readonly RegExp[] = [
    /expression\s*\(/i,
    /behavior\s*:/i,
    /-moz-binding\s*:/i,
    /javascript\s*:/i,
    /vbscript\s*:/i,
    /image-set\s*\(/i,   // also matches -webkit-image-set(
    /cross-fade\s*\(/i,
];

// ── Resource budgets (Decision 5) ─────────────────────────────────────────────

/** Whole input rejected (fail-closed → empty) above this. ~2 MB. */
export const MAX_INPUT_CHARS = 2_000_000;
/** Per-`data:` image DECODED bytes; oversized image stripped, deck kept. */
export const MAX_DATA_URI_BYTES = 2_000_000;
/** Max `<img>` elements; first N in document order kept, rest stripped. */
export const MAX_IMAGE_COUNT = 50;
/** Per-attribute value chars; oversized attribute stripped. */
export const MAX_ATTR_CHARS = 100_000;

// ── URL policy (Decision 3a) ───────────────────────────────────────────────────

/** Explicit raster MIME allowlist for inline `data:image` URIs. SVG is
 *  excluded deliberately (scriptable); exotic/loader formats excluded until a
 *  tested need. */
export const RASTER_DATA_IMAGE_MIME: ReadonlySet<string> = new Set([
    'image/png', 'image/jpeg', 'image/gif', 'image/webp',
]);

/**
 * Normalise a URL for scheme comparison: strip ASCII control characters
 * (incl. TAB/LF/CR — defeats `ja&#9;vascript:` style obfuscation the parser may
 * leave in the value), then trim. Case is left intact; callers lowercase only
 * the scheme.
 */
export function normalizeUrl(raw: string): string {
    // eslint-disable-next-line no-control-regex -- intentional: strip C0 controls + DEL
    return raw.replace(/[\u0000-\u001F\u007F]/g, '').trim();
}

/**
 * Parse + measure a `data:image` URL. Returns `{ mime, byteLength }` for an
 * allowed raster MIME, else `null`. `byteLength` is the DECODED payload size
 * (base64 inflates ~33%, so string length would mis-measure — R2-M4).
 */
export function parsePresentationDataImageUrl(raw: string): { mime: string; byteLength: number } | null {
    const v = normalizeUrl(raw);
    const m = /^data:([^;,]+)(;[^,]*)?,(.*)$/is.exec(v);
    if (!m) return null;
    const mime = m[1].trim().toLowerCase();
    if (!RASTER_DATA_IMAGE_MIME.has(mime)) return null;
    const params = (m[2] ?? '').toLowerCase();
    const payload = m[3] ?? '';
    let byteLength: number;
    if (params.includes(';base64')) {
        const b64 = payload.replace(/\s+/g, '');
        const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
        byteLength = Math.max(0, Math.floor(b64.length * 3 / 4) - pad);
    } else {
        // Percent/text-encoded: decode best-effort for a byte estimate.
        let decoded = payload;
        try { decoded = decodeURIComponent(payload); } catch { /* keep raw */ }
        byteLength = decoded.length;
    }
    return { mime, byteLength };
}

/** Scheme of a normalised URL, lowercased, or '' if none / fragment / relative. */
function schemeOf(normalised: string): string {
    const m = /^([a-z][a-z0-9+.-]*):/i.exec(normalised);
    return m ? m[1].toLowerCase() : '';
}

/**
 * The ONLY place a URL is judged (Decision 3a matrix). `el` and `attr` are
 * lowercased. Byte budgets are enforced separately by the engine (this judges
 * scheme/shape only). `el='css-url'` is the pseudo-element for `url(...)`
 * tokens inside a `style` value.
 */
export function isAllowedPresentationUrl(el: string, attr: string, rawValue: string): boolean {
    const v = normalizeUrl(rawValue);

    // CSS url(...) tokens: data:image raster only.
    if (el === 'css-url') return parsePresentationDataImageUrl(v) !== null;

    // SVG <use> href / xlink:href: local fragment only.
    if (el === 'use') return v.startsWith('#');

    // <img src>: data:image raster only (byte cap enforced by the engine).
    if (el === 'img' && attr === 'src') return parsePresentationDataImageUrl(v) !== null;

    // <a href>: https / mailto / fragment. http:// is rejected (see plan
    // prerequisite grep) — javascript/vbscript/data/file/scheme-relative all out.
    if (el === 'a' && attr === 'href') {
        if (v.startsWith('#')) return true;
        const scheme = schemeOf(v);
        return scheme === 'https' || scheme === 'mailto';
    }

    // Any other URL-bearing attribute defaults to rejected (safe).
    return false;
}

/** Anchor target values that are safe to keep. `_blank` requires the engine to
 *  also force `rel="noopener noreferrer"`. */
export function isAllowedAnchorTarget(target: string): boolean {
    const t = target.trim().toLowerCase();
    return t === '_self' || t === '_blank';
}

/**
 * Robustly extract every `url(...)` token from a CSS/attribute value. Handles
 * double-quoted, single-quoted (with escapes), and unquoted forms. `clean` is
 * false when a `url(` appears that the extractor could NOT fully parse — callers
 * MUST fail closed on `!clean` rather than treat "no tokens" as "no urls"
 * (audit Gemini-G1: a fragile `[^'")]` regex silently matches nothing on a
 * crafted `url("…)…")`, fail-OPEN-ing the whole declaration).
 */
export function extractCssUrls(value: string): { tokens: string[]; clean: boolean } {
    const tokens: string[] = [];
    const re = /url\(\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^)]*)\s*\)/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(value)) !== null) {
        let t = m[1].trim();
        if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
            t = t.slice(1, -1);
        }
        tokens.push(t);
    }
    const occurrences = (value.match(/url\(/gi) ?? []).length;
    return { tokens, clean: tokens.length === occurrences };
}

/**
 * True when EVERY `url(...)` token in a value is safe: a local `#fragment`
 * (SVG paint server / clip ref) or an allowed `data:image` raster. Fails CLOSED
 * if any `url(` could not be parsed. Used to vet SVG presentation attributes
 * such as `fill`/`stroke` that can carry `url(http://evil)` (audit H1).
 */
export function hasOnlyAllowedUrlTokens(value: string): boolean {
    const { tokens, clean } = extractCssUrls(value);
    if (!clean) return false;   // unparseable url( → reject (no fail-open)
    for (const raw of tokens) {
        const token = normalizeUrl(raw);
        if (token.startsWith('#')) continue;
        if (parsePresentationDataImageUrl(token)) continue;
        return false;
    }
    return true;
}
