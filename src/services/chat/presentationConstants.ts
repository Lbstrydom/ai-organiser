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
//
// Realistic end-to-end budgets for Claude Sonnet / Opus streaming. An 8-slide
// deck with content = 4000-6000 output tokens at ~60-80 tok/sec = 60-100s of
// streaming PLUS ~2-5s latency. Refinement is smaller but still multi-slide.
// Audit is a single pass over the deck.
//
// Pre-2026-04-20 values (45/30/15s) were hitting timeout on real digests and
// aborting with "Failed to generate: Aborted" — observed with a ~5K char
// source note + 8-slide request.

export const GENERATION_TIMEOUT = 180_000;   // 3 min — room for 8-12 slide decks
export const REFINEMENT_TIMEOUT = 120_000;   // 2 min — per-refine chat turn
export const AUDIT_TIMEOUT = 60_000;         // 1 min — brand audit pass

// ── Limits ──────────────────────────────────────────────────────────────────

export const MAX_VERSIONS = 20;

/** Slide count above which quality scans sample a representative subset. */
export const LARGE_DECK_THRESHOLD = 30;

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
