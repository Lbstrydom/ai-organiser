/**
 * Presentation Sanitizer
 *
 * Sanitizes LLM-generated HTML for safe iframe preview.
 * Allowlist-based tag/attribute filtering, URL scheme validation,
 * CSS property validation, and CSP injection.
 */

// ── Types ──────────────────────────────────────────────────────────────────

export interface SanitizeResult {
    html: string;
    rejectionCount: number;
    hasDeckRoot: boolean;
    hasSlides: boolean;
}

// ── Allowlists ─────────────────────────────────────────────────────────────

const ALLOWED_TAGS = new Set([
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
    // Media (restricted URLs handled separately)
    'img', 'figure', 'figcaption',
    // Links
    'a',
    // SVG
    'svg', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon',
    'ellipse', 'g', 'defs', 'text', 'tspan', 'use', 'symbol',
    'clippath', 'lineargradient', 'radialgradient', 'stop', 'mask',
    // Misc
    'details', 'summary', 'mark',
]);

const BLOCKED_TAGS = new Set([
    'script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet',
    'form', 'input', 'textarea', 'select', 'button', 'link', 'meta',
    'base',
]);

/** Attributes allowed on any element. */
const GLOBAL_ATTRIBUTES = new Set([
    'class', 'id', 'style', 'title', 'lang', 'dir', 'tabindex', 'hidden',
    'role', 'aria-label', 'aria-hidden', 'aria-describedby', 'aria-labelledby',
    'data-title', 'data-type', 'data-index',
]);

/** Tag-specific allowed attributes. */
const TAG_ATTRIBUTES: Record<string, Set<string>> = {
    a: new Set(['href', 'target', 'rel']),
    img: new Set(['src', 'alt', 'width', 'height', 'loading']),
    svg: new Set(['viewbox', 'xmlns', 'width', 'height', 'fill', 'stroke']),
    path: new Set(['d', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin']),
    circle: new Set(['cx', 'cy', 'r', 'fill', 'stroke']),
    rect: new Set(['x', 'y', 'width', 'height', 'rx', 'ry', 'fill', 'stroke']),
    line: new Set(['x1', 'y1', 'x2', 'y2', 'stroke', 'stroke-width']),
    polyline: new Set(['points', 'fill', 'stroke']),
    polygon: new Set(['points', 'fill', 'stroke']),
    ellipse: new Set(['cx', 'cy', 'rx', 'ry', 'fill', 'stroke']),
    g: new Set(['transform', 'fill', 'stroke']),
    text: new Set(['x', 'y', 'dx', 'dy', 'text-anchor', 'fill', 'font-size']),
    tspan: new Set(['x', 'y', 'dx', 'dy']),
    use: new Set(['href', 'xlink:href', 'x', 'y', 'width', 'height']),
    symbol: new Set(['viewbox', 'id']),
    lineargradient: new Set(['id', 'x1', 'y1', 'x2', 'y2', 'gradientunits']),
    radialgradient: new Set(['id', 'cx', 'cy', 'r', 'fx', 'fy', 'gradientunits']),
    stop: new Set(['offset', 'stop-color', 'stop-opacity']),
    clippath: new Set(['id']),
    mask: new Set(['id']),
    th: new Set(['colspan', 'rowspan', 'scope']),
    td: new Set(['colspan', 'rowspan']),
    col: new Set(['span']),
    colgroup: new Set(['span']),
    span: new Set(['data-num']),
};

/** CSS properties allowed in inline styles. */
const ALLOWED_CSS_PROPERTIES = new Set([
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
    'opacity', 'visibility', 'overflow', 'overflow-x', 'overflow-y',
    'box-shadow', 'text-shadow', 'transform', 'transition',
    'white-space', 'word-break', 'vertical-align',
    'list-style', 'list-style-type',
    'background-image', 'background-size', 'background-position', 'background-repeat',
    'fill', 'stroke', 'stroke-width',
]);

/** Patterns that indicate malicious CSS values. */
const DANGEROUS_CSS_VALUE_PATTERNS = [
    /expression\s*\(/i,
    /behavior\s*:/i,
    /-moz-binding\s*:/i,
    /javascript\s*:/i,
    /vbscript\s*:/i,
];

// ── URL Validation ─────────────────────────────────────────────────────────

function isAllowedHref(url: string): boolean {
    const trimmed = url.trim().toLowerCase();
    return trimmed.startsWith('http://') || trimmed.startsWith('https://')
        || trimmed.startsWith('#') || trimmed.startsWith('mailto:');
}

function isAllowedImgSrc(url: string): boolean {
    const trimmed = url.trim().toLowerCase();
    // Only data: URIs allowed for images (no remote loading)
    return trimmed.startsWith('data:image/');
}

function isAllowedCssUrl(url: string): boolean {
    const trimmed = url.trim().toLowerCase();
    return trimmed.startsWith('data:image/');
}

// ── CSS Sanitization ───────────────────────────────────────────────────────

function sanitizeCssValue(value: string): string | null {
    for (const pattern of DANGEROUS_CSS_VALUE_PATTERNS) {
        if (pattern.test(value)) return null;
    }
    // Check url() references
    const urlMatch = /url\s*\(\s*['"]?([^'")]+)['"]?\s*\)/i.exec(value);
    if (urlMatch && !isAllowedCssUrl(urlMatch[1])) {
        return null;
    }
    return value;
}

/**
 * Split a CSS style string into declarations, respecting semicolons inside url().
 * e.g. "background-image: url(data:image/png;base64,abc); color: red"
 *   → ["background-image: url(data:image/png;base64,abc)", "color: red"]
 */
function splitCssDeclarations(style: string): string[] {
    const results: string[] = [];
    let depth = 0;
    let current = '';
    for (const ch of style) {
        if (ch === '(') depth++;
        if (ch === ')') depth = Math.max(0, depth - 1);
        if (ch === ';' && depth === 0) {
            const trimmed = current.trim();
            if (trimmed) results.push(trimmed);
            current = '';
        } else {
            current += ch;
        }
    }
    const last = current.trim();
    if (last) results.push(last);
    return results;
}

function sanitizeStyleAttribute(style: string): string {
    const declarations = splitCssDeclarations(style);
    const kept: string[] = [];
    for (const decl of declarations) {
        const colonIdx = decl.indexOf(':');
        if (colonIdx < 0) continue;
        const prop = decl.slice(0, colonIdx).trim().toLowerCase();
        const val = decl.slice(colonIdx + 1).trim();
        if (!ALLOWED_CSS_PROPERTIES.has(prop)) continue;
        const sanitized = sanitizeCssValue(val);
        if (sanitized !== null) {
            kept.push(`${prop}: ${sanitized}`);
        }
    }
    return kept.join('; ');
}

// ── HTML Sanitization (regex-based, no DOM parser dependency) ──────────────

interface AttrFilterResult {
    kept: string[];
    rejected: number;
}

/** Filter a single attribute, returning its sanitized form or null if rejected. */
function filterAttribute(tag: string, attrName: string, attrValue: string): string | null {
    if (attrName.startsWith('on')) return null;

    const tagSpecific = TAG_ATTRIBUTES[tag];
    const isAllowedAttr = GLOBAL_ATTRIBUTES.has(attrName)
        || tagSpecific?.has(attrName)
        || attrName.startsWith('data-');
    if (!isAllowedAttr) return null;

    if (attrName === 'href' && !isAllowedHref(attrValue)) return null;
    if (attrName === 'src' && tag === 'img' && !isAllowedImgSrc(attrValue)) return null;

    if (attrName === 'style') {
        const sanitized = sanitizeStyleAttribute(attrValue);
        return sanitized ? `style="${sanitized}"` : null;
    }

    return `${attrName}="${attrValue}"`;
}

/** Parse and filter all attributes from a decoded attribute string. */
function filterAttributes(tag: string, decodedAttrs: string): AttrFilterResult {
    const kept: string[] = [];
    let rejected = 0;

    const attrPattern = /\s+([a-zA-Z][a-zA-Z0-9_:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/g;
    let attrMatch: RegExpExecArray | null;

    while ((attrMatch = attrPattern.exec(decodedAttrs)) !== null) {
        const attrName = attrMatch[1].toLowerCase();
        const attrValue = attrMatch[2] ?? attrMatch[3] ?? attrMatch[4] ?? '';
        const result = filterAttribute(tag, attrName, attrValue);
        if (result !== null) {
            kept.push(result);
        } else if (attrName.startsWith('on') || attrName === 'href' || attrName === 'src') {
            rejected++;
        }
    }

    // Handle bare attributes (no value) like hidden
    const bareAttrPattern = /\s+([a-zA-Z][a-zA-Z0-9_-]*)(?=\s|\/?>|$)(?!\s*=)/g;
    let bareMatch: RegExpExecArray | null;
    while ((bareMatch = bareAttrPattern.exec(decodedAttrs)) !== null) {
        const attrName = bareMatch[1].toLowerCase();
        if (GLOBAL_ATTRIBUTES.has(attrName)) {
            kept.push(attrName);
        }
    }

    return { kept, rejected };
}

/** Decode common HTML entities that could bypass event handler detection. */
function decodeEntities(s: string): string {
    return s
        .replaceAll(/&#x([0-9a-f]+);?/gi, (_m, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
        .replaceAll(/&#(\d+);?/g, (_m, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)));
}

/**
 * Sanitize LLM-generated presentation HTML.
 *
 * Uses regex-based tag/attribute filtering (no DOM dependency).
 * Strips blocked tags entirely, filters attributes on allowed tags,
 * validates URLs and CSS values.
 */
export function sanitizePresentation(rawHtml: string): SanitizeResult {
    if (!rawHtml?.trim()) {
        return { html: '', rejectionCount: 0, hasDeckRoot: false, hasSlides: false };
    }

    let rejectionCount = 0;
    let working = rawHtml;

    // Phase 1: Remove blocked tags and their content
    for (const tag of BLOCKED_TAGS) {
        // Tags with content (try first — greedy match prevents orphaned close tags)
        const contentPattern = new RegExp(String.raw`<${tag}\b[^>]*>[\s\S]*?</${tag}>`, 'gi');
        const contentMatches = working.match(contentPattern);
        if (contentMatches) {
            rejectionCount += contentMatches.length;
            working = working.replace(contentPattern, '');
        }

        // Self-closing or void tags (remaining after content removal)
        const voidPattern = new RegExp(String.raw`<${tag}\b[^>]*/?>`, 'gi');
        const voidMatches = working.match(voidPattern);
        if (voidMatches) {
            rejectionCount += voidMatches.length;
            working = working.replace(voidPattern, '');
        }
    }

    // Phase 2: Process remaining tags — filter attributes
    working = working.replaceAll(/<([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^>]*?)?)(\s*\/?)>/g,
        (_match, tagName: string, attrs: string, closing: string) => {
            const tag = tagName.toLowerCase();

            if (!ALLOWED_TAGS.has(tag)) {
                rejectionCount++;
                return '';
            }

            if (!attrs.trim()) {
                return `<${tagName}${closing}>`;
            }

            const decodedAttrs = decodeEntities(attrs);
            const { kept, rejected } = filterAttributes(tag, decodedAttrs);
            rejectionCount += rejected;

            const attrStr = kept.length > 0 ? ' ' + kept.join(' ') : '';
            return `<${tagName}${attrStr}${closing}>`;
        });

    // Structural detection
    const hasDeckRoot = /class="[^"]*\bdeck\b/.test(working) || /class='[^']*\bdeck\b/.test(working);
    const hasSlides = /class="[^"]*\bslide\b/.test(working) || /class='[^']*\bslide\b/.test(working);

    return { html: working, rejectionCount, hasDeckRoot, hasSlides };
}

// ── CSP Injection ──────────────────────────────────────────────────────────

const CSP_META = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:;">';

/**
 * Inject a Content-Security-Policy meta tag into the <head> of an HTML document.
 * If a CSP meta already exists, returns the HTML unchanged.
 */
export function injectCSP(html: string): string {
    // Already has CSP?
    if (/content-security-policy/i.test(html)) {
        return html;
    }

    // Insert after <head> if present
    const headMatch = /<head[^>]*>/i.exec(html);
    if (headMatch) {
        const insertAt = headMatch.index + headMatch[0].length;
        return html.slice(0, insertAt) + '\n' + CSP_META + html.slice(insertAt);
    }

    // No head — prepend
    return CSP_META + '\n' + html;
}
