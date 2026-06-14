/**
 * Visual embed backend + embedder provider (plan Phase 6 — C25/C2-M5/CA1).
 *
 * The injected `EmbeddingBackend<VisualPageTask>` for the generic queue: each
 * `embedBatch` call opens POOLED PDF handles (CA1 — ref-counted, TTL'd, so sequential
 * batches of one PDF re-use one parse), renders ONLY the batch's pages, embeds them via
 * the live backend, and discards the images immediately (C25 — queued tasks are pointers;
 * images never sit in the queue).
 *
 * Rate limiting (C2/M5): the Azure backend leases the per-deployment pacer bucket
 * (`buildAzureClaudeDeploymentKey` — shares the Phase-2 `azurePerDeploymentRpm` budget for
 * e.g. `embed-v-4-0`); the Cohere-native backend gets its OWN dual-gate pacer at
 * `cohereVisualRpm`. A 429 sets the dedicated VISUAL cooldown (separate from text) and
 * re-enqueues via the queue's transient path.
 */
import type { App } from 'obsidian';
import { TFile as ObsidianTFile } from 'obsidian';
import type { BatchEmbeddingResult } from '../embeddings/types';
import type { EmbeddingCooldown } from '../embeddings/embeddingCooldown';
import type { EmbeddingBackend } from '../vector/embeddingQueue';
import type { PdfHandlePool } from '../pdf/pdfHandlePool';
import { withAzureLease, buildAzureClaudeDeploymentKey, AzureRequestPacer } from '../azure/azureRequestPacer';
import { CohereV4VisualEmbeddingService } from './cohereV4VisualEmbeddingService';
import type { IVisualEmbeddingService, VisualPageTask } from './types';
import { VISUAL_EMBED_BATCH_SIZE } from './types';
import { selectVisualBackend } from './visualBackendResolver';
import { logger } from '../../utils/logger';
import type AIOrganiserPlugin from '../../main';

export interface VisualEmbedderProvider {
    /** Resolve the CURRENT embedder (re-selected per call — settings changes apply live).
     *  Null when the lane is unavailable (probe pending / no key). */
    getEmbedder: () => Promise<IVisualEmbeddingService | null>;
    dispose(): void;
}

/**
 * Build the embedder provider: wraps `selectVisualBackend` and injects the correct
 * pacing lease per backend.
 */
export function createVisualEmbedderProvider(plugin: AIOrganiserPlugin): VisualEmbedderProvider {
    let nativePacer: AzureRequestPacer | null = null;

    return {
        getEmbedder: async () => {
            const sel = await selectVisualBackend(plugin);
            if (sel.kind !== 'ready') return null;
            const cfg = { ...sel.cfg };
            if (cfg.backend === 'azure-cohere-v4' && cfg.endpoint) {
                const key = buildAzureClaudeDeploymentKey(cfg.endpoint, cfg.modelId);
                cfg.lease = (fn) => withAzureLease(key, undefined, fn);
            } else {
                if (!nativePacer) {
                    nativePacer = new AzureRequestPacer({
                        maxConcurrent: 1,
                        maxRpm: Math.max(1, plugin.settings.cohereVisualRpm),
                        maxQueue: 64,
                    });
                }
                const pacer = nativePacer;
                cfg.lease = async <T>(fn: () => Promise<T>): Promise<T> => {
                    const lease = await pacer.acquire();
                    try { return await fn(); } finally { lease.release(); }
                };
            }
            return new CohereV4VisualEmbeddingService(cfg);
        },
        dispose: () => {
            nativePacer?.dispose();
            nativePacer = null;
        },
    };
}

export interface VisualEmbedBackendDeps {
    app: App;
    pool: PdfHandlePool;
    provider: VisualEmbedderProvider;
    /** The DEDICATED visual cooldown bucket (separate from the text lane's). */
    visualCooldown: EmbeddingCooldown;
}

/**
 * The queue backend. Row-aligned contract: returns one vector per task; a page whose
 * render fails gets `[]` (the persist step filters empties) — a single bad page never
 * fails its siblings.
 */
export function createVisualEmbedBackend(deps: VisualEmbedBackendDeps): EmbeddingBackend<VisualPageTask> {
    return {
        maxBatchSize: VISUAL_EMBED_BATCH_SIZE,
        embedBatch: async (tasks: VisualPageTask[]): Promise<BatchEmbeddingResult> => {
            const embedder = await deps.provider.getEmbedder();
            if (!embedder) {
                return { success: false, reason: 'error', error: 'visual backend unavailable' };
            }

            // Render lazily (C25): pooled handle per distinct pdf, batch pages only.
            const dataUrls: (string | null)[] = new Array(tasks.length).fill(null);
            const byPdf = new Map<string, number[]>();
            tasks.forEach((t, i) => {
                const list = byPdf.get(t.pdfPath) ?? [];
                list.push(i);
                byPdf.set(t.pdfPath, list);
            });

            for (const [pdfPath, idxs] of byPdf) {
                const file = deps.app.vault.getAbstractFileByPath(pdfPath);
                if (!(file instanceof ObsidianTFile)) continue; // deleted since enqueue → [] rows
                const lease = await deps.pool.lease(file);
                if (!lease.ok) {
                    logger.warn('Search', `Visual embed: cannot open ${pdfPath}: ${lease.error}`);
                    continue;
                }
                try {
                    for (const i of idxs) {
                        const r = await lease.value.handle.renderPageImage(tasks[i].pageNumber);
                        if (r.ok) dataUrls[i] = r.value;
                        else logger.warn('Search', `Visual embed: render failed ${pdfPath}#${tasks[i].pageNumber}: ${r.error}`);
                    }
                } finally {
                    lease.value.release();
                }
            }

            const renderedIdx = dataUrls.map((u, i) => (u ? i : -1)).filter((i) => i >= 0);
            if (renderedIdx.length === 0) {
                return { success: false, reason: 'error', error: 'no pages rendered' };
            }

            const result = await embedder.embedImages(renderedIdx.map((i) => ({ dataUrl: dataUrls[i]! })));
            if (!result.ok) {
                if (result.error === 'rate-limited') {
                    deps.visualCooldown.note429(null);
                    return { success: false, reason: 'rate-limit', error: result.error };
                }
                return { success: false, reason: 'error', error: result.error };
            }

            // Row-align: [] for unrendered pages (filtered at persist).
            const embeddings: number[][] = tasks.map(() => []);
            renderedIdx.forEach((taskIdx, j) => { embeddings[taskIdx] = result.value.vectors[j] ?? []; });
            return { success: true, embeddings };
        },
    };
}
