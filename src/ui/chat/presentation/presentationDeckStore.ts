/**
 * Presentation deck store (TD-SSR-02 Phase 1-class / foundation).
 *
 * The single source of truth for deck state, extracted from
 * PresentationModeHandler so the canvas view + generation pipeline read/write
 * through one object instead of a dozen sibling handler fields.
 *
 * Fields are intentionally public + mutable: the handler/pipeline mutate them
 * in place (e.g. `deck.html = ...`, `deck.phase = 'refining'`) exactly as they
 * did when these were handler fields — this keeps the extraction behaviour-
 * preserving and mechanical. The one piece of real logic, `pushVersion`, lives
 * here because it's pure state (version history + the monotonic epoch).
 *
 * `deckEpoch` is the monotonic mutation counter — the thumbnail-cache key + the
 * side-rail layout change-signal. It MUST stay monotonic (never `versions.length`,
 * which the MAX_VERSIONS cap freezes and a restore doesn't change) or stale
 * filmstrip thumbnails surface. Bumped on every deck swap.
 */

import {
    type PresentationPhase, type PresentationVersion, type QualityResult,
    MAX_VERSIONS,
} from '../../../services/chat/presentationTypes';
import type { SlideDeckIr } from '../../../services/presentationIr/slideIr';

export class PresentationDeckStore {
    phase: PresentationPhase = 'empty';
    html: string | null = null;
    // `deckIr` is the canonical artifact — the deck is always IR-backed (legacy
    // HTML generation was retired 2026-06). Every mutation path produces a new
    // IR via the handler's commitDeckMutation, so it never disagrees with `html`.
    deckIr: SlideDeckIr | null = null;
    versions: PresentationVersion[] = [];
    versionIndex = -1;
    activeSlideIndex = 0;
    lastError: string | null = null;
    qualityResult: QualityResult | null = null;
    deckEpoch = 0;

    /** Push the current (html, deckIr, activeSlideIndex) as a new version, cap at
     *  MAX_VERSIONS, advance the index, and bump the monotonic epoch. No-op
     *  without html. */
    pushVersion(userPrompt: string): void {
        if (!this.html) return;
        this.versions.push({
            html: this.html,
            userPrompt,
            timestamp: Date.now(),
            activeSlideIndex: this.activeSlideIndex,
            deckIr: this.deckIr ?? undefined,
        });
        if (this.versions.length > MAX_VERSIONS) this.versions.shift();
        this.versionIndex = this.versions.length - 1;
        this.deckEpoch++;   // deck changed — invalidate thumbnail cache + signal layout
    }
}
