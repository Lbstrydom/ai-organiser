/**
 * Presentation command registry
 *
 * Replaces the old `PresentationModeHandler.activeInstance` static (a single
 * "most-recently-mounted wins" pointer set in a render hook). The registry:
 *   - tracks ALL live handlers (supports >1 open chat modal),
 *   - is keyed by explicit register/unregister tied to render + dispose,
 *   - resolves `getActive()` to the most-recently-activated handler that is
 *     still registered — so disposing the active one falls back to another
 *     live handler instead of leaving a dangling/null pointer.
 *
 * Decoupled from `PresentationModeHandler` (typed via a minimal interface) so
 * it stays unit-testable without the 1900-line handler.
 */

/** The slice of a presentation handler the global commands actually use. */
export interface PresentationCommandTarget {
    getDeckHtml(): string | null;
    selectSlideFromCommand(slideIndex: number): void;
}

// Activation-ordered list — the tail is the most-recently-activated live
// handler. An array (not a Set + pointer) is required for TRUE most-recent
// semantics: a Set preserves *insertion* order, so on unregister the fallback
// would pick the oldest-inserted survivor, not the most-recently-activated one
// (audit HIGH). Re-registering moves a handler to the tail.
const order: PresentationCommandTarget[] = [];

/** Register (or re-activate) a handler. Called when it renders/gains focus.
 *  Moves an already-present handler to the tail (most-recent). */
export function registerPresentationTarget(target: PresentationCommandTarget): void {
    const i = order.indexOf(target);
    if (i !== -1) order.splice(i, 1);
    order.push(target);
}

/** Unregister a handler. Called from its dispose(). The tail of the remaining
 *  list is the next-most-recently-activated handler (deterministic, no dangling ref). */
export function unregisterPresentationTarget(target: PresentationCommandTarget): void {
    const i = order.indexOf(target);
    if (i !== -1) order.splice(i, 1);
}

/** The handler global commands should target: the most-recently-activated one
 *  that is still registered, or null when no chat modal is open. */
export function getActivePresentationTarget(): PresentationCommandTarget | null {
    return order.length > 0 ? order[order.length - 1] : null;
}

/** Test-only: reset module state between tests. */
export function _resetPresentationRegistry(): void {
    order.length = 0;
}
