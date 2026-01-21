/**
 * Voy WASM Vector Store Implementation
 * Production-grade vector storage with Voy (https://github.com/tantaraio/voy)
 * Features: Binary storage, fast search, persistence, low memory footprint
 */

import { Voy as VoyClient } from 'voy-search';
import { App } from 'obsidian';
import { IVectorStore, VectorDocument, SearchResult, IndexMetadata, FileChangeTracker } from './types';

/**
 * Simple string hashing for change detection
 */
function hashString(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash).toString(16);
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
        version: '1.0.0'
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
            this.voy = new VoyClient();
            console.log('Voy vector store initialized');
        } catch (error) {
            console.error('Failed to initialize Voy:', error);
            throw new Error('Voy initialization failed: ' + (error as any).message);
        }
    }

    async upsert(documents: VectorDocument[]): Promise<void> {
        await this.initializeVoy();
        if (!this.voy) throw new Error('Voy not initialized');

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
                    console.warn(`Failed to add document ${doc.id} to Voy:`, error);
                }
            }
        }

        this.metadata.totalDocuments = this.documents.size;
        this.metadata.totalNotes = new Set([...this.documents.values()].map(d => d.filePath)).size;
        this.metadata.lastUpdated = Date.now();
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
                    console.warn(`Failed to remove document ${id} from Voy:`, error);
                }
            }
            this.documents.delete(id);
        }

        this.metadata.totalDocuments = this.documents.size;
        this.metadata.lastUpdated = Date.now();
    }

    async search(queryVector: number[], topK: number = 5): Promise<SearchResult[]> {
        await this.initializeVoy();
        if (!this.voy) throw new Error('Voy not initialized');

        try {
            // Convert to Float32Array for Voy
            const queryFloat32 = new Float32Array(queryVector);
            
            // Search using Voy
            const voyResults = this.voy.search(queryFloat32, topK);

            // Convert Voy results to SearchResult format
            const results: SearchResult[] = [];
            for (const voyResult of voyResults.neighbors) {
                const doc = this.documents.get(voyResult.id);
                if (doc) {
                    results.push({
                        document: doc,
                        score: 0.9, // Voy doesn't return distance in v0.6, use placeholder
                        highlightedText: doc.content.substring(0, 200) + '...'
                    });
                }
            }

            return results;
        } catch (error) {
            console.error('Voy search error:', error);
            return [];
        }
    }

    async searchByContent(
        query: string,
        embeddingService: any,
        topK: number = 5
    ): Promise<SearchResult[]> {
        try {
            if (!embeddingService || typeof embeddingService.generateEmbedding !== 'function') {
                console.warn('Invalid embedding service provided');
                return [];
            }

            const result = await embeddingService.generateEmbedding(query);
            if (!result.success || !result.embedding) {
                console.warn('Failed to generate query embedding');
                return [];
            }

            return this.search(result.embedding, topK);
        } catch (error) {
            console.error('Error in semantic search:', error);
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

        this.fileChangeTracker.updateHash(newPath, hashString(''));
    }

    async getMetadata(): Promise<IndexMetadata> {
        return { ...this.metadata };
    }

    async clear(): Promise<void> {
        // Reinitialize Voy to clear all data
        this.voy = null;
        await this.initializeVoy();
        
        this.documents.clear();
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
        if (!this.voy) return;

        try {
            // Serialize Voy index
            const serialized = this.voy.serialize();
            
            // Save to vault storage
            const indexPath = `${this.storagePath}/index.voy`;
            const metadataPath = `${this.storagePath}/metadata.json`;
            
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
                changeTracker: Array.from(this.fileChangeTracker.getTrackedFiles().entries())
            });
            await adapter.write(metadataPath, metadataJson);

            console.log('Voy index saved successfully');
        } catch (error) {
            console.error('Failed to save Voy index:', error);
            throw error;
        }
    }

    async load(): Promise<void> {
        try {
            const adapter = this.app.vault.adapter;
            const indexPath = `${this.storagePath}/index.voy`;
            const metadataPath = `${this.storagePath}/metadata.json`;

            // Check if index exists
            if (!(await adapter.exists(indexPath)) || !(await adapter.exists(metadataPath))) {
                console.log('No existing Voy index found');
                await this.initializeVoy();
                return;
            }

            // Load index data
            const serialized = await adapter.read(indexPath);
            
            // Load metadata
            const metadataJson = await adapter.read(metadataPath);
            const data = JSON.parse(metadataJson);

            // Restore documents
            this.documents = new Map(data.documents);
            
            // Restore metadata
            this.metadata = data.metadata;
            
            // Restore change tracker
            const trackerData = new Map<string, string>(data.changeTracker);
            for (const [path, hash] of trackerData) {
                this.fileChangeTracker.updateHash(path, hash as string);
            }

            // Deserialize Voy index
            this.voy = VoyClient.deserialize(serialized);

            console.log(`Voy index loaded: ${this.metadata.totalDocuments} documents`);
        } catch (error) {
            console.error('Failed to load Voy index:', error);
            // Initialize empty if load fails
            await this.initializeVoy();
        }
    }

    async dispose(): Promise<void> {
        try {
            await this.save();
        } catch (error) {
            console.error('Error saving index during disposal:', error);
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
