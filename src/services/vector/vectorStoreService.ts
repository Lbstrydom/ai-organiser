/**
 * Vector Store Service
 * Manages lifecycle of vector store, handles embeddings, and coordinates indexing
 */

import { App, TFile, EventRef, Notice, Platform } from 'obsidian';
import { IVectorStore, VectorDocument, SearchResult, FileChangeTracker, INDEX_SCHEMA_VERSION } from './types';
import { VoyVectorStore } from './voyVectorStore';
import { SimpleVectorStore } from './simpleVectorStore';
import { AIOrganiserSettings, getPluginManagedFolders } from '../../core/settings';
import { createContentHash } from './hashUtils';
import type { IEmbeddingService } from '../embeddings/types';
import { getTranslations } from '../../i18n';
import { logger } from '../../utils/logger';

export { INDEX_SCHEMA_VERSION } from './types';

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
    invalidateForFile(_filePath: string): void {
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
    private static readonly METADATA_PREFIX_MAX_CHARS = 200;
    private static readonly BULK_RENAME_THRESHOLD = 10;
    private static readonly RENAME_DEBOUNCE_MS = 500;
    private vectorStore: IVectorStore | null = null;
    private embeddingService: IEmbeddingService | null;
    private app: App;
    private settings: AIOrganiserSettings;
    private isIndexing = false;
    private searchCache = new SearchCache();
    private fileEventRefs: EventRef[] = [];
    private loadPromise: Promise<void> | null = null;
    private pendingRenames: Array<{ oldPath: string; newPath: string }> = [];
    private renameTimer: ReturnType<typeof setTimeout> | null = null;
    private hasWarnedIndexVersion = false;

    constructor(
        app: App,
        settings: AIOrganiserSettings,
        embeddingService: IEmbeddingService | null
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
            const embeddingInfo = this.embeddingService?.getModelInfo?.();
            const dims = embeddingInfo?.dimensions || 1536;
            const storagePath = this.settings.pluginFolder || 'AI-Organiser';
            const t = getTranslations(this.settings.interfaceLanguage);

            if (Platform.isMobile && this.settings.mobileIndexingMode === 'disabled') {
                this.vectorStore = new SimpleVectorStore();
                return this.vectorStore;
            }

            if (Platform.isMobile) {
                const indexSizeBytes = await this.getIndexSizeBytes(storagePath);
                const limitBytes = Math.max(1, this.settings.mobileIndexSizeLimit) * 1024 * 1024;
                if (indexSizeBytes > limitBytes) {
                    const sizeMb = Math.ceil(indexSizeBytes / (1024 * 1024));
                    const limitMb = Math.max(1, this.settings.mobileIndexSizeLimit);
                    new Notice(
                        t.messages.mobileIndexTooLarge
                            .replace('{size}', String(sizeMb))
                            .replace('{limit}', String(limitMb)),
                        5000
                    );
                    this.vectorStore = new SimpleVectorStore();
                    return this.vectorStore;
                }
            }

            // Create Voy WASM vector store (production)
            this.vectorStore = new VoyVectorStore(this.app, dims, storagePath);

            // Set embedding metadata
            (this.vectorStore as IVectorStore & { setEmbeddingMetadata?: (dims: number, model: string) => void }).setEmbeddingMetadata?.(
                dims,
                this.settings.embeddingModel
            );

            // Try to load existing index
            if (Platform.isMobile) {
                this.startIndexLoad();
            } else {
                await this.vectorStore.load();
            }

            logger.debug('Search', 'VoyVectorStore initialized successfully');
        } catch (error) {
            logger.error('Search', 'Failed to initialize VoyVectorStore, falling back to SimpleVectorStore', error);
            
            // Fallback to simple in-memory store
            this.vectorStore = new SimpleVectorStore();
            
            const embeddingInfo = this.embeddingService?.getModelInfo?.();
            if (embeddingInfo) {
                (this.vectorStore as IVectorStore & { setEmbeddingMetadata?: (dims: number, model: string) => void }).setEmbeddingMetadata?.(
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
        embeddingService: IEmbeddingService | null,
        shouldClear: boolean = false
    ): Promise<void> {
        this.embeddingService = embeddingService;
        if (shouldClear && this.vectorStore) {
            await this.vectorStore.clear();
            this.hasWarnedIndexVersion = false;
        }
    }

    /**
     * Index a single note (file)
     */
    public async indexNote(file: TFile): Promise<boolean> {
        try {
            if (Platform.isMobile && this.settings.mobileIndexingMode !== 'full') {
                return false;
            }

            if (!this.vectorStore) {
                logger.warn('Search', 'Vector store not initialized');
                return false;
            }

            if (!this.embeddingService) {
                logger.warn('Search', 'Embedding service not available for indexing');
                return false;
            }

            await this.ensureIndexLoaded();

            // Read file content
            const content = await this.app.vault.read(file);
            const contentHash = createContentHash(content);
            const changeTracker = this.getChangeTracker();
            const hasChanged = changeTracker ? changeTracker.hasChanged(file.path, contentHash) : true;

            // Skip if unchanged
            if (!hasChanged) {
                return true;
            }

            if (!content.trim()) {
                const oldDocs = await this.vectorStore.getDocumentsByFile(file.path);
                if (oldDocs.length > 0) {
                    await this.vectorStore.remove(oldDocs.map(d => d.id));
                }
                changeTracker?.updateHash(file.path, contentHash);
                return true;
            }

            // Chunk splitting with optional overlap
            const chunkSize = this.settings.chunkSize || 2000;
            const overlap = Math.max(0, Math.min(this.settings.chunkOverlap || 0, chunkSize - 1));
            const chunks = this.splitIntoChunks(content, chunkSize, overlap)
                .slice(0, this.settings.maxChunksPerNote);

            const tags = this.getFileTags(file);
            const folderPath = file.parent?.path || '';
            const metadataPrefix = this.buildMetadataPrefix(file.basename, folderPath, tags);

            // Create documents and embeddings
            const documents: VectorDocument[] = [];
            for (let i = 0; i < chunks.length; i++) {
                const chunk = chunks[i];
                const chunkHash = createContentHash(chunk);

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

            const embeddingResult = await this.embeddingService.batchGenerateEmbeddings(
                documents.map(doc => metadataPrefix + doc.content)
            );

            if (!embeddingResult.success || !embeddingResult.embeddings) {
                logger.warn('Search', `Failed to generate embeddings for note ${file.path}`, embeddingResult.error);
                return false;
            }

            if (embeddingResult.embeddings.length !== documents.length) {
                logger.warn('Search', `Embedding count mismatch for note ${file.path}`);
            }

            for (let i = 0; i < documents.length; i++) {
                documents[i].embedding = embeddingResult.embeddings[i] || [];
            }

            // Remove old documents and upsert new ones
            const oldDocs = await this.vectorStore.getDocumentsByFile(file.path);
            if (oldDocs.length > 0) {
                await this.vectorStore.remove(oldDocs.map(d => d.id));
            }

            if (documents.length > 0) {
                await this.vectorStore.upsert(documents);
                changeTracker?.updateHash(file.path, contentHash);
                // Invalidate search cache when content changes
                this.searchCache.invalidateForFile(file.path);
                return true;
            }

            return true;
        } catch (error) {
            logger.error('Search', `Error indexing note ${file.path}`, error);
            return false;
        }
    }

    /**
     * Shared indexing loop. Both indexVault() and rebuildVault() use this.
     */
    private async indexAllNotes(): Promise<{ indexed: number; failed: number }> {
        const excludedFolders = this.getEffectiveExcludedFolders();
        const files = this.app.vault.getMarkdownFiles();
        let indexed = 0, failed = 0;
        for (const file of files) {
            if (excludedFolders.some((folder: string) => file.path.startsWith(folder))) continue;
            const success = await this.indexNote(file);
            if (success) indexed++; else failed++;
        }
        return { indexed, failed };
    }

    /**
     * Incremental index — skips unchanged files via hash check.
     */
    public async indexVault(): Promise<{ indexed: number; failed: number }> {
        if (!this.vectorStore) {
            logger.warn('Search', 'Vector store not initialized');
            return { indexed: 0, failed: 0 };
        }

        if (Platform.isMobile && this.settings.mobileIndexingMode !== 'full') {
            return { indexed: 0, failed: 0 };
        }

        this.isIndexing = true;
        try {
            await this.ensureIndexLoaded();
            return await this.indexAllNotes();
        } finally {
            this.isIndexing = false;
        }
    }

    /**
     * Full rebuild — clears index, re-embeds all files, stamps version.
     */
    public async rebuildVault(): Promise<{ indexed: number; failed: number }> {
        if (!this.vectorStore || !this.embeddingService) {
            return { indexed: 0, failed: 0 };
        }

        if (Platform.isMobile && this.settings.mobileIndexingMode !== 'full') {
            return { indexed: 0, failed: 0 };
        }

        this.isIndexing = true;
        try {
            // Must wait for any in-progress load (mobile deferred load) before clearing
            await this.ensureIndexLoaded();
            // Clear everything — index data, change tracker, version
            await this.vectorStore.clear();
            this.searchCache.clear();
            // After clear(), FileChangeTracker is empty → every indexNote() re-embeds
            const result = await this.indexAllNotes();
            // Version is already stamped by upsert() inside indexNote()
            this.hasWarnedIndexVersion = false;
            return result;
        } finally {
            this.isIndexing = false;
        }
    }

    /**
     * Remove note from index
     */
    public async removeNote(file: TFile): Promise<void> {
        if (this.vectorStore) {
            await this.ensureIndexLoaded();
            await this.vectorStore.removeFile(file.path);
            // Invalidate cache when content removed
            this.searchCache.invalidateForFile(file.path);
        }
    }

    /**
     * Handle note rename
     */
    public async renameNote(oldPath: string, newPath: string): Promise<void> {
        if (!this.vectorStore) return;

        await this.ensureIndexLoaded();

        if (this.embeddingService) {
            await this.vectorStore.removeFile(oldPath);
            const file = this.app.vault.getFileByPath(newPath);
            if (file instanceof TFile) {
                await this.indexNote(file);
            }
        } else {
            await this.vectorStore.renameFile(oldPath, newPath);
        }

        this.searchCache.clear();
    }

    public queueRenameNote(oldPath: string, newPath: string): void {
        this.pendingRenames.push({ oldPath, newPath });

        if (this.renameTimer) {
            clearTimeout(this.renameTimer);
        }

        this.renameTimer = setTimeout(() => {
            void this.flushRenames();
        }, VectorStoreService.RENAME_DEBOUNCE_MS);
    }

    private async flushRenames(): Promise<void> {
        const batch = [...this.pendingRenames];
        this.pendingRenames = [];
        this.renameTimer = null;

        if (batch.length === 0 || !this.vectorStore) {
            return;
        }

        await this.ensureIndexLoaded();

        if (batch.length > VectorStoreService.BULK_RENAME_THRESHOLD) {
            new Notice(
                `${batch.length} notes moved. Run "Update Changed Files" in Manage Index to re-embed with updated paths.`,
                10000
            );
            for (const { oldPath, newPath } of batch) {
                await this.vectorStore.renameFile(oldPath, newPath);
            }
            this.searchCache.clear();
            return;
        }

        for (const { oldPath, newPath } of batch) {
            await this.renameNote(oldPath, newPath);
        }
    }

    /**
     * Register file event handlers for automatic indexing
     */
    public registerFileEventHandlers(): void {
        this.unregisterFileEventHandlers();
        if (Platform.isMobile && this.settings.mobileIndexingMode !== 'full') {
            return;
        }
        // Listen for file creation
        this.fileEventRefs.push(this.app.vault.on('create', async (file) => {
            if (file instanceof TFile && file.extension === 'md' && !this.isIndexing) {
                await this.indexNote(file);
            }
        }));

        // Listen for file modification
        this.fileEventRefs.push(this.app.vault.on('modify', async (file) => {
            if (file instanceof TFile && file.extension === 'md' && !this.isIndexing) {
                await this.indexNote(file);
            }
        }));

        // Listen for file deletion
        this.fileEventRefs.push(this.app.vault.on('delete', async (file) => {
            if (file instanceof TFile && file.extension === 'md' && !this.isIndexing) {
                await this.removeNote(file);
            }
        }));

        // Listen for file rename
        this.fileEventRefs.push(this.app.vault.on('rename', (file, oldPath) => {
            if (file instanceof TFile && file.extension === 'md' && !this.isIndexing) {
                this.queueRenameNote(oldPath, file.path);
            }
        }));
    }

    /**
     * Unregister file event handlers
     */
    public unregisterFileEventHandlers(): void {
        if (this.fileEventRefs.length === 0) return;

        for (const ref of this.fileEventRefs) {
            this.app.vault.offref(ref);
        }
        this.fileEventRefs = [];
    }

    /**
     * Search by query string (with caching)
     */
    public async search(query: string, topK: number = 5): Promise<SearchResult[]> {
        if (!this.vectorStore) {
            return [];
        }

        await this.ensureIndexLoaded();

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
            await this.ensureIndexLoaded();
            await this.vectorStore.save();
        }
    }

    /**
     * Cleanup and dispose resources
     */
    public async dispose(): Promise<void> {
        this.unregisterFileEventHandlers();
        this.searchCache.clear();
        this.isIndexing = false;
        if (this.vectorStore) {
            // Save before disposing
            try {
                await this.vectorStore.save();
                logger.debug('Search', 'Vector store saved successfully');
            } catch (error) {
                logger.error('Search', 'Error saving vector store', error);
            }
            
            await this.vectorStore.dispose();
            this.vectorStore = null;
        }
    }

    /**
     * Get effective excluded folders based on settings.
     * Always merges user exclusions with plugin-managed folders so that
     * chat logs, canvas files, etc. are never indexed.
     */
    private getEffectiveExcludedFolders(): string[] {
        const base = this.settings.useSharedExcludedFolders
            ? (this.settings.excludedFolders || [])
            : (this.settings.indexExcludedFolders || []);
        const managed = getPluginManagedFolders(this.settings);
        return [...new Set([...base, ...managed])];
    }

    private getChangeTracker(): FileChangeTracker | null {
        return this.vectorStore?.getFileChangeTracker?.() || null;
    }

    private startIndexLoad(): void {
        if (!this.vectorStore || this.loadPromise) {
            return;
        }
        this.loadPromise = this.vectorStore.load()
            .catch((error) => {
                logger.error('Search', 'Failed to load vector index', error);
            })
            .finally(() => {
                this.loadPromise = null;
            });
    }

    private async ensureIndexLoaded(): Promise<void> {
        if (this.loadPromise) {
            await this.loadPromise;
        }

        await this.checkIndexVersion();
    }

    private async checkIndexVersion(): Promise<void> {
        if (!this.vectorStore || this.hasWarnedIndexVersion) {
            return;
        }

        const metadata = await this.vectorStore.getMetadata();
        if (metadata?.version !== INDEX_SCHEMA_VERSION) {
            this.hasWarnedIndexVersion = true;

            if (this.settings.autoIndexNewNotes && this.embeddingService) {
                logger.debug('Search', `Index version ${metadata?.version ?? 'unknown'} outdated — auto-rebuilding to ${INDEX_SCHEMA_VERSION}...`);
                new Notice('Index outdated — rebuilding automatically...', 4000);
                // Run rebuild in background so it doesn't block the current operation
                void this.rebuildVault().then(result => {
                    if (result.indexed > 0) {
                        new Notice(`Index rebuilt: ${result.indexed} notes indexed`, 4000);
                    }
                }).catch(err => {
                    logger.error('Search', 'Auto-rebuild failed', err);
                    new Notice('Index auto-rebuild failed. Rebuild manually via settings.', 5000);
                });
            } else {
                const msg = `Vector index version ${metadata?.version ?? 'unknown'} is outdated (current: ${INDEX_SCHEMA_VERSION}). Rebuild via Settings → Vault Intelligence → Semantic Search → Build Index.`;
                logger.warn('Search', msg);
                new Notice(msg, 10000);
            }
        }
    }

    private async getIndexSizeBytes(storagePath: string): Promise<number> {
        const adapter = this.app.vault.adapter;
        const indexPath = `${storagePath}/index.voy`;
        const metadataPath = `${storagePath}/meta.json`;
        const legacyMetadataPath = `${storagePath}/metadata.json`;
        let total = 0;

        for (const path of [indexPath, metadataPath, legacyMetadataPath]) {
            if (await adapter.exists(path)) {
                const stat = await adapter.stat(path);
                total += stat?.size || 0;
            }
        }

        return total;
    }

    private splitIntoChunks(content: string, chunkSize: number, overlap: number): string[] {
        if (chunkSize <= 0) {
            return [];
        }

        const chunks: string[] = [];
        let start = 0;

        while (start < content.length) {
            const end = Math.min(start + chunkSize, content.length);
            chunks.push(content.substring(start, end));

            if (end >= content.length) {
                break;
            }

            start = Math.max(0, end - overlap);
        }

        return chunks;
    }

    private buildMetadataPrefix(title: string, folderPath: string, tags: string[]): string {
        const parts: string[] = [];
        if (title) parts.push(`Title: ${title}`);
        if (folderPath) parts.push(`Path: ${folderPath}`);
        if (tags.length > 0) parts.push(`Tags: ${tags.join(', ')}`);

        let prefix = parts.join('\n');
        if (prefix.length > VectorStoreService.METADATA_PREFIX_MAX_CHARS) {
            prefix = prefix.substring(0, VectorStoreService.METADATA_PREFIX_MAX_CHARS);
        }

        return prefix ? `${prefix}\n---\n` : '';
    }

    private getFileTags(file: TFile): string[] {
        const cache = this.app.metadataCache.getFileCache(file);
        if (!cache) return [];

        const tags: string[] = [];
        if (cache.frontmatter?.tags) {
            const fmTags = Array.isArray(cache.frontmatter.tags)
                ? cache.frontmatter.tags
                : [cache.frontmatter.tags];
            tags.push(...fmTags.map((tag: string) => tag.replace(/^#/, '')));
        }

        if (cache.tags) {
            tags.push(...cache.tags.map(tag => tag.tag.replace(/^#/, '')));
        }

        return [...new Set(tags)].filter(Boolean);
    }
}
