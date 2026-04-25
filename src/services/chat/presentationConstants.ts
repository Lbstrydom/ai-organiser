/**
 * Presentation Constants
 *
 * Shared constants for the presentation pipeline: geometry, timeouts, limits,
 * and the canonical deck schema (class names and selectors).
 */

// ── Geometry ────────────────────────────────────────────────────────────────

export const SLIDE_WIDTH = 1920;
export const SLIDE_HEIGHT = 1080;

// ── Timeouts (two-tier budget) ─────────────────────────────────────────────
//
// Generation / refinement use a SOFT / HARD split:
//   - soft budget: at this point the UI prompts the user to extend or cancel
//     — generation does NOT abort
//   - hard budget: absolute ceiling. GenerationProgressController calls
//     abort() on the supplied AbortController when this fires.
//
// Inner service timeouts (runHtmlTask / fetch) MUST use the HARD budget, not
// soft — using soft would crash the fetch at the exact moment the extend
// card opens. Soft enforcement happens in the handler-owned controller via
// the injected AbortSignal.
//
// Audit is a single flat cap — no progress UI, no two-tier logic there.

/** Structured budget preset per operation. Soft → hard transition surfaces
 *  the extend card; the HARD cap is IMMUTABLE for the lifetime of a
 *  generation (plan §4 — extend is one-shot soft-prompt suppression, not
 *  deadline extension). `getExtendDisplayMs(preset)` returns the gap for
 *  i18n copy — the single source of truth so comments, labels, and
 *  behavior can't drift.
 *
 *  Fields are `readonly` and exported objects are frozen so consumers
 *  can't mutate a preset at runtime and silently change timeout behavior
 *  for every later caller. (Audit R4 M1) */
export interface BudgetPreset {
    readonly softBudgetMs: number;  // UI prompts extend / cancel
    readonly hardBudgetMs: number;  // absolute cap — controller aborts
}

export const GENERATION_BUDGET: BudgetPreset = Object.freeze({
    softBudgetMs: 300_000,  // 5 min
    hardBudgetMs: 500_000,  // ~8 min
});

export const REFINEMENT_BUDGET: BudgetPreset = Object.freeze({
    softBudgetMs: 240_000,  // 4 min
    hardBudgetMs: 360_000,  // 6 min
});

// Flat exports retained as aliases for handler call sites that destructure
// `softBudgetMs` / `hardBudgetMs` directly. Derived from the presets — the
// preset objects are the authoritative source. (Audit R4 M2 — single source)
export const GENERATION_SOFT_BUDGET_MS = GENERATION_BUDGET.softBudgetMs;
export const GENERATION_HARD_BUDGET_MS = GENERATION_BUDGET.hardBudgetMs;
export const REFINEMENT_SOFT_BUDGET_MS = REFINEMENT_BUDGET.softBudgetMs;
export const REFINEMENT_HARD_BUDGET_MS = REFINEMENT_BUDGET.hardBudgetMs;
export const AUDIT_TIMEOUT = 60_000;  // 1 min — single cap, no soft/hard

/** Derive the extend-card display amount from a preset — the soft→hard gap.
 *  i18n copy uses this so the "+N min" label can't drift from the actual
 *  soft/hard budgets. (Audit R2 L1/M5 — single source of truth)
 *
 *  Enforces the same invariants as GenerationProgressController
 *  (softBudgetMs < hardBudgetMs, both positive finite) so the display
 *  value is never negative or NaN. (Audit R3 L5) */
export function getExtendDisplayMs(preset: BudgetPreset): number {
    if (!Number.isFinite(preset.softBudgetMs) || preset.softBudgetMs <= 0 ||
        !Number.isFinite(preset.hardBudgetMs) || preset.hardBudgetMs <= 0 ||
        preset.softBudgetMs >= preset.hardBudgetMs) {
        throw new Error('getExtendDisplayMs: invalid preset — require 0 < softBudgetMs < hardBudgetMs');
    }
    return preset.hardBudgetMs - preset.softBudgetMs;
}

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

/**
 * Canonical slide DOM selector. Matches both the LLM's `<section class="slide …">`
 * output AND the legacy `.slide` shape that `extractSlideInfo` historically
 * accepted. New code should import this rather than hardcoding a string —
 * SSoT for "what counts as a slide" (Gemini final-gate finding 2026-04-25).
 */
export const SLIDE_SELECTOR = 'section.slide, .slide';

// ── Targeted Slide Editing budgets (slide-authoring-editing plan) ──────────
//
// Tunable caps for the create-flow source resolution and edit-flow context.
// All values picked to fit within the project's 40K char chunking threshold
// (contentSizePolicy.ts) so prompts don't trigger map-reduce.

/** Maximum number of files enumerated from a folder source. */
export const FOLDER_MAX_FILES = 25;

/** Total content budget across all selected folder files. */
export const FOLDER_TOTAL_BUDGET_CHARS = 24_000;

/** Files whose evenly-divided allocation falls below this are dropped
 *  rather than included as a useless excerpt. */
export const FOLDER_PER_FILE_MIN_CHARS = 500;

/** Total budget for explicitly-named reference notes in Content-mode edits. */
export const REFERENCES_BUDGET_CHARS = 12_000;

/** Reference notes whose allocation falls below this are dropped. */
export const REFERENCES_PER_NOTE_MIN_CHARS = 800;

/** Snippet count fetched from researchSearchService for Content-mode web search. */
export const WEB_RESEARCH_RESULT_COUNT = 5;

/** Threshold above which design mode falls back to compact deck summary
 *  instead of sending full HTML — must stay below contentSizePolicy's 40K
 *  chunking trigger so design edits never trigger map-reduce. */
export const DESIGN_MODE_FALLBACK_CHARS = 40_000;

/** Hard reject threshold for scoped edits AND the per-prompt HTML truncation
 *  cap used by `sanitizeHtmlForPrompt`. Single source of truth for all
 *  prompt-side HTML budgets (R3-M3 fix, 2026-04-25). */
export const SCOPED_EDIT_HARD_LIMIT_CHARS = 120_000;
export const MAX_HTML_PROMPT_CHARS = SCOPED_EDIT_HARD_LIMIT_CHARS;
