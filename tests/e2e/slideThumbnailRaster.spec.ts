/**
 * Real-browser (Chromium) verification of the thumbnail INERT-RASTER path —
 * the audit-H1 security claim behind SlideThumbnailProvider.
 *
 * The filmstrip rasterizes each slide via SVG `<foreignObject>` → `<img>` →
 * `<canvas>` → PNG. The safety argument is that loading the SVG through an
 * `<img>` element runs it in the browser's "secure static mode": scripts inside
 * the foreignObject HTML do NOT execute and external sub-resources are NOT
 * fetched — while a data:-only document leaves the canvas un-tainted so
 * `toDataURL` succeeds.
 *
 * happy-dom can't prove any of that (no real canvas raster, no secure-static
 * SVG mode, no network), so the provider's unit tests inject a fake rasterizer.
 * THIS spec exercises the real browser primitive the production raster relies on,
 * mirroring buildForeignObjectSvg + defaultRasterize verbatim.
 */
import { test, expect } from '@playwright/test';

// Mirror the production constants (slideThumbnailProvider.ts).
const THUMB_W = 192;
const THUMB_H = 108;
const SLIDE_W = 1920;

// A sentinel host that must NEVER be contacted — an external sub-resource
// referenced inside the foreignObject. If the img-SVG raster fetched it, the
// "no network" half of the inert-raster claim would be false.
const TRACKER = 'http://127.0.0.1:59999/should-never-be-fetched.png';

/** Faithful inline copy of buildForeignObjectSvg (the part under test is the
 *  browser's handling of it, not the string builder — which is unit-tested). */
function buildForeignObjectSvg(styles: string, slideXhtml: string): string {
    const scale = THUMB_W / SLIDE_W;
    const safeStyles = styles.replaceAll(']]>', ']]]]><![CDATA[>');
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${THUMB_W}" height="${THUMB_H}">`
        + '<foreignObject width="100%" height="100%">'
        + '<div xmlns="http://www.w3.org/1999/xhtml" '
        + `style="width:${SLIDE_W}px;height:1080px;transform:scale(${scale});transform-origin:top left;overflow:hidden">`
        + `<style><![CDATA[${safeStyles}]]></style>`
        + slideXhtml
        + '</div></foreignObject></svg>';
}

/** Run the real defaultRasterize algorithm in the page: build the SVG data-URL,
 *  load it as an <img>, draw to a canvas, toDataURL. Reports the outcome plus
 *  whether an injected script executed in the page (window.__pwned). */
async function raster(page: import('@playwright/test').Page, svg: string) {
    return page.evaluate(async ({ svgStr, w, h }) => {
        (window as unknown as { __pwned?: number }).__pwned = undefined;
        const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgStr);
        const img = new Image();
        const loaded = await new Promise<boolean>((res) => {
            img.onload = () => res(true);
            img.onerror = () => res(false);
            img.src = url;
        });
        const out = { loaded, png: null as string | null, tainted: false, pwned: false };
        if (!loaded) { out.pwned = !!(window as unknown as { __pwned?: number }).__pwned; return out; }
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (ctx) {
            ctx.drawImage(img, 0, 0, w, h);
            try { out.png = canvas.toDataURL('image/png'); }
            catch { out.tainted = true; }   // toDataURL throws on a tainted canvas
        }
        // Give any (forbidden) async script/network a tick to fire before we read.
        await new Promise((r) => setTimeout(r, 50));
        out.pwned = !!(window as unknown as { __pwned?: number }).__pwned;
        return out;
    }, { svgStr: svg, w: THUMB_W, h: THUMB_H });
}

const SLIDE_WITH_SCRIPT = '<section class="slide"><h1>Hi</h1>'
    + '<script>window.__pwned = 1;<\/script>'
    + `<img src="${TRACKER}" /></section>`;

test('img-loaded foreignObject SVG produces a PNG and does NOT execute embedded scripts', async ({ page }) => {
    const r = await raster(page, buildForeignObjectSvg('h1{color:red}', SLIDE_WITH_SCRIPT));
    expect(r.loaded).toBe(true);
    expect(r.tainted).toBe(false);                         // data:-only → canvas not tainted
    expect(r.png).toMatch(/^data:image\/png[;,]/);         // a real PNG raster came out
    expect(r.pwned).toBe(false);                           // the <script> did NOT run
});

test('no network request is made for an external sub-resource inside the foreignObject', async ({ page }) => {
    const hits: string[] = [];
    page.on('request', (req) => { if (req.url().includes('should-never-be-fetched')) hits.push(req.url()); });
    await raster(page, buildForeignObjectSvg('', SLIDE_WITH_SCRIPT));
    expect(hits).toEqual([]);                              // img-SVG secure-static mode fetches nothing
});

test('baseline: the same script DOES run when executed directly (assertion is not vacuous)', async ({ page }) => {
    await page.setContent('<!doctype html><html><body></body></html>');
    const pwned = await page.evaluate(() => {
        (window as unknown as { __pwned?: number }).__pwned = undefined;
        const s = document.createElement('script');
        s.textContent = 'window.__pwned = 1;';
        document.body.appendChild(s);
        return !!(window as unknown as { __pwned?: number }).__pwned;
    });
    expect(pwned).toBe(true);   // proves __pwned CAN be set → the inert-raster assertions mean something
});
