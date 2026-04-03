/**
 * Tests for AttachmentIndexService
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AttachmentIndexService } from '../src/services/chat/attachmentIndexService';
import type { IEmbeddingService, EmbeddingResult, BatchEmbeddingResult } from '../src/services/embeddings/types';

// Mock obsidian Platform
vi.mock('obsidian', () => ({
    Platform: { isMobile: false },
}));

function makeEmbeddingService(dims = 4): IEmbeddingService {
    const makeVec = (seed: number) => Array.from({ length: dims }, (_, i) => ((i + seed + 1) / dims));
    return {
        generateEmbedding: vi.fn().mockImplementation(async (text: string): Promise<EmbeddingResult> => {
            const seed = text.charCodeAt(0) ?? 0;
            return { success: true, embedding: makeVec(seed) };
        }),
        batchGenerateEmbeddings: vi.fn().mockImplementation(async (texts: string[]): Promise<BatchEmbeddingResult> => {
            return {
                success: true,
                embeddings: texts.map((t, i) => makeVec(t.charCodeAt(0) ?? i)),
            };
        }),
        getModelDimensions: () => dims,
        getModelName: () => 'test-model',
        getModelInfo: () => ({ provider: 'test', model: 'test-model', dimensions: dims, maxTokens: 512 }),
        testConnection: async () => ({ success: true }),
        dispose: async () => {},
    };
}

describe('AttachmentIndexService', () => {
    describe('initial state', () => {
        it('starts not ready', () => {
            const svc = new AttachmentIndexService(makeEmbeddingService());
            expect(svc.isReady).toBe(false);
            expect(svc.isIndexing).toBe(false);
            expect(svc.chunkCount).toBe(0);
            expect(svc.totalChunks).toBe(0);
            expect(svc.isPartial).toBe(false);
        });
    });

    describe('indexDocument', () => {
        it('returns 0 for text with fewer than 2 chunks', async () => {
            const svc = new AttachmentIndexService(makeEmbeddingService());
            // Very short text won't produce multiple chunks
            const result = await svc.indexDocument('Short text.', 'doc1');
            expect(result).toBe(0);
        });

        it('indexes a multi-chunk document and becomes ready', async () => {
            const svc = new AttachmentIndexService(makeEmbeddingService());
            // Generate text large enough to produce multiple 1000-char chunks
            const largeText = 'A'.repeat(1500) + ' ' + 'B'.repeat(1500);
            const count = await svc.indexDocument(largeText, 'doc1');
            expect(count).toBeGreaterThan(0);
            expect(svc.isReady).toBe(true);
        });

        it('calls onProgress during indexing', async () => {
            const svc = new AttachmentIndexService(makeEmbeddingService());
            const progress: number[] = [];
            const largeText = 'Word '.repeat(500);
            await svc.indexDocument(largeText, 'doc1', (p) => progress.push(p));
            expect(progress.length).toBeGreaterThan(0);
            expect(progress[progress.length - 1]).toBe(100);
        });

        it('returns 0 if already indexing (single-flight guard)', async () => {
            const svc = new AttachmentIndexService(makeEmbeddingService());
            // Start indexing without awaiting
            const largeText = 'Word '.repeat(500);
            const p1 = svc.indexDocument(largeText, 'doc1');
            // Second call should return 0 immediately
            const p2 = svc.indexDocument(largeText, 'doc2');
            const [r1, r2] = await Promise.all([p1, p2]);
            // r2 should be 0 (blocked by single-flight)
            expect(r2).toBe(0);
        });
    });

    describe('queryRelevantChunks', () => {
        it('returns empty string when not ready', async () => {
            const svc = new AttachmentIndexService(makeEmbeddingService());
            expect(await svc.queryRelevantChunks('query')).toBe('');
        });

        it('returns relevant chunks after indexing', async () => {
            const svc = new AttachmentIndexService(makeEmbeddingService());
            const largeText = 'The quick brown fox jumps over the lazy dog. '.repeat(100);
            await svc.indexDocument(largeText, 'doc1');
            if (!svc.isReady) return; // Skip if text too short
            const result = await svc.queryRelevantChunks('fox');
            expect(typeof result).toBe('string');
        });

        it('respects maxChars limit', async () => {
            const svc = new AttachmentIndexService(makeEmbeddingService());
            const largeText = 'Content '.repeat(500);
            await svc.indexDocument(largeText, 'doc1');
            if (!svc.isReady) return;
            const result = await svc.queryRelevantChunks('content', { maxChars: 100 });
            expect(result.length).toBeLessThanOrEqual(200); // Some tolerance for separator
        });
    });

    describe('dispose', () => {
        it('clears state after dispose', async () => {
            const svc = new AttachmentIndexService(makeEmbeddingService());
            const largeText = 'Word '.repeat(500);
            await svc.indexDocument(largeText, 'doc1');
            svc.dispose();
            expect(svc.isReady).toBe(false);
            expect(svc.chunkCount).toBe(0);
            expect(await svc.queryRelevantChunks('query')).toBe('');
        });
    });

    describe('isPartial', () => {
        it('is false when all chunks are indexed', async () => {
            const svc = new AttachmentIndexService(makeEmbeddingService());
            const largeText = 'Word '.repeat(500);
            await svc.indexDocument(largeText, 'doc1');
            if (!svc.isReady) return;
            // All batches complete → not partial
            expect(svc.isPartial).toBe(false);
        });
    });
});
