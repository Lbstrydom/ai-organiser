/**
 * Tests for LocalOnnxEmbeddingService
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LocalOnnxEmbeddingService } from '../src/services/embeddings/localOnnxEmbeddingService';

// Mock @xenova/transformers dynamic import
vi.mock('@xenova/transformers', () => ({
    pipeline: vi.fn().mockResolvedValue(
        vi.fn().mockResolvedValue({ data: new Float32Array([0.1, 0.2, 0.3, 0.4]) })
    ),
}));

describe('LocalOnnxEmbeddingService', () => {
    describe('getModelDimensions', () => {
        it('returns 384 for default model', () => {
            const svc = new LocalOnnxEmbeddingService();
            expect(svc.getModelDimensions()).toBe(384);
        });

        it('returns 768 for nomic model', () => {
            const svc = new LocalOnnxEmbeddingService('nomic-ai/nomic-embed-text-v1.5');
            expect(svc.getModelDimensions()).toBe(768);
        });

        it('returns 384 for unknown model (fallback)', () => {
            const svc = new LocalOnnxEmbeddingService('unknown/model');
            expect(svc.getModelDimensions()).toBe(384);
        });
    });

    describe('getModelName', () => {
        it('returns the model ID', () => {
            const svc = new LocalOnnxEmbeddingService('Xenova/bge-small-en-v1.5');
            expect(svc.getModelName()).toBe('Xenova/bge-small-en-v1.5');
        });
    });

    describe('getModelInfo', () => {
        it('returns correct provider and dimensions', () => {
            const svc = new LocalOnnxEmbeddingService();
            const info = svc.getModelInfo();
            expect(info.provider).toBe('local-onnx');
            expect(info.dimensions).toBe(384);
            expect(info.maxTokens).toBe(512);
            expect(info.model).toBe('Xenova/all-MiniLM-L6-v2');
        });
    });

    describe('generateEmbedding', () => {
        it('returns success with embedding array', async () => {
            const svc = new LocalOnnxEmbeddingService();
            const result = await svc.generateEmbedding('hello world');
            expect(result.success).toBe(true);
            expect(result.embedding).toBeDefined();
            expect(Array.isArray(result.embedding)).toBe(true);
        });

        it('returns failure on pipeline error', async () => {
            // Simulate pipeline failure by making getPipeline throw
            const svc = new LocalOnnxEmbeddingService('bad/model');
            // Spy on the private method through mock replacement
            vi.spyOn(svc as any, 'getPipeline').mockRejectedValueOnce(new Error('Pipeline failed'));
            const result = await svc.generateEmbedding('test');
            expect(result.success).toBe(false);
            expect(result.error).toContain('Pipeline failed');
        });
    });

    describe('batchGenerateEmbeddings', () => {
        it('returns success with array of embeddings', async () => {
            const svc = new LocalOnnxEmbeddingService();
            const result = await svc.batchGenerateEmbeddings(['text one', 'text two']);
            expect(result.success).toBe(true);
            expect(result.embeddings).toHaveLength(2);
        });

        it('returns failure if any individual embedding fails', async () => {
            const svc = new LocalOnnxEmbeddingService();
            vi.spyOn(svc as any, 'getPipeline')
                .mockResolvedValueOnce(vi.fn().mockResolvedValue({ data: new Float32Array([0.1]) }))
                .mockRejectedValueOnce(new Error('batch fail'));
            const result = await svc.batchGenerateEmbeddings(['ok', 'fail']);
            expect(result.success).toBe(false);
        });
    });

    describe('testConnection', () => {
        it('returns success when pipeline loads', async () => {
            const svc = new LocalOnnxEmbeddingService();
            const result = await svc.testConnection();
            expect(result.success).toBe(true);
        });
    });

    describe('dispose', () => {
        it('clears pipeline without error', async () => {
            const svc = new LocalOnnxEmbeddingService();
            await svc.generateEmbedding('prime the pipeline');
            await expect(svc.dispose()).resolves.toBeUndefined();
        });
    });
});
