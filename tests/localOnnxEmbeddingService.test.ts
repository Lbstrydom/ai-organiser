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

        // audit-caught (H2/M15): generateEmbedding() never throws — it
        // catches internally and returns a failure Result. testConnection()
        // previously awaited that Result without inspecting `.success`,
        // so a broken embedding backend was reported as a successful
        // connection. This is the regression lock for that fix.
        it('returns failure when the embedding call itself fails, instead of reporting success', async () => {
            const svc = new LocalOnnxEmbeddingService();
            vi.spyOn(svc, 'generateEmbedding').mockResolvedValueOnce({ success: false, error: 'model load failed' });
            const result = await svc.testConnection();
            expect(result.success).toBe(false);
            expect(result.error).toBe('model load failed');
        });

        it('falls back to a default error message when the failed Result carries none', async () => {
            const svc = new LocalOnnxEmbeddingService();
            vi.spyOn(svc, 'generateEmbedding').mockResolvedValueOnce({ success: false });
            const result = await svc.testConnection();
            expect(result.success).toBe(false);
            expect(result.error).toBe('Embedding test failed');
        });
    });

    describe('concurrent initialization (audit-caught M5/M12)', () => {
        it('shares one in-flight pipeline promise across concurrent calls instead of initializing twice', async () => {
            const { pipeline } = await import('@xenova/transformers');
            const pipelineMock = pipeline as unknown as ReturnType<typeof vi.fn>;
            pipelineMock.mockClear();
            const svc = new LocalOnnxEmbeddingService();
            const [a, b] = await Promise.all([
                svc.generateEmbedding('concurrent one'),
                svc.generateEmbedding('concurrent two'),
            ]);
            expect(a.success).toBe(true);
            expect(b.success).toBe(true);
            expect(pipelineMock).toHaveBeenCalledTimes(1);
        });

        // audit-caught (M2/M5, round 2): dispose() during an in-flight init
        // used to clear this.pipeline/this.pipelinePromise, but the
        // in-flight async work kept running regardless and would resurrect
        // this.pipeline once it resolved — a disposed instance silently
        // becoming "ready" again with a stale pipeline reference.
        it('discards an in-flight init\'s result if dispose() was called before it resolved', async () => {
            const { pipeline } = await import('@xenova/transformers');
            const pipelineMock = pipeline as unknown as ReturnType<typeof vi.fn>;
            let resolveInit: ((fn: () => Promise<{ data: Float32Array }>) => void) | undefined;
            pipelineMock.mockImplementationOnce(() => new Promise((resolve) => { resolveInit = resolve; }));

            const svc = new LocalOnnxEmbeddingService();
            const inFlight = svc.generateEmbedding('will be disposed mid-flight');

            // The mock's Promise executor (which captures resolveInit) only
            // runs once execution reaches the `pipeline(...)` call inside
            // getPipeline()'s IIFE — which is itself preceded by an awaited
            // dynamic import. Wait for that microtask chain to actually get
            // there before disposing, or dispose() races ahead of it.
            await vi.waitFor(() => { if (!resolveInit) throw new Error('not yet'); });

            await svc.dispose();
            // Now let the init actually complete, AFTER disposal.
            resolveInit!(vi.fn().mockResolvedValue({ data: new Float32Array([0.1]) }));
            await inFlight;

            // A fresh call after disposal must trigger a genuinely NEW init
            // (proving the disposed init's result was discarded, not reused).
            pipelineMock.mockClear();
            pipelineMock.mockResolvedValueOnce(vi.fn().mockResolvedValue({ data: new Float32Array([0.2]) }));
            const after = await svc.generateEmbedding('after dispose');
            expect(after.success).toBe(true);
            expect(pipelineMock).toHaveBeenCalledTimes(1);
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
