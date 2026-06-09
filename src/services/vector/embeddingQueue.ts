/**
 * Embedding queue (D4.4) — the real thundering-herd fix.
 *
 * A plugin-scoped singleton (constructed in `onload`, D0) that SERIALIZES all
 * embedding work behind a single cap-1 drain loop. Only one network request is
 * ever in flight, so the FIRST 429 sets the cooldown before the next request
 * fires — no parallel 429 storm.
 *
 * Work is enqueued as `ChunkTask`s (one note → many chunks). Each `enqueue`
 * call is a "batch" (one note); the drain dequeues exactly `maxBatchSize`
 * CHUNKS per iteration so **one iteration = exactly one provider request** — a
 * partial failure can never re-embed already-completed chunks (no
 * double-billing). On success the batch's `onBatchSuccess` persists the vectors
 * (it holds the note metadata); transient failures (`cooldown`/`rate-limit`)
 * re-enqueue; permanent errors drop+log.
 *
 * The drain yields while the foreground gate is active (one-shot `onIdle`) and
 * pauses while the cooldown is active (single scheduled wake).
 */

import type { ForegroundGate } from '../foregroundGate';
import type { EmbeddingCooldown } from '../embeddings/embeddingCooldown';
import type { IEmbeddingService, BatchEmbeddingResult } from '../embeddings/types';
import { logger } from '../../utils/logger';

/** A single chunk of a note to embed, keyed by `(path, chunkIndex)`. */
export interface ChunkTask {
    path: string;
    chunkIndex: number;
    /** The final embed string (metadata prefix + chunk content). */
    text: string;
}

/** Persists a note's embeddings (ordered by the enqueue task order). Supplied
 *  by the caller, which retains the note metadata. May throw — the queue
 *  isolates it. */
export type OnBatchSuccess = (embeddings: number[][]) => Promise<void>;

type ScheduleFn = (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
type CancelFn = (handle: ReturnType<typeof setTimeout>) => void;

/** Hard timeout on a single embedding request (H5). The cap-1 drain means one
 *  hung request would otherwise stall ALL indexing indefinitely. */
const BATCH_TIMEOUT_MS = 90_000;

export interface EmbeddingQueueDeps {
    /** Reaches the CURRENT embedding service indirectly so a settings-driven
     *  swap never leaves the queue holding a stale instance (D4.4 lifecycle). */
    getEmbeddingService: () => IEmbeddingService | null;
    foregroundGate: ForegroundGate;
    cooldown: EmbeddingCooldown;
    /** Injectable timer (tests). Defaults to global setTimeout/clearTimeout. */
    schedule?: ScheduleFn;
    cancel?: CancelFn;
}

interface Batch {
    path: string;
    onBatchSuccess: OnBatchSuccess;
    /** Filled by chunk position as embeddings arrive. */
    slots: (number[] | undefined)[];
    total: number;
    remaining: number;
    settled: boolean;
    completion: Promise<void>;
    resolve: () => void;
}

interface QueueItem {
    task: ChunkTask;
    batch: Batch;
    /** Position of this chunk within its batch (for ordered persistence). */
    slot: number;
}

const DEFAULT_BATCH_SIZE = 16;

// Init-race tolerance (live 2026-06-08): on plugin load a vault re-index can enqueue
// chunks BEFORE the async embedding service finishes initializing. Rather than drop
// every pending chunk on the first null, wait a bounded number of short intervals for
// the service to appear; only fail if it's genuinely absent (no key + no ONNX fallback).
const NULL_SERVICE_RETRY_MS = 1500;
// ~45s window for the embedding service to finish initializing. On a cold load the
// vector store + embedding service init can lag the first auto-index enqueue by tens
// of seconds (live: chunks still dropped under the old 12s bound), so wait generously
// before giving up — the chunks are small text payloads, cheap to hold.
const MAX_NULL_SERVICE_WAITS = 30;

export class EmbeddingQueue {
    private readonly pending: QueueItem[] = [];
    private readonly batches = new Map<string, Batch>();
    private readonly getEmbeddingService: () => IEmbeddingService | null;
    private readonly foregroundGate: ForegroundGate;
    private readonly cooldown: EmbeddingCooldown;
    private readonly schedule: ScheduleFn;
    private readonly cancel: CancelFn;

    private draining = false;
    private nullServiceWaits = 0;
    private wakeTimer: ReturnType<typeof setTimeout> | null = null;
    private idleUnsub: (() => void) | null = null;

    constructor(deps: EmbeddingQueueDeps) {
        this.getEmbeddingService = deps.getEmbeddingService;
        this.foregroundGate = deps.foregroundGate;
        this.cooldown = deps.cooldown;
        this.schedule = deps.schedule ?? ((fn, ms) => setTimeout(fn, ms));
        this.cancel = deps.cancel ?? ((h) => clearTimeout(h));
    }

    /**
     * Enqueue all of one note's chunks. Re-enqueueing a path SUPERSEDES its
     * prior pending batch (a re-saved note wins). Returns a promise that
     * resolves when THIS batch finishes draining (success or terminal failure)
     * — `rebuildVault` awaits it for a truthful "rebuild complete".
     */
    enqueue(tasks: ChunkTask[], onBatchSuccess: OnBatchSuccess): Promise<void> {
        if (tasks.length === 0) return Promise.resolve();
        // Invariant (M20): one enqueue = one note, so every task shares a path.
        // The sole caller (vectorStoreService.indexNote) guarantees this; guard
        // defensively so a mis-call can't silently mix notes into one batch.
        const path = tasks[0].path;
        const ownTasks = tasks.every((t) => t.path === path) ? tasks : tasks.filter((t) => t.path === path);
        if (ownTasks.length !== tasks.length) {
            logger.warn('Search', `Embedding queue: enqueue mixed paths for ${path}; ignoring foreign chunks`);
        }

        // Supersede any prior pending batch for this path.
        this.removePath(path, /*supersededByNewBatch*/ true);

        let resolve!: () => void;
        const completion = new Promise<void>((res) => { resolve = res; });
        const batch: Batch = {
            path,
            onBatchSuccess,
            slots: new Array<number[] | undefined>(ownTasks.length).fill(undefined),
            total: ownTasks.length,
            remaining: ownTasks.length,
            settled: false,
            completion,
            resolve,
        };
        this.batches.set(path, batch);
        ownTasks.forEach((task, slot) => this.pending.push({ task, batch, slot }));

        void this.kick();
        return completion;
    }

    /**
     * Remove a path's pending chunks (delete/rename — R2-M1). Settles its batch
     * so any awaiter unblocks. `superseded=true` when a newer batch replaces it.
     */
    removePath(path: string, superseded = false): void {
        const batch = this.batches.get(path);
        if (!batch) return;
        for (let i = this.pending.length - 1; i >= 0; i--) {
            if (this.pending[i].batch === batch) this.pending.splice(i, 1);
        }
        this.settle(batch);
        if (superseded) logger.debug('Search', `Embedding queue: superseded pending batch for ${path}`);
    }

    /** Pending chunk count (tests / diagnostics). */
    get pendingCount(): number {
        return this.pending.length;
    }

    dispose(): void {
        if (this.wakeTimer !== null) {
            this.cancel(this.wakeTimer);
            this.wakeTimer = null;
        }
        if (this.idleUnsub) {
            this.idleUnsub();
            this.idleUnsub = null;
        }
        // Settle anything still pending so awaiters never hang.
        for (const batch of this.batches.values()) this.settle(batch);
        this.pending.length = 0;
    }

    // ── Drain ───────────────────────────────────────────────────────────────

    /** Race an embedding request against a hard timeout (H5). Uses real timers
     *  (not the injected scheduler) — this liveness guard is internal, never
     *  test-controlled, and must not interleave with the wake scheduler. */
    private withTimeout(p: Promise<BatchEmbeddingResult>): Promise<BatchEmbeddingResult> {
        return new Promise<BatchEmbeddingResult>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('embedding request timed out')), BATCH_TIMEOUT_MS);
            p.then(
                (r) => { clearTimeout(timer); resolve(r); },
                (e) => { clearTimeout(timer); reject(e instanceof Error ? e : new Error(String(e))); },
            );
        });
    }

    private async kick(): Promise<void> {
        if (this.draining) return;
        this.draining = true;
        try {
            await this.drainOnce();
        } finally {
            this.draining = false;
        }
    }

    private async drainOnce(): Promise<void> {
        while (this.pending.length > 0) {
            if (this.foregroundGate.isActive()) {
                this.subscribeIdle();
                return;
            }
            if (this.cooldown.isCoolingDown()) {
                this.scheduleWake(this.cooldown.remainingMs());
                return;
            }
            const service = this.getEmbeddingService();
            if (!service) {
                // Init race: the service may still be initializing — wait a bounded
                // number of short intervals before giving up, so a reload's re-index
                // isn't dropped just because the queue drained a beat too early.
                if (this.nullServiceWaits < MAX_NULL_SERVICE_WAITS) {
                    this.nullServiceWaits++;
                    this.scheduleWake(NULL_SERVICE_RETRY_MS);
                    return;
                }
                this.failAllPending('no embedding service');
                this.nullServiceWaits = 0;
                return;
            }
            this.nullServiceWaits = 0; // service appeared — reset the init-race counter

            const batchSize = Math.max(1, service.maxBatchSize || DEFAULT_BATCH_SIZE);
            const items = this.takeNext(batchSize);
            if (items.length === 0) continue; // all dropped as stale/settled

            // H5/H6: bound the request with a timeout and a try/catch. A throw
            // (provider without a typed-result contract) or a hung request must
            // never strand the batch or stall the cap-1 drain forever — both
            // degrade to a dropped batch so the loop keeps making progress.
            let result: BatchEmbeddingResult;
            try {
                result = await this.withTimeout(service.batchGenerateEmbeddings(items.map((i) => i.task.text)));
            } catch (e) {
                this.dropItems(items, e instanceof Error ? e.message : 'embedding request failed');
                continue;
            }

            if (result.success && result.embeddings) {
                await this.applyEmbeddings(items, result.embeddings);
            } else if (result.reason === 'cooldown' || result.reason === 'rate-limit') {
                // Transient — restore at the FRONT and wait out the cooldown.
                this.pending.unshift(...items);
                this.scheduleWake(this.cooldown.remainingMs());
                return;
            } else {
                // Permanent — drop these chunks and fail their batches.
                this.dropItems(items, result.error ?? 'embedding error');
            }
        }
    }

    /** Take up to `n` still-live items off the front (skips settled batches). */
    private takeNext(n: number): QueueItem[] {
        const items: QueueItem[] = [];
        while (items.length < n && this.pending.length > 0) {
            const item = this.pending.shift()!;
            if (item.batch.settled) continue; // superseded/removed since enqueue
            items.push(item);
        }
        return items;
    }

    private async applyEmbeddings(items: QueueItem[], embeddings: number[][]): Promise<void> {
        const completed = new Set<Batch>();
        items.forEach((item, i) => {
            const batch = item.batch;
            if (batch.settled) return;
            batch.slots[item.slot] = embeddings[i] ?? [];
            batch.remaining--;
            if (batch.remaining <= 0) completed.add(batch);
        });

        for (const batch of completed) {
            if (batch.settled) continue;
            const ordered = batch.slots.map((e) => e ?? []);
            try {
                await batch.onBatchSuccess(ordered);
            } catch (e) {
                logger.error('Search', `Embedding queue: onBatchSuccess failed for ${batch.path}`, e);
            } finally {
                this.settle(batch);
            }
        }
    }

    private dropItems(items: QueueItem[], error: string): void {
        const affected = new Set<Batch>();
        for (const item of items) affected.add(item.batch);
        for (const batch of affected) {
            if (batch.settled) continue;
            logger.warn('Search', `Embedding queue: dropping ${batch.path} — ${error}`);
            // Drop the rest of this batch's pending chunks too — a partial note
            // must not be half-persisted.
            for (let i = this.pending.length - 1; i >= 0; i--) {
                if (this.pending[i].batch === batch) this.pending.splice(i, 1);
            }
            this.settle(batch);
        }
    }

    private failAllPending(reason: string): void {
        logger.warn('Search', `Embedding queue: failing ${this.pending.length} pending chunks — ${reason}`);
        const batches = new Set(this.pending.map((i) => i.batch));
        this.pending.length = 0;
        for (const batch of batches) this.settle(batch);
    }

    private settle(batch: Batch): void {
        if (batch.settled) return;
        batch.settled = true;
        this.batches.delete(batch.path);
        batch.resolve();
    }

    private subscribeIdle(): void {
        if (this.idleUnsub) return; // already waiting
        this.idleUnsub = this.foregroundGate.onIdle(() => {
            if (this.idleUnsub) {
                this.idleUnsub();
                this.idleUnsub = null;
            }
            void this.kick();
        });
    }

    private scheduleWake(ms: number): void {
        if (this.wakeTimer !== null) return; // already scheduled
        this.wakeTimer = this.schedule(() => {
            this.wakeTimer = null;
            void this.kick();
        }, Math.max(0, ms));
    }
}
