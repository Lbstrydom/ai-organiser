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
    // happy-dom doesn't implement scrollIntoView — stub so setActive/arrow nav
    // don't throw under test.
    if (typeof (el as unknown as { scrollIntoView?: unknown }).scrollIntoView !== 'function') {
        (el as unknown as Record<string, unknown>).scrollIntoView = (): void => {};
    }
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

    it('uses a roving tabindex: only the active thumb is a tab stop', () => {
        const { opts } = makeOpts(3);
        new SlideFilmstrip(host, opts).render();  // active = 0
        const thumbs = host.querySelectorAll('.ai-organiser-pres-filmstrip-thumb');
        expect(thumbs[0].getAttribute('tabindex')).toBe('0');
        expect(thumbs[1].getAttribute('tabindex')).toBe('-1');
        expect(thumbs[2].getAttribute('tabindex')).toBe('-1');
    });

    it('ArrowDown moves the roving tabindex + focus to the next thumb', () => {
        const { opts } = makeOpts(3);
        new SlideFilmstrip(host, opts).render();
        const thumbs = host.querySelectorAll('.ai-organiser-pres-filmstrip-thumb');
        (thumbs[0] as HTMLElement).focus();
        const strip = host.querySelector('.ai-organiser-pres-filmstrip') as HTMLElement;
        strip.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
        expect(thumbs[1].getAttribute('tabindex')).toBe('0');
        expect(thumbs[0].getAttribute('tabindex')).toBe('-1');
        expect(document.activeElement).toBe(thumbs[1]);
    });

    it('ArrowDown on the last thumb stays put (clamped, no crash)', () => {
        const { opts } = makeOpts(3);
        new SlideFilmstrip(host, opts).render();
        const thumbs = host.querySelectorAll('.ai-organiser-pres-filmstrip-thumb');
        (thumbs[2] as HTMLElement).focus();   // last thumb
        const strip = host.querySelector('.ai-organiser-pres-filmstrip') as HTMLElement;
        expect(() => strip.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))).not.toThrow();
        expect(thumbs[2].getAttribute('tabindex')).toBe('0');   // stayed on last
        expect(document.activeElement).toBe(thumbs[2]);
    });

    it('End jumps to the last thumb, Home to the first', () => {
        const { opts } = makeOpts(4);
        new SlideFilmstrip(host, opts).render();
        const thumbs = host.querySelectorAll('.ai-organiser-pres-filmstrip-thumb');
        (thumbs[0] as HTMLElement).focus();
        const strip = host.querySelector('.ai-organiser-pres-filmstrip') as HTMLElement;
        strip.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
        expect(document.activeElement).toBe(thumbs[3]);
        strip.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
        expect(document.activeElement).toBe(thumbs[0]);
    });

    it('setActive moves the roving tabindex onto the active thumb', () => {
        const { opts } = makeOpts(3);
        const fs = new SlideFilmstrip(host, opts);
        fs.render();
        fs.setActive(2);
        const thumbs = host.querySelectorAll('.ai-organiser-pres-filmstrip-thumb');
        expect(thumbs[2].getAttribute('tabindex')).toBe('0');
        expect(thumbs[0].getAttribute('tabindex')).toBe('-1');
    });

    it('restores focus to the active thumb when the strip rebuilds with focus inside', () => {
        let active = 1;
        const fs = new SlideFilmstrip(host, {
            getCount: () => 3, getActiveIndex: () => active,
            getThumbnail: async (i) => `data:image/png;base64,T${i}`, onSelect: () => {},
        });
        fs.render();
        (host.querySelectorAll('.ai-organiser-pres-filmstrip-thumb')[1] as HTMLElement).focus();
        fs.refresh();   // deck replaced — rebuild empties + recreates
        const thumbs = host.querySelectorAll('.ai-organiser-pres-filmstrip-thumb');
        expect(document.activeElement).toBe(thumbs[active]);
    });

    it('uses the supplied groupLabel for the group aria-label', () => {
        const { opts } = makeOpts(2, { groupLabel: 'Diapositives' });
        new SlideFilmstrip(host, opts).render();
        const strip = host.querySelector('.ai-organiser-pres-filmstrip') as HTMLElement;
        expect(strip.getAttribute('aria-label')).toBe('Diapositives');
    });
});
