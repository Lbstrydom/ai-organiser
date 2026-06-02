// @vitest-environment happy-dom
/**
 * Unit tests for SlideThumbnailProvider (plan: slides-side-rail-workspace Phase 2).
 * The raster step (Image→canvas) can't run under happy-dom, so it's injected.
 * These cover parse/serialise, cache keying by deck version, LRU, abort, dispose.
 */
import { describe, it, expect, vi } from 'vitest';
import { SlideThumbnailProvider } from '../src/services/chat/slideThumbnailProvider';

const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function deckHtml(n: number): string {
    const slides = Array.from({ length: n }, (_, i) =>
        `<section class="slide"><h1>Slide ${i + 1}</h1><img src="${TINY_PNG}" alt=""></section>`).join('');
    return `<!doctype html><html><head><style>.slide{background:linear-gradient(#123,#456)}</style></head>`
        + `<body><div class="deck">${slides}</div></body></html>`;
}

function make(html: string, version = 1) {
    const state = { html, version };
    const rasterize = vi.fn(async (svg: string) => `data:image/png;base64,RASTER(${svg.length})`);
    const provider = new SlideThumbnailProvider({
        getHtml: () => state.html,
        getDeckVersion: () => state.version,
        rasterize,
    });
    return { provider, rasterize, state };
}

describe('SlideThumbnailProvider', () => {
    it('counts slides parsed from the deck HTML', () => {
        expect(make(deckHtml(5)).provider.slideCount()).toBe(5);
        expect(make(deckHtml(1)).provider.slideCount()).toBe(1);
        expect(make('<html><body></body></html>').provider.slideCount()).toBe(0);
    });

    it('rasterises a slide via an SVG foreignObject data-URL (with CDATA styles + the slide)', async () => {
        const { provider, rasterize } = make(deckHtml(3));
        const png = await provider.getThumbnail(0);
        expect(png).toMatch(/^data:image\/png/);
        const svgUrl = decodeURIComponent(rasterize.mock.calls[0][0]);
        expect(svgUrl).toContain('<foreignObject');
        expect(svgUrl).toContain('<![CDATA[');           // theme CSS wrapped in CDATA
        expect(svgUrl).toContain('Slide 1');             // the slide markup
        expect(svgUrl).toContain('transform:scale(');    // scaled to thumbnail box
    });

    it('caches by (deckVersion, index) — second call does not re-rasterise', async () => {
        const { provider, rasterize } = make(deckHtml(3));
        await provider.getThumbnail(1);
        await provider.getThumbnail(1);
        expect(rasterize).toHaveBeenCalledTimes(1);
    });

    it('re-rasterises when the deck version bumps (cache invalidated by key)', async () => {
        const { provider, rasterize, state } = make(deckHtml(3), 1);
        await provider.getThumbnail(0);
        state.version = 2;
        state.html = deckHtml(3); // new deck content
        await provider.getThumbnail(0);
        expect(rasterize).toHaveBeenCalledTimes(2);
    });

    it('returns null for out-of-range indices', async () => {
        const { provider } = make(deckHtml(2));
        expect(await provider.getThumbnail(5)).toBeNull();
        expect(await provider.getThumbnail(-1)).toBeNull();
    });

    it('does not cache an aborted result', async () => {
        const ac = new AbortController();
        const { provider, rasterize } = make(deckHtml(2));
        rasterize.mockImplementationOnce(async () => { ac.abort(); return 'data:image/png;base64,X'; });
        await provider.getThumbnail(0, ac.signal);
        await provider.getThumbnail(0, new AbortController().signal);
        expect(rasterize).toHaveBeenCalledTimes(2); // first wasn't cached (aborted)
    });

    it('evicts least-recently-used entries past the cache cap', async () => {
        // 70 slides > CACHE_CAP (60): rendering all then re-fetching slide 0
        // should miss (evicted) and re-rasterise.
        const { provider, rasterize } = make(deckHtml(70));
        for (let i = 0; i < 70; i++) await provider.getThumbnail(i);
        const callsAfterFirstPass = rasterize.mock.calls.length;
        expect(callsAfterFirstPass).toBe(70);
        await provider.getThumbnail(0); // index 0 is the oldest → evicted → re-raster
        expect(rasterize.mock.calls.length).toBe(71);
    });

    it('escapes a CDATA terminator in theme CSS', async () => {
        const html = '<html><head><style>.x{content:"]]>"}</style></head>'
            + '<body><div class="deck"><section class="slide">a</section></div></body></html>';
        const { provider, rasterize } = make(html);
        await provider.getThumbnail(0);
        const svg = decodeURIComponent(rasterize.mock.calls[0][0]);
        // The CSS's `]]>` was split so it can't close the CDATA early...
        expect(svg).toContain(']]]]><![CDATA[>');
        // ...and exactly one CDATA section opens + closes (valid XML).
        expect((svg.match(/<!\[CDATA\[/g) || []).length).toBe(2); // original + the split re-open
    });

    it('dispose clears the cache', async () => {
        const { provider, rasterize } = make(deckHtml(2));
        await provider.getThumbnail(0);
        provider.dispose();
        await provider.getThumbnail(0);
        expect(rasterize).toHaveBeenCalledTimes(2);
    });
});
