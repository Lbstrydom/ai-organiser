export type Result<T> =
    | { ok: true; value: T }
    | { ok: false; error: string };

export function ok<T>(value: T): Result<T> { return { ok: true, value }; }
export function err<T>(error: string): Result<T> { return { ok: false, error }; }

/** A single item-level failure inside a batch (e.g. one source that could not be processed). */
export interface BatchError {
    /** Stable identifier for the failed item (URL, vault path, or title). */
    source: string;
    /** Human-readable reason. */
    error: string;
}

/**
 * The boundary contract for batch operations (D5). Full success, partial success,
 * and total failure are all expressible without `null`/`void`/`boolean` bags:
 * `items` carries every processed entry (callers derive successes/failures from it),
 * `errors` mirrors the item-level failures, `isPartial` flags a mixed outcome.
 */
export interface BatchResult<T> {
    items: T[];
    errors: BatchError[];
    warnings: string[];
    isPartial: boolean;
}
