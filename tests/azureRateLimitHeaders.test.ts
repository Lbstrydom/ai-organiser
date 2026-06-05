import { describe, it, expect } from 'vitest';
import {
    parseAzureRateLimitHeaders, computeAzureBackoffMs, classifyTpm, estimateMinProcessedTokens,
} from '../src/services/azure/azureRateLimitHeaders';

describe('parseAzureRateLimitHeaders', () => {
    it('parses the OpenAI shape (case-insensitive) + retry-after secs', () => {
        const info = parseAzureRateLimitHeaders({
            'X-RateLimit-Limit-Tokens': '10000', 'x-ratelimit-remaining-tokens': '0',
            'x-ratelimit-limit-requests': '10', 'x-ratelimit-remaining-requests': '3',
            'retry-after': '43',
        });
        expect(info.limitTokens).toBe(10000);
        expect(info.remainingTokens).toBe(0);
        expect(info.limitRequests).toBe(10);
        expect(info.remainingRequests).toBe(3);
        expect(info.retryAfterMs).toBe(43000);
    });
    it('parses the Foundry-Claude reset-* + renewalperiod shape with "Ns" suffixes', () => {
        const info = parseAzureRateLimitHeaders({
            'x-ratelimit-reset-tokens': '60s', 'x-ratelimit-reset-requests': '1s',
        });
        expect(info.resetTokensSec).toBe(60);
        expect(info.resetRequestsSec).toBe(1);
    });
    it('prefers the ms variants over retry-after secs (R2-M3)', () => {
        const info = parseAzureRateLimitHeaders({ 'retry-after': '5', 'retry-after-ms': '250' });
        expect(info.retryAfterMs).toBe(250);
        expect(parseAzureRateLimitHeaders({ 'x-ms-retry-after-ms': '500' }).retryAfterMs).toBe(500);
    });
    it('parses retry-after HTTP-date', () => {
        const now = 1_000_000;
        const date = new Date(now + 30_000).toUTCString();
        expect(parseAzureRateLimitHeaders({ 'retry-after': date }, now).retryAfterMs).toBeGreaterThanOrEqual(29_000);
    });
    it('missing → all undefined', () => {
        const info = parseAzureRateLimitHeaders({});
        expect(info.limitTokens).toBeUndefined();
        expect(info.retryAfterMs).toBeUndefined();
    });
});

describe('computeAzureBackoffMs (audit H2)', () => {
    const noJitter = () => 0;
    it('honours explicit retry-after first', () => {
        expect(computeAzureBackoffMs({ retryAfterMs: 4300, resetRequestsSec: 1 }, 0, noJitter)).toBe(4300);
    });
    it('waits for the EXHAUSTED dimension, not the min', () => {
        // requests exhausted (60s reset), tokens fine (1s reset) → must wait 60s, not 1s.
        const ms = computeAzureBackoffMs({
            remainingRequests: 0, resetRequestsSec: 60, remainingTokens: 5000, resetTokensSec: 1,
        }, 0, noJitter);
        expect(ms).toBe(60_000);
    });
    it('uses MAX of resets when ambiguous (never min)', () => {
        const ms = computeAzureBackoffMs({ resetRequestsSec: 5, resetTokensSec: 30 }, 0, noJitter);
        expect(ms).toBe(30_000);
    });
    it('honours an authoritative reset IN FULL (uncapped — audit M23)', () => {
        expect(computeAzureBackoffMs({ resetTokensSec: 90 }, 0, noJitter)).toBe(90_000);
        expect(computeAzureBackoffMs({ retryAfterMs: 90_000 }, 0, noJitter)).toBe(90_000);
    });
    it('caps the FALLBACK exponential at 60s', () => {
        expect(computeAzureBackoffMs({}, 20, noJitter)).toBe(60_000);
    });
    it('falls back to capped exponential with no reset info', () => {
        expect(computeAzureBackoffMs({}, 2, noJitter)).toBeGreaterThan(0);
        expect(computeAzureBackoffMs({}, 10, noJitter)).toBeLessThanOrEqual(60_000);
    });
});

describe('classifyTpm + estimateMinProcessedTokens (audit H3/R2-H4)', () => {
    it('only fails fast on a token-dimension body with est > limit', () => {
        const info = { limitTokens: 10000 };
        expect(classifyTpm('Rate limit exceeded for ...Tokens', info, 12000)).toBe(true);
        expect(classifyTpm('Rate limit exceeded for ...Requests', info, 12000)).toBe(false); // RPM dim
        expect(classifyTpm('Rate limit exceeded for ...Tokens', info, 5000)).toBe(false);    // fits
        expect(classifyTpm('tokens', {}, 12000)).toBe(false);                                // limit unknown
    });
    it('estimate INCLUDES the requested output budget (R2-H4)', () => {
        // tiny prompt, huge max_tokens → must exceed a 10k limit.
        const body = JSON.stringify({ messages: [{ content: 'hi' }], max_tokens: 64000 });
        const est = estimateMinProcessedTokens(body);
        expect(est).toBeGreaterThan(60000);
        expect(classifyTpm('...Tokens...', { limitTokens: 10000 }, est)).toBe(true);
    });
    it('handles max_completion_tokens + non-JSON body', () => {
        expect(estimateMinProcessedTokens(JSON.stringify({ max_completion_tokens: 8000 }))).toBeGreaterThanOrEqual(8000);
        expect(estimateMinProcessedTokens('not json' + 'x'.repeat(100))).toBeGreaterThan(0);
    });
});
