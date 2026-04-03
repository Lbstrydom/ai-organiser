import { chunkPlainTextAsync } from '../../utils/textChunker';
import type { IEmbeddingService } from '../embeddings/types';

const MOBILE_CHUNK_CAP = 200;

function cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0, magA = 0, magB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        magA += a[i] * a[i];
        magB += b[i] * b[i];
    }
    const mag = Math.sqrt(magA) * Math.sqrt(magB);
    return mag === 0 ? 0 : dot / mag;
}

export class AttachmentIndexService {
    private chunks: Array<{ text: string; embedding: number[] }> = [];
    private _isIndexing = false;
    private _isReady = false;
    private _chunkCount = 0;
    private _totalChunks = 0;
    private abortController: AbortController | null = null;

    constructor(private embeddingService: IEmbeddingService) {}

    /**
     * Chunk and embed a document. Progress callback fires per batch.
     * Returns chunk count on success, 0 on failure.
     * Single-flight: returns 0 if already indexing.
     */
    async indexDocument(
        text: string,
        _documentId: string,
        onProgress?: (percent: number) => void,
        signal?: AbortSignal,
    ): Promise<number> {
        if (this._isIndexing) return 0;
        this._isIndexing = true;
        this.abortController = new AbortController();

        try {
            const rawChunks = await chunkPlainTextAsync(text, {
                maxChars: 1000,
                overlapChars: 200,
            });

            // Mobile cap
            const { Platform } = await import('obsidian');
            const maxChunks = Platform.isMobile ? MOBILE_CHUNK_CAP : rawChunks.length;
            const cappedChunks = rawChunks.slice(0, maxChunks);

            this._totalChunks = cappedChunks.length;

            if (cappedChunks.length < 2) {
                this._isIndexing = false;
                return 0;
            }

            const BATCH_SIZE = 10;
            for (let i = 0; i < cappedChunks.length; i += BATCH_SIZE) {
                if (signal?.aborted || this.abortController.signal.aborted) break;

                const batch = cappedChunks.slice(i, i + BATCH_SIZE);
                await this.embedBatch(batch);
                onProgress?.(Math.round(((i + batch.length) / cappedChunks.length) * 100));
            }

            this._isReady = this.chunks.length > 0;
            return this.chunks.length;
        } finally {
            this._isIndexing = false;
        }
    }

    /**
     * Retrieve top-K chunks relevant to query.
     * Returns empty string if not ready or currently indexing.
     */
    async queryRelevantChunks(
        query: string,
        options?: { topK?: number; minSimilarity?: number; maxChars?: number },
    ): Promise<string> {
        if (!this._isReady || this._isIndexing) return '';

        const topK = options?.topK ?? 5;
        const minSim = options?.minSimilarity ?? 0.4;
        const maxChars = options?.maxChars ?? 5000;

        const queryResult = await this.embeddingService.generateEmbedding(query);
        if (!queryResult.success || !queryResult.embedding) return '';

        const queryEmbedding = queryResult.embedding;

        const scored = this.chunks.map(chunk => ({
            text: chunk.text,
            score: cosineSimilarity(queryEmbedding, chunk.embedding),
        }));

        const relevant = scored
            .filter(s => s.score >= minSim)
            .sort((a, b) => b.score - a.score)
            .slice(0, topK);

        let total = 0;
        const selected: string[] = [];
        for (const r of relevant) {
            if (total + r.text.length > maxChars) break;
            selected.push(r.text);
            total += r.text.length;
        }

        return selected.join('\n\n---\n\n');
    }

    private async embedBatch(batch: string[]): Promise<void> {
        try {
            const batchResult = await this.embeddingService.batchGenerateEmbeddings(batch);
            if (batchResult.success && batchResult.embeddings) {
                for (let j = 0; j < batch.length; j++) {
                    const embedding = batchResult.embeddings[j];
                    if (embedding) {
                        this.chunks.push({ text: batch[j], embedding });
                    }
                }
                this._chunkCount = this.chunks.length;
            }
        } catch {
            // Partial batch failure — continue with what we have
        }
    }

    get chunkCount(): number { return this._chunkCount; }
    get totalChunks(): number { return this._totalChunks; }
    get isReady(): boolean { return this._isReady; }
    get isIndexing(): boolean { return this._isIndexing; }
    get isPartial(): boolean { return this._chunkCount < this._totalChunks && this._chunkCount > 0; }

    dispose(): void {
        this.abortController?.abort();
        this.chunks = [];
        this._isReady = false;
        this._isIndexing = false;
        this._chunkCount = 0;
    }
}
