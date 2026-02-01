/**
 * Simple In-Memory Vector Store Implementation
 * Phase 4.2 baseline implementation for semantic search
 * Can be upgraded to Voy WASM later for better performance
 */

import { IVectorStore, VectorDocument, SearchResult, IndexMetadata, FileChangeTracker } from './types';

/**
 * Calculate cosine similarity between two vectors
 */
function cosineSimilarity(vecA: number[], vecB: number[]): number {
    if (vecA.length !== vecB.length) return 0;

    let dotProduct = 0;
    let magnitudeA = 0;
    let magnitudeB = 0;

    for (let i = 0; i < vecA.length; i++) {
        dotProduct += vecA[i] * vecB[i];
        magnitudeA += vecA[i] * vecA[i];
        magnitudeB += vecB[i] * vecB[i];
    }

    magnitudeA = Math.sqrt(magnitudeA);
    magnitudeB = Math.sqrt(magnitudeB);

    if (magnitudeA === 0 || magnitudeB === 0) return 0;
    return dotProduct / (magnitudeA * magnitudeB);
}

/**
 * Simple FileChangeTracker implementation
 */
class SimpleFileChangeTracker implements FileChangeTracker {
    private hashes: Map<string, string> = new Map();

    hasChanged(filePath: string, contentHash: string): boolean {
        const storedHash = this.hashes.get(filePath);
        return storedHash !== contentHash;
    }

    updateHash(filePath: string, contentHash: string): void {
        this.hashes.set(filePath, contentHash);
    }

    removeHash(filePath: string): void {
        this.hashes.delete(filePath);
    }

    getTrackedFiles(): Map<string, string> {
        return new Map(this.hashes);
    }

    clear(): void {
        this.hashes.clear();
    }
}

/**
 * Simple in-memory vector store
 * Stores documents and embeddings in memory with cosine similarity search
 */
export class SimpleVectorStore implements IVectorStore {
    private documents: Map<string, VectorDocument> = new Map();
    private embeddings: Map<string, number[]> = new Map();
    private fileChangeTracker: FileChangeTracker = new SimpleFileChangeTracker();
    private metadata: IndexMetadata = {
        totalDocuments: 0,
        totalNotes: 0,
        lastUpdated: Date.now(),
        embeddingDims: 1536, // Default OpenAI
        embeddingModel: 'unknown',
        version: '1.0.0'
    };

    async upsert(documents: VectorDocument[]): Promise<void> {
        for (const doc of documents) {
            this.documents.set(doc.id, doc);
            if (doc.embedding) {
                this.embeddings.set(doc.id, doc.embedding);
            }
        }
        this.metadata.totalDocuments = this.documents.size;
        this.metadata.totalNotes = new Set([...this.documents.values()].map(d => d.filePath)).size;
        this.metadata.lastUpdated = Date.now();
    }

    async remove(ids: string[]): Promise<void> {
        for (const id of ids) {
            this.documents.delete(id);
            this.embeddings.delete(id);
        }
        this.metadata.totalDocuments = this.documents.size;
        this.metadata.lastUpdated = Date.now();
    }

    async search(queryVector: number[], topK: number = 5, filter?: (doc: VectorDocument) => boolean): Promise<SearchResult[]> {
        const results: Array<{ id: string; score: number }> = [];

        for (const [id, embedding] of this.embeddings.entries()) {
            // Skip docs that don't pass filter before computing similarity
            if (filter) {
                const doc = this.documents.get(id);
                if (!doc || !filter(doc)) continue;
            }
            const score = cosineSimilarity(queryVector, embedding);
            if (score > 0) {
                results.push({ id, score });
            }
        }

        // Sort by similarity score descending
        results.sort((a, b) => b.score - a.score);

        // Return top K results
        return results.slice(0, topK).map(r => ({
            document: this.documents.get(r.id)!,
            score: r.score,
            highlightedText: this.documents.get(r.id)?.content.substring(0, 200) || ''
        }));
    }

    async searchByContent(
        query: string,
        embeddingService: any,
        topK: number = 5,
        filter?: (doc: VectorDocument) => boolean
    ): Promise<SearchResult[]> {
        try {
            if (!embeddingService || typeof embeddingService.generateEmbedding !== 'function') {
                console.warn('[SimpleVectorStore] Invalid embedding service provided');
                return [];
            }

            // Generate embedding for the query
            const result = await embeddingService.generateEmbedding(query);
            if (!result.success || !result.embedding) {
                console.warn('[SimpleVectorStore] Failed to generate query embedding');
                return [];
            }

            // Use the vector search
            return this.search(result.embedding, topK, filter);
        } catch (error) {
            console.error('[SimpleVectorStore] Error in semantic search:', error);
            return [];
        }
    }

    async getDocument(id: string): Promise<VectorDocument | null> {
        return this.documents.get(id) || null;
    }

    async getDocumentsByFile(filePath: string): Promise<VectorDocument[]> {
        return [...this.documents.values()].filter(d => d.filePath === filePath);
    }

    async removeFile(filePath: string): Promise<void> {
        const ids = [...this.documents.entries()]
            .filter(([, doc]) => doc.filePath === filePath)
            .map(([id]) => id);
        await this.remove(ids);
        this.fileChangeTracker.removeHash(filePath);
    }

    async renameFile(oldPath: string, newPath: string): Promise<void> {
        const documents = await this.getDocumentsByFile(oldPath);
        for (const doc of documents) {
            doc.filePath = newPath;
            doc.id = `${newPath}-${doc.chunkIndex}`;
        }
        await this.upsert(documents);
        const existingHash = this.fileChangeTracker.getTrackedFiles().get(oldPath);
        if (existingHash) {
            this.fileChangeTracker.updateHash(newPath, existingHash);
        }
        this.fileChangeTracker.removeHash(oldPath);
    }

    async getMetadata(): Promise<IndexMetadata> {
        return { ...this.metadata };
    }

    async clear(): Promise<void> {
        this.documents.clear();
        this.embeddings.clear();
        this.fileChangeTracker.clear();
        this.metadata.totalDocuments = 0;
        this.metadata.totalNotes = 0;
        this.metadata.lastUpdated = Date.now();
    }

    async rebuild(documents: VectorDocument[]): Promise<void> {
        await this.clear();
        await this.upsert(documents);
    }

    async save(): Promise<void> {
        // In-memory store doesn't need to save
        // TODO: Add persistence if needed
    }

    async load(): Promise<void> {
        // In-memory store doesn't need to load
        // TODO: Add persistence if needed
    }

    async dispose(): Promise<void> {
        this.clear();
    }

    /**
     * Get file change tracker
     */
    public getFileChangeTracker(): FileChangeTracker {
        return this.fileChangeTracker;
    }

    /**
     * Set embedding metadata
     */
    public setEmbeddingMetadata(dims: number, model: string): void {
        this.metadata.embeddingDims = dims;
        this.metadata.embeddingModel = model;
    }
}
