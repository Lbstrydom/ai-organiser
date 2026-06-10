/**
 * Visual retrieval service (plan Phase 7 / C1 / C4-M7) — the QUERY side of the visual lane.
 *
 * OWNS query embedding (C1): Cohere Embed v4 maps text and images into the SAME vector
 * space, so a text query embeds via `embedTextQueries` on the SELECTED backend and
 * cosine-searches the page-image vectors. `ragService` never touches backend/dim details
 * (M7 ownership) — it only consumes `VisualHit[]`.
 *
 * Scope (C19) is applied by the REPOSITORY pre-topK (registry-eligible hosts → exact
 * ranking); this service just threads it through.
 *
 * Graceful by contract (D12): disabled feature / missing lane / unavailable backend /
 * needs-rebuild / embed failure all yield `ok([])` with a debug log — visual retrieval
 * must never break text RAG.
 */
import type { Result } from '../../core/result';
import { ok } from '../../core/result';
import { logger } from '../../utils/logger';
import type { VisualIndexRepository } from './visualIndexRepository';
import type { IVisualEmbeddingService, RetrievalScope, VisualHit } from './types';

export interface VisualRetrievalDeps {
    /** Live lane state — null when the visual lane is down (read per call, never cached). */
    getRepository: () => VisualIndexRepository | null;
    /** The DP-2-selected embedder (per call — settings changes apply live). */
    getEmbedder: () => Promise<IVisualEmbeddingService | null>;
    /** Feature self-gate. */
    isEnabled: () => boolean;
}

export class VisualRetrievalService {
    constructor(private readonly deps: VisualRetrievalDeps) {}

    /** Top-`limit` visual hits for a text query within `scope`. Never throws; never errs —
     *  visual context is strictly additive to text RAG (empty on any unavailability). */
    async search(query: string, scope: RetrievalScope, limit: number): Promise<Result<VisualHit[]>> {
        try {
            if (!this.deps.isEnabled()) return ok([]);
            const repository = this.deps.getRepository();
            if (!repository || repository.needsRebuild) return ok([]);
            const trimmed = query.trim();
            if (!trimmed || limit <= 0) return ok([]);

            const embedder = await this.deps.getEmbedder();
            if (!embedder) {
                logger.debug('Search', 'Visual retrieval skipped: no backend available');
                return ok([]);
            }
            const embedded = await embedder.embedTextQueries([trimmed]);
            if (!embedded.ok || !embedded.value.vectors[0]) {
                logger.debug('Search', `Visual retrieval skipped: query embed failed (${embedded.ok ? 'empty' : embedded.error})`);
                return ok([]);
            }
            const hits = await repository.searchByVector(embedded.value.vectors[0], scope, limit);
            if (!hits.ok) {
                logger.debug('Search', `Visual retrieval skipped: ${hits.error}`);
                return ok([]);
            }
            return hits;
        } catch (e) {
            logger.warn('Search', `Visual retrieval failed: ${e instanceof Error ? e.message : String(e)}`);
            return ok([]);
        }
    }
}
