/**
 * EmbeddingCooldown (D4.2) — Retry-After parsing (seconds + HTTP-date),
 * window set, escalation, decay, reset. Uses an injected clock.
 */
import { describe, it, expect } from 'vitest';
import { EmbeddingCooldown, parseRetryAfter } from '../src/services/embeddings/embeddingCooldown';

describe('parseRetryAfter', () => {
    it('parses delta-seconds', () => {
        expect(parseRetryAfter('120', 0)).toBe(120_000);
        expect(parseRetryAfter('  5 ', 0)).toBe(5_000);
    });
    it('parses HTTP-date relative to now', () => {
        const now = Date.parse('Wed, 21 Oct 2025 07:28:00 GMT');
        expect(parseRetryAfter('Wed, 21 Oct 2025 07:28:30 GMT', now)).toBe(30_000);
    });
    it('past HTTP-date → 0 (clock skew graceful)', () => {
        const now = Date.parse('Wed, 21 Oct 2025 07:28:00 GMT');
        expect(parseRetryAfter('Wed, 21 Oct 2025 07:27:00 GMT', now)).toBe(0);
    });
    it('absent / unparseable → 0', () => {
        expect(parseRetryAfter(undefined, 0)).toBe(0);
        expect(parseRetryAfter('', 0)).toBe(0);
        expect(parseRetryAfter('soon', 0)).toBe(0);
    });
});

describe('EmbeddingCooldown', () => {
    it('not cooling initially', () => {
        const cd = new EmbeddingCooldown(() => 0);
        expect(cd.isCoolingDown()).toBe(false);
        expect(cd.remainingMs()).toBe(0);
    });

    it('note429 with Retry-After sets the window', () => {
        let t = 1000;
        const cd = new EmbeddingCooldown(() => t);
        cd.note429('10'); // 10s
        expect(cd.isCoolingDown()).toBe(true);
        expect(cd.remainingMs()).toBe(10_000);
        t = 1000 + 10_000;
        expect(cd.isCoolingDown()).toBe(false);
    });

    it('uses the backoff floor when no Retry-After (≥ base)', () => {
        const cd = new EmbeddingCooldown(() => 0);
        cd.note429();
        expect(cd.remainingMs()).toBeGreaterThanOrEqual(2_000);
    });

    it('escalates the floor on consecutive 429s', () => {
        const cd = new EmbeddingCooldown(() => 0);
        cd.note429();
        const first = cd.remainingMs();
        cd.note429();
        const second = cd.remainingMs();
        expect(second).toBeGreaterThan(first);
    });

    it('honours a larger Retry-After over the backoff floor', () => {
        const cd = new EmbeddingCooldown(() => 0);
        cd.note429('120'); // 120s >> base backoff
        expect(cd.remainingMs()).toBe(120_000);
    });

    it('clamps an enormous Retry-After to the 10-minute ceiling (H7)', () => {
        const cd = new EmbeddingCooldown(() => 0);
        cd.note429('999999999'); // ~31 years in seconds
        expect(cd.remainingMs()).toBe(600_000);
    });

    it('reset clears the window and escalation', () => {
        let t = 0;
        const cd = new EmbeddingCooldown(() => t);
        cd.note429('30');
        cd.reset();
        expect(cd.isCoolingDown()).toBe(false);
        // escalation reset → next 429 floor is back to base
        cd.note429();
        expect(cd.remainingMs()).toBeLessThanOrEqual(4_000);
    });
});
