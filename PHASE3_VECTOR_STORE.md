# Phase 3: Vector Store & Semantic Search Infrastructure

## Overview

Phase 3 implements the core vector storage and file synchronization layer for semantic search. This phase focuses on infrastructure and foundation; Phase 4 will add user-facing semantic search commands.

## Components Implemented

### 1. Vector Store Types (`src/services/vector/types.ts`)
- **VectorDocument**: Structure for indexed chunks with metadata
- **SearchResult**: Result structure for semantic search
- **IndexMetadata**: Index statistics and tracking
- **IVectorStore**: Core interface for vector store implementations
- **FileChangeTracker**: Interface for tracking file modifications

### 2. File Change Detection (`src/services/vector/fileChangeDetector.ts`)
- Simple string hashing for change detection
- Enables incremental indexing (skip unchanged notes)
- Reduces embedding costs by avoiding redundant re-embedding
- Methods:
  - `hasChanged()`: Check if content has changed
  - `computeHash()`: Generate content hash
  - `exportHashes()` / `loadHashes()`: Persistence

### 3. Voy Vector Store (`src/services/vector/voyVectorStore.ts`)
- WASM-based vector storage engine
- Efficient binary storage (prevents 60MB+ file bloat)
- Core methods:
  - `initialize()`: Load persisted index
  - `upsertNote()`: Add/update note with embedded chunks
  - `removeNote()`: Remove note from index
  - `renameNote()`: Handle file renames
  - `search()`: Semantic similarity search
  - `searchByVector()`: Direct vector search
  - `rebuildIndex()`: Full vault re-indexing
  - `saveIndex()`: Persist to disk

**Key Features:**
- Hash-based incremental indexing
- Cosine similarity search (in-memory fallback)
- Batch embedding generation
- Separate metadata storage from vectors

### 4. Index Sync Coordinator (`src/services/vector/indexSyncCoordinator.ts`)
- Coordinates vault file system events with vector index
- Debounced updates (1000ms) to prevent rapid re-indexing
- Handles:
  - File modifications (`onFileModified`)
  - File deletions (`onFileDeleted`)
  - File renames (`onFileRenamed`)
  - Full vault indexing (`indexVault`)
- Respects excluded folders configuration

### 5. Service Exports (`src/services/vector/index.ts`)
- Clean public API for vector services
- Type-safe exports

## Integration Points

### Settings (`src/core/settings.ts`)
Existing embeddings settings already support vector store:
- `embeddingProvider`: Model selection
- `embeddingModel`: Specific model name
- `embeddingApiKey` / `embeddingEndpoint`: Provider authentication
- `chunkSize` (2000): Token size for chunks
- `chunkOverlap` (200): Overlap between chunks
- `maxChunksPerNote` (50): Prevent memory issues
- `indexExcludedFolders`: Folders to skip
- `autoIndexNewNotes`: Enable auto-indexing

### i18n Keys (`src/i18n/en.ts` and `zh-cn.ts`)
Added translation keys for semantic search UI:
- `buildSemanticIndex`: Rebuild index command
- `clearSemanticIndex`: Clear index command  
- `searchSemanticVault`: Search command
- `buildingIndex`: Building index message
- `indexBuildComplete`: Success message
- `indexBuildFailed`: Error message
- etc.

### Dependencies (`package.json`)
- `voy-search`: ^0.6.0 - WASM vector database

## How It Works

### Indexing Flow
1. **Initialize**: Load persisted index on plugin startup
2. **File Changed**: Detect change via hash comparison
3. **Chunk Content**: Split into overlapping chunks (2000 chars, 200 overlap)
4. **Embed Chunks**: Use configured embedding provider (OpenAI, Claude, etc.)
5. **Store Documents**: Save vectors and metadata
6. **Persist**: Save index to `.ai-organiser/` folder

### Search Flow
1. **Query Embedding**: Embed user query using same provider
2. **Vector Search**: Find similar chunks via cosine similarity
3. **Results Ranking**: Sort by similarity score
4. **Return Results**: Include preview, source, and heading

## File Storage

Index stored in vault's `.ai-organiser/` hidden folder:
- `vector-index.json`: Voy index data structure
- `vector-documents.json`: Document metadata (paths, chunks, headings)
- `vector-metadata.json`: Index statistics (version, dimensions, count, timestamp)
- `file-hashes.json`: File content hashes for change detection

## Next Phase (Phase 4)

Phase 4 will integrate vector store with plugin:
- Register semantic search commands
- Create search results modal/view
- Display "related notes" in sidebar
- Add RAG (Retrieval-Augmented Generation) support
- Integrate with chat features

## Design Decisions

### Why Voy WASM?
- Binary storage: ~1-10MB vs. 60MB+ JSON
- Efficient cosine similarity search
- Lazy loading support
- Browser/Obsidian compatible

### Why Hash-Based Indexing?
- Skip re-embedding unchanged files
- Reduces API costs
- Fast change detection

### Why Separate Metadata?
- Load metadata without loading vectors
- Quick index statistics
- Efficient file synchronization

### Why Multiple Embedding Providers?
- Cloud-first (OpenAI default)
- Local option (Ollama) for privacy
- Flexibility for cost optimization
- Easy to swap providers

## Testing Notes

The infrastructure is complete and builds successfully. Testing will occur during Phase 4 integration:
1. Create test vault with 100+ notes
2. Build index and measure performance
3. Test search quality with various queries
4. Verify incremental indexing skips unchanged notes
5. Test with different embedding models
6. Verify persistence across plugin reload

## Future Improvements

- Semantic similarity filtering (e.g., minimum score threshold)
- Custom prompt engineering for better relevance
- Caching common queries
- Batch search for multi-query operations
- Index compression and optimization
- Duplicate detection and merging
- Support for embeddings from different models (mix-and-match)
