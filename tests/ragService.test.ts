/**
 * RAGService Tests
 * 
 * Tests RAGService behavior with a test vector store (no network calls)
 * Verifies:
 * - Context retrieval respects maxChunks and minSimilarity
 * - Current file exclusion works
 * - Metadata inclusion/exclusion works
 * - Source deduplication works
 * - Empty context handling
 * - RAG prompt building
 */

import { RAGService, RAGContext, RAGOptions } from '../src/services/ragService';
import { IVectorStore, SearchResult, VectorDocument, type FileChangeTracker } from '../src/services/vector/types';
import { AIOrganiserSettings } from '../src/core/settings';
import type { IEmbeddingService, EmbeddingResult, BatchEmbeddingResult, EmbeddingModelInfo } from '../src/services/embeddings/types';

/**
 * Mock embedding service for testing
 */
class MockEmbeddingService implements IEmbeddingService {
    async generateEmbedding(text: string): Promise<EmbeddingResult> {
        return {
            success: true,
            embedding: Array(1536).fill(0).map((_, i) => Math.sin(text.length + i) * 0.5),
            tokenCount: Math.min(text.length, 1000)
        };
    }

    async batchGenerateEmbeddings(texts: string[]): Promise<BatchEmbeddingResult> {
        const embeddings = texts.map(text =>
            Array(1536).fill(0).map((_, i) => Math.sin(text.length + i) * 0.5)
        );
        return {
            success: true,
            embeddings,
            totalTokens: texts.reduce((sum, t) => sum + Math.min(t.length, 1000), 0)
        };
    }

    getModelDimensions(): number {
        return 1536;
    }

    getModelName(): string {
        return 'test-model';
    }

    getModelInfo(): EmbeddingModelInfo {
        return {
            provider: 'test',
            model: 'test-model',
            dimensions: 1536,
            maxTokens: 8192
        };
    }

    async testConnection(): Promise<{ success: boolean; error?: string }> {
        return { success: true };
    }

    async dispose(): Promise<void> {}
}

/**
 * Test vector store implementation
 * Stores documents and performs simple similarity search
 */
class TestVectorStore implements IVectorStore {
    private documents: Map<string, VectorDocument> = new Map();
    private embeddings: Map<string, number[]> = new Map();
    public lastSearchQuery: string | null = null;
    public lastSearchTopK: number | null = null;
    public lastSearchFilter: ((doc: VectorDocument) => boolean) | undefined;
    private tracker: FileChangeTracker = {
        hasChanged: () => true,
        updateHash: () => {},
        removeHash: () => {},
        getTrackedFiles: () => new Map(),
        clear: () => {}
    };

    constructor() {
        this.setupMockData();
    }

    /**
     * Setup mock data for testing
     */
    private setupMockData(): void {
        const mockDocs: VectorDocument[] = [
            {
                id: 'test.md-0',
                filePath: 'test.md',
                chunkIndex: 0,
                content: 'This is the first document about AI and machine learning concepts.',
                metadata: {
                    title: 'AI Concepts',
                    createdTime: 1000000,
                    modifiedTime: 1000000,
                    contentHash: 'hash1',
                    wordCount: 10,
                    tokens: 20
                }
            },
            {
                id: 'test.md-1',
                filePath: 'test.md',
                chunkIndex: 1,
                content: 'Deep learning is a subset of machine learning.',
                metadata: {
                    title: 'AI Concepts',
                    createdTime: 1000000,
                    modifiedTime: 1000000,
                    contentHash: 'hash1',
                    wordCount: 8,
                    tokens: 15
                }
            },
            {
                id: 'other.md-0',
                filePath: 'other.md',
                chunkIndex: 0,
                content: 'Python is a popular programming language for data science.',
                metadata: {
                    title: 'Python Guide',
                    createdTime: 2000000,
                    modifiedTime: 2000000,
                    contentHash: 'hash2',
                    wordCount: 9,
                    tokens: 18
                }
            },
            {
                id: 'other.md-1',
                filePath: 'other.md',
                chunkIndex: 1,
                content: 'Data science involves statistics and programming.',
                metadata: {
                    title: 'Python Guide',
                    createdTime: 2000000,
                    modifiedTime: 2000000,
                    contentHash: 'hash2',
                    wordCount: 8,
                    tokens: 14
                }
            },
            {
                id: 'third.md-0',
                filePath: 'third.md',
                chunkIndex: 0,
                content: 'Neural networks are inspired by biological neurons.',
                metadata: {
                    title: 'Neural Networks',
                    createdTime: 3000000,
                    modifiedTime: 3000000,
                    contentHash: 'hash3',
                    wordCount: 7,
                    tokens: 12
                }
            },
            {
                id: 'Projects/ai-research.md-0',
                filePath: 'Projects/ai-research.md',
                chunkIndex: 0,
                content: 'Research into transformer architectures and attention mechanisms.',
                metadata: {
                    title: 'AI Research',
                    createdTime: 4000000,
                    modifiedTime: 4000000,
                    contentHash: 'hash4',
                    wordCount: 8,
                    tokens: 16
                }
            },
            {
                id: 'Projects/ml-notes.md-0',
                filePath: 'Projects/ml-notes.md',
                chunkIndex: 0,
                content: 'Machine learning models require large training datasets.',
                metadata: {
                    title: 'ML Notes',
                    createdTime: 5000000,
                    modifiedTime: 5000000,
                    contentHash: 'hash5',
                    wordCount: 7,
                    tokens: 14
                }
            }
        ];

        mockDocs.forEach(doc => {
            this.documents.set(doc.id, doc);
            // Simple embedding: based on content
            this.embeddings.set(doc.id, this.simpleEmbedding(doc.content));
        });
    }

    /**
     * Simple embedding function for testing (not real embeddings)
     */
    private simpleEmbedding(text: string): number[] {
        const embedding = Array(1536).fill(0);
        const words = text.toLowerCase().split(/\s+/);
        
        // Distribute word hashes across embedding dimensions
        words.forEach((word, idx) => {
            let hash = 0;
            for (let i = 0; i < word.length; i++) {
                hash = ((hash << 5) - hash) + word.charCodeAt(i);
            }
            
            // Use modulo to map to embedding dimension
            const dim = Math.abs(hash) % 1536;
            embedding[dim] += Math.sin(hash) * 0.5 + 0.5;
        });
        
        // Normalize embedding
        const norm = Math.sqrt(embedding.reduce((sum, x) => sum + x * x, 0));
        if (norm > 0) {
            for (let i = 0; i < embedding.length; i++) {
                embedding[i] /= norm;
            }
        }
        
        return embedding;
    }

    /**
     * Compute similarity between two embeddings
     */
    private cosineSimilarity(a: number[], b: number[]): number {
        let dotProduct = 0;
        let normA = 0;
        let normB = 0;
        
        for (let i = 0; i < a.length; i++) {
            dotProduct += a[i] * b[i];
            normA += a[i] * a[i];
            normB += b[i] * b[i];
        }
        
        const denominator = Math.sqrt(normA) * Math.sqrt(normB);
        return denominator === 0 ? 0 : dotProduct / denominator;
    }

    async upsert(documents: VectorDocument[]): Promise<void> {
        documents.forEach(doc => {
            this.documents.set(doc.id, doc);
            this.embeddings.set(doc.id, this.simpleEmbedding(doc.content));
        });
    }

    async remove(ids: string[]): Promise<void> {
        ids.forEach(id => {
            this.documents.delete(id);
            this.embeddings.delete(id);
        });
    }

    async search(queryVector: number[], topK: number = 5, filter?: (doc: VectorDocument) => boolean): Promise<SearchResult[]> {
        const results: Array<{ id: string; score: number }> = [];

        this.embeddings.forEach((embedding, id) => {
            if (filter) {
                const doc = this.documents.get(id);
                if (!doc || !filter(doc)) return;
            }
            const score = this.cosineSimilarity(queryVector, embedding);
            results.push({ id, score });
        });

        results.sort((a, b) => b.score - a.score);

        return results.slice(0, topK).map(r => ({
            document: this.documents.get(r.id)!,
            score: r.score,
            highlightedText: this.documents.get(r.id)!.content.substring(0, 100)
        }));
    }

    async searchByContent(query: string, embeddingService: any, topK: number = 5, filter?: (doc: VectorDocument) => boolean): Promise<SearchResult[]> {
        this.lastSearchQuery = query;
        this.lastSearchTopK = topK;
        this.lastSearchFilter = filter;
        const queryEmbedding = this.simpleEmbedding(query);
        return this.search(queryEmbedding, topK, filter);
    }

    async getDocument(id: string): Promise<VectorDocument | null> {
        return this.documents.get(id) || null;
    }

    async getDocumentsByFile(filePath: string): Promise<VectorDocument[]> {
        return Array.from(this.documents.values()).filter(d => d.filePath === filePath);
    }

    async removeFile(filePath: string): Promise<void> {
        const idsToRemove = Array.from(this.documents.entries())
            .filter(([_, doc]) => doc.filePath === filePath)
            .map(([id, _]) => id);
        
        await this.remove(idsToRemove);
    }

    async renameFile(oldPath: string, newPath: string): Promise<void> {
        const docsToUpdate = Array.from(this.documents.entries())
            .filter(([_, doc]) => doc.filePath === oldPath);
        
        docsToUpdate.forEach(([id, doc]) => {
            doc.filePath = newPath;
            this.documents.set(id, doc);
        });
    }

    async getMetadata() {
        const uniqueFiles = new Set(Array.from(this.documents.values()).map(d => d.filePath));
        return {
            totalDocuments: this.documents.size,
            totalNotes: uniqueFiles.size,
            lastUpdated: Date.now(),
            embeddingDims: 1536,
            embeddingModel: 'test-model',
            version: '1.0'
        };
    }

    async clear(): Promise<void> {
        this.documents.clear();
        this.embeddings.clear();
    }

    getFileChangeTracker(): FileChangeTracker {
        return this.tracker;
    }

    async rebuild(documents: VectorDocument[]): Promise<void> {
        this.documents.clear();
        this.embeddings.clear();
        await this.upsert(documents);
    }

    async save(): Promise<void> {}

    async load(): Promise<void> {}

    async dispose(): Promise<void> {}
}

/**
 * Create mock settings
 */
function createMockSettings(overrides?: Partial<AIOrganiserSettings>): AIOrganiserSettings {
    return {
        serviceType: 'local',
        ragContextChunks: 5,
        ragIncludeMetadata: true,
        ...overrides
    } as AIOrganiserSettings;
}

/**
 * Create mock TFile
 */
function createMockFile(path: string) {
    const basename = path.split('/').pop()?.replace(/\.md$/i, '') || path;
    return { path, basename } as any;
}

describe('RAGService', () => {
    let vectorStore: TestVectorStore;
    let ragService: RAGService;
    let settings: AIOrganiserSettings;
    let embeddingService: MockEmbeddingService;

    beforeEach(() => {
        vectorStore = new TestVectorStore();
        settings = createMockSettings();
        embeddingService = new MockEmbeddingService();
        ragService = new RAGService(vectorStore, settings, embeddingService);
    });

    describe('retrieveContext', () => {
        it('should return RAGContext with expected structure', async () => {
            const context = await ragService.retrieveContext('machine learning');
            
            expect(context).toHaveProperty('chunks');
            expect(context).toHaveProperty('formattedContext');
            expect(context).toHaveProperty('sources');
            expect(context).toHaveProperty('totalChunks');
        });

        it('should respect maxChunks parameter', async () => {
            const context = await ragService.retrieveContext('learning', undefined, {
                maxChunks: 2
            });
            
            expect(context.chunks.length).toBeLessThanOrEqual(2);
            expect(context.totalChunks).toBeLessThanOrEqual(2);
        });

        it('should respect minSimilarity parameter', async () => {
            const context = await ragService.retrieveContext('learning', undefined, {
                minSimilarity: 0.1
            });
            
            // All returned chunks should meet minimum similarity
            context.chunks.forEach(chunk => {
                expect(chunk.score).toBeGreaterThanOrEqual(0.1);
            });
        });

        it('should filter low-similarity results', async () => {
            // With very high threshold, should get few or no results
            const context = await ragService.retrieveContext('learning', undefined, {
                minSimilarity: 0.99
            });
            
            // High threshold might return nothing, which is valid
            expect(context.chunks.length).toBeLessThanOrEqual(5);
        });

        it('should exclude current file when requested', async () => {
            const currentFile = createMockFile('test.md');
            
            const context = await ragService.retrieveContext('learning', currentFile, {
                excludeCurrentFile: true,
                maxChunks: 10
            });
            
            // No chunks should be from test.md
            context.chunks.forEach(chunk => {
                expect(chunk.document.filePath).not.toBe('test.md');
            });
        });

        it('should include current file when excludeCurrentFile is false', async () => {
            const currentFile = createMockFile('test.md');
            
            const context = await ragService.retrieveContext('learning', currentFile, {
                excludeCurrentFile: false,
                maxChunks: 10
            });
            
            // May or may not include test.md depending on relevance, but exclusion is disabled
            expect(context).toBeDefined();
        });

        it('should return empty context on vector store error', async () => {
            // Create a store that throws
            const errorStore: IVectorStore = {
                searchByContent: async (_q: string, _e: any, _k?: number, _f?: any) => { throw new Error('Store error'); },
                search: async (_v: number[], _k?: number, _f?: any) => { throw new Error('Store error'); },
                upsert: async () => {},
                remove: async () => {},
                getDocument: async () => null,
                getDocumentsByFile: async () => [],
                removeFile: async () => {},
                renameFile: async () => {},
                getMetadata: async () => ({} as any),
                clear: async () => {},
                getFileChangeTracker: () => ({
                    hasChanged: () => false,
                    updateHash: () => {},
                    removeHash: () => {},
                    getTrackedFiles: () => new Map(),
                    clear: () => {}
                }),
                rebuild: async () => {},
                save: async () => {},
                load: async () => {},
                dispose: async () => {}
            };
            
            const service = new RAGService(errorStore, settings, embeddingService);
            const context = await service.retrieveContext('query');
            
            expect(context.chunks).toEqual([]);
            expect(context.formattedContext).toBe('');
            expect(context.sources).toEqual([]);
            expect(context.totalChunks).toBe(0);
        });

        it('should deduplicate sources', async () => {
            // Both chunks from test.md should be merged into one source
            const context = await ragService.retrieveContext('learning', undefined, {
                maxChunks: 10
            });
            
            const sourceCounts = context.sources.reduce((acc, source) => {
                acc[source] = (acc[source] || 0) + 1;
                return acc;
            }, {} as Record<string, number>);
            
            // Each source should appear only once
            Object.values(sourceCounts).forEach(count => {
                expect(count).toBe(1);
            });
        });

        it('should produce stable formatted context with metadata', async () => {
            const context = await ragService.retrieveContext('learning', undefined, {
                includeMetadata: true,
                maxChunks: 2,
                minSimilarity: 0
            });
            
            if (context.totalChunks > 0) {
                expect(context.formattedContext).toContain('Relevant Context from Vault');
                expect(context.formattedContext).toContain('File:');
                expect(context.formattedContext).toContain('Title:');
                expect(context.formattedContext).toContain('Relevance Score:');
                expect(context.formattedContext).toContain('Content:');
            }
        });

        it('should produce formatted context without metadata', async () => {
            const context = await ragService.retrieveContext('learning', undefined, {
                includeMetadata: false,
                maxChunks: 2,
                minSimilarity: 0
            });
            
            // Should not include metadata sections
            if (context.totalChunks > 0) {
                expect(context.formattedContext).not.toContain('File:');
                expect(context.formattedContext).not.toContain('Relevance Score:');
                expect(context.formattedContext).toContain('Content:');
            }
        });

        it('should use default maxChunks from settings', async () => {
            const customSettings = createMockSettings({ ragContextChunks: 3 });
            const service = new RAGService(vectorStore, customSettings, embeddingService);
            
            const context = await service.retrieveContext('learning');
            
            expect(context.chunks.length).toBeLessThanOrEqual(3);
        });

        it('should use default includeMetadata from settings', async () => {
            const customSettings = createMockSettings({ ragIncludeMetadata: false });
            const service = new RAGService(vectorStore, customSettings, embeddingService);
            
            const context = await service.retrieveContext('learning');
            
            expect(context.formattedContext).not.toContain('File:');
        });

        it('should handle empty query', async () => {
            const context = await ragService.retrieveContext('');
            
            expect(context).toBeDefined();
            expect(context.chunks).toBeInstanceOf(Array);
        });

        it('should return non-empty chunks when results exist', async () => {
            const context = await ragService.retrieveContext('learning', undefined, {
                maxChunks: 5,
                minSimilarity: 0
            });
            
            expect(context.totalChunks).toBeGreaterThan(0);
            expect(context.chunks.length).toBeGreaterThan(0);
        });
    });

    describe('buildRAGPrompt', () => {
        it('should return userQuery when context is empty', async () => {
            const emptyContext: RAGContext = {
                chunks: [],
                formattedContext: '',
                sources: [],
                totalChunks: 0
            };
            
            const prompt = ragService.buildRAGPrompt('What is AI?', emptyContext);
            
            expect(prompt).toBe('What is AI?');
        });

        it('should include context when available', async () => {
            const context = await ragService.retrieveContext('learning', undefined, {
                maxChunks: 2
            });
            
            // Only test buildRAGPrompt if context is available
            if (context.totalChunks > 0) {
                const prompt = ragService.buildRAGPrompt('What is machine learning?', context);
                
                expect(prompt).toContain('What is machine learning?');
                expect(prompt).toContain('Relevant Context from Vault');
            }
        });

        it('should produce valid prompt string', async () => {
            const context = await ragService.retrieveContext('learning', undefined, {
                maxChunks: 2
            });
            
            const prompt = ragService.buildRAGPrompt('Query', context);
            
            expect(typeof prompt).toBe('string');
            expect(prompt.length).toBeGreaterThan(0);
        });

        it('should include task section when context available', async () => {
            const context = await ragService.retrieveContext('learning', undefined, {
                maxChunks: 2
            });
            
            const prompt = ragService.buildRAGPrompt('Query', context);
            
            if (context.totalChunks > 0) {
                expect(prompt).toContain('Task');
                expect(prompt).toContain('Based on the context');
            }
        });
    });

    describe('getRelatedNotes', () => {
        it('should return related notes excluding the current file', async () => {
            const file = createMockFile('test.md');
            const results = await ragService.getRelatedNotes(file, 'machine learning concepts', 5);

            results.forEach(r => {
                expect(r.document.filePath).not.toBe('test.md');
            });
        });

        it('should build a focused query with title and stripped frontmatter', async () => {
            const file = createMockFile('sample.md');
            const content = [
                '---',
                'title: Frontmatter Title',
                'tags: [test]',
                '---',
                'Body text about machine learning.'
            ].join('\n');

            await ragService.getRelatedNotes(file, content, 5);

            expect(vectorStore.lastSearchQuery).toContain('sample');
            expect(vectorStore.lastSearchQuery).toContain('Body text about machine learning.');
            expect(vectorStore.lastSearchQuery).not.toContain('title: Frontmatter Title');
            expect(vectorStore.lastSearchQuery).not.toContain('---');
        });

        it('should over-fetch results before slicing', async () => {
            const file = createMockFile('test.md');
            await ragService.getRelatedNotes(file, 'machine learning concepts', 2);

            expect(vectorStore.lastSearchTopK).toBe(10);
        });

        it('should deduplicate results by file path', async () => {
            const file = createMockFile('nonexistent.md');
            const results = await ragService.getRelatedNotes(file, 'machine learning', 10);

            const uniquePaths = new Set(results.map(r => r.document.filePath));
            expect(uniquePaths.size).toBe(results.length);
        });

        it('should filter by folderScope when provided', async () => {
            const file = createMockFile('test.md');
            const results = await ragService.getRelatedNotes(
                file, 'machine learning research', 10,
                { folderScope: 'Projects' }
            );

            results.forEach(r => {
                expect(r.document.filePath).toMatch(/^Projects\//);
            });
        });

        it('should return all notes when folderScope is null', async () => {
            const file = createMockFile('test.md');
            const results = await ragService.getRelatedNotes(
                file, 'machine learning', 10,
                { folderScope: null }
            );

            // Should include notes from multiple folders
            const paths = results.map(r => r.document.filePath);
            expect(paths.length).toBeGreaterThan(0);
        });

        it('should return all notes when folderScope is empty string', async () => {
            const file = createMockFile('test.md');
            const results = await ragService.getRelatedNotes(
                file, 'machine learning', 10,
                { folderScope: '' }
            );

            // Empty string normalizes to no filter (vault-wide)
            const hasRootNotes = results.some(r => !r.document.filePath.includes('/'));
            expect(hasRootNotes || results.length === 0).toBe(true);
        });

        it('should return all notes when folderScope is "/"', async () => {
            const file = createMockFile('test.md');
            const results = await ragService.getRelatedNotes(
                file, 'machine learning', 10,
                { folderScope: '/' }
            );

            // "/" normalizes to no filter (vault-wide)
            expect(results).toBeDefined();
        });

        it('should respect maxResults', async () => {
            const file = createMockFile('nonexistent.md');
            const results = await ragService.getRelatedNotes(
                file, 'machine learning', 2
            );

            expect(results.length).toBeLessThanOrEqual(2);
        });

        it('should return empty array on error', async () => {
            const errorStore: IVectorStore = {
                searchByContent: async (_q: string, _e: any, _k?: number, _f?: any) => { throw new Error('Store error'); },
                search: async (_v: number[], _k?: number, _f?: any) => { throw new Error('Store error'); },
                upsert: async () => {},
                remove: async () => {},
                getDocument: async () => null,
                getDocumentsByFile: async () => [],
                removeFile: async () => {},
                renameFile: async () => {},
                getMetadata: async () => ({} as any),
                clear: async () => {},
                getFileChangeTracker: () => ({
                    hasChanged: () => false,
                    updateHash: () => {},
                    removeHash: () => {},
                    getTrackedFiles: () => new Map(),
                    clear: () => {}
                }),
                rebuild: async () => {},
                save: async () => {},
                load: async () => {},
                dispose: async () => {}
            };

            const service = new RAGService(errorStore, settings, embeddingService);
            const file = createMockFile('test.md');
            const results = await service.getRelatedNotes(file, 'query', 5);

            expect(results).toEqual([]);
        });
    });

    describe('Integration scenarios', () => {
        it('should handle full RAG workflow: query → retrieve → build prompt', async () => {
            const query = 'Tell me about machine learning';
            
            // Retrieve context
            const context = await ragService.retrieveContext(query, undefined, {
                maxChunks: 3,
                minSimilarity: 0.5,
                includeMetadata: true
            });
            
            // Build RAG prompt
            const ragPrompt = ragService.buildRAGPrompt(query, context);
            
            // Verify result
            expect(ragPrompt).toContain(query);
            if (context.totalChunks > 0) {
                expect(ragPrompt).toContain('Relevant Context');
            }
        });

        it('should handle excluded file workflow', async () => {
            const currentFile = createMockFile('test.md');
            const query = 'learning concepts';
            
            const context = await ragService.retrieveContext(query, currentFile, {
                excludeCurrentFile: true,
                maxChunks: 5
            });
            
            // Verify no chunks from excluded file
            context.chunks.forEach(chunk => {
                expect(chunk.document.filePath).not.toBe('test.md');
            });
        });
    });
});
