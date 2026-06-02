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

const live = new Set<PresentationCommandTarget>();
let lastActivated: PresentationCommandTarget | null = null;

/** Register (or re-activate) a handler. Called when it renders/gains focus. */
export function registerPresentationTarget(target: PresentationCommandTarget): void {
    live.add(target);
    lastActivated = target;
}

/** Unregister a handler. Called from its dispose(). If it was the active one,
 *  fall back to any other still-live handler (deterministic, no dangling ref). */
export function unregisterPresentationTarget(target: PresentationCommandTarget): void {
    live.delete(target);
    if (lastActivated === target) {
        lastActivated = live.size > 0 ? [...live][live.size - 1] : null;
    }
}

/** The handler global commands should target: the most-recently-activated one
 *  that is still registered, or null when no chat modal is open. */
export function getActivePresentationTarget(): PresentationCommandTarget | null {
    if (lastActivated && live.has(lastActivated)) return lastActivated;
    return live.size > 0 ? [...live][live.size - 1] : null;
}

/** Test-only: reset module state between tests. */
export function _resetPresentationRegistry(): void {
    live.clear();
    lastActivated = null;
}
