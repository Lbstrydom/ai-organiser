/**
 * Retry with exponential backoff for TTS API calls.
 *
 * Shared by all TtsEngine consumers so the retry policy lives in one place.
 * Base delay 500 ms, doubles per attempt (500 → 1000 → 2000 ms for 3 tries).
 * Abort signal cancels any pending delay and causes an immediate throw.
 */

const BASE_DELAY_MS = 500;

/**
 * Call `fn` up to `maxAttempts` times. On each failure except the last,
 * wait `BASE_DELAY_MS * 2^attempt` ms before retrying. Propagates the last
 * error when all attempts fail.
 *
 * `signal` is checked before every attempt and during every backoff delay.
 * When aborted, throws immediately without waiting.
 */
export async function retryWithBackoff<T>(
    fn: () => Promise<T>,
    maxAttempts: number,
    signal?: AbortSignal,
): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (signal?.aborted) throw new Error('Aborted');
        try {
            return await fn();
        } catch (err) {
            lastError = err;
            if (attempt < maxAttempts - 1) {
                const delay = BASE_DELAY_MS * Math.pow(2, attempt);
                await new Promise<void>((resolve) => {
                    const timer = setTimeout(resolve, delay);
                    signal?.addEventListener(
                        'abort',
                        () => { clearTimeout(timer); resolve(); },
                        { once: true },
                    );
                });
            }
        }
    }
    throw lastError;
}
