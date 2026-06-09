/**
 * EmbeddingQueue (D4.4) — cap-1 atomic drain, maxBatchSize-per-request,
 * transient re-enqueue (cooldown/rate-limit), permanent drop, foreground
 * yield + onIdle resume, path supersede, removePath, per-batch completion.
 */
import { describe, it, expect, vi } from 'vitest';
import { EmbeddingQueue, type ChunkTask } from '../src/services/vector/embeddingQueue';
import { ForegroundGate } from '../src/services/foregroundGate';
import { EmbeddingCooldown } from '../src/services/embeddings/embeddingCooldown';
import type { BatchEmbeddingResult } from '../src/services/embeddings/types';

const flush = () => new Promise((r) => setTimeout(r, 0));
const task = (path: string, chunkIndex: number, text: string): ChunkTask => ({ path, chunkIndex, text });

function mockService(maxBatchSize: number, impl?: (texts: string[]) => Promise<BatchEmbeddingResult>) {
    const batchGenerateEmbeddings = vi.fn(impl ?? (async (texts: string[]) => ({ success: true, embeddings: texts.map((_, i) => [i]) })));
    return { maxBatchSize, batchGenerateEmbeddings } as any;
}

interface Harness {
    queue: EmbeddingQueue;
    gate: ForegroundGate;
    cooldown: EmbeddingCooldown;
    runScheduled: () => void;
    setNow: (n: number) => void;
}

function harness(service: any): Harness {
    const gate = new ForegroundGate();
    let now = 0;
    const cooldown = new EmbeddingCooldown(() => now);
    const scheduled: Array<() => void> = [];
    const queue = new EmbeddingQueue({
        getEmbeddingService: () => service,
        foregroundGate: gate,
        cooldown,
        schedule: (fn) => { scheduled.push(fn); return scheduled.length as any; },
        cancel: () => { /* noop */ },
    });
    return {
        queue, gate, cooldown,
        runScheduled: () => { const fn = scheduled.shift(); fn?.(); },
        setNow: (n: number) => { now = n; },
    };
}

describe('EmbeddingQueue init-race tolerance (live 2026-06-08)', () => {
    function raceHarness(getSvc: () => unknown) {
        const scheduled: Array<() => void> = [];
        const queue = new EmbeddingQueue({
            getEmbeddingService: getSvc as never,
            foregroundGate: new ForegroundGate(),
            cooldown: new EmbeddingCooldown(() => 0),
            schedule: (fn: () => void) => { scheduled.push(fn); return scheduled.length as never; },
            cancel: () => { /* noop */ },
        });
        return { queue, scheduled };
    }

    it('waits (does NOT drop chunks) while the embedding service is still initializing, then drains when it appears', async () => {
        let svc: unknown = null; // not ready yet — the reload init race
        const { queue, scheduled } = raceHarness(() => svc);
        const onSuccess = vi.fn(async () => { /* persist */ });
        const completion = queue.enqueue([task('a', 0, 'x')], onSuccess);
        await flush();
        // First drain: service null → a wake is SCHEDULED, nothing failed/persisted.
        expect(scheduled.length).toBe(1);
        expect(onSuccess).not.toHaveBeenCalled();
        // Service finishes initializing; the scheduled wake drains successfully.
        svc = mockService(1);
        scheduled.shift()!();
        await completion;
        expect((svc as ReturnType<typeof mockService>).batchGenerateEmbeddings).toHaveBeenCalledTimes(1);
        expect(onSuccess).toHaveBeenCalledTimes(1);
    });

    it('eventually fails pending chunks if the service NEVER initializes (no key + no fallback)', async () => {
        const { queue, scheduled } = raceHarness(() => null);
        const onSuccess = vi.fn(async () => { /* persist */ });
        const completion = queue.enqueue([task('a', 0, 'x')], onSuccess);
        await flush();
        // Up to MAX_NULL_SERVICE_WAITS (8) wakes are scheduled, never persisting.
        for (let i = 0; i < 8; i++) {
            expect(scheduled.length).toBe(1);
            scheduled.shift()!(); // fire the wake → next (async) drain
            await flush();        // let the async drain re-schedule (or fail at the bound)
        }
        // The drain after the bound failed all pending → completion settled, nothing persisted.
        await completion;
        expect(onSuccess).not.toHaveBeenCalled();
        expect(scheduled.length).toBe(0); // no further wake after the final fail
    });
});

describe('EmbeddingQueue', () => {
    it('embeds one note in a single request and persists via onBatchSuccess', async () => {
        const svc = mockService(2);
        const { queue } = harness(svc);
        const onSuccess = vi.fn(async (_e: number[][]) => { /* persist */ });
        await queue.enqueue([task('a', 0, 'x'), task('a', 1, 'y')], onSuccess);
        expect(svc.batchGenerateEmbeddings).toHaveBeenCalledTimes(1); // 2 chunks, batch 2 → 1 request
        expect(onSuccess).toHaveBeenCalledTimes(1);
        expect(onSuccess.mock.calls[0][0]).toEqual([[0], [1]]);
    });

    it('splits into exactly maxBatchSize chunks per request (atomic)', async () => {
        const svc = mockService(2);
        const { queue } = harness(svc);
        const onSuccess = vi.fn(async (_e: number[][]) => { /* persist */ });
        await queue.enqueue([task('a', 0, 'x'), task('a', 1, 'y'), task('a', 2, 'z')], onSuccess);
        expect(svc.batchGenerateEmbeddings).toHaveBeenCalledTimes(2); // 3 chunks / batch 2 → 2 requests
        expect(svc.batchGenerateEmbeddings.mock.calls[0][0]).toHaveLength(2);
        expect(svc.batchGenerateEmbeddings.mock.calls[1][0]).toHaveLength(1);
        expect(onSuccess).toHaveBeenCalledTimes(1); // one note → one persist
        expect(onSuccess.mock.calls[0][0]).toHaveLength(3);
    });

    it('re-enqueues on rate-limit and resumes after cooldown', async () => {
        let calls = 0;
        const svc = mockService(4, async (texts) => {
            calls++;
            if (calls === 1) return { success: false, reason: 'rate-limit' };
            return { success: true, embeddings: texts.map(() => [1]) };
        });
        const h = harness(svc);
        // First call sets a cooldown so the queue waits before retrying.
        const onSuccess = vi.fn(async (_e: number[][]) => { /* persist */ });
        // Pre-arm the cooldown deterministically (first 429 sets it in real code).
        const completion = h.queue.enqueue([task('a', 0, 'x')], onSuccess);
        // emulate the 429 having set the cooldown window
        h.cooldown.note429('5');
        await flush();
        expect(calls).toBe(1);
        expect(onSuccess).not.toHaveBeenCalled();
        // cooldown elapses → scheduled wake fires → retry succeeds
        h.setNow(5000);
        h.runScheduled();
        await completion;
        expect(calls).toBe(2);
        expect(onSuccess).toHaveBeenCalledTimes(1);
    });

    it('drops + does NOT persist on a permanent error', async () => {
        const svc = mockService(4, async () => ({ success: false, reason: 'error', error: 'boom' }));
        const { queue } = harness(svc);
        const onSuccess = vi.fn(async (_e: number[][]) => { /* persist */ });
        await queue.enqueue([task('a', 0, 'x')], onSuccess); // completion still resolves
        expect(onSuccess).not.toHaveBeenCalled();
    });

    it('yields while the foreground gate is active, resumes on idle', async () => {
        const svc = mockService(4);
        const { queue, gate } = harness(svc);
        let release!: () => void;
        const held = new Promise<void>((r) => { release = r; });
        const op = gate.withForeground(() => held);
        const onSuccess = vi.fn(async (_e: number[][]) => { /* persist */ });
        const completion = queue.enqueue([task('a', 0, 'x')], onSuccess);
        await flush();
        expect(svc.batchGenerateEmbeddings).not.toHaveBeenCalled(); // yielded
        release();
        await op; // gate → idle → onIdle wakes the drain
        await completion;
        expect(svc.batchGenerateEmbeddings).toHaveBeenCalledTimes(1);
        expect(onSuccess).toHaveBeenCalledTimes(1);
    });

    it('a re-enqueued path supersedes its prior pending batch', async () => {
        const svc = mockService(4);
        const { queue, gate } = harness(svc);
        let release!: () => void;
        const held = new Promise<void>((r) => { release = r; });
        const op = gate.withForeground(() => held); // hold so nothing drains yet
        const s1 = vi.fn(async (_e: number[][]) => { /* persist */ });
        const s2 = vi.fn(async (_e: number[][]) => { /* persist */ });
        const c1 = queue.enqueue([task('a', 0, 'old')], s1);
        const c2 = queue.enqueue([task('a', 0, 'new')], s2); // same path → supersedes c1
        await flush();
        release();
        await op;
        await Promise.all([c1, c2]);
        expect(s1).not.toHaveBeenCalled(); // superseded
        expect(s2).toHaveBeenCalledTimes(1);
    });

    it('a thrown batch call drops the batch without stranding the awaiter (H6)', async () => {
        const svc = mockService(4, async () => { throw new Error('network down'); });
        const { queue } = harness(svc);
        const onSuccess = vi.fn(async (_e: number[][]) => { /* persist */ });
        // completion still resolves (drop path) — never hangs.
        await queue.enqueue([task('a', 0, 'x')], onSuccess);
        expect(onSuccess).not.toHaveBeenCalled();
        expect(queue.pendingCount).toBe(0);
    });

    it('ignores foreign-path chunks in a single enqueue (M20)', async () => {
        const svc = mockService(4);
        const { queue } = harness(svc);
        const onSuccess = vi.fn(async (_e: number[][]) => { /* persist */ });
        // tasks[0].path is 'a'; the 'b' chunk is foreign and dropped.
        await queue.enqueue([task('a', 0, 'x'), task('b', 0, 'y')], onSuccess);
        expect(onSuccess).toHaveBeenCalledTimes(1);
        expect(onSuccess.mock.calls[0][0]).toHaveLength(1); // only the 'a' chunk
    });

    it('removePath cancels pending chunks and resolves the batch', async () => {
        const svc = mockService(4);
        const { queue, gate } = harness(svc);
        let release!: () => void;
        const held = new Promise<void>((r) => { release = r; });
        const op = gate.withForeground(() => held);
        const onSuccess = vi.fn(async (_e: number[][]) => { /* persist */ });
        const completion = queue.enqueue([task('a', 0, 'x')], onSuccess);
        queue.removePath('a');
        await completion; // resolved by removePath
        release();
        await op;
        await flush();
        expect(onSuccess).not.toHaveBeenCalled();
        expect(queue.pendingCount).toBe(0);
    });
});
