// @vitest-environment happy-dom
/**
 * abortableSleep (D6/G2) — resolves on timer OR abort, settles within a tick of
 * abort, clears the timer, never rejects.
 */
import { describe, it, expect, vi } from 'vitest';
import { abortableSleep } from '../src/utils/abortableSleep';

describe('abortableSleep', () => {
    it('resolves after the timer when not aborted', async () => {
        const start = await abortableSleep(5).then(() => 'done');
        expect(start).toBe('done');
    });

    it('resolves immediately when the signal is already aborted', async () => {
        const ac = new AbortController();
        ac.abort();
        await expect(abortableSleep(10_000, ac.signal)).resolves.toBeUndefined();
    });

    it('settles within a tick of a mid-sleep abort (does not wait out the timer)', async () => {
        vi.useFakeTimers();
        try {
            const ac = new AbortController();
            let settled = false;
            const p = abortableSleep(60_000, ac.signal).then(() => { settled = true; });
            ac.abort();
            await p;
            expect(settled).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it('clears the underlying timer on abort (no pending timer left)', async () => {
        vi.useFakeTimers();
        try {
            const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
            const ac = new AbortController();
            const p = abortableSleep(60_000, ac.signal);
            ac.abort();
            await p;
            expect(clearSpy).toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it('never rejects (abort path resolves)', async () => {
        const ac = new AbortController();
        const p = abortableSleep(1_000, ac.signal);
        ac.abort();
        await expect(p).resolves.toBeUndefined();
    });
});
