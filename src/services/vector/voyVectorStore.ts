/**
 * Voy WASM Vector Store Implementation
 * Production-grade vector storage with Voy (https://github.com/tantaraio/voy)
 * Features: Binary storage, fast search, persistence, low memory footprint
 */

import type { Voy as VoyClient } from 'voy-search';
// The `.wasm` asset is loaded as a Uint8Array via esbuild's `binary` loader
// (see esbuild.config.mjs). The `.js` file is the WASM glue module shipped by
// voy-search; we import it as a namespace and read `Voy` from it.
// @ts-expect-error - esbuild resolves .wasm imports via the binary loader
import voyWasm from 'voy-search/voy_search_bg.wasm';
// @ts-expect-error - JS glue module without its own .d.ts
import * as voyBg from 'voy-search/voy_search_bg.js';
import { App } from 'obsidian';
import { IVectorStore, VectorDocument, SearchResult, IndexMetadata, FileChangeTracker, INDEX_SCHEMA_VERSION } from './types';
import { cosineSimilarity } from './vectorMath';
import { logger } from '../../utils/logger';

const VoyClass = (voyBg as unknown as { Voy: typeof import('voy-search').Voy }).Voy;

let voyWasmInit: Promise<void> | null = null;

async function ensureVoyWasmReady(): Promise<void> {
    if (voyWasmInit) {
        return voyWasmInit;
    }

    voyWasmInit = (async () => {
        if (typeof voyBg.__wbg_set_wasm !== 'function') {
            throw new Error('Voy WASM glue is missing __wbg_set_wasm');
        }

        const result = await WebAssembly.instantiate(voyWasm, {
            './voy_search_bg.js': voyBg
        });

        // WebAssembly.instantiate with BufferSource returns WebAssemblyInstantiatedSource
        const instantiatedSource = result as unknown as WebAssembly.WebAssemblyInstantiatedSource;
        voyBg.__wbg_set_wasm(instantiatedSource.instance.exports);
    })();

    return voyWasmInit;
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
 * Voy WASM Vector Store
 * High-performance vector search using WebAssembly
 */
export class VoyVectorStore implements IVectorStore {
    private voy: VoyClient | null = null;
    private documents: Map<string, VectorDocument> = new Map();
    private fileChangeTracker: FileChangeTracker = new SimpleFileChangeTracker();
    private metadata: IndexMetadata = {
        totalDocuments: 0,
        totalNotes: 0,
        lastUpdated: Date.now(),
        embeddingDims: 1536, // Default OpenAI
        embeddingModel: 'unknown',
        version: INDEX_SCHEMA_VERSION
    };
    private app: App;
    private storagePath: string;

    constructor(app: App, embeddingDims: number = 1536, storagePath: string = '.ai-organiser/vector-index') {
        this.app = app;
        this.metadata.embeddingDims = embeddingDims;
        this.storagePath = storagePath;
    }

    /**
     * Initialize Voy instance
     */
    private async initializeVoy(): Promise<void> {
        if (this.voy) return;

        try {
            // Initialize Voy with embedding dimensions
            await ensureVoyWasmReady();
            this.voy = new VoyClass();
            logger.debug('Search', 'Voy vector store initialized');
        } catch (error) {
            logger.error('Search', 'Failed to initialize Voy:', error);
            throw new Error('Voy initialization failed: ' + (error instanceof Error ? error.message : String(error)));
        }
    }

    async upsert(documents: VectorDocument[]): Promise<void> {
        await this.initializeVoy();
        if (!this.voy) throw new Error('Voy not initialized');

        let allIndexed = true;
        for (const doc of documents) {
            // Store document metadata
            this.documents.set(doc.id, doc);

            // Add to Voy index if embedding exists
            if (doc.embedding && doc.embedding.length > 0) {
                try {
                    // Voy expects: Resource { embeddings: EmbeddedResource[] }
                    this.voy.add({
                        embeddings: [{
                            id: doc.id,
                            title: doc.metadata.title,
                            url: doc.filePath,
                            embeddings: doc.embedding
                        }]
                    });
                } catch (error) {
                    allIndexed = false;
                    logger.warn('Search', `Failed to add document ${doc.id} to Voy:`, error);
                }
            } else {
                // Document has no/empty embedding — it won't be searchable.
                // This happens when batchGenerateEmbeddings partially fails.
                allIndexed = false;
            }
        }

        this.metadata.totalDocuments = this.documents.size;
        this.metadata.totalNotes = new Set([...this.documents.values()].map(d => d.filePath)).size;
        this.metadata.lastUpdated = Date.now();
        // Lazy Migration Strategy:
        // Update version on partial updates so active users don't see "Index Outdated"
        // warnings constantly. The index may contain mixed schema versions (old files
        // vs newly-indexed files), which is acceptable for metadata additions but
        // would be dangerous for dimension changes. Dimension changes are self-protecting:
        // Voy WASM rejects vectors with mismatched dimensions at insert time.
        // Skip version stamp if any document failed to index or had empty embeddings.
        if (allIndexed) {
            this.metadata.version = INDEX_SCHEMA_VERSION;
        }
    }

    async remove(ids: string[]): Promise<void> {
        await this.initializeVoy();
        if (!this.voy) throw new Error('Voy not initialized');

        for (const id of ids) {
            const doc = this.documents.get(id);
            if (doc) {
                try {
                    // Voy remove expects Resource { embeddings: EmbeddedResource[] }
                    this.voy.remove({
                        embeddings: [{
                            id: id,
                            title: doc.metadata.title,
                            url: doc.filePath,
                            embeddings: doc.embedding || []
                        }]
                    });
                } catch (error) {
                    logger.warn('Search', `Failed to remove document ${id} from Voy:`, error);
                }
            }
            this.documents.delete(id);
        }

        this.metadata.totalDocuments = this.documents.size;
        this.metadata.lastUpdated = Date.now();
    }

    async search(queryVector: number[], topK: number = 5, filter?: (doc: VectorDocument) => boolean): Promise<SearchResult[]> {
        await this.initializeVoy();
        if (!this.voy) throw new Error('Voy not initialized');

        try {
            // Convert to Float32Array for Voy
            const queryFloat32 = new Float32Array(queryVector);

            // Over-fetch when filtering (Voy WASM has no built-in filter).
            // Cap must be high enough for folder-scoped searches where most
            // nearest neighbors may be outside the target folder.
            const fetchK = filter ? Math.min(topK * 3, 500) : topK;

            // Search using Voy
            const voyResults = this.voy.search(queryFloat32, fetchK);

            // Convert Voy results to SearchResult format
            let results: SearchResult[] = [];
            for (const voyResult of voyResults.neighbors) {
                const doc = this.documents.get(voyResult.id);
                if (doc) {
                    const score = doc.embedding?.length
                        ? cosineSimilarity(queryVector, doc.embedding)
                        : 0.5;
                    results.push({
                        document: doc,
                        score,
                        highlightedText: doc.content.substring(0, 200) + '...'
                    });
                }
            }

            // Apply filter post-search
            if (filter) {
                results = results.filter(r => filter(r.document));
            }

            return results.slice(0, topK);
        } catch (error) {
            logger.error('Search', 'Voy search error:', error);
            return [];
        }
    }

    async searchByContent(
        query: string,
        embeddingService: import('../embeddings/types').IEmbeddingService | null | undefined,
        topK: number = 5,
        filter?: (doc: VectorDocument) => boolean
    ): Promise<SearchResult[]> {
        try {
            if (!embeddingService || typeof embeddingService.generateEmbedding !== 'function') {
                logger.warn('Search', 'Invalid embedding service provided');
                return [];
            }

            const result = await embeddingService.generateEmbedding(query);
            if (!result.success || !result.embedding) {
                logger.warn('Search', 'Failed to generate query embedding');
                return [];
            }

            return this.search(result.embedding, topK, filter);
        } catch (error) {
            logger.error('Search', 'Error in semantic search:', error);
            return [];
        }
    }

    getDocument(id: string): Promise<VectorDocument | null> {
        return Promise.resolve(this.documents.get(id) || null);
    }

    getDocumentsByFile(filePath: string): Promise<VectorDocument[]> {
        return Promise.resolve([...this.documents.values()].filter(d => d.filePath === filePath));
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
        
        // Update document paths
        for (const doc of documents) {
            const oldId = doc.id;
            doc.filePath = newPath;
            doc.id = `${newPath}-${doc.chunkIndex}`;
            
            // Remove old and add new
            this.documents.delete(oldId);
            this.documents.set(doc.id, doc);
        }

        // Re-add to Voy with new IDs
        if (documents.length > 0) {
            await this.remove([...documents.map(d => `${oldPath}-${d.chunkIndex}`)]);
            await this.upsert(documents);
        }

        const existingHash = this.fileChangeTracker.getTrackedFiles().get(oldPath);
        if (existingHash) {
            this.fileChangeTracker.updateHash(newPath, existingHash);
        }
        this.fileChangeTracker.removeHash(oldPath);
    }

    getMetadata(): Promise<IndexMetadata> {
        return Promise.resolve({ ...this.metadata });
    }

    async clear(): Promise<void> {
        // Reinitialize Voy to clear all data
        this.voy = null;
        await this.initializeVoy();

        this.documents.clear();
        this.fileChangeTracker.clear();
        this.metadata = {
            totalDocuments: 0,
            totalNotes: 0,
            lastUpdated: Date.now(),
            embeddingDims: this.metadata.embeddingDims,
            embeddingModel: this.metadata.embeddingModel,
            version: INDEX_SCHEMA_VERSION
        };
    }

    async rebuild(documents: VectorDocument[]): Promise<void> {
        await this.clear();
        await this.upsert(documents);
    }

    async save(): Promise<void> {
        if (!this.voy) return;

        try {
            // Serialize Voy index
            const serialized = this.voy.serialize();
            
            // Save to vault storage
            const indexPath = `${this.storagePath}/index.voy`;
            const metadataPath = `${this.storagePath}/meta.json`;
            
            // Ensure directory exists
            const adapter = this.app.vault.adapter;
            const dirPath = this.storagePath;
            
            if (!(await adapter.exists(dirPath))) {
                await adapter.mkdir(dirPath);
            }

            // Write index data (Voy serializes to string)
            await adapter.write(indexPath, serialized);
            
            // Write metadata
            const metadataJson = JSON.stringify({
                metadata: this.metadata,
                documents: Array.from(this.documents.entries()),
                fileHashes: Array.from(this.fileChangeTracker.getTrackedFiles().entries())
            });
            await adapter.write(metadataPath, metadataJson);

            logger.debug('Search', 'Voy index saved successfully');
        } catch (error) {
            logger.error('Search', 'Failed to save Voy index:', error);
            throw error;
        }
    }

    async load(): Promise<void> {
        try {
            const adapter = this.app.vault.adapter;
            const indexPath = `${this.storagePath}/index.voy`;
            const metadataPath = `${this.storagePath}/meta.json`;
            const legacyMetadataPath = `${this.storagePath}/metadata.json`;

            // Check if index exists
            const hasMeta = await adapter.exists(metadataPath);
            const hasLegacyMeta = await adapter.exists(legacyMetadataPath);
            if (!(await adapter.exists(indexPath)) || (!hasMeta && !hasLegacyMeta)) {
                logger.debug('Search', 'No existing Voy index found');
                await this.initializeVoy();
                return;
            }

            // Load index data
            const serialized = await adapter.read(indexPath);
            
            // Load metadata
            const metadataJson = await adapter.read(hasMeta ? metadataPath : legacyMetadataPath);
            const data = JSON.parse(metadataJson);

            // Restore documents
            this.documents = new Map(data.documents);
            
            // Restore metadata
            this.metadata = data.metadata;
            
            // Restore change tracker
            const trackerData = new Map<string, string>(data.fileHashes || data.changeTracker || []);
            for (const [path, hash] of trackerData) {
                this.fileChangeTracker.updateHash(path, hash);
            }

            // Initialize WebAssembly before deserializing
            await ensureVoyWasmReady();
            
            // Deserialize Voy index
            this.voy = VoyClass.deserialize(serialized);

            logger.debug('Search', `Voy index loaded: ${this.metadata.totalDocuments} documents`);
        } catch (error) {
            logger.error('Search', 'Failed to load Voy index:', error);
            // Initialize empty if load fails
            await this.initializeVoy();
        }
    }

    async dispose(): Promise<void> {
        try {
            await this.save();
        } catch (error) {
            logger.error('Search', 'Error saving index during disposal:', error);
        }
        
        this.voy = null;
        this.documents.clear();
        this.fileChangeTracker.clear();
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
