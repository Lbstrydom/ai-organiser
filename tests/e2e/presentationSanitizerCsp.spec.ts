/**
 * Real-browser (Chromium) CSP + iframe-sandbox enforcement for the presentation
 * preview — sanitizer Phase 2 / Decision 7 Outcome A.
 *
 * happy-dom does NOT enforce CSP or sandbox script-blocking, so a "script didn't
 * RUN" assertion there proves nothing. These tests load real srcdoc in a real
 * Chromium iframe and assert that an injected <script> does not execute, while
 * the parent retains the same-origin contentDocument access nav/export needs.
 *
 * Mirrors how SlideIframePreview builds the iframe: `sandbox="allow-same-origin"`
 * (no allow-scripts) + `injectCSP`'d document, srcdoc set via the property.
 */
import { test, expect } from '@playwright/test';
import { injectCSP } from '../../src/services/chat/presentationSanitizer';

// MUST match SlideIframePreview's sandbox attribute (Outcome A: no allow-scripts).
const HARDENED_SANDBOX = 'allow-same-origin';

const BARE_DOC = '<!doctype html><html><head></head><body>'
    + '<div class="deck"><section class="slide"><h1>Hi</h1></section></div>'
    + '</body></html>';

/** Load `html` as srcdoc in an iframe with `sandbox`, inject a `window.__pwned`
 *  script the way a sanitizer-escape would, and report what executed + whether
 *  the parent can still read the contentDocument. */
async function probe(page: import('@playwright/test').Page, sandbox: string, html: string) {
    await page.setContent(`<iframe id="f" sandbox="${sandbox}"></iframe>`);
    return page.evaluate(async (doc) => {
        const f = document.getElementById('f') as HTMLIFrameElement;
        await new Promise<void>((res) => { f.onload = () => res(); f.srcdoc = doc; });
        const idoc = f.contentDocument as Document;
        const iwin = f.contentWindow as (Window & { __pwned?: number });
        const out = {
            sameOriginDomAccess: !!idoc.querySelector('.slide'),
            cspPresent: !!idoc.querySelector('meta[http-equiv]'),
            pwned: false,
        };
        try {
            const s = idoc.createElement('script');
            s.textContent = 'window.__pwned = 1;';
            idoc.body.appendChild(s);
        } catch { /* sandbox/CSP may throw — counts as blocked */ }
        await new Promise((r) => setTimeout(r, 30));
        out.pwned = iwin.__pwned === 1;
        return out;
    }, html);
}

test('hardened sandbox (no allow-scripts) blocks injected scripts; parent keeps DOM access', async ({ page }) => {
    const r = await probe(page, HARDENED_SANDBOX, injectCSP(BARE_DOC));
    expect(r.sameOriginDomAccess).toBe(true);   // nav / applyDomFixes / pptx export still work
    expect(r.pwned).toBe(false);                // no script executes
});

test('CSP alone blocks scripts even if allow-scripts were present (defense-in-depth)', async ({ page }) => {
    const r = await probe(page, 'allow-same-origin allow-scripts', injectCSP(BARE_DOC));
    expect(r.cspPresent).toBe(true);
    expect(r.pwned).toBe(false);                // CSP default-src 'none' blocks it
});

test('baseline: allow-scripts + NO CSP → the script WOULD run (assertion is not vacuous)', async ({ page }) => {
    const r = await probe(page, 'allow-same-origin allow-scripts', BARE_DOC);
    expect(r.pwned).toBe(true);
});

// ── Brand-font-embedding: `font-src data:` authorizes embedded fonts ─────────

/** Inject an @font-face with `fontSrc`, USE the family, and collect any
 *  `securitypolicyviolation` directives the browser fires. */
async function fontProbe(page: import('@playwright/test').Page, fontSrc: string) {
    await page.setContent(`<iframe id="f" sandbox="${HARDENED_SANDBOX}"></iframe>`);
    return page.evaluate(async ({ doc, fontSrc }) => {
        const f = document.getElementById('f') as HTMLIFrameElement;
        await new Promise<void>((res) => { f.onload = () => res(); f.srcdoc = doc; });
        const idoc = f.contentDocument as Document;
        const violations: string[] = [];
        idoc.addEventListener('securitypolicyviolation', (e) => violations.push((e as SecurityPolicyViolationEvent).violatedDirective));
        const style = idoc.createElement('style');
        style.textContent = `@font-face{font-family:'ProbeFont';src:url(${fontSrc}) format('woff2');} .p{font-family:'ProbeFont';}`;
        idoc.head.appendChild(style);
        const el = idoc.createElement('div'); el.className = 'p'; el.textContent = 'trigger'; idoc.body.appendChild(el);
        try { await (idoc as Document & { fonts: FontFaceSet }).fonts.load("16px 'ProbeFont'"); } catch { /* decode may fail; CSP fires regardless */ }
        await new Promise((r) => setTimeout(r, 100));
        return { fontSrcViolation: violations.some((v) => v.includes('font-src')) };
    }, { doc: injectCSP(BARE_DOC), fontSrc });
}

// 'wOF2' magic, base64 → a data: woff2 (won't decode, but CSP gates the SCHEME).
const DATA_WOFF2 = 'data:font/woff2;base64,d09GMg==';

test('font-src data: ALLOWS an embedded data: @font-face (no CSP violation)', async ({ page }) => {
    const r = await fontProbe(page, DATA_WOFF2);
    expect(r.fontSrcViolation).toBe(false);   // embedded brand font is authorized
});

test('font-src data: BLOCKS an https: @font-face (CSP violation fired)', async ({ page }) => {
    const r = await fontProbe(page, 'https://example.com/x.woff2');
    expect(r.fontSrcViolation).toBe(true);    // no-network invariant preserved
});
