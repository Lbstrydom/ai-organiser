// @vitest-environment happy-dom
/**
 * Unit tests for SlideFilmstrip (plan: slides-side-rail-workspace Phase 2).
 * Presentational: count/active/onSelect, hidden at ≤1 slide, async thumb load.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SlideFilmstrip, type SlideFilmstripOptions } from '../src/ui/components/SlideFilmstrip';

// Obsidian DOM helper polyfill over happy-dom.
function polyfill(el: HTMLElement): HTMLElement {
    const e = el as unknown as Record<string, unknown>;
    e.empty = (): void => { while (el.firstChild) el.removeChild(el.firstChild); };
    e.addClass = (c: string): void => el.classList.add(c);
    e.removeClass = (c: string): void => el.classList.remove(c);
    e.toggleClass = (c: string, on?: boolean): void => {
        if (on === undefined) el.classList.toggle(c);
        else el.classList.toggle(c, on);
    };
    e.createEl = (tag: string, opts?: { cls?: string; text?: string; attr?: Record<string, string> }): HTMLElement => {
        const child = document.createElement(tag);
        if (opts?.cls) child.className = opts.cls;
        if (opts?.text) child.textContent = opts.text;
        if (opts?.attr) for (const [k, v] of Object.entries(opts.attr)) child.setAttribute(k, v);
        el.appendChild(child);
        polyfill(child);
        return child;
    };
    return el;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function makeOpts(count: number, over: Partial<SlideFilmstripOptions> = {}): { opts: SlideFilmstripOptions; onSelect: ReturnType<typeof vi.fn>; getThumbnail: ReturnType<typeof vi.fn> } {
    let active = 0;
    const onSelect = vi.fn((i: number) => { active = i; });
    const getThumbnail = vi.fn(async (i: number) => `data:image/png;base64,T${i}`);
    const opts: SlideFilmstripOptions = {
        getCount: () => count,
        getActiveIndex: () => active,
        getThumbnail,
        onSelect,
        ...over,
    };
    return { opts, onSelect, getThumbnail };
}

describe('SlideFilmstrip', () => {
    let host: HTMLElement;
    beforeEach(() => { document.body.innerHTML = ''; host = polyfill(document.body.appendChild(document.createElement('div'))); });

    it('hides itself for a single-slide deck (nothing to navigate)', () => {
        const { opts } = makeOpts(1);
        new SlideFilmstrip(host, opts).render();
        expect(host.classList.contains('ai-organiser-hidden')).toBe(true);
        expect(host.querySelectorAll('.ai-organiser-pres-filmstrip-thumb').length).toBe(0);
    });

    it('renders one thumb per slide with index + aria-label', () => {
        const { opts } = makeOpts(4);
        new SlideFilmstrip(host, opts).render();
        const thumbs = host.querySelectorAll('.ai-organiser-pres-filmstrip-thumb');
        expect(thumbs.length).toBe(4);
        expect(thumbs[0].getAttribute('data-index')).toBe('0');
        expect(thumbs[2].getAttribute('aria-label')).toBe('Slide 3');
        expect(host.classList.contains('ai-organiser-hidden')).toBe(false);
    });

    it('click on a thumb fires onSelect with its index', () => {
        const { opts, onSelect } = makeOpts(3);
        new SlideFilmstrip(host, opts).render();
        (host.querySelectorAll('.ai-organiser-pres-filmstrip-thumb')[2] as HTMLElement).dispatchEvent(new Event('click'));
        expect(onSelect).toHaveBeenCalledWith(2);
    });

    it('loads each thumbnail async and sets the img src + is-loaded', async () => {
        const { opts, getThumbnail } = makeOpts(2);
        new SlideFilmstrip(host, opts).render();
        await flush();
        expect(getThumbnail).toHaveBeenCalledTimes(2);
        const img = host.querySelector('.ai-organiser-pres-filmstrip-img') as HTMLImageElement;
        expect(img.getAttribute('src')).toBe('data:image/png;base64,T0');
        expect(img.classList.contains('is-loaded')).toBe(true);
    });

    it('setActive moves the highlight without rebuilding', () => {
        const { opts } = makeOpts(3);
        const fs = new SlideFilmstrip(host, opts);
        fs.render();
        fs.setActive(2);
        const thumbs = host.querySelectorAll('.ai-organiser-pres-filmstrip-thumb');
        expect(thumbs[2].classList.contains('is-active')).toBe(true);
        expect(thumbs[0].classList.contains('is-active')).toBe(false);
    });

    it('dispose empties the host and aborts the in-flight thumbnail load', async () => {
        let abortedSignal: AbortSignal | undefined;
        let resolveThumb: (v: string) => void = () => {};
        const getThumbnail = vi.fn((_i: number, signal?: AbortSignal) => {
            abortedSignal = signal;
            return new Promise<string>((res) => { resolveThumb = res; });
        });
        const { opts } = makeOpts(3, { getThumbnail });
        const fs = new SlideFilmstrip(host, opts);
        fs.render();
        await flush();                     // first sequential thumbnail is in flight
        fs.dispose();
        expect(abortedSignal?.aborted).toBe(true);   // dispose aborted the signal
        resolveThumb('data:image/png;base64,LATE');  // late resolve must not write
        await flush();
        expect(host.querySelectorAll('.ai-organiser-pres-filmstrip-thumb').length).toBe(0);
    });

    it('ignores a non-data: thumbnail URL (enforces the inert contract)', async () => {
        const getThumbnail = vi.fn(async () => 'https://evil/x.png');
        const { opts } = makeOpts(2, { getThumbnail });
        new SlideFilmstrip(host, opts).render();
        await flush(); await flush();
        const img = host.querySelector('.ai-organiser-pres-filmstrip-img') as HTMLImageElement;
        expect(img.getAttribute('src')).toBeNull();   // rejected, not assigned
    });
});
