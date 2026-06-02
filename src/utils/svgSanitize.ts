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

/** Allowed SVG element tag names (lowercased). External-ref + scripting
 *  elements (`script`, `foreignObject`, `use`, `image`, `a`, `animate`,
 *  `set`) are deliberately excluded. */
const ALLOWED_SVG_TAGS = new Set([
    'svg', 'g', 'defs', 'title', 'desc', 'symbol', 'mask', 'clippath',
    'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
    'text', 'tspan', 'lineargradient', 'radialgradient', 'stop',
]);

/** Allowed presentation/geometry attributes. Anything not listed — including
 *  every `on*` handler and `href`/`xlink:href` — is dropped. */
const ALLOWED_SVG_ATTRS = new Set([
    'd', 'points', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry',
    'width', 'height', 'viewbox', 'preserveaspectratio',
    'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-linecap',
    'stroke-linejoin', 'stroke-dasharray', 'stroke-opacity', 'opacity',
    'transform', 'offset', 'stop-color', 'stop-opacity', 'gradientunits',
    'gradienttransform', 'class', 'id', 'text-anchor', 'dominant-baseline',
    'font-size', 'font-family', 'font-weight', 'xmlns',
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
        const isAllowed = ALLOWED_SVG_ATTRS.has(name)
            // Strip namespace prefix (e.g. xml:space) before the allowlist check,
            // but never allow xlink:* / *href.
            && !name.includes('href');
        if (!isAllowed || name.startsWith('on')) {
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
