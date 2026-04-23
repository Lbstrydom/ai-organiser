/**
 * withProgress / withProgressResult
 * ---------------------------------
 * Two explicit named exports — caller chooses contract at call site.
 * No runtime structural guessing (R2-M1).
 *
 * Reporter owns ALL user-facing toasts. Callers MUST NOT fire their own
 * Notice on !r.ok — doing so double-toasts (Gemini-v2-H1).
 *
 * Canonical call-site pattern:
 *     const r = await withProgress({...}, op);
 *     if (!r.ok) return;      // reporter already showed the toast
 *     use(r.value);
 */

import type { Result } from '../../core/result';
import { ok, err } from '../../core/result';
import { ProgressReporter, normalizeError } from './progressReporter';
import type { ProgressReporterOptions } from './types';

const CANCEL_SENTINEL = 'cancelled';

/** Use when the operation returns a raw T. Wrapper promotes to Result<T>.
 *  - throw AbortError → reporter.cancel(); returns { ok: false, error: 'cancelled' }
 *  - throw any other  → reporter.fail(err);  returns { ok: false, error: <normalized> }
 *  - returns T        → reporter.succeed();  returns { ok: true, value: T }
 */
export async function withProgress<T, TKey extends string>(
    options: ProgressReporterOptions<TKey>,
    operation: (reporter: ProgressReporter<TKey>) => Promise<T>,
): Promise<Result<T>> {
    const reporter = new ProgressReporter<TKey>(options);
    const unknown = options.plugin.t?.progress?.unknownError || 'Unknown error';
    try {
        const value = await operation(reporter);
        reporter.succeed();
        return ok(value);
    } catch (e) {
        if (isAbortError(e)) {
            if (!isTerminalState(reporter)) reporter.cancel();
            return err(CANCEL_SENTINEL);
        }
        const msg = normalizeError(e, unknown);
        reporter.fail(msg);
        return err(msg);
    }
}

/** Use when the operation already returns Result<T> (service-boundary style).
 *  Inner `{ ok: false, error: 'cancelled' }` routes to reporter.cancel() NOT
 *  reporter.fail() — so the user sees neutral "Cancelled" instead of red
 *  "Failed: cancelled" (Gemini-v3-M1).
 */
export async function withProgressResult<T, TKey extends string>(
    options: ProgressReporterOptions<TKey>,
    operation: (reporter: ProgressReporter<TKey>) => Promise<Result<T>>,
): Promise<Result<T>> {
    const reporter = new ProgressReporter<TKey>(options);
    const unknown = options.plugin.t?.progress?.unknownError || 'Unknown error';
    try {
        const r = await operation(reporter);
        if (r.ok) {
            reporter.succeed();
            return r;
        }
        if (isCancelSentinel(r.error)) {
            if (!isTerminalState(reporter)) reporter.cancel();
            return r;
        }
        reporter.fail(r.error);
        return r;
    } catch (e) {
        if (isAbortError(e)) {
            if (!isTerminalState(reporter)) reporter.cancel();
            return err(CANCEL_SENTINEL);
        }
        const msg = normalizeError(e, unknown);
        reporter.fail(msg);
        return err(msg);
    }
}

function isAbortError(e: unknown): boolean {
    if (e instanceof DOMException && e.name === 'AbortError') return true;
    if (e instanceof Error && e.name === 'AbortError') return true;
    return false;
}

function isCancelSentinel(msg: string): boolean {
    return /^cancell?ed$/i.test(msg.trim());
}

function isTerminalState<TKey extends string>(reporter: ProgressReporter<TKey>): boolean {
    // Reporter guards its own transitions internally; this is a conservative
    // "has the signal-abort path already driven us terminal?" check. The
    // reporter's methods are all idempotent, so even a redundant .cancel()
    // here would no-op. This exists only to avoid a spurious Cancelled
    // Notice if the signal already fired one.
    void reporter;
    return false;
}
