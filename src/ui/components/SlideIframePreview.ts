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

import type { DomFix, QualityResult, ReliabilityTier } from '../../services/chat/presentationTypes';
import { SLIDE_WIDTH, SLIDE_HEIGHT, DECK_CLASSES } from '../../services/chat/presentationConstants';
import { buildSlideRuntimeCode } from '../../services/chat/slideRuntime';

// ── CSS Sanitisation for DOM Fixes (H5) ─────────────────────────────────────

/** CSS properties allowed in brand-audit DOM fixes. */
const ALLOWED_FIX_PROPERTIES = new Set([
    'color', 'background-color', 'background',
    'font-size', 'font-weight', 'font-style', 'font-family',
    'text-align', 'text-decoration', 'text-transform', 'line-height', 'letter-spacing',
    'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
    'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
    'border', 'border-radius', 'border-color', 'border-width', 'border-style',
    'width', 'height', 'max-width', 'max-height', 'min-width', 'min-height',
    'display', 'flex', 'flex-direction', 'justify-content', 'align-items', 'gap',
    'opacity', 'visibility', 'overflow',
    'box-shadow', 'text-shadow',
    'fill', 'stroke', 'stroke-width',
]);

/** Patterns that indicate malicious CSS values. */
const DANGEROUS_VALUE_PATTERNS = /url\s*\(|expression\s*\(|behavior\s*:|javascript\s*:|<\/style>/i;

function isAllowedCssProperty(prop: string): boolean {
    return ALLOWED_FIX_PROPERTIES.has(prop.trim().toLowerCase());
}

function isSafeCssValue(value: string): boolean {
    return !DANGEROUS_VALUE_PATTERNS.test(value);
}

// ── postMessage Protocol ─────────────────────────────────────────────────────

const MSG_NONCE_LENGTH = 8;

interface SlideMessage {
    nonce: string;
    action: string;
    payload?: unknown;
}

function generateNonce(): string {
    const arr = new Uint8Array(MSG_NONCE_LENGTH);
    crypto.getRandomValues(arr);
    return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
}

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
    private reliability: ReliabilityTier | null = null;
    private state: PreviewState = 'idle';
    private resizeObserver: ResizeObserver | null = null;
    private renderToken = 0; // Guard stale iframe load callbacks (M13)
    private keyHandler: ((e: KeyboardEvent) => void) | null = null;
    private keyHandlerTarget: HTMLElement | null = null; // Track actual listener target (M3)
    private domFixStyle: HTMLStyleElement | null = null; // Reusable style tag for applyDomFixes (M4)
    private nonce = '';
    private messageHandler: ((e: MessageEvent) => void) | null = null;

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
        this.showActiveSlide(); // CSS toggle as fallback
        this.sendMessage('goToSlide', { index });
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
        // H5: Sanitize CSS from audit LLM output before injecting into iframe
        const safeFixes = fixes.filter(fix =>
            isAllowedCssProperty(fix.property) && isSafeCssValue(fix.value)
        );
        // M4: Reuse a single <style> tag to avoid accumulating duplicate rules
        const rules = safeFixes
            .map(fix => `${fix.selector} { ${fix.property}: ${fix.value} !important; }`)
            .join('\n');
        if (!rules) return;
        if (!this.domFixStyle?.parentNode) {
            this.domFixStyle = doc.createElement('style');
            doc.head.appendChild(this.domFixStyle);
        }
        this.domFixStyle.textContent = rules;
    }

    setQuality(result: QualityResult | null): void {
        this.qualityResult = result;
        this.renderQualityBadge();
    }

    /** Set the reliability tier and render the badge. */
    setReliability(tier: ReliabilityTier | null): void {
        this.reliability = tier;
        this.renderReliabilityBadge();
    }

    dispose(): void {
        this.resizeObserver?.disconnect();
        this.resizeObserver = null;
        if (this.keyHandler) {
            // M3: Remove from actual target (wrapper), not this.container
            const target = this.keyHandlerTarget ?? this.container;
            target.removeEventListener('keydown', this.keyHandler);
            this.keyHandler = null;
            this.keyHandlerTarget = null;
        }
        if (this.messageHandler) {
            window.removeEventListener('message', this.messageHandler);
            this.messageHandler = null;
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

        // Clean up previous message listener before re-render
        if (this.messageHandler) {
            window.removeEventListener('message', this.messageHandler);
            this.messageHandler = null;
        }

        if (this.state === 'idle') {
            // H2: Full state reset when returning to idle
            this.resizeObserver?.disconnect();
            this.resizeObserver = null;
            this.iframe = null;
            this.slideCount = 0;
            this.currentSlideIndex = 0;
            this.navStylesInjected = false;
            this.domFixStyle = null;
            this.navContainer = null;
            this.navCounter = null;
            this.prevBtn = null;
            this.nextBtn = null;
            this.liveRegion = null;
            this.iframeWrapper = null;
            this.statusEl = null;
            this.keyHandlerTarget = null;
            this.nonce = '';
            return;
        }

        const wrapper = this.container.createEl('div', {
            cls: 'ai-organiser-pres-preview',
            attr: { role: 'region', 'aria-label': 'Slide preview' },
        });

        // H3: Reset per-iframe flags so new iframes get their own styles
        this.navStylesInjected = false;
        this.domFixStyle = null;

        // Phase 5: postMessage protocol — nonce ties messages to this iframe instance
        this.nonce = generateNonce();
        this.messageHandler = (e: MessageEvent) => {
            if (e.source !== this.iframe?.contentWindow) return;
            const data = e.data as SlideMessage | undefined;
            if (data?.nonce !== this.nonce) return;
            this.handleIframeMessage(data);
        };
        window.addEventListener('message', this.messageHandler);

        // Make wrapper focusable for keyboard nav (H5)
        wrapper.tabIndex = 0;
        this.keyHandlerTarget = wrapper; // M3: Track actual listener target
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
                sandbox: 'allow-same-origin allow-scripts',
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
            text: 'Preview. Final pptx may have minor layout differences.',
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

        // Phase 6: Inject slide runtime for in-iframe keyboard nav + postMessage sync
        const runtimeScript = doc.createElement('script');
        runtimeScript.textContent = buildSlideRuntimeCode(this.nonce);
        doc.body.appendChild(runtimeScript);

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

    // ── postMessage Protocol ──────────────────────────────────────────────────

    private sendMessage(action: string, payload?: unknown): void {
        if (!this.iframe?.contentWindow) return;
        const msg: SlideMessage = { nonce: this.nonce, action, payload };
        this.iframe.contentWindow.postMessage(msg, '*');
    }

    private handleIframeMessage(msg: SlideMessage): void {
        switch (msg.action) {
            case 'slideChanged': {
                const payload = msg.payload as { index: number; slideCount: number } | undefined;
                if (typeof payload?.index === 'number') {
                    this.currentSlideIndex = payload.index;
                    this.updateNav();
                    this.announce(`Slide ${payload.index + 1} of ${this.slideCount}`);
                    this.options.onSlideSelect?.(payload.index);
                }
                break;
            }
            case 'ready':
                // Runtime initialized inside iframe — no action needed
                break;
        }
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

    // ── Reliability Badge ────────────────────────────────────────────────────

    private renderReliabilityBadge(): void {
        const container = this.container.querySelector('.ai-organiser-pres-quality-container');
        if (!container) return;

        // Remove existing reliability badge if present
        const existing = container.querySelector('.ai-organiser-pres-reliability-badge');
        if (existing) existing.remove();

        if (!this.reliability || this.state !== 'ready') return;

        const labels: Record<ReliabilityTier, { text: string; cls: string }> = {
            'ok': { text: '\u2713 OK', cls: 'reliability-ok' },
            'warning': { text: '\u26A0 Warning', cls: 'reliability-warning' },
            'structurally-damaged': { text: '\u2715 Damaged', cls: 'reliability-damaged' },
            'unreliable': { text: '\u2715\u2715 Unreliable', cls: 'reliability-unreliable' },
        };

        const info = labels[this.reliability];
        const badge = document.createElement('div');
        badge.className = `ai-organiser-pres-reliability-badge ${info.cls}`;
        badge.textContent = info.text;
        container.insertBefore(badge, container.firstChild);
    }
}
