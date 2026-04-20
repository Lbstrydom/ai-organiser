/**
 * Long-Running Operation Progress Controller
 *
 * Domain-neutral two-tier (soft/hard) budget + progress timer. Extracted from
 * the presentation-specific `GenerationProgressController` in Phase 2
 * (plan §10) so Research, Minutes, Smart Tag, and future consumers can
 * share one audited + hardened primitive.
 *
 * Two-tier budget model:
 *   t = 0..soft      Normal streaming; progress callbacks fire on change.
 *   t = soft         onSoftBudget fires ONCE. Operation does NOT abort —
 *                    caller decides (typically: prompt user to extend or
 *                    abort via their own AbortController).
 *   t = soft..hard   Extension window; operation continues.
 *   t = hard         onHardBudget fires; controller calls abort() on the
 *                    supplied AbortController. Caller renders failure UI.
 *
 * The controller does NOT own the AbortController — it receives one and
 * signals it on hard cap. This keeps abort policy (when/whether to render
 * system notice, etc.) with the caller.
 *
 * External-abort binding: if the caller's AbortController fires for any
 * reason (user cancel, upstream teardown), the controller self-disposes.
 */

import { logger } from '../../utils/logger';
import type { LongRunningOpOptions } from './types';

export class LongRunningOpController {
    private readonly startedAt: number;
    private readonly options: LongRunningOpOptions;
    private softTimer: ReturnType<typeof setTimeout> | null = null;
    private hardTimer: ReturnType<typeof setTimeout> | null = null;
    private lastProgress = 0;
    private softBudgetFired = false;
    private disposed = false;

    /** Registered by the UI when an extend card opens so the controller
     *  can force-dismiss it on dispose (completion / hard cap / external
     *  abort). */
    private extendCardCancelHook: (() => void) | null = null;

    /** External-abort listener — stashed so dispose() can unbind it and
     *  not leak a listener on the AbortController's signal. */
    private externalAbortListener: (() => void) | null = null;

    constructor(options: LongRunningOpOptions) {
        if (!Number.isFinite(options.softBudgetMs) || options.softBudgetMs <= 0) {
            throw new Error('LongRunningOpController: softBudgetMs must be a positive finite number');
        }
        if (!Number.isFinite(options.hardBudgetMs) || options.hardBudgetMs <= 0) {
            throw new Error('LongRunningOpController: hardBudgetMs must be a positive finite number');
        }
        if (options.softBudgetMs >= options.hardBudgetMs) {
            throw new Error('LongRunningOpController: softBudgetMs must be < hardBudgetMs');
        }
        if (options.expected !== undefined) {
            if (!Number.isFinite(options.expected) || options.expected < 1) {
                throw new Error('LongRunningOpController: expected must be a positive finite number when provided (coerced to integer via floor)');
            }
        }

        this.options = {
            ...options,
            expected: options.expected === undefined ? undefined : Math.floor(options.expected),
        };
        this.startedAt = (options.now ?? Date.now)();

        if (options.abortController.signal.aborted) {
            // Pre-aborted — skip timer setup. Defer onDispose to a
            // microtask so the caller's `const ctrl = new X()` assignment
            // finishes before the callback runs.
            this.disposed = true;
            queueMicrotask(() => this.safeInvoke(() => options.onDispose?.()));
            return;
        }
        this.externalAbortListener = () => this.dispose();
        options.abortController.signal.addEventListener('abort', this.externalAbortListener, { once: true });

        this.softTimer = setTimeout(() => {
            this.softTimer = null;
            if (this.disposed || this.softBudgetFired) return;
            this.softBudgetFired = true;
            this.safeInvoke(() => options.onSoftBudget?.(this.getElapsedMs()));
        }, options.softBudgetMs);

        this.hardTimer = setTimeout(() => {
            this.hardTimer = null;
            if (this.disposed) return;
            // Exception safety: abort + dispose MUST run even if the
            // observer throws. finally keeps the hard cap authoritative.
            try {
                this.safeInvoke(() => options.onHardBudget?.(this.getElapsedMs()));
            } finally {
                try { options.abortController.abort(); } catch { /* noop */ }
                this.dispose();
            }
        }, options.hardBudgetMs);
    }

    /** Centralized safe-invocation boundary for observer callbacks. Isolates
     *  the controller's control flow from observer failures AND surfaces
     *  the failure through the repo's logger so bugs aren't silently lost.
     *  Uses `logger.error` because project policy suppresses `.warn` in
     *  production — these are real bugs that should always surface. */
    private safeInvoke(fn: () => void | Promise<void>): void {
        try {
            const r = fn();
            if (r && typeof r.catch === 'function') {
                r.catch((err: unknown) => {
                    logger.error('LongRunningOp', 'observer rejected', err);
                });
            }
        } catch (err) {
            logger.error('LongRunningOp', 'observer threw', err);
        }
    }

    /**
     * Caller reports the newest progress count (e.g. slides closed, chunks
     * completed). Fires `onProgress` only when the value actually changes —
     * elapsed-time ticks are the consumer's responsibility (a separate 1s
     * timer in the UI layer, to keep the aria-live region quiet between
     * structural transitions).
     *
     * Invalid values (negative / NaN / Infinity) are rejected with a debug
     * log so upstream bugs surface rather than vanishing silently.
     */
    recordProgress(currentItem: number): void {
        if (this.disposed) return;
        if (!Number.isFinite(currentItem) || currentItem < 0) {
            logger.debug('LongRunningOp', 'recordProgress rejected invalid value', { currentItem });
            return;
        }
        const safeCount = Math.floor(currentItem);
        if (safeCount === this.lastProgress) return;
        this.lastProgress = safeCount;
        this.safeInvoke(() =>
            this.options.onProgress?.(safeCount, this.options.expected, this.getElapsedMs()),
        );
    }

    /** Elapsed ms since construction. Used by callers for display + budget copy. */
    getElapsedMs(): number {
        return ((this.options.now ?? Date.now)()) - this.startedAt;
    }

    /** Last progress count recorded (0 pre-first-progress). Exposed so
     *  the UI's elapsed ticker can re-render with the current slide/chunk
     *  fragment when only time moved. */
    getLastProgress(): number {
        return this.lastProgress;
    }

    /** One-shot flag — once set, soft budget cannot re-fire. */
    isSoftBudgetFired(): boolean {
        return this.softBudgetFired;
    }

    /** Register a cancel hook so the controller can force-dismiss an open
     *  extend card on terminal state. Post-disposal registrations fire the
     *  hook via a microtask (so the caller's own setup finishes first). */
    setExtendCardCancelHook(fn: () => void): void {
        if (this.disposed) {
            queueMicrotask(() => this.safeInvoke(fn));
            return;
        }
        this.extendCardCancelHook = fn;
    }

    /** Clears timers, unbinds external-abort listener, fires extend-card
     *  cancel hook then onDispose. Idempotent. */
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        if (this.softTimer !== null) {
            clearTimeout(this.softTimer);
            this.softTimer = null;
        }
        if (this.hardTimer !== null) {
            clearTimeout(this.hardTimer);
            this.hardTimer = null;
        }
        if (this.externalAbortListener) {
            try {
                this.options.abortController.signal.removeEventListener(
                    'abort', this.externalAbortListener,
                );
            } catch { /* noop */ }
            this.externalAbortListener = null;
        }
        const cancelHook = this.extendCardCancelHook;
        this.extendCardCancelHook = null;
        if (cancelHook) this.safeInvoke(cancelHook);
        this.safeInvoke(() => this.options.onDispose?.());
    }
}

/**
 * Extract a count from a user prompt using a domain-specific regex.
 * Presentation uses this for "8 slides"; Research could use it for
 * "5 sources". Clamps to [1, maxCount] and falls back on no match.
 *
 * @param prompt  user input text
 * @param pattern regex with one capturing group for the digit count
 * @param fallback default count when no match
 * @param maxCount upper clamp to guard pathological inputs
 */
export function parseCountFromPrompt(
    prompt: string,
    pattern: RegExp,
    fallback: number,
    maxCount: number,
): number {
    const m = pattern.exec(prompt);
    const n = m ? Number.parseInt(m[1], 10) : fallback;
    if (!Number.isFinite(n)) return fallback;
    return Math.max(1, Math.min(n, maxCount));
}
