/**
 * Slide Iframe Preview
 *
 * Renders HTML slides in a sandboxed iframe (srcdoc) inside the modal.
 * Same-origin access via allow-same-origin lets us navigate slides,
 * apply Haiku audit DOM fixes, and pass elements to dom-to-pptx.
 *
 * Accessibility: iframe has title, buttons have aria-labels, slide changes
 * announced via live region, keyboard navigation via ArrowLeft/ArrowRight.
 */

import type { DomFix, QualityResult } from '../../services/chat/presentationTypes';
import { SLIDE_WIDTH, SLIDE_HEIGHT, DECK_CLASSES } from '../../services/chat/presentationConstants';

export interface PreviewOptions {
    onSlideSelect?: (index: number) => void;
}

type PreviewState = 'idle' | 'loading' | 'ready' | 'empty' | 'error';

export class SlideIframePreview {
    private container: HTMLElement;
    private options: PreviewOptions;
    private iframe: HTMLIFrameElement | null = null;
    private html = '';
    private currentSlideIndex = 0;
    private slideCount = 0;
    private qualityResult: QualityResult | null = null;
    private state: PreviewState = 'idle';
    private resizeObserver: ResizeObserver | null = null;
    private renderToken = 0; // Guard stale iframe load callbacks (M13)
    private keyHandler: ((e: KeyboardEvent) => void) | null = null;

    // Nav refs
    private navContainer: HTMLElement | null = null;
    private navCounter: HTMLElement | null = null;
    private prevBtn: HTMLButtonElement | null = null;
    private nextBtn: HTMLButtonElement | null = null;
    private liveRegion: HTMLElement | null = null;
    private iframeWrapper: HTMLElement | null = null;
    private statusEl: HTMLElement | null = null;

    constructor(container: HTMLElement, options: PreviewOptions = {}) {
        this.container = container;
        this.options = options;
    }

    // ── Public API ──────────────────────────────────────────────────────────

    setHtml(html: string): void {
        this.html = html;
        this.currentSlideIndex = 0;
        this.state = html ? 'loading' : 'idle';
        this.render();
    }

    getHtml(): string {
        return this.html;
    }

    /** Single authoritative slide change method (M14 fix) */
    goToSlide(index: number): void {
        if (index < 0 || index >= this.slideCount || this.state !== 'ready') return;
        this.currentSlideIndex = index;
        this.showActiveSlide();
        this.updateNav();
        this.announce(`Slide ${index + 1} of ${this.slideCount}`);
        this.options.onSlideSelect?.(index);
    }

    /** Alias for external callers */
    navigateToSlide(index: number): void { this.goToSlide(index); }

    getSlideCount(): number { return this.slideCount; }
    getActiveIndex(): number { return this.currentSlideIndex; }
    getIframeDocument(): Document | null { return this.iframe?.contentDocument ?? null; }

    applyDomFixes(fixes: DomFix[]): void {
        const doc = this.getIframeDocument();
        if (!doc) return;
        for (const fix of fixes) {
            const el = doc.querySelector(fix.selector);
            if (el) (el as HTMLElement).style.setProperty(fix.property, fix.value);
        }
    }

    setQuality(result: QualityResult | null): void {
        this.qualityResult = result;
        this.renderQualityBadge();
    }

    dispose(): void {
        this.resizeObserver?.disconnect();
        this.resizeObserver = null;
        if (this.keyHandler) {
            this.container.removeEventListener('keydown', this.keyHandler);
            this.keyHandler = null;
        }
        this.renderToken++; // Invalidate pending loads
        this.container.empty();
        this.iframe = null;
        this.html = '';
        this.state = 'idle';
    }

    // ── Rendering ───────────────────────────────────────────────────────────

    private render(): void {
        this.renderToken++; // Invalidate prior iframe loads (M13)
        this.container.empty();

        if (this.state === 'idle') return;

        const wrapper = this.container.createEl('div', {
            cls: 'ai-organiser-pres-preview',
            attr: { role: 'region', 'aria-label': 'Slide preview' },
        });

        // Make wrapper focusable for keyboard nav (H5)
        wrapper.tabIndex = 0;
        this.keyHandler = (e: KeyboardEvent) => {
            if (e.key === 'ArrowLeft') { this.goToSlide(this.currentSlideIndex - 1); e.preventDefault(); }
            if (e.key === 'ArrowRight') { this.goToSlide(this.currentSlideIndex + 1); e.preventDefault(); }
            if (e.key === 'Home') { this.goToSlide(0); e.preventDefault(); }
            if (e.key === 'End') { this.goToSlide(this.slideCount - 1); e.preventDefault(); }
        };
        wrapper.addEventListener('keydown', this.keyHandler);

        // Live region for accessibility announcements (H5)
        this.liveRegion = wrapper.createEl('div', {
            cls: 'sr-only',
            attr: { 'aria-live': 'polite', 'aria-atomic': 'true' },
        });

        // Status message area (H6)
        this.statusEl = wrapper.createEl('div', { cls: 'ai-organiser-pres-status' });

        // Iframe container
        this.iframeWrapper = wrapper.createEl('div', { cls: 'ai-organiser-pres-iframe-wrapper' });

        if (this.state === 'loading') {
            this.statusEl.textContent = 'Loading preview...';
        }

        const token = this.renderToken;

        this.iframe = this.iframeWrapper.createEl('iframe', {
            cls: 'ai-organiser-pres-iframe',
            attr: {
                srcdoc: this.html,
                sandbox: 'allow-same-origin',
                title: 'Slide deck preview', // H5 accessibility
            },
        });

        this.iframe.addEventListener('load', () => {
            if (token !== this.renderToken) return; // Stale (M13)
            this.onIframeLoad();
        });

        // Navigation bar
        this.renderNavBar(wrapper);

        // Quality container
        wrapper.createEl('div', { cls: 'ai-organiser-pres-quality-container' });

        // Disclaimer
        wrapper.createEl('div', {
            cls: 'ai-organiser-pres-disclaimer',
            text: 'Preview. Final PPTX may have minor layout differences.',
        });

        // ResizeObserver for responsive scaling (M12)
        this.resizeObserver?.disconnect();
        this.resizeObserver = new ResizeObserver(() => {
            if (this.state === 'ready') this.updateScale();
        });
        this.resizeObserver.observe(this.iframeWrapper);
    }

    private onIframeLoad(): void {
        const doc = this.getIframeDocument();
        if (!doc) {
            this.state = 'error';
            if (this.statusEl) this.statusEl.textContent = 'Failed to load preview.';
            return;
        }

        const slides = doc.querySelectorAll(`.${DECK_CLASSES.slide}`);
        this.slideCount = slides.length;

        if (this.slideCount === 0) {
            this.state = 'empty';
            if (this.statusEl) this.statusEl.textContent = 'No slides found in generated HTML.';
            this.updateNav();
            return;
        }

        this.state = 'ready';
        if (this.statusEl) this.statusEl.textContent = '';
        this.updateScale();
        this.showActiveSlide();
        this.updateNav();
        this.renderQualityBadge();
    }

    private updateScale(): void {
        if (!this.iframeWrapper || !this.iframe) return;
        const containerWidth = this.iframeWrapper.clientWidth || 600;
        const scale = containerWidth / SLIDE_WIDTH;
        this.iframe.addClass('ai-organiser-scaled-iframe');
        this.iframe.setCssProps({
            '--iframe-scale': String(scale),
            '--iframe-width': `${SLIDE_WIDTH}px`,
            '--iframe-height': `${SLIDE_HEIGHT}px`
        });
        this.iframeWrapper.addClass('ai-organiser-scaled-iframe-wrapper');
        this.iframeWrapper.setCssProps({ '--iframe-wrapper-height': `${Math.ceil(SLIDE_HEIGHT * scale)}px` });
    }

    private showActiveSlide(): void {
        const doc = this.getIframeDocument();
        if (!doc) return;

        // R2 H4 fix: use CSS class toggle instead of mutating inline display
        // This preserves original layout mode for dom-to-pptx export
        this.ensureNavigationStyles(doc);
        const slides = doc.querySelectorAll(`.${DECK_CLASSES.slide}`);
        slides.forEach((slide, i) => {
            slide.classList.toggle('pres-nav-hidden', i !== this.currentSlideIndex);
        });
    }

    /** Inject navigation CSS into iframe once (non-destructive) */
    private navStylesInjected = false;
    private ensureNavigationStyles(doc: Document): void {
        if (this.navStylesInjected) return;
        const style = doc.createElement('style');
        style.textContent = '.pres-nav-hidden { display: none !important; }';
        doc.head?.appendChild(style);
        this.navStylesInjected = true;
    }

    // ── Navigation ──────────────────────────────────────────────────────────

    private renderNavBar(parent: HTMLElement): void {
        this.navContainer = parent.createEl('div', { cls: 'ai-organiser-pres-nav' });

        this.prevBtn = this.navContainer.createEl('button', {
            cls: 'ai-organiser-pres-nav-btn',
            text: '◄',
            attr: { 'aria-label': 'Previous slide' }, // H5
        });
        this.prevBtn.addEventListener('click', () => this.goToSlide(this.currentSlideIndex - 1));

        this.navCounter = this.navContainer.createEl('span', {
            cls: 'ai-organiser-pres-nav-counter',
            text: '— / —',
        });

        this.nextBtn = this.navContainer.createEl('button', {
            cls: 'ai-organiser-pres-nav-btn',
            text: '►',
            attr: { 'aria-label': 'Next slide' }, // H5
        });
        this.nextBtn.addEventListener('click', () => this.goToSlide(this.currentSlideIndex + 1));
    }

    private updateNav(): void {
        const isReady = this.state === 'ready' && this.slideCount > 0;

        if (this.navCounter) {
            this.navCounter.textContent = isReady
                ? `${this.currentSlideIndex + 1} / ${this.slideCount}`
                : '— / —';
        }
        if (this.prevBtn) {
            this.prevBtn.disabled = !isReady || this.currentSlideIndex <= 0;
        }
        if (this.nextBtn) {
            this.nextBtn.disabled = !isReady || this.currentSlideIndex >= this.slideCount - 1;
        }

        // L4: hide nav when only 1 slide
        if (this.navContainer) {
            this.navContainer.toggleClass('ai-organiser-hidden', this.slideCount <= 1);
        }
    }

    private announce(text: string): void {
        if (this.liveRegion) this.liveRegion.textContent = text;
    }

    // ── Quality Badge ───────────────────────────────────────────────────────

    private renderQualityBadge(): void {
        const container = this.container.querySelector('.ai-organiser-pres-quality-container');
        if (!container) return;
        (container as HTMLElement).empty();

        if (!this.qualityResult || this.state !== 'ready') return;
        const score = this.qualityResult.totalScore;
        const cls = score >= 80 ? 'quality-good' : score >= 50 ? 'quality-warn' : 'quality-poor';

        const badge = document.createElement('div');
        badge.className = `ai-organiser-pres-quality-badge ${cls}`;
        badge.textContent = `Quality: ${score}/100`;
        container.appendChild(badge);
    }
}
