/**
 * Pure Azure rate-limit header parsing + backoff/TPM timing logic (azure-429-
 * throttling). No state, no Obsidian, no network — fully unit-testable.
 *
 * Handles BOTH Azure shapes:
 *  - Azure OpenAI (`/openai/v1/…`, `api-key`): `x-ratelimit-limit-tokens`,
 *    `-remaining-tokens`, `-limit-requests`, `-remaining-requests`, `retry-after`.
 *  - Foundry Claude (`/anthropic/v1/messages`, `Bearer`): same `x-ratelimit-*`
 *    PLUS `x-ratelimit-reset-*` (secs until reset). The `x-ratelimit-renewalperiod-*`
 *    headers (window length) are intentionally NOT parsed — `reset-*` already gives
 *    the wait-until time the backoff needs; renewal period adds nothing actionable.
 * Plus the common ms variants `retry-after-ms` / `x-ms-retry-after-ms` (audit R2-M3).
 */

import { logger } from '../../utils/logger';

export interface AzureRateLimitInfo {
    limitTokens?: number;
    remainingTokens?: number;
    limitRequests?: number;
    remainingRequests?: number;
    resetTokensSec?: number;
    resetRequestsSec?: number;
    /** Explicit Retry-After, normalized to ms (covers s + ms + HTTP-date). */
    retryAfterMs?: number;
}

/** Case-insensitive header lookup (requestUrl lowercases keys, but be defensive). */
function getHeader(headers: Record<string, string> | undefined, name: string): string | undefined {
    if (!headers) return undefined;
    const lower = name.toLowerCase();
    const key = Object.keys(headers).find(k => k.toLowerCase() === lower);
    return key ? headers[key] : undefined;
}

function toNumber(v: string | undefined): number | undefined {
    if (v == null) return undefined;
    const n = Number.parseFloat(v.trim());
    return Number.isFinite(n) ? n : undefined;
}

/** Parse a duration value to SECONDS: plain number, or suffixed `"60s"`/`"1s"`. */
function toSeconds(v: string | undefined): number | undefined {
    if (v == null) return undefined;
    const t = v.trim();
    const m = /^(\d+(?:\.\d+)?)\s*s$/i.exec(t);
    if (m) return Number.parseFloat(m[1]);
    return toNumber(t);
}

/** Parse `Retry-After` (delta-seconds OR HTTP-date) plus ms variants → ms. */
function parseRetryAfterMs(headers: Record<string, string> | undefined, now: number): number | undefined {
    // Millisecond variants take precedence (more precise) — audit R2-M3.
    const ms = toNumber(getHeader(headers, 'retry-after-ms')) ?? toNumber(getHeader(headers, 'x-ms-retry-after-ms'));
    if (ms != null && ms >= 0) return ms;
    const ra = getHeader(headers, 'retry-after');
    if (ra == null) return undefined;
    const secs = Number.parseInt(ra, 10);
    if (!Number.isNaN(secs) && String(secs) === ra.trim()) return Math.max(0, secs * 1000);
    const dateMs = Date.parse(ra);
    if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - now);
    return undefined;
}

export function parseAzureRateLimitHeaders(
    headers: Record<string, string> | undefined,
    now: number = Date.now(),
): AzureRateLimitInfo {
    return {
        limitTokens: toNumber(getHeader(headers, 'x-ratelimit-limit-tokens')),
        remainingTokens: toNumber(getHeader(headers, 'x-ratelimit-remaining-tokens')),
        limitRequests: toNumber(getHeader(headers, 'x-ratelimit-limit-requests')),
        remainingRequests: toNumber(getHeader(headers, 'x-ratelimit-remaining-requests')),
        resetTokensSec: toSeconds(getHeader(headers, 'x-ratelimit-reset-tokens')),
        resetRequestsSec: toSeconds(getHeader(headers, 'x-ratelimit-reset-requests')),
        retryAfterMs: parseRetryAfterMs(headers, now),
    };
}

const MAX_BACKOFF_MS = 60_000;
const BASE_BACKOFF_MS = 1_000;

/**
 * Backoff ms for a retriable Azure response. Priority (audit H2):
 *  1. explicit `Retry-After` (ms),
 *  2. the reset of the EXHAUSTED dimension (`remaining≈0`); if both exhausted or
 *     ambiguous, the MAX of the available resets (NEVER the min — min re-429s),
 *  3. capped jittered exponential.
 */
export function computeAzureBackoffMs(
    info: AzureRateLimitInfo,
    attempt: number,
    random: () => number = Math.random,
): number {
    // Authoritative server-provided delays are honoured IN FULL — the cap applies
    // only to the fallback exponential (audit M23: truncating an authoritative 90s
    // reset to 60s would just re-429).
    if (info.retryAfterMs != null && info.retryAfterMs > 0) return info.retryAfterMs;

    const resets: number[] = [];
    const reqExhausted = info.remainingRequests != null && info.remainingRequests <= 0;
    const tokExhausted = info.remainingTokens != null && info.remainingTokens <= 0;
    if (reqExhausted && info.resetRequestsSec != null) resets.push(info.resetRequestsSec);
    if (tokExhausted && info.resetTokensSec != null) resets.push(info.resetTokensSec);
    // If we couldn't pin an exhausted dimension, fall back to whatever resets we have.
    if (resets.length === 0) {
        if (info.resetRequestsSec != null) resets.push(info.resetRequestsSec);
        if (info.resetTokensSec != null) resets.push(info.resetTokensSec);
    }
    if (resets.length > 0) return Math.max(...resets) * 1000; // authoritative — uncapped

    return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * Math.pow(2, attempt) * (0.5 + random()));
}

/** Token/TPM dimension words seen in Azure 429 bodies (e.g. "…Tokens", "tokens per minute"). */
const TPM_BODY_RE = /token/i;

/**
 * Evidence-based >TPM fail-fast (audit H3/R2-H4): true ONLY when the 429 body
 * names a TOKEN dimension AND a conservative estimate exceeds the known TPM limit.
 * Errs toward retrying (returns false on any ambiguity).
 */
export function classifyTpm(errorBody: string | undefined, info: AzureRateLimitInfo, estTokens: number): boolean {
    if (info.limitTokens == null) return false;
    if (!errorBody || !TPM_BODY_RE.test(errorBody)) return false;
    return estTokens > info.limitTokens;
}

/** Chars-per-token lower bound (over-counts chars/token → under-counts tokens → errs toward retrying). */
const CHARS_PER_TOKEN_LB = 5;

/**
 * Conservative LOWER bound on the tokens a request MUST consume = the INPUT only.
 *
 * The minimum a request processes is its input (always read) + 0 output (a
 * generation may be empty). `max_tokens` is a CEILING, not committed usage — a tiny
 * prompt with `max_tokens: 64000` (e.g. adaptive thinking) actually generates a
 * handful of tokens and fits comfortably under a low TPM. Counting that ceiling
 * (the old audit-R2-H4 behaviour) hard-failed small requests that would have
 * succeeded on retry — proven live: a tiny Mermaid prompt fail-fasted as "~64k
 * tokens" under a 10k TPM. So the lower bound is input-only: the >TPM fail-fast
 * fires ONLY when the INPUT alone can never fit the per-minute budget (a genuinely
 * huge document); everything else retries (and a real >TPM still surfaces via the
 * exhausted-retry path). Errs toward retrying.
 */
export function estimateMinProcessedTokens(body: string): number {
    return Math.floor((body?.length ?? 0) / CHARS_PER_TOKEN_LB);
}

/**
 * MULTIMODAL has NO reliable client-side lower bound (a base64 PDF/image body is not
 * char≈token — images are tile-priced — and `max_tokens` is only a ceiling). So there
 * is nothing safe to pre-emptively fail-fast on: return 0 → `classifyTpm` never fires
 * for multimodal, every 429 retries, and a genuine >TPM surfaces via the exhausted-
 * retry path (the actionable `AzureRateLimitError`). Kept as a named seam for clarity.
 */
export function estimateMultimodalMinTokens(_maxTokens?: number): number {
    return 0;
}

/** Debug-log the ALLOWLISTED numeric rate-limit headers (never auth/body). */
export function logAzureRateLimitHeaders(info: AzureRateLimitInfo, source: string): void {
    logger.debug('Azure', `[rate-limit ${source}] remReq=${info.remainingRequests ?? '?'}/${info.limitRequests ?? '?'} `
        + `remTok=${info.remainingTokens ?? '?'}/${info.limitTokens ?? '?'} `
        + `resetReq=${info.resetRequestsSec ?? '?'}s resetTok=${info.resetTokensSec ?? '?'}s `
        + `retryAfter=${info.retryAfterMs != null ? Math.round(info.retryAfterMs) + 'ms' : '?'}`);
}
