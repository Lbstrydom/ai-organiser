// @vitest-environment happy-dom
/**
 * GenericEmbeddingQueue (D3) — the generalized scheduler core. Text byte-parity is
 * pinned by the pre-existing `embeddingQueue.test.ts` (the wrapper is unchanged in
 * behavior); this suite covers the GENERIC seam: an image-task instantiation whose
 * queued tasks are POINTERS only (C25), keyed supersede, and backend mapping.
 */
import { describe, it, expect, vi } from 'vitest';
import { GenericEmbeddingQueue, EmbeddingQueue, type ChunkTask, type EmbeddingBackend } from '../src/services/vector/embeddingQueue';
import { ForegroundGate } from '../src/services/foregroundGate';
import { EmbeddingCooldown } from '../src/services/embeddings/embeddingCooldown';
import type { VisualPageTask } from '../src/services/visualEmbedding/types';

const flush = () => new Promise((r) => setTimeout(r, 0));

function visualTask(host: string, pdf: string, page: number): VisualPageTask {
    return { hostNotePath: host, pdfPath: pdf, pageNumber: page, contentHash: 'h1', pageText: `text p${page}` };
}

function makeQueue<TTask>(backend: EmbeddingBackend<TTask> | null) {
    const scheduled: Array<() => void> = [];
    const queue = new GenericEmbeddingQueue<TTask>({
        getBackend: () => backend,
        foregroundGate: new ForegroundGate(),
        cooldown: new EmbeddingCooldown(() => 0),
        schedule: (fn) => { scheduled.push(fn); return scheduled.length as never; },
        cancel: () => { /* noop */ },
    });
    return { queue, scheduled };
}

describe('GenericEmbeddingQueue — visual (pointer) instantiation', () => {
    it('passes the RAW pointer tasks to embedBatch — no rendered images in the queue (C25)', async () => {
        const seen: VisualPageTask[][] = [];
        const backend: EmbeddingBackend<VisualPageTask> = {
            maxBatchSize: 8,
            embedBatch: async (tasks) => {
                seen.push(tasks);
                return { success: true, embeddings: tasks.map(() => [0.1, 0.2]) };
            },
        };
        const { queue } = makeQueue(backend);
        const tasks = [visualTask('n.md', 'a.pdf', 1), visualTask('n.md', 'a.pdf', 3)];
        const persisted = vi.fn(async () => { /* persist */ });
        await queue.enqueueKeyed('n.md::vis::a.pdf', tasks, persisted);
        await flush();

        expect(seen).toHaveLength(1);
        expect(seen[0]).toEqual(tasks); // pointers verbatim — no dataUrl field anywhere
        expect(seen[0].every((t) => !('dataUrl' in t))).toBe(true);
        expect(persisted).toHaveBeenCalledWith([[0.1, 0.2], [0.1, 0.2]]);
    });

    it('re-enqueueing the same key SUPERSEDES the pending batch', async () => {
        let release!: () => void;
        const gateFirst = new Promise<void>((r) => { release = r; });
        const calls: number[][] = [];
        const backend: EmbeddingBackend<VisualPageTask> = {
            maxBatchSize: 1,
            embedBatch: async (tasks) => {
                calls.push(tasks.map((t) => t.pageNumber));
                await gateFirst;
                return { success: true, embeddings: tasks.map(() => [1]) };
            },
        };
        const { queue } = makeQueue(backend);
        const key = 'n.md::vis::a.pdf';
        const first = queue.enqueueKeyed(key, [visualTask('n.md', 'a.pdf', 1), visualTask('n.md', 'a.pdf', 2)], async () => {});
        await flush();
        // First chunk is in-flight; the rest of batch 1 is superseded by batch 2.
        const second = queue.enqueueKeyed(key, [visualTask('n.md', 'a.pdf', 9)], async () => {});
        release();
        await first;
        await second;
        const flat = calls.flat();
        expect(flat).toContain(9);
        expect(flat).not.toContain(2); // superseded chunk never dispatched
    });

    it('batches respect the backend maxBatchSize (one request per iteration)', async () => {
        const sizes: number[] = [];
        const backend: EmbeddingBackend<VisualPageTask> = {
            maxBatchSize: 2,
            embedBatch: async (tasks) => {
                sizes.push(tasks.length);
                return { success: true, embeddings: tasks.map(() => [1]) };
            },
        };
        const { queue } = makeQueue(backend);
        await queue.enqueueKeyed('k', [1, 2, 3, 4, 5].map((p) => visualTask('n.md', 'a.pdf', p)), async () => {});
        expect(sizes).toEqual([2, 2, 1]);
    });

    it('rate-limit result re-enqueues (transient) instead of dropping', async () => {
        let attempts = 0;
        const backend: EmbeddingBackend<VisualPageTask> = {
            maxBatchSize: 8,
            embedBatch: async (tasks) => {
                attempts++;
                if (attempts === 1) return { success: false, reason: 'rate-limit', error: 'rate-limited' };
                return { success: true, embeddings: tasks.map(() => [1]) };
            },
        };
        const { queue, scheduled } = makeQueue(backend);
        const persisted = vi.fn(async () => {});
        const completion = queue.enqueueKeyed('k', [visualTask('n.md', 'a.pdf', 1)], persisted);
        await flush();
        expect(attempts).toBe(1);
        expect(persisted).not.toHaveBeenCalled();
        scheduled.shift()?.(); // cooldown wake
        await completion;
        expect(attempts).toBe(2);
        expect(persisted).toHaveBeenCalledTimes(1);
    });
});

describe('EmbeddingQueue wrapper — text mapping parity (D3)', () => {
    it('maps ChunkTask.text into the embedding service call and keys batches by path', async () => {
        const texts: string[][] = [];
        const service = {
            maxBatchSize: 16,
            batchGenerateEmbeddings: async (ts: string[]) => {
                texts.push(ts);
                return { success: true, embeddings: ts.map((_, i) => [i]) };
            },
        };
        const queue = new EmbeddingQueue({
            getEmbeddingService: () => service as never,
            foregroundGate: new ForegroundGate(),
            cooldown: new EmbeddingCooldown(() => 0),
            schedule: (fn) => { fn(); return 0 as never; },
            cancel: () => { /* noop */ },
        });
        const tasks: ChunkTask[] = [
            { path: 'a.md', chunkIndex: 0, text: 'alpha' },
            { path: 'a.md', chunkIndex: 1, text: 'beta' },
        ];
        const persisted = vi.fn(async () => {});
        await queue.enqueue(tasks, persisted);
        expect(texts).toEqual([['alpha', 'beta']]);
        expect(persisted).toHaveBeenCalledWith([[0], [1]]);
    });
});
