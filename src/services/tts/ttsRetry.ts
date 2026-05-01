/**
 * TTS retry helper — exponential backoff with full jitter for transient failures.
 *
 * Wraps a per-chunk operation so a single 429/503 mid-generation doesn't waste
 * the user's spend on completed chunks. Honours AbortSignal — wakes immediately
 * on abort during the sleep window.
 *
 * Engine errors are classified retryable via either:
 *   - `error.retryable === true` (set by GeminiTtsEngine for 429/5xx), OR
 *   - error name is 'NetworkError' / 'TimeoutError' / 'AbortError' (no — abort is terminal)
 */

export interface RetryPolicy {
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
    retryableHttpCodes: number[];
}

export const DEFAULT_TTS_RETRY: RetryPolicy = {
    maxAttempts: 3,
    baseDelayMs: 1000,
    maxDelayMs: 8000,
    retryableHttpCodes: [429, 500, 502, 503, 504],
};

interface RetryableError {
    retryable?: boolean;
    httpStatus?: number;
}

function isRetryable(err: unknown, policy: RetryPolicy): boolean {
    if (!err || typeof err !== 'object') return false;
    const e = err as RetryableError & { name?: string };
    if (e.retryable === true) return true;
    if (typeof e.httpStatus === 'number' && policy.retryableHttpCodes.includes(e.httpStatus)) {
        return true;
    }
    if (e.name === 'NetworkError' || e.name === 'TimeoutError') return true;
    return false;
}

function isAbort(err: unknown): boolean {
    if (err instanceof DOMException && err.name === 'AbortError') return true;
    if (err instanceof Error && err.name === 'AbortError') return true;
    return false;
}

/** Sleep with abort-aware wakeup. */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new DOMException('Aborted', 'AbortError'));
            return;
        }
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        const onAbort = (): void => {
            clearTimeout(timer);
            reject(new DOMException('Aborted', 'AbortError'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

/** Exponential backoff with full-jitter formula. */
function computeDelay(attempt: number, policy: RetryPolicy): number {
    const base = Math.min(policy.baseDelayMs * Math.pow(2, attempt - 1), policy.maxDelayMs);
    return Math.floor(base * (0.5 + Math.random() * 0.5));
}

export async function retryWithBackoff<T>(
    op: (attempt: number) => Promise<T>,
    policy: RetryPolicy = DEFAULT_TTS_RETRY,
    signal?: AbortSignal,
    onRetry?: (attempt: number, delayMs: number, err: unknown) => void,
): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
        if (signal?.aborted) {
            throw new DOMException('Aborted', 'AbortError');
        }
        try {
            return await op(attempt);
        } catch (err) {
            if (isAbort(err)) throw err;
            lastErr = err;
            if (attempt >= policy.maxAttempts || !isRetryable(err, policy)) {
                throw err;
            }
            const delayMs = computeDelay(attempt, policy);
            onRetry?.(attempt, delayMs, err);
            await abortableSleep(delayMs, signal);
        }
    }
    throw lastErr;
}
