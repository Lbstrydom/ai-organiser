/**
 * SlideFilmstrip — vertical strip of slide thumbnails for quick navigation
 * (plan: slides-side-rail-workspace, Phase 2).
 *
 * Presentational: no service imports. The host supplies slide count, the active
 * index, an async thumbnail provider (returns an inert PNG data-URL), and an
 * onSelect callback. Hidden when the deck has ≤ 1 slide (nothing to navigate).
 *
 * Thumbnails load asynchronously; a render token + per-render AbortController
 * prevent stale writes after refresh()/dispose().
 */

import { listen } from '../utils/domUtils';
import { logger } from '../../utils/logger';

export interface SlideFilmstripOptions {
    getCount: () => number;
    getActiveIndex: () => number;
    getThumbnail: (index: number, signal?: AbortSignal) => Promise<string | null>;
    onSelect: (index: number) => void;
    /** i18n aria-label template with `{n}` for the 1-based slide number. */
    itemLabelTemplate?: string;
    /** i18n aria-label for the thumbnail group as a whole. */
    groupLabel?: string;
}

export class SlideFilmstrip {
    private readonly container: HTMLElement;
    private readonly options: SlideFilmstripOptions;
    private thumbs: HTMLButtonElement[] = [];
    private renderToken = 0;
    private abort: AbortController | null = null;
    private cleanups: Array<() => void> = [];

    constructor(container: HTMLElement, options: SlideFilmstripOptions) {
        this.container = container;
        this.options = options;
    }

    /** Build the strip from the current deck. Safe to call repeatedly. */
    render(): void {
        this.renderToken++;
        this.abort?.abort();
        this.abort = new AbortController();
        const signal = this.abort.signal;
        const token = this.renderToken;
        this.teardownListeners();

        // If focus is currently inside the strip we're about to empty, the
        // rebuild would drop it to <body>. Remember so we can restore it to the
        // active thumb after rebuild (audit: focus-loss on refresh/replace).
        const hadFocus = this.container.contains(document.activeElement);

        this.container.empty();
        this.thumbs = [];

        const count = this.options.getCount();
        // Nothing to navigate with 0 or 1 slide — hide the strip entirely.
        this.container.toggleClass('ai-organiser-hidden', count <= 1);
        if (count <= 1) return;

        // A group of buttons (NOT role=list/listitem — that overrides the
        // buttons' native semantics for assistive tech; audit H2/M16).
        const strip = this.container.createEl('div', {
            cls: 'ai-organiser-pres-filmstrip',
            attr: { role: 'group', 'aria-label': this.options.groupLabel ?? 'Slide thumbnails' },
        });
        // Vertical keyboard model for the thumbnail group (audit a11y).
        this.cleanups.push(listen(strip, 'keydown', (e) => this.onStripKey(e)));

        const active = this.options.getActiveIndex();
        const imgs: HTMLImageElement[] = [];
        for (let i = 0; i < count; i++) {
            const label = (this.options.itemLabelTemplate ?? 'Slide {n}').replace('{n}', String(i + 1));
            const btn = strip.createEl('button', {
                cls: 'ai-organiser-pres-filmstrip-thumb',
                // Roving tabindex: only the active thumb is in the tab order; the
                // rest are reachable via Arrow/Home/End. This keeps the group a
                // single tab stop instead of N stops (audit: tab-order MEDIUM).
                attr: {
                    type: 'button',
                    'aria-label': label,
                    'data-index': String(i),
                    tabindex: i === active ? '0' : '-1',
                },
            });
            btn.toggleClass('is-active', i === active);
            if (i === active) btn.setAttribute('aria-current', 'true'); // expose active state to AT
            // Number badge shows immediately; the raster fills in when ready.
            btn.createEl('span', { cls: 'ai-organiser-pres-filmstrip-num', text: String(i + 1) });
            imgs.push(btn.createEl('img', { cls: 'ai-organiser-pres-filmstrip-img', attr: { alt: '' } }));
            const idx = i;
            this.cleanups.push(listen(btn, 'click', () => this.options.onSelect(idx)));
            this.thumbs.push(btn);
        }

        // Restore keyboard focus to the active thumb if the user was navigating
        // inside the strip when it rebuilt.
        if (hadFocus) this.thumbs[active]?.focus();

        // Load thumbnails SEQUENTIALLY (not all at once) so a large deck can't
        // fire dozens of concurrent rasterizations (audit M3/M12). The whole
        // loop is guarded so a stray throw is logged, never an unhandled rejection.
        void this.loadThumbnails(token, signal, count, imgs).catch((e) =>
            logger.warn('Presentation', `[filmstrip] thumbnail load loop failed: ${String(e)}`));
    }

    private onStripKey(e: KeyboardEvent): void {
        const n = this.thumbs.length;
        if (n === 0) return;
        const cur = this.thumbs.findIndex((b) => b === document.activeElement);
        let next = -1;
        if (e.key === 'ArrowDown') next = cur < 0 ? 0 : Math.min(n - 1, cur + 1);
        else if (e.key === 'ArrowUp') next = cur < 0 ? 0 : Math.max(0, cur - 1);
        else if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = n - 1;
        // ArrowDown/ArrowUp are already clamped via Math.min/Math.max above, but
        // guard both ends explicitly so the invariant doesn't depend on reading
        // the clamp (audit G1 — defensive against a future off-by-one).
        if (next < 0 || next >= n) return;
        e.preventDefault();
        // Move the roving tabindex with focus so Tab re-enters where we left off.
        for (const b of this.thumbs) b.setAttribute('tabindex', '-1');
        this.thumbs[next].setAttribute('tabindex', '0');
        this.thumbs[next].focus();
        this.thumbs[next].scrollIntoView({ block: 'nearest' });
    }

    /** Re-render (deck changed). Alias for render() — kept for call-site clarity. */
    refresh(): void {
        this.render();
    }

    /** Move the active highlight without rebuilding (prev/next nav). */
    setActive(index: number): void {
        for (const btn of this.thumbs) {
            const isActive = btn.getAttribute('data-index') === String(index);
            btn.toggleClass('is-active', isActive);
            // Keep the roving tabindex and AT state on the active thumb so a Tab
            // press lands on the current slide, not slide 1 (audit: roving tabindex).
            btn.setAttribute('tabindex', isActive ? '0' : '-1');
            if (isActive) {
                btn.setAttribute('aria-current', 'true');
                // When the slide is advanced from another control, scroll the
                // active thumb into view in the scrollable strip (audit MEDIUM).
                btn.scrollIntoView({ block: 'nearest' });
            } else {
                btn.removeAttribute('aria-current');
            }
        }
    }

    dispose(): void {
        this.renderToken++;
        this.abort?.abort();
        this.abort = null;
        this.teardownListeners();
        this.container.empty();
        this.thumbs = [];
    }

    // ── internals ──────────────────────────────────────────────────────────────

    private async loadThumbnails(
        token: number, signal: AbortSignal, count: number, imgs: HTMLImageElement[],
    ): Promise<void> {
        for (let i = 0; i < count; i++) {
            if (token !== this.renderToken || signal.aborted) return;
            let url: string | null = null;
            try {
                url = await this.options.getThumbnail(i, signal);
            } catch (e) {
                // Never let a provider rejection escape (audit H3/H4), but log
                // it — silent swallowing violates the repo logging invariant.
                url = null;
                if (!signal.aborted) {
                    logger.warn('Presentation', `[filmstrip] thumbnail ${i} failed: ${String(e)}`);
                }
            }
            if (token !== this.renderToken || signal.aborted) return;
            // Enforce the EXACT contract — the provider emits a PNG data-URL.
            // Reject anything else (incl. data:image/svg, http:) before img.src
            // (audit M4 + the tightened guard).
            if (url && /^data:image\/png[;,]/i.test(url)) {
                imgs[i].src = url;
                imgs[i].addClass('is-loaded');
            }
        }
    }

    private teardownListeners(): void {
        for (const off of this.cleanups) off();
        this.cleanups = [];
    }
}
