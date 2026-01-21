/**
 * Vector Store Service
 * Manages lifecycle of vector store, handles embeddings, and coordinates indexing
 */

import { App, TFile } from 'obsidian';
import { IVectorStore, VectorDocument, SearchResult } from './types';
import { VoyVectorStore } from './voyVectorStore';
import { SimpleVectorStore } from './simpleVectorStore';
import { AIOrganiserSettings } from '../../core/settings';

/**
 * Search cache entry
 */
interface CacheEntry {
    results: SearchResult[];
    timestamp: number;
}

/**
 * Simple search cache with TTL
 */
class SearchCache {
    private cache = new Map<string, CacheEntry>();
    private ttl: number; // milliseconds
    private maxSize: number;

    constructor(ttlMs: number = 5 * 60 * 1000, maxSize: number = 100) {
        this.ttl = ttlMs;
        this.maxSize = maxSize;
    }

    /**
     * Get cached results for a query
     */
    get(query: string, topK: number): SearchResult[] | null {
        const key = this.makeKey(query, topK);
        const entry = this.cache.get(key);

        if (!entry) return null;

        // Check if expired
        if (Date.now() - entry.timestamp > this.ttl) {
            this.cache.delete(key);
            return null;
        }

        return entry.results;
    }

    /**
     * Store results in cache
     */
    set(query: string, topK: number, results: SearchResult[]): void {
        const key = this.makeKey(query, topK);

        // Evict oldest entries if at capacity
        if (this.cache.size >= this.maxSize) {
            const oldestKey = this.findOldestKey();
            if (oldestKey) this.cache.delete(oldestKey);
        }

        this.cache.set(key, {
            results,
            timestamp: Date.now()
        });
    }

    /**
     * Clear the cache
     */
    clear(): void {
        this.cache.clear();
    }

    /**
     * Invalidate cache entries related to a file
     */
    invalidateForFile(filePath: string): void {
        // Clear entire cache when a file changes
        // A more sophisticated approach would track which queries include which files
        this.clear();
    }

    private makeKey(query: string, topK: number): string {
        return `${query}::${topK}`;
    }

    private findOldestKey(): string | null {
        let oldestKey: string | null = null;
        let oldestTime = Infinity;

        for (const [key, entry] of this.cache.entries()) {
            if (entry.timestamp < oldestTime) {
                oldestTime = entry.timestamp;
                oldestKey = key;
            }
        }

        return oldestKey;
    }
}

/**
 * Service for managing vector store operations
 */
export class VectorStoreService {
    private vectorStore: IVectorStore | null = null;
    private embeddingService: any;
    private app: App;
    private settings: AIOrganiserSettings;
    private isIndexing = false;
    private searchCache = new SearchCache();

    constructor(
        app: App,
        settings: AIOrganiserSettings,
        embeddingService: any
    ) {
        this.app = app;
        this.settings = settings;
        this.embeddingService = embeddingService;
    }

    /**
     * Create and initialize a vector store
     */
    public async createVectorStore(): Promise<IVectorStore> {
        if (this.vectorStore) {
            return this.vectorStore;
        }

        try {
            // Get embedding dimensions
            const embeddingInfo = await this.embeddingService?.getModelInfo?.();
            const dims = embeddingInfo?.dimensions || 1536;

            // Create Voy WASM vector store (production)
            this.vectorStore = new VoyVectorStore(this.app, dims);

            // Set embedding metadata
            (this.vectorStore as any).setEmbeddingMetadata?.(
                dims,
                this.settings.embeddingModel
            );

            // Try to load existing index
            await this.vectorStore.load();

            console.log('VoyVectorStore initialized successfully');
        } catch (error) {
            console.error('Failed to initialize VoyVectorStore, falling back to SimpleVectorStore:', error);
            
            // Fallback to simple in-memory store
            this.vectorStore = new SimpleVectorStore();
            
            const embeddingInfo = await this.embeddingService?.getModelInfo?.();
            if (embeddingInfo) {
                (this.vectorStore as any).setEmbeddingMetadata?.(
                    embeddingInfo.dimensions || 1536,
                    this.settings.embeddingModel
                );
            }
        }

        return this.vectorStore;
    }

    /**
     * Get the current vector store instance
     */
    public getVectorStore(): IVectorStore | null {
        return this.vectorStore;
    }

    /**
     * Update embedding service and reinitialize if needed
     */
    public async updateEmbeddingService(
        embeddingService: any
    ): Promise<void> {
        this.embeddingService = embeddingService;
        if (this.vectorStore) {
            // Reset vector store to reindex with new embeddings
            await this.vectorStore.clear();
        }
    }

    /**
     * Index a single note (file)
     */
    public async indexNote(file: TFile): Promise<boolean> {
        try {
            if (!this.vectorStore) {
                console.warn('Vector store not initialized');
                return false;
            }

            // Read file content
            const content = await this.app.vault.read(file);
            if (!content.trim()) {
                return true; // Empty file is not an error
            }

            // Simple chunk splitting (max 2000 characters)
            const chunkSize = this.settings.chunkSize || 2000;
            const chunks: string[] = [];
            for (let i = 0; i < content.length; i += chunkSize) {
                chunks.push(content.substring(i, i + chunkSize));
            }

            // Create documents (without embeddings for now)
            const documents: VectorDocument[] = [];
            for (let i = 0; i < Math.min(chunks.length, this.settings.maxChunksPerNote); i++) {
                const chunk = chunks[i];
                const chunkHash = this.hashString(chunk);

                documents.push({
                    id: `${file.path}-${i}`,
                    filePath: file.path,
                    chunkIndex: i,
                    content: chunk,
                    metadata: {
                        title: file.basename,
                        createdTime: file.stat?.ctime || Date.now(),
                        modifiedTime: file.stat?.mtime || Date.now(),
                        contentHash: chunkHash,
                        wordCount: chunk.split(/\s+/).length,
                        tokens: Math.ceil(chunk.length / 4)
                    }
                });
            }

            // Remove old documents and upsert new ones
            const oldDocs = await this.vectorStore.getDocumentsByFile(file.path);
            if (oldDocs.length > 0) {
                await this.vectorStore.remove(oldDocs.map(d => d.id));
            }

            if (documents.length > 0) {
                await this.vectorStore.upsert(documents);
                // Invalidate search cache when content changes
                this.searchCache.invalidateForFile(file.path);
                return true;
            }

            return true;
        } catch (error) {
            console.error(`Error indexing note ${file.path}:`, error);
            return false;
        }
    }

    /**
     * Index all notes in vault
     */
    public async indexVault(): Promise<{ indexed: number; failed: number }> {
        if (!this.vectorStore) {
            console.warn('Vector store not initialized');
            return { indexed: 0, failed: 0 };
        }

        this.isIndexing = true;
        let indexed = 0;
        let failed = 0;

        try {
            // Get excluded folders (shared with tagging or custom)
            const excludedFolders = this.getEffectiveExcludedFolders();

            // Get all markdown files
            const files = this.app.vault.getMarkdownFiles();
            for (const file of files) {
                // Skip excluded folders
                if (excludedFolders.some((folder: string) => file.path.startsWith(folder))) {
                    continue;
                }

                const success = await this.indexNote(file);
                if (success) {
                    indexed++;
                } else {
                    failed++;
                }
            }

            return { indexed, failed };
        } finally {
            this.isIndexing = false;
        }
    }

    /**
     * Remove note from index
     */
    public async removeNote(file: TFile): Promise<void> {
        if (this.vectorStore) {
            await this.vectorStore.removeFile(file.path);
            // Invalidate cache when content removed
            this.searchCache.invalidateForFile(file.path);
        }
    }

    /**
     * Handle note rename
     */
    public async renameNote(oldPath: string, newPath: string): Promise<void> {
        if (this.vectorStore) {
            await this.vectorStore.renameFile(oldPath, newPath);
            // Invalidate cache when file renamed
            this.searchCache.clear();
        }
    }

    /**
     * Register file event handlers for automatic indexing
     */
    public registerFileEventHandlers(): void {
        // Listen for file creation
        this.app.vault.on('create', async (file) => {
            if (file instanceof TFile && file.extension === 'md' && !this.isIndexing) {
                await this.indexNote(file);
            }
        });

        // Listen for file modification
        this.app.vault.on('modify', async (file) => {
            if (file instanceof TFile && file.extension === 'md' && !this.isIndexing) {
                await this.indexNote(file);
            }
        });

        // Listen for file deletion
        this.app.vault.on('delete', async (file) => {
            if (file instanceof TFile && file.extension === 'md' && !this.isIndexing) {
                await this.removeNote(file);
            }
        });

        // Listen for file rename
        this.app.vault.on('rename', async (file, oldPath) => {
            if (file instanceof TFile && file.extension === 'md' && !this.isIndexing) {
                await this.renameNote(oldPath, file.path);
            }
        });
    }

    /**
     * Search by query string (with caching)
     */
    public async search(query: string, topK: number = 5): Promise<SearchResult[]> {
        if (!this.vectorStore) {
            return [];
        }

        // Check cache first
        const cached = this.searchCache.get(query, topK);
        if (cached) {
            return cached;
        }

        // Perform search
        const results = await this.vectorStore.searchByContent(query, this.embeddingService, topK);

        // Cache results
        this.searchCache.set(query, topK, results);

        return results;
    }

    /**
     * Clear the search cache
     */
    public clearSearchCache(): void {
        this.searchCache.clear();
    }

    /**
     * Get indexing status
     */
    public isCurrentlyIndexing(): boolean {
        return this.isIndexing;
    }

    /**
     * Manually save the vector store to disk
     */
    public async saveIndex(): Promise<void> {
        if (this.vectorStore) {
            await this.vectorStore.save();
        }
    }

    /**
     * Cleanup and dispose resources
     */
    public async dispose(): Promise<void> {
        if (this.vectorStore) {
            // Save before disposing
            try {
                await this.vectorStore.save();
                console.log('Vector store saved successfully');
            } catch (error) {
                console.error('Error saving vector store:', error);
            }
            
            await this.vectorStore.dispose();
            this.vectorStore = null;
        }
    }

    /**
     * Get effective excluded folders based on settings
     * Returns shared tagging exclusions or custom indexing exclusions
     */
    private getEffectiveExcludedFolders(): string[] {
        if (this.settings.useSharedExcludedFolders) {
            return this.settings.excludedFolders || [];
        }
        return this.settings.indexExcludedFolders || [];
    }

    /**
     * Simple string hashing for change detection
     */
    private hashString(str: string): string {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }
        return Math.abs(hash).toString(16);
    }
}
