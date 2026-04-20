/**
 * Long-Running Operation — Shared Types
 *
 * Domain-neutral types for any long-running LLM-backed operation that
 * needs a two-tier (soft/hard) budget + progress surface. Spun out of the
 * presentation-specific `GenerationProgressController` in Phase 2 so
 * Research, Minutes, and future consumers can share the same primitive
 * (plan §10).
 *
 * Terminology choices:
 *   - `currentItem` / `expectedItems` — generic "item" language instead of
 *     presentation-specific "slide". Each consumer pairs with a
 *     `LabelFormatter` that renders copy for its domain.
 *   - Budget still soft/hard. Extend still one-shot. Cancel still owned by
 *     the caller's AbortController.
 */

export interface LongRunningOpCallbacks {
    /** Fires whenever `recordProgress` reports a NEW currentItem (differs
     *  from the previously-seen value). Pre-first-progress state is the
     *  consumer's responsibility to render. */
    onProgress?: (current: number, expected: number | undefined, elapsedMs: number) => void;
    /** Fires once at softBudgetMs. Operation continues — caller decides
     *  whether to extend or abort. Callback may be async; the controller
     *  does NOT await it. */
    onSoftBudget?: (elapsedMs: number) => void | Promise<void>;
    /** Fires once at hardBudgetMs. Controller calls abort() immediately
     *  after, then disposes. */
    onHardBudget?: (elapsedMs: number) => void;
    /** Called when dispose() runs. Used by the UI to auto-dismiss any
     *  open extend card / status surface on terminal state. */
    onDispose?: () => void;
}

export interface LongRunningOpOptions extends LongRunningOpCallbacks {
    softBudgetMs: number;
    hardBudgetMs: number;
    /** Expected total item count (e.g. slides, chunks, sources). Undefined
     *  when the caller can't pre-derive one — labeller falls back to
     *  unbounded form ("Item N" without "of M"). */
    expected?: number;
    /** AbortController the controller aborts on hard cap. Owner keeps the
     *  reference and decides when to abort manually (e.g. on user Cancel). */
    abortController: AbortController;
    /** Optional time provider for unit tests. Defaults to Date.now. */
    now?: () => number;
}

/**
 * Presentational helper — maps (current, expected, elapsed) to the string
 * that lands in the thinking indicator's live-region span. Each consumer
 * owns its own formatter so the noun is domain-specific
 * ("Slide", "Chunk", "Source"). Kept as a pure function so it's easy to
 * unit-test and swap per caller.
 */
export type LabelFormatter = (
    current: number,
    expected: number | undefined,
    elapsedMs: number,
) => string;
