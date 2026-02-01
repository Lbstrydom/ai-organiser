/**
 * Vector Store Types and Interfaces
 * Defines core types for semantic search and RAG functionality
 */

/**
 * Represents a chunked document stored in the vector database
 */
export interface VectorDocument {
    id: string;                        // Unique identifier (usually filePath-chunkIndex)
    filePath: string;                  // Path to original note
    chunkIndex: number;                // Index of chunk within file
    content: string;                   // Actual text content
    embedding?: number[];              // Vector embedding (optional for storage)
    metadata: {
        title: string;                 // Note title
        createdTime: number;          // Creation time (ms)
        modifiedTime: number;         // Last modified time (ms)
        contentHash: string;          // Hash of original content
        wordCount: number;            // Approximate word count
        tokens: number;               // Estimated token count
    };
}

/**
 * Search result from vector store
 */
export interface SearchResult {
    document: VectorDocument;
    score: number;                     // Cosine similarity score (0-1)
    highlightedText: string;          // Text snippet with query highlighted
}

/**
 * Index statistics and metadata
 */
export interface IndexMetadata {
    totalDocuments: number;            // Number of chunks indexed
    totalNotes: number;               // Number of unique notes
    lastUpdated: number;              // Timestamp of last update
    embeddingDims: number;            // Dimensions of embeddings
    embeddingModel: string;           // Model name
    version: string;                  // Index version
}

/**
 * Core vector store interface
 * Implementations: VoyVectorStore, etc.
 */
export interface IVectorStore {
    /**
     * Add or update documents in the index
     */
    upsert(documents: VectorDocument[]): Promise<void>;

    /**
     * Remove document(s) from the index
     */
    remove(ids: string[]): Promise<void>;

    /**
     * Search for similar documents
     * @param filter Optional predicate to include only matching documents
     */
    search(queryVector: number[], topK?: number, filter?: (doc: VectorDocument) => boolean): Promise<SearchResult[]>;

    /**
     * Search by content (embeds query automatically)
     * @param filter Optional predicate to include only matching documents
     */
    searchByContent(query: string, embeddingService: any, topK?: number, filter?: (doc: VectorDocument) => boolean): Promise<SearchResult[]>;

    /**
     * Get document by ID
     */
    getDocument(id: string): Promise<VectorDocument | null>;

    /**
     * Get all documents for a file
     */
    getDocumentsByFile(filePath: string): Promise<VectorDocument[]>;

    /**
     * Remove all documents from a file
     */
    removeFile(filePath: string): Promise<void>;

    /**
     * Rename file references in index
     */
    renameFile(oldPath: string, newPath: string): Promise<void>;

    /**
     * Get index statistics
     */
    getMetadata(): Promise<IndexMetadata>;

    /**
     * Clear entire index
     */
    clear(): Promise<void>;

    /**
     * Get file change tracker for incremental indexing
     */
    getFileChangeTracker(): FileChangeTracker;

    /**
     * Rebuild index from vault
     */
    rebuild(documents: VectorDocument[]): Promise<void>;

    /**
     * Persist index to disk
     */
    save(): Promise<void>;

    /**
     * Load index from disk
     */
    load(): Promise<void>;

    /**
     * Close and cleanup resources
     */
    dispose(): Promise<void>;
}

/**
 * File change tracking for incremental indexing
 */
export interface FileChangeTracker {
    /**
     * Check if file has changed since last index
     */
    hasChanged(filePath: string, contentHash: string): boolean;

    /**
     * Update tracked hash for a file
     */
    updateHash(filePath: string, contentHash: string): void;

    /**
     * Remove tracked hash for a file
     */
    removeHash(filePath: string): void;

    /**
     * Get all tracked files
     */
    getTrackedFiles(): Map<string, string>;

    /**
     * Clear change tracking
     */
    clear(): void;
}

/**
 * Configuration for VectorStoreService
 */
export interface VectorStoreConfig {
    enableSemanticSearch: boolean;
    embeddingProvider: string;
    embeddingModel: string;
    chunkSize: number;
    chunkOverlap: number;
    maxChunksPerNote: number;
    autoIndexNewNotes: boolean;
    indexExcludedFolders: string[];
    storagePath?: string;
}
