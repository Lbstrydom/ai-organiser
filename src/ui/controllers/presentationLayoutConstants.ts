/**
 * Layout constants for the Slides side-rail workspace (plan: slides-side-rail-workspace).
 *
 * TS-owned single source of truth for clamp math, narrow detection, and tests.
 * CSS mirrors only the `--pres-rail-width` default (360px) as a pre-mount fallback;
 * the runtime default + breakpoint flow from here (audit L1/M3/Gemini-G2).
 */

/** Minimum usable rail width. */
export const PRES_RAIL_MIN_PX = 280;
/** Hard maximum rail width regardless of modal size. */
export const PRES_RAIL_MAX_PX = 560;
/** Default rail width before the user resizes. Must equal the CSS fallback. */
export const PRES_RAIL_DEFAULT_PX = 360;
/** Keyboard resize step for the rail separator (ArrowLeft/ArrowRight). */
export const PRES_RESIZE_STEP_PX = 16;
/** Minimum touch/hit target for the resizer + toggle. */
export const PRES_HIT_TARGET_PX = 44;
/** Filmstrip column width (Phase 2). */
export const PRES_FILMSTRIP_WIDTH_PX = 96;
/**
 * Below this MODAL width (not viewport — the modal is ~92vw, so a viewport
 * media query fires at the wrong size; audit Gemini-G2) the workspace falls
 * back to the stacked column. Applied by the controller as a class.
 */
export const PRES_NARROW_BREAKPOINT_PX = 900;
/** The rail may occupy at most this fraction of the modal width. */
export const PRES_RAIL_MAX_FRACTION = 0.4;

/**
 * Clamp a desired rail width to `[MIN, min(MAX, fraction*modalWidth)]`.
 *
 * Used at APPLY time only — the user's raw chosen value is persisted unclamped
 * so a large-monitor preference survives a temporary open on a small screen
 * (audit Gemini-G5).
 */
export function clampRailWidth(desiredPx: number, modalWidthPx: number): number {
    // Persisted width comes from user-editable settings JSON and modal width
    // from DOM measurement — both can be NaN/Infinity. Coerce to safe finite
    // values before any math (audit M13).
    const desired = Number.isFinite(desiredPx) ? desiredPx : PRES_RAIL_DEFAULT_PX;
    const modalWidth = Number.isFinite(modalWidthPx) && modalWidthPx > 0 ? modalWidthPx : 0;
    // When the modal width is unknown (0 — measured before layout), skip the
    // fraction cap entirely; the ResizeObserver re-applies once laid out.
    const fractionUpper = modalWidth > 0
        ? Math.round(modalWidth * PRES_RAIL_MAX_FRACTION)
        : PRES_RAIL_MAX_PX;
    // Keep the upper bound at least MIN so the result is always coherent even
    // on a very narrow modal (where the narrow-class fallback takes over anyway).
    const upper = Math.max(PRES_RAIL_MIN_PX, Math.min(PRES_RAIL_MAX_PX, fractionUpper));
    return Math.max(PRES_RAIL_MIN_PX, Math.min(upper, Math.round(desired)));
}
