import { describe, it, expect } from 'vitest';
import { AzureRequestPacer, type PacerClock, type RateLimitLease, AZURE_PACER_MAX_QUEUE } from '../src/services/azure/azureRequestPacer';
import { AzureRateLimitError } from '../src/services/azure/azureRateLimitError';

/** Manually-advanced clock so the rolling window + pump timers are deterministic. */
class FakeClock implements PacerClock {
    t = 0;
    private timers: Array<{ id: number; fn: () => void; at: number }> = [];
    private nextId = 1;
    now(): number { return this.t; }
    setTimeout(fn: () => void, ms: number): unknown { const id = this.nextId++; this.timers.push({ id, fn, at: this.t + ms }); return id; }
    clearTimeout(h: unknown): void { this.timers = this.timers.filter(x => x.id !== h); }
    advance(ms: number): void {
        this.t += ms;
        const due = this.timers.filter(x => x.at <= this.t).sort((a, b) => a.at - b.at);
        this.timers = this.timers.filter(x => x.at > this.t);
        for (const x of due) x.fn();
    }
}
const flush = () => new Promise<void>(r => setTimeout(r, 0));

describe('AzureRequestPacer — concurrency gate', () => {
    it('caps in-flight at maxConcurrent; a release admits the next', async () => {
        const clock = new FakeClock();
        const p = new AzureRequestPacer({ maxConcurrent: 2, maxRpm: 100, maxQueue: 50 }, clock);
        const a = await p.acquire();
        const b = await p.acquire();
        expect(p.activeCount).toBe(2);
        let cLease: RateLimitLease | null = null;
        p.acquire().then(l => { cLease = l; });
        await flush();
        expect(cLease).toBeNull();         // queued — cap reached
        expect(p.queueLength).toBe(1);
        a.release();
        await flush();
        expect(cLease).not.toBeNull();     // admitted on release
        b.release(); (cLease as unknown as RateLimitLease).release();
    });
});

describe('AzureRequestPacer — RPM admission window (audit H1)', () => {
    it('the (maxRpm+1)-th start within 60s waits until the oldest ages out', async () => {
        const clock = new FakeClock();
        const p = new AzureRequestPacer({ maxConcurrent: 100, maxRpm: 2, maxQueue: 50 }, clock);
        await p.acquire(); await p.acquire();   // 2 starts at t=0 (held, not released)
        expect(p.recentStarts).toBe(2);
        let third: RateLimitLease | null = null;
        p.acquire().then(l => { third = l; });
        await flush();
        expect(third).toBeNull();               // RPM window full → blocked despite free concurrency
        clock.advance(60_001);                  // oldest start ages out
        await flush();
        expect(third).not.toBeNull();           // admitted by the window timer
    });
});

describe('AzureRequestPacer — cancellation (audit R2-H1)', () => {
    it('abort while QUEUED removes the waiter and rejects', async () => {
        const clock = new FakeClock();
        const p = new AzureRequestPacer({ maxConcurrent: 1, maxRpm: 100, maxQueue: 50 }, clock);
        await p.acquire();                      // hold the only slot
        const ctrl = new AbortController();
        const rejected = p.acquire(ctrl.signal).catch(e => e);
        await flush();
        expect(p.queueLength).toBe(1);
        ctrl.abort();
        const err = await rejected;
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toBe('Aborted');
        expect(p.queueLength).toBe(0);          // removed from the FIFO
    });
    it('rejects immediately if the signal is already aborted', async () => {
        const p = new AzureRequestPacer({ maxConcurrent: 1, maxRpm: 1, maxQueue: 1 }, new FakeClock());
        const ctrl = new AbortController(); ctrl.abort();
        await expect(p.acquire(ctrl.signal)).rejects.toThrow('Aborted');
    });
});

describe('AzureRequestPacer — deadlock-free + policy + queue', () => {
    it('a release-then-backoff lets a queued request proceed (deadlock-free)', async () => {
        const clock = new FakeClock();
        const p = new AzureRequestPacer({ maxConcurrent: 2, maxRpm: 100, maxQueue: 50 }, clock);
        const a = await p.acquire(); await p.acquire();
        let queued: RateLimitLease | null = null;
        p.acquire().then(l => { queued = l; });
        await flush();
        expect(queued).toBeNull();
        a.release();                            // the "backing-off" request releases its lease
        await flush();
        expect(queued).not.toBeNull();          // others proceed — no stall
    });
    it('in-place setPolicy preserves the window + active + FIFO (audit R2-M1)', async () => {
        const clock = new FakeClock();
        const p = new AzureRequestPacer({ maxConcurrent: 2, maxRpm: 100, maxQueue: 50 }, clock);
        await p.acquire(); await p.acquire();
        const startsBefore = p.recentStarts;
        let queued: RateLimitLease | null = null;
        p.acquire().then(l => { queued = l; });
        await flush();
        p.setPolicy({ maxConcurrent: 4, maxRpm: 100, maxQueue: 50 }); // raise cap → pump
        await flush();
        expect(queued).not.toBeNull();          // admitted without recreation
        expect(p.recentStarts).toBe(startsBefore + 1); // window preserved (not reset)
    });
    it('rejects with queue-full past maxQueue', async () => {
        const p = new AzureRequestPacer({ maxConcurrent: 1, maxRpm: 100, maxQueue: 1 }, new FakeClock());
        await p.acquire();                      // slot held
        p.acquire().catch(() => { /* the one allowed queue slot */ });
        await flush();
        await expect(p.acquire()).rejects.toBeInstanceOf(AzureRateLimitError);
    });
    it('dispose rejects pending waiters', async () => {
        const p = new AzureRequestPacer({ maxConcurrent: 1, maxRpm: 100, maxQueue: 50 }, new FakeClock());
        await p.acquire();
        const rejected = p.acquire().catch(e => e);
        await flush();
        p.dispose();
        const e = await rejected;
        expect(e.message).toMatch(/disposed/i);
        expect(e.name).toBe('AbortError'); // classified as a cancellation (audit M4)
    });
    it('AZURE_PACER_MAX_QUEUE is the exported constant default', () => {
        expect(AZURE_PACER_MAX_QUEUE).toBe(256);
    });
    it('normalizes a NaN/Infinity policy to safe values (audit M8/M21)', async () => {
        const p = new AzureRequestPacer({ maxConcurrent: NaN, maxRpm: Infinity, maxQueue: -5 } as never, new FakeClock());
        // NaN/Infinity/<1 → fall back to the base defaults (2/10/256), never NaN.
        const a = await p.acquire();
        expect(a).toBeTruthy();
        expect(p.activeCount).toBe(1);
    });
    it('a queued abort rejects with name AbortError (audit M4/M24)', async () => {
        const p = new AzureRequestPacer({ maxConcurrent: 1, maxRpm: 100, maxQueue: 50 }, new FakeClock());
        await p.acquire();
        const ctrl = new AbortController();
        const rejected: Promise<Error> = p.acquire(ctrl.signal).then(() => new Error('granted')).catch(e => e as Error);
        await flush();
        ctrl.abort();
        expect((await rejected).name).toBe('AbortError');
    });
    it('FIFO: a new arrival does NOT jump a queued waiter (audit H2)', async () => {
        const clock = new FakeClock();
        const p = new AzureRequestPacer({ maxConcurrent: 1, maxRpm: 100, maxQueue: 50 }, clock);
        const held = await p.acquire();
        const order: number[] = [];
        p.acquire().then(l => { order.push(1); l.release(); });
        await flush();
        // A second arrival must queue BEHIND the first even though a release is imminent.
        p.acquire().then(l => { order.push(2); l.release(); });
        await flush();
        held.release();
        await flush();
        expect(order).toEqual([1, 2]); // FIFO preserved
    });
});
