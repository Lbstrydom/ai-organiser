/**
 * SlideThumbnailProvider — renders deck slides into inert raster thumbnails for
 * the filmstrip (plan: slides-side-rail-workspace, Phase 2).
 *
 * SAFETY: thumbnails are produced via SVG `<foreignObject>` → `<img>` → `<canvas>`
 * → `toDataURL` (a spike confirmed this renders the real slide — theme `<style>`
 * + inline styles + data: images — without tainting the canvas). The output is
 * an inert PNG data-URL the filmstrip shows as `<img>`. Slide HTML/CSS is NEVER
 * cloned into the host (Obsidian) DOM — that would render untrusted slide CSS
 * outside the sandbox we hardened in the sanitizer work.
 *
 * The slide markup is serialised through `XMLSerializer` (from the already-
 * sanitised deck DOM) so `<foreignObject>` gets valid XHTML (void elements
 * self-closed) — raw HTML fails to load as an SVG image.
 *
 * Browser-only (Obsidian/Electron). Fails closed (returns null) without a DOM.
 *
 * SECURITY ARGUMENT (audit H1): the SVG-foreignObject is loaded as an `<img>`,
 * and images NEVER execute scripts — so even a `<script>`/handler that somehow
 * survived would not run here (it's strictly more inert than the sandboxed
 * preview iframe). External sub-resource fetches (SSRF/tracking) are likewise
 * impossible: the input is the SAME sanitised deck the preview renders, where
 * Phase-1 sanitisation already restricts `img@src` + CSS `url()` to `data:`
 * rasters and forbids external/`javascript:` URLs. So the rendered SVG can only
 * reference inline data — no network. This path depends on that sanitisation;
 * it must only ever be fed `this.html` (post-sanitizePresentation), never raw
 * LLM output.
 */

import { DECK_CLASSES } from './presentationConstants';

const THUMB_W = 192;
const THUMB_H = 108; // 16:9
const SLIDE_W = 1920;
const CACHE_CAP = 60;

/** Rasterise an SVG data-URL to a PNG data-URL. Injectable for tests (happy-dom
 *  has no real canvas raster). Returns null on load failure / taint / no DOM. */
export type Rasterizer = (svgDataUrl: string, w: number, h: number, signal?: AbortSignal) => Promise<string | null>;

const defaultRasterize: Rasterizer = async (svgDataUrl, w, h, signal) => {
    if (typeof Image === 'undefined' || typeof document === 'undefined') return null;
    if (signal?.aborted) return null;
    const img = new Image();
    // Settle the load promise on abort too, and clean up handlers either way so
    // a cancelled load doesn't leak or resolve late (audit).
    const ok = await new Promise<boolean>((res) => {
        const done = (v: boolean) => { img.onload = null; img.onerror = null; signal?.removeEventListener('abort', onAbort); res(v); };
        const onAbort = () => { img.src = ''; done(false); };
        signal?.addEventListener('abort', onAbort, { once: true });
        img.onload = () => done(true);
        img.onerror = () => done(false);
        img.src = svgDataUrl;
    });
    if (!ok || signal?.aborted) return null;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, w, h);
    try {
        return canvas.toDataURL('image/png'); // throws if the canvas was tainted
    } catch {
        return null;
    }
};

export interface SlideThumbnailProviderDeps {
    /** Current full deck HTML (the sanitised document the preview renders). */
    getHtml: () => string | null;
    /** Monotonic deck version — bumps on every committed mutation; keys the cache. */
    getDeckVersion: () => number;
    /** Override the raster step (tests). */
    rasterize?: Rasterizer;
}

interface ParsedDeck {
    version: number;
    styles: string;      // concatenated <style> text
    slides: string[];    // each slide serialised to XHTML
}

export class SlideThumbnailProvider {
    private readonly deps: SlideThumbnailProviderDeps;
    private readonly rasterize: Rasterizer;
    private readonly cache = new Map<string, string>(); // `${version}:${index}` → PNG data-URL
    private parsed: ParsedDeck | null = null;

    constructor(deps: SlideThumbnailProviderDeps) {
        this.deps = deps;
        this.rasterize = deps.rasterize ?? defaultRasterize;
    }

    /** Number of slides in the current deck (parsed from the deck HTML). */
    slideCount(): number {
        return this.parse()?.slides.length ?? 0;
    }

    /** PNG data-URL for slide `index`, or null (out of range / no DOM / raster
     *  failure / aborted). Cached by `(deckVersion, index)`. */
    async getThumbnail(index: number, signal?: AbortSignal): Promise<string | null> {
        const deck = this.parse();
        if (!deck || index < 0 || index >= deck.slides.length) return null;
        const key = `${deck.version}:${index}`;
        const cached = this.cache.get(key);
        if (cached !== undefined) {
            // LRU touch
            this.cache.delete(key);
            this.cache.set(key, cached);
            return cached;
        }
        const svg = buildForeignObjectSvg(deck.styles, deck.slides[index]);
        const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
        const png = await this.rasterize(url, THUMB_W, THUMB_H, signal);
        if (png && !signal?.aborted) this.put(key, png);
        return png ?? null;
    }

    dispose(): void {
        this.cache.clear();
        this.parsed = null;
    }

    // ── internals ──────────────────────────────────────────────────────────────

    /** Parse + serialise the deck once per version (memoised). */
    private parse(): ParsedDeck | null {
        const html = this.deps.getHtml();
        const version = this.deps.getDeckVersion();
        if (this.parsed && this.parsed.version === version) return this.parsed;
        if (!html || typeof DOMParser === 'undefined' || typeof XMLSerializer === 'undefined') return null;

        let doc: Document;
        try {
            doc = new DOMParser().parseFromString(html, 'text/html');
        } catch {
            return null;
        }
        const styles = Array.from(doc.querySelectorAll('style'))
            .map((s) => s.textContent ?? '')
            .join('\n');
        const serializer = new XMLSerializer();
        const slides = Array.from(doc.querySelectorAll(`.${DECK_CLASSES.slide}`))
            .map((el) => {
                try { return serializer.serializeToString(el); } catch { return ''; }
            })
            .filter((s) => s.length > 0);

        this.parsed = { version, styles, slides };
        return this.parsed;
    }

    private put(key: string, value: string): void {
        this.cache.set(key, value);
        while (this.cache.size > CACHE_CAP) {
            const oldest = this.cache.keys().next().value;
            if (oldest === undefined) break;
            this.cache.delete(oldest);
        }
    }
}

/** Build the SVG-foreignObject markup that renders one slide scaled to the
 *  thumbnail box. CSS goes in a CDATA `<style>` so `>`/`&` in selectors/values
 *  can't break the XML; the slide markup is already XML-serialised. */
function buildForeignObjectSvg(styles: string, slideXhtml: string): string {
    const scale = THUMB_W / SLIDE_W;
    // Split any CDATA terminator so theme CSS can't break out of the CDATA
    // section (audit M10). `]]>` → `]]]]><![CDATA[>`.
    const safeStyles = styles.replaceAll(']]>', ']]]]><![CDATA[>');
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${THUMB_W}" height="${THUMB_H}">`
        + '<foreignObject width="100%" height="100%">'
        + '<div xmlns="http://www.w3.org/1999/xhtml" '
        + `style="width:${SLIDE_W}px;height:1080px;transform:scale(${scale});transform-origin:top left;overflow:hidden">`
        + `<style><![CDATA[${safeStyles}]]></style>`
        + slideXhtml
        + '</div></foreignObject></svg>';
}
