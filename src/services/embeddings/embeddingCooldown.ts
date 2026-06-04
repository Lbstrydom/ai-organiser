/**
 * Embedding cooldown / circuit breaker (D4.2).
 *
 * A real 429 from a network embedding provider sets a cooldown window; while
 * cooling, the embedding service short-circuits (no network) and the queue
 * defers its drain. The window is `max(Retry-After, exponential backoff)` so a
 * server-directed wait is always honoured, with an escalating floor for
 * repeated 429s.
 *
 * Plugin-scoped singleton — constructed in `onload` (D0), injected into the
 * active embedding provider via the factory.
 */

const BASE_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 60_000;
/** Hard ceiling on any cooldown window (H7) — a hostile/buggy Retry-After
 *  (enormous seconds or a far-future HTTP date) must not disable embeddings
 *  for hours/years. 10 minutes is generous for a real rate-limit pause. */
const MAX_COOLDOWN_MS = 600_000;

/**
 * Parse a `Retry-After` header into milliseconds. Supports delta-seconds
 * ("120") and HTTP-date ("Wed, 21 Oct 2025 07:28:00 GMT"). Returns 0 when
 * absent/unparseable or in the past (clock skew → graceful fall-through to
 * the backoff floor).
 */
export function parseRetryAfter(header: string | undefined | null, now: number = Date.now()): number {
    if (!header) return 0;
    const trimmed = header.trim();
    const secs = Number.parseInt(trimmed, 10);
    // Pure-integer delta-seconds (avoid Date.parse swallowing "120" oddly).
    if (/^\d+$/.test(trimmed) && !Number.isNaN(secs) && secs > 0) return secs * 1000;
    const dateMs = Date.parse(trimmed);
    if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - now);
    return 0;
}

export class EmbeddingCooldown {
    private cooldownUntil = 0;
    private consecutive = 0;
    private readonly now: () => number;

    /** `now` is injectable for deterministic tests; defaults to `Date.now`. */
    constructor(now: () => number = () => Date.now()) {
        this.now = now;
    }

    /** Record a 429. Sets the window to max(Retry-After, escalating backoff). */
    note429(retryAfterHeader?: string | null): void {
        this.consecutive++;
        const now = this.now();
        const headerMs = parseRetryAfter(retryAfterHeader, now);
        const backoffMs = Math.min(BASE_BACKOFF_MS * Math.pow(2, this.consecutive - 1), MAX_BACKOFF_MS);
        // H7: clamp to a hard ceiling so a bogus Retry-After can't park the
        // window in the far future.
        const windowMs = Math.min(Math.max(headerMs, backoffMs), MAX_COOLDOWN_MS);
        this.cooldownUntil = Math.max(this.cooldownUntil, now + windowMs);
    }

    isCoolingDown(): boolean {
        return this.now() < this.cooldownUntil;
    }

    /** Milliseconds until the cooldown clears (0 when not cooling). */
    remainingMs(): number {
        return Math.max(0, this.cooldownUntil - this.now());
    }

    /** Clear the window and the escalation counter (e.g. after a clean batch). */
    reset(): void {
        this.cooldownUntil = 0;
        this.consecutive = 0;
    }
}
