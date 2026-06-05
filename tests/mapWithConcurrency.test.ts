import { describe, it, expect } from 'vitest';
import { mapWithConcurrency } from '../src/utils/mapWithConcurrency';

describe('mapWithConcurrency', () => {
    it('preserves result order', async () => {
        const out = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => n * 10);
        expect(out).toEqual([10, 20, 30, 40, 50]);
    });

    it('never exceeds the concurrency limit', async () => {
        let active = 0;
        let peak = 0;
        await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
            active++;
            peak = Math.max(peak, active);
            await new Promise((r) => setTimeout(r, 5));
            active--;
        });
        expect(peak).toBeLessThanOrEqual(4);
        expect(peak).toBeGreaterThan(1);
    });

    it('handles empty input', async () => {
        expect(await mapWithConcurrency([], 4, async (x) => x)).toEqual([]);
    });

    it('stops picking up new work after abort', async () => {
        const controller = new AbortController();
        let processed = 0;
        await mapWithConcurrency(Array.from({ length: 50 }, (_, i) => i), 2, async (i) => {
            processed++;
            if (i === 2) controller.abort();
            await new Promise((r) => setTimeout(r, 1));
            return i;
        }, controller.signal);
        // A few in-flight complete, but the bulk of queued work is dropped.
        expect(processed).toBeLessThan(50);
    });
});
