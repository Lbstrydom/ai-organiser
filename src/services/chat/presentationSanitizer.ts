/**
 * Presentation Sanitizer — parser-based (DOMPurify) trust boundary.
 *
 * Plan: docs/plans/presentation-sanitizer-hardening.md.
 *
 * Sanitizes LLM-generated slide HTML before it renders in a sandboxed iframe.
 * The engine is DOMPurify (real browser parser → no regex parser-differentials);
 * the allow/deny policy is the single source of truth in
 * `utils/presentationSanitizePolicy`. Per-element URL rules, the CSS-property
 * allowlist, anchor canonicalisation, and resource budgets run in DOMPurify
 * hooks (they see the PARSED node). Fails CLOSED: any internal error returns
 * empty HTML, never raw input.
 *
 * Synchronous + main-thread (Electron/Chromium at runtime; happy-dom in tests).
 */

import DOMPurify from 'dompurify';
import { logger } from '../../utils/logger';
import {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    FORBID_TAGS,
    ALLOWED_CSS_PROPERTIES,
    DANGEROUS_CSS_VALUE_PATTERNS,
    MAX_INPUT_CHARS,
    MAX_DATA_URI_BYTES,
    MAX_IMAGE_COUNT,
    MAX_ATTR_CHARS,
    isAllowedPresentationUrl,
    isAllowedAnchorTarget,
    parsePresentationDataImageUrl,
    hasOnlyAllowedUrlTokens,
    extractCssUrls,
} from '../../utils/presentationSanitizePolicy';

// ── Types ──────────────────────────────────────────────────────────────────

export type SanitizeStatus =
    | 'ok'
    | 'sanitized'
    | 'budget-exceeded'
    | 'malformed-input'
    | 'internal-error';

export interface SanitizeResult {
    html: string;
    status: SanitizeStatus;
    hasDeckRoot: boolean;
    hasSlides: boolean;
    /** Back-compat: total removals (tags + attrs + urls). */
    rejectionCount: number;
    removed: { tags: number; attrs: number; urls: number };
    resources: { dataUriBytes: number; imageCount: number; inputChars: number };
    budgetHit?: 'input-size' | 'data-uri-size' | 'image-count';
}

/**
 * Shared dangerous-pattern regexes for the STREAMING reliability heuristic
 * (`streamingHtmlAssembler.countDangerousPatterns`). **NOT a security boundary**
 * — DOMPurify is. Kept non-global so `.test()` stays stateless (a counter must
 * build its own global copy).
 */
export const DANGEROUS_HTML_PATTERNS: ReadonlyArray<RegExp> = [
    /<script/i,
    /<iframe/i,
    /on\w+=/i,
    /javascript:/i,
];

// ── Engine (singleton instance + per-call context) ──────────────────────────

interface SanitizeCtx {
    win: Window;
    removedAttrs: number;     // our attr strips (oversized / bad target / dropped CSS decls)
    removedUrls: number;      // our URL rejects
    cssDataUriBytes: number;  // bytes from CSS url(data:image) (M5 budget accounting)
    budgetHit?: 'data-uri-size';  // CSS data: over the byte cap
}

/** Single active context — safe because `DOMPurify.sanitize` is strictly
 *  synchronous and hooks must never call `sanitize` (documented invariant), so
 *  no two sanitize calls can interleave on JS's single thread (Decision 6). */
let activeCtx: SanitizeCtx | null = null;

interface AttrHookEvent { attrName: string; attrValue: string; keepAttr: boolean }

type Purifier = ReturnType<typeof DOMPurify>;
let purifier: Purifier | null = null;
let purifierWin: unknown = null;

function isElement(node: Node): node is Element {
    return node.nodeType === 1;
}

// Cached CSSOM scratch element per window (L2 — avoid one alloc per style attr).
let scratchStyleEl: HTMLElement | null = null;
let scratchStyleWin: unknown = null;

/** Rebuild a `style` value keeping only allowlisted properties + safe values,
 *  using CSSOM on the PURIFIER'S OWN window (not ambient globalThis — R2-L1).
 *  Counts dropped declarations (M4) and enforces the data: byte budget on CSS
 *  `url()` images, accumulating bytes into ctx (M5). */
function sanitizeStyleValue(ctx: SanitizeCtx, value: string): { css: string; dropped: number } {
    let el: HTMLElement;
    try {
        if (scratchStyleWin !== ctx.win || !scratchStyleEl) {
            scratchStyleEl = ctx.win.document.createElement('div');
            scratchStyleWin = ctx.win;
        }
        el = scratchStyleEl;
        // Parse the untrusted CSS via the attribute (CSSOM canonicalises it).
        // Using setAttribute rather than `.style.cssText =` keeps this a parse,
        // not a static-style assignment (lint: no-static-styles-assignment).
        el.removeAttribute('style');  // reset before reuse
        el.setAttribute('style', value);
    } catch {
        return { css: '', dropped: 1 };
    }
    const decls: string[] = [];
    let dropped = 0;
    for (let i = 0; i < el.style.length; i++) {
        const prop = el.style.item(i);
        if (!ALLOWED_CSS_PROPERTIES.has(prop)) { dropped++; continue; }
        const val = el.style.getPropertyValue(prop);
        if (DANGEROUS_CSS_VALUE_PATTERNS.some((re) => re.test(val))) { dropped++; continue; }
        // Every url(...) token must be #fragment or an allowed data:image raster
        // within the byte budget (M5). Fail CLOSED on an unparseable url(
        // (audit Gemini-G1 — no fail-open).
        const { tokens, clean } = extractCssUrls(val);
        let urlOk = clean;
        if (urlOk) {
            for (const raw of tokens) {
                if (raw.trim().startsWith('#')) continue;
                const parsed = parsePresentationDataImageUrl(raw);
                if (!parsed) { urlOk = false; break; }
                ctx.cssDataUriBytes += parsed.byteLength;
                if (parsed.byteLength > MAX_DATA_URI_BYTES) { urlOk = false; ctx.budgetHit = 'data-uri-size'; break; }
            }
        }
        if (!urlOk) { dropped++; continue; }
        decls.push(`${prop}: ${val}`);
    }
    return { css: decls.join('; '), dropped };
}

function registerHooks(dp: Purifier): void {
    dp.addHook('uponSanitizeAttribute', (node, data) => {
        const ctx = activeCtx;
        if (!ctx || !isElement(node)) return;
        const ev = data as unknown as AttrHookEvent;
        const tag = node.nodeName.toLowerCase();
        const name = ev.attrName;
        const value = ev.attrValue ?? '';

        // Oversized attribute value → strip.
        if (value.length > MAX_ATTR_CHARS) {
            ev.keepAttr = false;
            ctx.removedAttrs++;
            return;
        }

        // Inline style → CSS-property allowlist (DOMPurify does NOT enforce ours).
        if (name === 'style') {
            const clean = sanitizeStyleValue(ctx, value);
            ctx.removedAttrs += clean.dropped;     // M4: partial strip counts as a removal
            if (clean.css) ev.attrValue = clean.css;
            else ev.keepAttr = false;
            return;
        }

        // Anchor target canonicalisation (rel forced in afterSanitizeAttributes).
        if (tag === 'a' && name === 'target') {
            if (!isAllowedAnchorTarget(value)) { ev.keepAttr = false; ctx.removedAttrs++; }
            return;
        }

        // URL-bearing attributes → per-element policy (byte budgets run in the
        // post-sanitize DOM walk, not here — mid-traversal node removal breaks
        // DOMPurify's iterator).
        if (name === 'href' || name === 'src' || name === 'xlink:href') {
            const el = tag === 'use' ? 'use'
                : (tag === 'a' && name === 'href') ? 'a'
                : (tag === 'img' && name === 'src') ? 'img'
                : 'other';
            if (!isAllowedPresentationUrl(el, name, value)) {
                ev.keepAttr = false;
                ctx.removedUrls++;
            }
            return;
        }

        // SVG presentation attributes (fill / stroke / etc.) can carry
        // url(http://evil) / url(javascript:…) paint refs — only #fragment or
        // data:image raster url() tokens are allowed (audit H1). The pre-check is
        // case-INSENSITIVE: `URL(`/`Url(` are valid CSS (audit R2-H1).
        if (/url\(/i.test(value) && !hasOnlyAllowedUrlTokens(value)) {
            ev.keepAttr = false;
            ctx.removedUrls++;
        }
    });

    dp.addHook('afterSanitizeAttributes', (node) => {
        if (!isElement(node)) return;
        // Force noopener/noreferrer on target=_blank anchors.
        if (node.nodeName.toLowerCase() === 'a') {
            const target = node.getAttribute('target');
            if (target && target.trim().toLowerCase() === '_blank') {
                node.setAttribute('rel', 'noopener noreferrer');
            }
        }
    });
}

/** Lazily build the dedicated purifier (hooks registered once). Returns null
 *  when no DOM-capable window is available (fail closed at the call site). */
function getPurifier(): Purifier | null {
    const win = (typeof window !== 'undefined' ? window : undefined) as Window | undefined;
    if (!win || !win.document) return null;
    if (purifier && purifierWin === win) return purifier;
    const dp = DOMPurify(win as unknown as Window & typeof globalThis);
    registerHooks(dp);
    purifier = dp;
    purifierWin = win;
    return dp;
}

const PURIFY_CONFIG = {
    ALLOWED_TAGS: [...ALLOWED_TAGS],
    ALLOWED_ATTR: [...ALLOWED_ATTR],
    FORBID_TAGS: [...FORBID_TAGS],
    // Strict allowlist (audit Gemini-G2): only the data-*/aria-* enumerated in
    // the policy's ALLOWED_ATTR survive — no arbitrary data-attribute injection.
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    ADD_ATTR: ['target', 'rel', 'xlink:href'],
    WHOLE_DOCUMENT: false,
    RETURN_DOM: true,            // post-walk budgets on the returned tree
    RETURN_DOM_FRAGMENT: false,
    KEEP_CONTENT: true,
};

/** DOMPurify reports the boilerplate body/html/head wrapper in `.removed`;
 *  exclude it so a clean deck isn't mis-counted as `sanitized`. */
const WRAPPER_NODE_NAMES = new Set(['BODY', 'HTML', 'HEAD']);

/**
 * Enforce resource budgets on the sanitised DOM (Decision 5) — done AFTER
 * sanitize (not in hooks) because removing nodes mid-traversal breaks
 * DOMPurify's iterator. Returns the removed-element count + which budget tripped.
 */
function enforceImageBudgets(root: Element): {
    removedTags: number; dataUriBytes: number; imageCount: number;
    budgetHit?: 'data-uri-size' | 'image-count';
} {
    let removedTags = 0;
    let dataUriBytes = 0;
    let budgetHit: 'data-uri-size' | 'image-count' | undefined;

    // Byte budget — strip any single oversized data: image, keep the deck.
    for (const img of Array.from(root.querySelectorAll('img'))) {
        const src = img.getAttribute('src');
        if (!src) continue;
        const parsed = parsePresentationDataImageUrl(src);
        if (!parsed) continue;
        dataUriBytes += parsed.byteLength;
        if (parsed.byteLength > MAX_DATA_URI_BYTES) {
            img.remove();
            removedTags++;
            budgetHit = 'data-uri-size';
        }
    }

    // Count budget — keep the first N in document order, strip the rest.
    const remaining = Array.from(root.querySelectorAll('img'));
    if (remaining.length > MAX_IMAGE_COUNT) {
        for (let i = MAX_IMAGE_COUNT; i < remaining.length; i++) {
            remaining[i].remove();
            removedTags++;
        }
        budgetHit = 'image-count';
    }

    const imageCount = Math.min(remaining.length, MAX_IMAGE_COUNT);
    return { removedTags, dataUriBytes, imageCount, budgetHit };
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Sanitize LLM-generated presentation HTML. Same signature as before; returns
 * the richer `SanitizeResult` (NOT `Result<T>` — fail-closed-to-safe-output is
 * the contract, see plan Decision 4). Idempotent on already-clean HTML.
 */
export function sanitizePresentation(rawHtml: string): SanitizeResult {
    const empty = (status: SanitizeStatus, budgetHit?: SanitizeResult['budgetHit']): SanitizeResult => ({
        html: '', status, hasDeckRoot: false, hasSlides: false, rejectionCount: 0,
        removed: { tags: 0, attrs: 0, urls: 0 },
        resources: { dataUriBytes: 0, imageCount: 0, inputChars: typeof rawHtml === 'string' ? rawHtml.length : 0 },
        budgetHit,
    });

    if (typeof rawHtml !== 'string') return empty('malformed-input');
    if (!rawHtml.trim()) return { ...empty('ok'), resources: { dataUriBytes: 0, imageCount: 0, inputChars: 0 } };

    // Budget: reject a multi-MB blob before handing it to the parser (fail closed).
    if (rawHtml.length > MAX_INPUT_CHARS) return empty('budget-exceeded', 'input-size');

    const dp = getPurifier();
    if (!dp) {
        logger.error('Presentation', 'sanitizePresentation: no DOM available — failing closed');
        return empty('internal-error');
    }

    // Re-entrancy guard (audit R2-M4): the single `activeCtx` slot is safe only
    // because DOMPurify is synchronous and hooks must never re-enter sanitize.
    // ENFORCE that invariant rather than merely documenting it — a future hook
    // (or logging/consumer callback) that re-enters fails closed instead of
    // corrupting the in-flight context.
    if (activeCtx !== null) {
        logger.error('Presentation', 'sanitizePresentation: re-entrant call detected — failing closed');
        return empty('internal-error');
    }

    const ctx: SanitizeCtx = {
        win: purifierWin as Window,
        removedAttrs: 0, removedUrls: 0, cssDataUriBytes: 0,
    };

    let root: Element;
    try {
        activeCtx = ctx;
        // RETURN_DOM → the sanitised <body> element (its innerHTML is the deck).
        root = dp.sanitize(rawHtml, PURIFY_CONFIG) as unknown as Element;
    } catch (e) {
        logger.error('Presentation', `sanitizePresentation threw — failing closed: ${String(e)}`);
        return empty('internal-error');
    } finally {
        activeCtx = null;
    }

    // Resource budgets on the returned tree (post-traversal — Decision 5).
    const budgets = enforceImageBudgets(root);
    const html = root.innerHTML;

    // Removal accounting: DOMPurify's own removals (script/forbidden/disallowed
    // attrs) live in dp.removed; merge with our hook + budget tallies (R2-H2).
    // Exclude the boilerplate body/html/head wrapper DOMPurify reports.
    let domTags = 0;
    let domAttrs = 0;
    for (const entry of dp.removed as Array<{ element?: Node; attribute?: unknown }>) {
        if (entry.element) {
            const nn = (entry.element.nodeName || '').toUpperCase();
            if (WRAPPER_NODE_NAMES.has(nn)) continue;
            domTags++;
        } else {
            domAttrs++;
        }
    }

    const removed = {
        tags: domTags + budgets.removedTags,
        attrs: domAttrs + ctx.removedAttrs,
        urls: ctx.removedUrls,
    };
    const total = removed.tags + removed.attrs + removed.urls;

    const hasDeckRoot = /class\s*=\s*"[^"]*\bdeck\b/.test(html) || /class\s*=\s*'[^']*\bdeck\b/.test(html);
    const hasSlides = /class\s*=\s*"[^"]*\bslide\b/.test(html) || /class\s*=\s*'[^']*\bslide\b/.test(html);

    const budgetHit = budgets.budgetHit ?? ctx.budgetHit;
    const status: SanitizeStatus = (total > 0 || budgetHit) ? 'sanitized' : 'ok';

    return {
        html,
        status,
        hasDeckRoot,
        hasSlides,
        rejectionCount: total,
        removed,
        resources: {
            dataUriBytes: budgets.dataUriBytes + ctx.cssDataUriBytes,  // img + CSS data: (M5)
            imageCount: budgets.imageCount,
            inputChars: rawHtml.length,
        },
        budgetHit,
    };
}

// ── CSP Injection ──────────────────────────────────────────────────────────

// `font-src data:` authorizes brand `@font-face` embeds (data: woff2) injected into
// the head via brandCss. data:-only keeps the no-network invariant; `default-src
// 'none'` (no script-src) is untouched, so scripts still cannot execute.
const CSP_META = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:; font-src data:;">';

/**
 * Inject a Content-Security-Policy meta tag into the <head> of an HTML document.
 * If a CSP meta already exists, returns the HTML unchanged.
 *
 * NOTE (plan Phase 2): the stronger "CSP is the FIRST child of <head>" guarantee
 * + the Outcome A/B script-src decision are Phase 2 work; Phase 1 keeps the
 * existing `default-src 'none'` behaviour unchanged.
 */
export function injectCSP(html: string): string {
    if (/content-security-policy/i.test(html)) {
        return html;
    }
    const headMatch = /<head[^>]*>/i.exec(html);
    if (headMatch) {
        const insertAt = headMatch.index + headMatch[0].length;
        return html.slice(0, insertAt) + '\n' + CSP_META + html.slice(insertAt);
    }
    return CSP_META + '\n' + html;
}

// SVG sanitiser lives in a neutral util (debt D3); re-exported for back-compat.
export { sanitizeSvgMarkup } from '../../utils/svgSanitize';
