/**
 * Neutral SVG/HTML sanitisation utilities (debt plan D3+D4). Relocated here from
 * `services/chat/presentationSanitizer` so BOTH the chat layer and the
 * `presentationIr` renderers can import them without either depending on the
 * other's domain (the renderers were importing `../chat/...`, an inverted
 * coupling). `chat/presentationSanitizer` re-exports `sanitizeSvgMarkup` for
 * back-compat.
 *
 * These are DEFENCE-IN-DEPTH. The AUTHORITATIVE HTML allowlist + CSP runs at the
 * service boundary (`presentationHtmlService.buildHtmlFromDeckIr` →
 * `sanitizePresentation` + `injectCSP`); `stripDangerousHtml` is a pure inner
 * layer for `custom.html`, NOT a substitute for that allowlist. A caller that
 * consumes renderer output WITHOUT the service boundary must run an allowlist.
 */

import { SVG_TAGS, SVG_ATTRS, MAX_INPUT_CHARS, extractCssUrls } from './presentationSanitizePolicy';

/** Allowed SVG element tag names (lowercased), DERIVED from the shared policy
 *  SSOT (M6 — no parallel tag list). This embed/PPTX context is intentionally
 *  TIGHTER than the inline-preview policy: `<use>` is removed because embedded
 *  SVG must not carry even local-fragment refs out of context. `script`,
 *  `foreignObject`, `image`, `a`, `animate`, `set` are already absent from the
 *  policy set. */
const ALLOWED_SVG_TAGS = new Set([...SVG_TAGS].filter((t) => t !== 'use'));

/** Allowed SVG attributes, DERIVED from the shared policy SVG_ATTRS (M6): every
 *  policy SVG attr EXCEPT the URL-bearing `href`/`xlink:href` (embedded SVG must
 *  not reference anything), PLUS `class`/`id` (global in the policy but needed
 *  here). The `!name.includes('href')` guard below is belt-and-braces. */
const ALLOWED_SVG_ATTRS = new Set([
    ...[...SVG_ATTRS].filter((a) => !a.includes('href')),
    'class', 'id',
]);

/**
 * Sanitize raw `<svg>` markup before it is embedded (as a data-URI image in
 * PPTX or inline in preview HTML). Uses a DOMParser allowlist walk — NOT regex
 * (regex SVG sanitizers are defeated by mixed-case tags, namespaces, encoded
 * URLs). Strips `<script>`/`<foreignObject>`/`<use>`/external refs, every `on*`
 * handler, and `href`/`xlink:href`.
 *
 * Requires a DOM (Obsidian/Electron at runtime; happy-dom in tests). When no
 * DOMParser is available it returns an empty string rather than risk emitting
 * unsanitized markup (fail-closed).
 */
export function sanitizeSvgMarkup(svg: string): string {
    if (typeof DOMParser === 'undefined') return '';
    // Input budget (audit M7) — parity with the main sanitizer's MAX_INPUT_CHARS;
    // refuse to parse a multi-MB blob (fail closed).
    if (typeof svg !== 'string' || svg.length > MAX_INPUT_CHARS) return '';
    let doc: Document;
    try {
        doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    } catch {
        return '';
    }
    const root = doc.querySelector('svg');
    if (!root) return '';
    scrubSvgNode(root);
    return root.outerHTML;
}

function scrubSvgNode(el: Element): void {
    // Depth-first; collect children first since we may remove nodes.
    for (const child of Array.from(el.children)) {
        const tag = child.tagName.toLowerCase();
        if (!ALLOWED_SVG_TAGS.has(tag)) {
            child.remove();
            continue;
        }
        scrubSvgNode(child);
    }
    for (const attr of Array.from(el.attributes)) {
        const name = attr.name.toLowerCase();
        // Match the FULL (prefixed) attribute name against the allowlist — we do
        // NOT strip namespace prefixes, so namespaced attrs like `xml:space` are
        // dropped (they aren't in ALLOWED_SVG_ATTRS). Any name containing `href`
        // (`href` / `xlink:href`) is always excluded regardless of the allowlist.
        const isAllowed = ALLOWED_SVG_ATTRS.has(name) && !name.includes('href');
        // Drop EXTERNAL url() references in otherwise-allowlisted paint/presentation
        // attributes (e.g. `fill="url(http://…)"`) — the allowlist permits the
        // attribute but not an external paint server. Internal refs (`url(#gradient)`,
        // including quoted `url('#g')`) are kept. Uses the shared robust extractor
        // (fail-closed on unparseable url(), no backtracking false-positive on
        // quoted internal refs — audit Gemini-G1 + D2-D4 H4).
        const { tokens, clean } = extractCssUrls(attr.value);
        const hasExternalUrl = !clean || tokens.some((t) => !t.trim().startsWith('#'));
        if (!isAllowed || name.startsWith('on') || hasExternalUrl) {
            el.removeAttribute(attr.name);
        }
    }
}

/**
 * Pure, regex-based strip of the most dangerous constructs from a raw
 * `custom.html` fragment — scripts, inline `on*` handlers, and `javascript:`
 * URLs. DEFENCE-IN-DEPTH ONLY: this is NOT a complete sanitiser; the
 * authoritative allowlist + CSP runs at the service boundary (see the module
 * header). Stateless `String.replace`.
 */
export function stripDangerousHtml(html: string): string {
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<script[^>]*>/gi, '')
        .replace(/[\s/]on\w+\s*=\s*"[^"]*"/gi, '')
        .replace(/[\s/]on\w+\s*=\s*'[^']*'/gi, '')
        .replace(/[\s/]on\w+\s*=\s*[^\s>]+/gi, '')
        .replace(/javascript:/gi, '');
}
