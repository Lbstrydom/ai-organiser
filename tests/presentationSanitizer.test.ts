// @vitest-environment happy-dom
/**
 * Security tests for the DOMPurify-based presentation sanitizer
 * (plan: presentation-sanitizer-hardening, Phase 1).
 *
 * happy-dom gives DOMPurify a real-ish parser for the removal corpus. CSP
 * enforcement (a "script didn't RUN" assertion) is NOT testable here — happy-dom
 * doesn't enforce CSP — that's the deferred Phase-2 Playwright test. These
 * assert the sanitizer REMOVES the executable surface.
 */

import { describe, it, expect } from 'vitest';
import {
    sanitizePresentation,
    injectCSP,
    DANGEROUS_HTML_PATTERNS,
} from '../src/services/chat/presentationSanitizer';
import {
    isAllowedPresentationUrl,
    parsePresentationDataImageUrl,
    MAX_INPUT_CHARS,
    MAX_IMAGE_COUNT,
} from '../src/utils/presentationSanitizePolicy';

const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function noExecutableSurface(html: string): void {
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/\son\w+\s*=/i);     // event handler attribute
    expect(html).not.toMatch(/javascript:/i);
    expect(html).not.toMatch(/vbscript:/i);
    expect(html).not.toMatch(/<iframe/i);
}

// ── Classic XSS ───────────────────────────────────────────────────────────────

describe('sanitizePresentation — classic XSS removal', () => {
    const vectors: Array<[string, string]> = [
        ['script tag', '<div class="slide"><script>window.__x=1</script>Hi</div>'],
        ['img onerror', '<div class="slide"><img src=x onerror="alert(1)"></div>'],
        ['svg onload', '<div class="slide"><svg onload="alert(1)"></svg></div>'],
        ['javascript: href', '<div class="slide"><a href="javascript:alert(1)">x</a></div>'],
        ['vbscript: href', '<div class="slide"><a href="vbscript:msgbox(1)">x</a></div>'],
        ['entity-encoded handler', '<div class="slide"><img src=x &#111;nerror=alert(1)></div>'],
        ['iframe', '<div class="slide"><iframe src="https://evil"></iframe></div>'],
        ['inline handler on div', '<div class="slide" onmouseover="alert(1)">x</div>'],
    ];
    for (const [name, html] of vectors) {
        it(`removes ${name}`, () => {
            const r = sanitizePresentation(html);
            noExecutableSurface(r.html);
            expect(r.status).toBe('sanitized');
        });
    }
});

// ── Parser-differential / mXSS ──────────────────────────────────────────────

describe('sanitizePresentation — parser-differential vectors', () => {
    const vectors: Array<[string, string]> = [
        ['comment breakout', '<!--><script>alert(1)</script>--><div class="slide">x</div>'],
        ['malformed unclosed', '<div class="slide"><script>alert(1)<div>still</div>'],
        ['quoted gt in attr', '<div class="slide" title="a>b"><img src=x onerror=alert(1)></div>'],
        ['svg style img', '<div class="slide"><svg><style><img src=x onerror=alert(1)></style></svg></div>'],
        ['tab-obfuscated js', '<div class="slide"><a href="ja\tva\nscript:alert(1)">x</a></div>'],
        ['mixed-case script', '<div class="slide"><ScRiPt>alert(1)</ScRiPt></div>'],
    ];
    for (const [name, html] of vectors) {
        it(`neutralises ${name}`, () => {
            noExecutableSurface(sanitizePresentation(html).html);
        });
    }
});

// ── SVG specialisation ──────────────────────────────────────────────────────

describe('sanitizePresentation — SVG URL specialisation', () => {
    it('strips <use href> external ref but keeps a #fragment', () => {
        const r = sanitizePresentation('<div class="slide"><svg><use href="https://evil/x"/><use href="#ok"/></svg></div>');
        expect(r.html).not.toMatch(/https:\/\/evil/);
        expect(r.html).toMatch(/#ok/);
    });
    it('drops <image> entirely', () => {
        const r = sanitizePresentation('<div class="slide"><svg><image href="javascript:alert(1)"/></svg></div>');
        expect(r.html).not.toMatch(/<image/i);
        noExecutableSurface(r.html);
    });
    it('drops <foreignObject>', () => {
        const r = sanitizePresentation('<div class="slide"><svg><foreignObject><div>x</div></foreignObject></svg></div>');
        expect(r.html).not.toMatch(/foreignobject/i);
    });
    it('keeps a legitimate gradient + path', () => {
        const r = sanitizePresentation('<div class="slide"><svg viewBox="0 0 10 10"><defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient></defs><path d="M0 0" fill="url(#g)"/></svg></div>');
        expect(r.html.toLowerCase()).toMatch(/lineargradient/);
        expect(r.html).toMatch(/<path/i);
    });
});

// ── Anchors ───────────────────────────────────────────────────────────────────

describe('sanitizePresentation — anchor canonicalisation', () => {
    it('forces rel=noopener noreferrer on target=_blank', () => {
        const r = sanitizePresentation('<div class="slide"><a href="https://ok.com" target="_blank">x</a></div>');
        expect(r.html).toMatch(/rel="noopener noreferrer"/);
    });
    it('strips target=_top', () => {
        const r = sanitizePresentation('<div class="slide"><a href="https://ok.com" target="_top">x</a></div>');
        expect(r.html).not.toMatch(/_top/);
    });
    it('strips http:// href but keeps https / # / mailto', () => {
        expect(sanitizePresentation('<a href="http://x.com" class="slide">x</a>').html).not.toMatch(/http:\/\//);
        expect(sanitizePresentation('<a href="https://x.com" class="slide">x</a>').html).toMatch(/https:\/\/x\.com/);
        expect(sanitizePresentation('<a href="#s2" class="slide">x</a>').html).toMatch(/#s2/);
        expect(sanitizePresentation('<a href="mailto:a@b.com" class="slide">x</a>').html).toMatch(/mailto:/);
    });
});

// ── CSS allowlist ──────────────────────────────────────────────────────────────

describe('sanitizePresentation — CSS property/value allowlist', () => {
    it('strips url(javascript:) but keeps a legitimate prop', () => {
        const r = sanitizePresentation('<div class="slide" style="background:url(javascript:alert(1)); width:100px">x</div>');
        expect(r.html).not.toMatch(/javascript:/i);
        expect(r.html).toMatch(/width:\s*100px/);
    });
    it('strips image-set()', () => {
        const r = sanitizePresentation('<div class="slide" style="background-image:image-set(&quot;https://e/x&quot; 1x)">x</div>');
        expect(r.html).not.toMatch(/image-set/i);
    });
    it('drops a non-allowlisted property but keeps allowed ones', () => {
        const r = sanitizePresentation('<div class="slide" style="color:red; -moz-binding:url(x)">x</div>');
        expect(r.html).toMatch(/color:\s*red/);
        expect(r.html).not.toMatch(/-moz-binding/i);
    });
    it('keeps a data:image raster background', () => {
        const r = sanitizePresentation(`<div class="slide" style="background-image:url(${TINY_PNG})">x</div>`);
        expect(r.html).toMatch(/data:image\/png/);
    });
    it('fails closed on a crafted url() with internal paren (no fail-open, Gemini-G1)', () => {
        const r = sanitizePresentation('<div class="slide" style="background:url(&quot;http://evil.com/a)b&quot;)">x</div>');
        expect(r.html).not.toMatch(/evil\.com/);
    });
    it('counts a partial CSS strip as a removal (audit M4)', () => {
        const r = sanitizePresentation('<div class="slide" style="color:red; -moz-binding:url(x)">x</div>');
        expect(r.status).toBe('sanitized');
        expect(r.removed.attrs).toBeGreaterThanOrEqual(1);
    });
    it('keeps flex-grow (the CSSOM expansion of `flex:1`) so grow-sized layouts survive', () => {
        // Regression: the sanitizer enumerates CSSOM longhands; `flex:1` expands to
        // flex-grow/shrink/basis. Without those allowlisted, bar-chart tracks collapse.
        const r = sanitizePresentation('<div class="slide" style="flex:1">x</div>');
        expect(r.html).toMatch(/flex-grow:\s*1/);
    });
    it('keeps per-side border longhands (the CSSOM expansion of `border:2px solid`)', () => {
        const r = sanitizePresentation('<div class="slide" style="border:2px solid #1a3a5c">x</div>');
        // At least the per-side width/color survive so cards keep their border.
        expect(r.html).toMatch(/border-top-(width|color|style)/);
        expect(r.html).not.toMatch(/javascript:/i);
    });
});

// ── SVG paint url() (audit H1) ──────────────────────────────────────────────

describe('sanitizePresentation — SVG paint url() guard (H1)', () => {
    it('keeps fill=url(#grad) internal ref', () => {
        const r = sanitizePresentation('<div class="slide"><svg><rect fill="url(#grad)"/></svg></div>');
        expect(r.html).toMatch(/url\(#grad\)/);
    });
    it('strips fill=url(http://evil) external paint ref', () => {
        const r = sanitizePresentation('<div class="slide"><svg><rect fill="url(http://evil/x)"/></svg></div>');
        expect(r.html).not.toMatch(/http:\/\/evil/);
    });
    it('strips stroke=url(javascript:...)', () => {
        const r = sanitizePresentation('<div class="slide"><svg><rect stroke="url(javascript:alert(1))"/></svg></div>');
        expect(r.html).not.toMatch(/javascript:/i);
    });
    it('strips uppercase URL( external ref (case-insensitive guard, R2-H1)', () => {
        const r = sanitizePresentation('<div class="slide"><svg><rect fill="URL(http://evil/x)"/></svg></div>');
        expect(r.html).not.toMatch(/evil/i);
    });
});

// ── Budgets (Decision 5) ────────────────────────────────────────────────────

describe('sanitizePresentation — resource budgets', () => {
    it('rejects oversized input → budget-exceeded, empty html', () => {
        const big = '<div class="slide">' + 'a'.repeat(MAX_INPUT_CHARS + 10) + '</div>';
        const r = sanitizePresentation(big);
        expect(r.status).toBe('budget-exceeded');
        expect(r.budgetHit).toBe('input-size');
        expect(r.html).toBe('');
    });
    it('keeps first N images in document order, strips the rest', () => {
        const imgs = Array.from({ length: MAX_IMAGE_COUNT + 5 }, () => `<img src="${TINY_PNG}">`).join('');
        const r = sanitizePresentation(`<div class="slide">${imgs}</div>`);
        const count = (r.html.match(/<img/gi) || []).length;
        expect(count).toBe(MAX_IMAGE_COUNT);
        expect(r.budgetHit).toBe('image-count');
    });
});

// ── Result contract (Decision 4) ────────────────────────────────────────────

describe('sanitizePresentation — result contract', () => {
    it('clean deck → status ok, no removals', () => {
        const r = sanitizePresentation('<div class="deck"><section class="slide"><h1>Title</h1></section></div>');
        expect(r.status).toBe('ok');
        expect(r.rejectionCount).toBe(0);
        expect(r.hasDeckRoot).toBe(true);
        expect(r.hasSlides).toBe(true);
    });
    it('script deck → sanitized, removed.tags >= 1', () => {
        const r = sanitizePresentation('<div class="slide"><script>x</script></div>');
        expect(r.status).toBe('sanitized');
        expect(r.removed.tags).toBeGreaterThanOrEqual(1);
    });
    it('non-string → malformed-input, empty html', () => {
        // @ts-expect-error testing a non-string caller
        const r = sanitizePresentation(null);
        expect(r.status).toBe('malformed-input');
        expect(r.html).toBe('');
    });
    it('empty string → ok, empty html', () => {
        const r = sanitizePresentation('   ');
        expect(r.status).toBe('ok');
        expect(r.html).toBe('');
    });
    it('idempotent on a clean deck', () => {
        const clean = sanitizePresentation('<div class="deck"><section class="slide"><h1>T</h1><p>body</p></section></div>').html;
        expect(sanitizePresentation(clean).html).toBe(clean);
    });
});

// ── Golden parity (structural, not byte) ─────────────────────────────────────

describe('sanitizePresentation — representative deck survives', () => {
    it('preserves svg/gradient/use#frag/data-raster/box-sizing', () => {
        const deck = `<div class="deck"><section class="slide" style="box-sizing:border-box; width:1920px">
            <h1>Glass</h1>
            <svg viewBox="0 0 100 100"><defs><linearGradient id="g"><stop offset="0" stop-color="#123"/></linearGradient></defs><rect width="100" height="100" fill="url(#g)"/><use href="#g"/></svg>
            <img src="${TINY_PNG}" alt="x">
        </section></div>`;
        const r = sanitizePresentation(deck);
        expect(r.html).not.toBe('');
        expect(r.hasDeckRoot).toBe(true);
        expect(r.hasSlides).toBe(true);
        expect(r.html.toLowerCase()).toMatch(/lineargradient/);
        expect(r.html).toMatch(/box-sizing:\s*border-box/);
        expect(r.html).toMatch(/data:image\/png/);
        expect(r.html).toMatch(/#g/);
        noExecutableSurface(r.html);
    });
});

// ── injectCSP ────────────────────────────────────────────────────────────────

describe('injectCSP', () => {
    it('injects a CSP meta into <head>', () => {
        const out = injectCSP('<html><head></head><body>x</body></html>');
        expect(out).toMatch(/content-security-policy/i);
        expect(out).toMatch(/default-src 'none'/);
    });
    it('is idempotent', () => {
        const once = injectCSP('<html><head></head><body>x</body></html>');
        expect(injectCSP(once)).toBe(once);
    });
    it('authorizes data: fonts (font-src data:) without relaxing scripts (brand-font-embedding)', () => {
        const out = injectCSP('<html><head></head><body>x</body></html>');
        expect(out).toMatch(/font-src data:/);          // embedded @font-face authorized
        expect(out).toMatch(/default-src 'none'/);      // scripts still blocked (no script-src)
        expect(out).not.toMatch(/script-src/);
        expect(out).toMatch(/img-src data:/);           // unchanged
        expect(out).not.toMatch(/font-src[^;]*https/);  // data: only, no network fonts
    });
});

// ── Policy unit tests ──────────────────────────────────────────────────────────

describe('presentationSanitizePolicy', () => {
    it('isAllowedPresentationUrl matrix', () => {
        expect(isAllowedPresentationUrl('a', 'href', 'https://x.com')).toBe(true);
        expect(isAllowedPresentationUrl('a', 'href', 'http://x.com')).toBe(false);
        expect(isAllowedPresentationUrl('a', 'href', '#frag')).toBe(true);
        expect(isAllowedPresentationUrl('a', 'href', 'mailto:a@b.com')).toBe(true);
        expect(isAllowedPresentationUrl('a', 'href', 'javascript:alert(1)')).toBe(false);
        expect(isAllowedPresentationUrl('use', 'href', '#g')).toBe(true);
        expect(isAllowedPresentationUrl('use', 'href', 'https://e/x')).toBe(false);
        expect(isAllowedPresentationUrl('img', 'src', TINY_PNG)).toBe(true);
        expect(isAllowedPresentationUrl('img', 'src', 'data:image/svg+xml,<svg/>')).toBe(false);
        expect(isAllowedPresentationUrl('css-url', 'url', TINY_PNG)).toBe(true);
    });
    it('parsePresentationDataImageUrl measures decoded bytes', () => {
        const parsed = parsePresentationDataImageUrl(TINY_PNG);
        expect(parsed?.mime).toBe('image/png');
        expect(parsed?.byteLength).toBeGreaterThan(0);
        expect(parsePresentationDataImageUrl('data:image/svg+xml,<svg/>')).toBeNull();
    });
    it('DANGEROUS_HTML_PATTERNS are non-global (stateless .test)', () => {
        for (const re of DANGEROUS_HTML_PATTERNS) expect(re.global).toBe(false);
    });
});
