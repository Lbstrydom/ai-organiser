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

// ── Streaming ──────────────────────────────────────────────────────────────

/** Marker emitted by the LLM before the HTML deck content. */
export const HTML_START_MARKER = '---HTML_START---';

/** Marker emitted by the LLM after the HTML deck content. */
export const HTML_END_MARKER = '---HTML_END---';

/** Default debounce interval (ms) for streaming checkpoint renders. */
export const STREAM_RENDER_DEBOUNCE_MS = 800;

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
