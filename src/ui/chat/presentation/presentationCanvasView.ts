/**
 * Presentation canvas view (TD-SSR-02 Phase 5).
 *
 * Owns the visual deck surface extracted from PresentationModeHandler: the
 * sandboxed iframe preview, the thumbnail filmstrip + its provider, and the
 * deferred slide-navigation handle. Reads/writes deck state through the shared
 * PresentationDeckStore (html, deckEpoch, activeSlideIndex, qualityResult) so it
 * never holds a second copy.
 *
 * Security note (unchanged from the handler): the thumbnail provider is fed ONLY
 * `deck.html` (post-sanitize) and rasterizes offscreen — slide CSS never enters
 * the host DOM. Keep it that way.
 *
 * The handler/pipeline/audit talk to the surface through this object's methods
 * (refreshPreview / getIframeDocument / applyDomFixes / setReliability /
 * setQuality / navigateToSlide), never a raw preview ref.
 */

import { SlideIframePreview } from '../../components/SlideIframePreview';
import type { IframeSelectionEvent } from '../../components/SlideIframePreview';
import { SlideFilmstrip } from '../../components/SlideFilmstrip';
import { SlideThumbnailProvider } from '../../../services/chat/slideThumbnailProvider';
import { projectForEditor } from '../../../services/chat/presentationDomDecorator';
import { countSlides } from '../../../services/prompts/presentationChatPrompts';
import type { QualityResult } from '../../../services/chat/presentationTypes';
import type { PresentationDeckStore } from './presentationDeckStore';

const NAVIGATE_DEFER_MS = 200;

export interface CanvasViewLabels {
    slidePreviewEmpty: string;
    slideBgHoverTooltip: string;
    slideThumbnails: string;
    slideThumbnailItem: string;
}

export interface CanvasViewDeps {
    /** Iframe element click → the handler routes it into the edit-scope controller. */
    onElementSelect: (event: IframeSelectionEvent) => void;
}

export class PresentationCanvasView {
    private preview: SlideIframePreview | null = null;
    private filmstrip: SlideFilmstrip | null = null;
    private thumbnailProvider: SlideThumbnailProvider | null = null;
    private navigateTimeoutId: ReturnType<typeof setTimeout> | null = null;

    constructor(
        private readonly deck: PresentationDeckStore,
        private readonly deps: CanvasViewDeps,
    ) {}

    /** Build the preview + filmstrip into the given canvas-body container and
     *  render the current deck. Tear down any prior widgets first via dispose(). */
    mount(canvasBody: HTMLElement, labels: CanvasViewLabels): void {
        const filmstripHost = canvasBody.createEl('div', { cls: 'ai-organiser-pres-filmstrip-host' });
        const previewContainer = canvasBody.createEl('div', { cls: 'ai-organiser-pres-preview-container' });
        this.preview = new SlideIframePreview(previewContainer, {
            onSlideSelect: (idx) => { this.deck.activeSlideIndex = idx; this.filmstrip?.setActive(idx); },
            onElementSelect: (event) => { this.deps.onElementSelect(event); },
            emptyPlaceholderText: labels.slidePreviewEmpty,
            bgHoverLabelTemplate: labels.slideBgHoverTooltip,
        });
        // Thumbnails are rastered from deck.html (offscreen, never cloned into
        // the host DOM), keyed by the monotonic deck epoch.
        this.thumbnailProvider = new SlideThumbnailProvider({
            getHtml: () => this.deck.html,
            getDeckVersion: () => this.deck.deckEpoch,
        });
        this.filmstrip = new SlideFilmstrip(filmstripHost, {
            getCount: () => this.thumbnailProvider?.slideCount() ?? 0,
            getActiveIndex: () => this.deck.activeSlideIndex,
            getThumbnail: (i, signal) => this.thumbnailProvider?.getThumbnail(i, signal) ?? Promise.resolve(null),
            onSelect: (i) => { this.deck.activeSlideIndex = i; this.preview?.navigateToSlide(i); this.filmstrip?.setActive(i); },
            groupLabel: labels.slideThumbnails,
            itemLabelTemplate: labels.slideThumbnailItem,
        });
        this.filmstrip.render();
        this.refreshPreview();
    }

    /** Re-project the deck HTML into the iframe + refresh the filmstrip. The
     *  only path that should poke the preview's setHtml. */
    refreshPreview(): void {
        if (!this.preview || !this.deck.html) return;
        const count = countSlides(this.deck.html);
        if (this.deck.activeSlideIndex < 0 || this.deck.activeSlideIndex >= count) {
            this.deck.activeSlideIndex = 0;
        }
        this.preview.setHtml(projectForEditor(this.deck.html));
        if (this.deck.activeSlideIndex > 0) {
            // Track the navigate handle so rapid re-render / dispose can cancel
            // the stale callback before it fires.
            this.clearNavigateTimeout();
            this.navigateTimeoutId = setTimeout(() => {
                this.navigateTimeoutId = null;
                this.preview?.navigateToSlide(this.deck.activeSlideIndex);
            }, NAVIGATE_DEFER_MS);
        }
        if (this.deck.qualityResult) {
            this.preview.setQuality(this.deck.qualityResult);
        }
        // Rebuild the filmstrip for the (possibly new) deck — the provider keys
        // its cache by deck epoch, so unchanged decks reuse cached thumbnails.
        this.filmstrip?.refresh();
    }

    clearNavigateTimeout(): void {
        if (this.navigateTimeoutId !== null) {
            clearTimeout(this.navigateTimeoutId);
            this.navigateTimeoutId = null;
        }
    }

    /** True once a preview surface exists (gate for export / quality reads). */
    isReady(): boolean {
        return this.preview !== null;
    }

    navigateToSlide(index: number): void {
        this.preview?.navigateToSlide(index);
    }

    getIframeDocument(): Document | null {
        return this.preview?.getIframeDocument() ?? null;
    }

    applyDomFixes(violations: Parameters<SlideIframePreview['applyDomFixes']>[0]): void {
        this.preview?.applyDomFixes(violations);
    }

    setReliability(tier: Parameters<SlideIframePreview['setReliability']>[0]): void {
        this.preview?.setReliability(tier);
    }

    setQuality(quality: QualityResult): void {
        this.preview?.setQuality(quality);
    }

    /** Tear down all widgets + cancel the pending nav. Safe to call repeatedly
     *  and before a re-mount. */
    dispose(): void {
        this.clearNavigateTimeout();
        this.preview?.dispose();
        this.preview = null;
        this.filmstrip?.dispose();
        this.filmstrip = null;
        this.thumbnailProvider?.dispose();
        this.thumbnailProvider = null;
    }
}
