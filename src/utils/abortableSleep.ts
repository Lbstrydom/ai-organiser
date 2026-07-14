/**
 * Sleep that settles early on abort (D6 / Gemini-G2).
 *
 * RESOLVES (never rejects) on abort so callers don't have to guard against
 * unhandled rejections — the retry loop checks `signal.aborted` AFTER the sleep
 * and returns a definitive cancellation, rather than relying on a throw. Always
 * clears the timer + removes the listener (no leak).
 *
 * Used to replace `CloudLLMService.postWithRetry`'s bare `setTimeout` backoff
 * sleeps so a Cancel during a 47s rate-limit stall interrupts immediately
 * instead of waiting out the timer.
 */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
        if (signal?.aborted) {
            resolve();
            return;
        }
        const onAbort = (): void => {
            cleanup();
            resolve();
        };
        const cleanup = (): void => {
            window.clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
        };
        const timer = window.setTimeout(() => {
            cleanup();
            resolve();
        }, ms);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}
