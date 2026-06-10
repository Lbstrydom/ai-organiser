/**
 * Visual-search lane contracts (plan Phase 5, C1/C25).
 *
 * One space, one backend, one dim. Cohere Embed v4 embeds TEXT and IMAGES into the SAME
 * vector space, so a text query → vector → cosine-search the page-image vectors. The service
 * therefore exposes BOTH sides (C1) — index (`embedImages`) and query (`embedTextQueries`) —
 * and `visualIndexService.search` owns query embedding so `ragService` never touches
 * backend/dim details (M7 ownership).
 */

export type VisualBackend = 'azure-cohere-v4' | 'cohere-native';

/**
 * A page to embed. Holds ONLY a lightweight pointer (C25) — NEVER the rendered data-URI.
 * The image is materialised inside the embed batch, embedded, then discarded immediately.
 */
export interface VisualPageTask {
    /** Host note that linked the PDF (vector key + lifecycle owner). */
    hostNotePath: string;
    /** Vault path of the source PDF. */
    pdfPath: string;
    /** 1-based page number. */
    pageNumber: number;
    /** Content hash of the PDF (cache identity; mtime/size insufficient across sync). */
    contentHash: string;
    /** Optional page text (carried for the RAG payload's text-degrade path). */
    pageText?: string;
}

/** A pointer the RAG payload builder materialises into an image at build time (C4). */
export interface PdfPageRef {
    pdfPath: string;
    page: number;
}

/** One float-vector batch result (index or query side). */
export interface EmbeddingBatch {
    /** Row-aligned vectors; each length === `dim`. */
    vectors: number[][];
}

import type { Result } from '../../core/result';

/** Symmetric embed contract — both sides share ONE space/backend/dim (C1). */
export interface IVisualEmbeddingService {
    /** Index side: page images → vectors (`input_type: 'search_document'`). */
    embedImages(images: Array<{ dataUrl: string }>): Promise<Result<EmbeddingBatch>>;
    /** Query side: text → vectors in the SAME space (`input_type: 'search_query'`). */
    embedTextQueries(queries: string[]): Promise<Result<EmbeddingBatch>>;
    readonly dim: number;
    readonly modelId: string;
    readonly backend: VisualBackend;
}

/** A retrieval hit from the visual index. */
export interface VisualHit {
    hostNotePath: string;
    pdfPath: string;
    page: number;
    score: number;
    pageText?: string;
    renderRef: PdfPageRef;
}

/** Retrieval scope shared by BOTH lanes (C4/H1) — folder-scoped RAG must not leak. */
export interface RetrievalScope {
    folderScope?: string;
    currentFile?: string;
}

// ── Limits (C2) — named constants ────────────────────────────────────────────
export const VISUAL_EMBED_BATCH_SIZE = 8;        // ≤ Cohere v4 per-request image max
export const MAX_PAGE_IMAGE_BYTES = 4_000_000;   // 4 MB per page data-URI
export const VISUAL_DIM_DEFAULT = 1536;          // Cohere v4 output_dimension (pinned)
