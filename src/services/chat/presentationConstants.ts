/**
 * Presentation Constants
 *
 * Shared constants for the presentation pipeline: geometry, timeouts, limits,
 * and the canonical deck schema (class names and selectors).
 */

// ── Geometry ────────────────────────────────────────────────────────────────

export const SLIDE_WIDTH = 1920;
export const SLIDE_HEIGHT = 1080;

// ── Timeouts ────────────────────────────────────────────────────────────────

export const GENERATION_TIMEOUT = 45_000;
export const REFINEMENT_TIMEOUT = 30_000;
export const AUDIT_TIMEOUT = 15_000;

// ── Limits ──────────────────────────────────────────────────────────────────

export const MAX_VERSIONS = 20;

// ── Deck Schema (canonical class names) ─────────────────────────────────────

export const DECK_CLASSES = {
    deck: 'deck',
    slide: 'slide',
    slideTitle: 'slide-title',
    slideContent: 'slide-content',
    slideSection: 'slide-section',
    slideClosing: 'slide-closing',
    speakerNotes: 'speaker-notes',
    slideNum: 'slide-num',
} as const;

export const SLIDE_TYPES = ['slide-title', 'slide-content', 'slide-section', 'slide-closing'] as const;
export type SlideType = typeof SLIDE_TYPES[number];
