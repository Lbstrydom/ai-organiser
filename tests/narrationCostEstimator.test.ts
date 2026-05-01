/**
 * Cost estimator tests — char count, USD/EUR, chunk count, edge cases.
 */

import { describe, it, expect } from 'vitest';
import { estimateNarrationCost } from '../src/services/audioNarration/narrationCostEstimator';

describe('estimateNarrationCost', () => {
    it('charCount equals input length', () => {
        const text = 'Hello world.';
        const r = estimateNarrationCost(text, 'gemini', 'Charon');
        expect(r.charCount).toBe(text.length);
    });

    it('chunkCount is at least 1 for non-empty input', () => {
        const r = estimateNarrationCost('short', 'gemini', 'Charon');
        expect(r.chunkCount).toBeGreaterThanOrEqual(1);
    });

    it('chunkCount grows with longer input', () => {
        const short = estimateNarrationCost('a', 'gemini', 'Charon');
        const long = estimateNarrationCost('a'.repeat(5000), 'gemini', 'Charon');
        expect(long.chunkCount).toBeGreaterThanOrEqual(short.chunkCount);
    });

    it('USD scales linearly with chars', () => {
        const oneM = 'a'.repeat(1_000_000);
        const r = estimateNarrationCost(oneM, 'gemini', 'Charon');
        expect(r.estUsd).toBeCloseTo(15.00, 2);  // gemini @ $15/M chars
    });

    it('EUR is roughly 0.92 of USD', () => {
        const r = estimateNarrationCost('a'.repeat(1_000_000), 'gemini', 'Charon');
        const ratio = r.estEur / r.estUsd;
        expect(ratio).toBeCloseTo(0.92, 2);
    });

    it('estDurationSec scales with chars', () => {
        const r = estimateNarrationCost('a'.repeat(140), 'gemini', 'Charon');
        expect(r.estDurationSec).toBe(10);  // 140 / 14 = 10s
    });

    it('preserves voice and providerId in result', () => {
        const r = estimateNarrationCost('text', 'gemini', 'Puck');
        expect(r.providerId).toBe('gemini');
        expect(r.voice).toBe('Puck');
    });

    it('throws on unknown provider', () => {
        expect(() => estimateNarrationCost('text', 'unknown' as 'gemini', 'Charon')).toThrow();
    });
});
