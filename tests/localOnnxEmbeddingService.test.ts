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

        // audit-caught (H4/M3/H7, round 3): the class itself rejects an
        // unpinned model id — a defense-in-depth guarantee that holds even
        // if a future caller constructs this class directly, bypassing
        // resolveLocalOnnxEmbeddingService()'s own (separate) validation.
        // Unmocked getPipeline() — this exercises the REAL implementation,
        // not a spy, so it proves the class's own enforcement, not the
        // factory's.
        it('rejects an unrecognised model id at the pipeline boundary, never calling the transformers pipeline', async () => {
            const { pipeline } = await import('@xenova/transformers');
            const pipelineMock = pipeline as unknown as ReturnType<typeof vi.fn>;
            pipelineMock.mockClear();
            const svc = new LocalOnnxEmbeddingService('some-random/unreviewed-model');
            const result = await svc.generateEmbedding('test');
            expect(result.success).toBe(false);
            expect(result.error).toContain('Unsupported local-onnx model id');
            expect(pipelineMock).not.toHaveBeenCalled();
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

        // Gemini gate final round 2, G2: a long-running batch loop that
        // outlives a dispose() call (e.g. the user toggled the feature off
        // mid-index) must stop cleanly instead of silently starting a new
        // model download/init for the remaining texts.
        it('stops cleanly instead of resurrecting the service if disposed mid-batch', async () => {
            const { pipeline } = await import('@xenova/transformers');
            const pipelineMock = pipeline as unknown as ReturnType<typeof vi.fn>;
            pipelineMock.mockClear();
            const svc = new LocalOnnxEmbeddingService();
            await svc.generateEmbedding('prime the pipeline');
            pipelineMock.mockClear();

            await svc.dispose();
            const result = await svc.batchGenerateEmbeddings(['a', 'b', 'c']);

            expect(result.success).toBe(false);
            expect(result.error).toBe('Service disposed');
            expect(pipelineMock).not.toHaveBeenCalled();
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

        // Gemini gate final round 2, G1/G2 (supersedes the earlier round-1/2
        // "reinit after dispose" design): dispose() is now PERMANENT — it
        // never causes a "fresh call triggers a new init" outcome, because
        // freeing WASM memory out from under an active inference can crash
        // the renderer, and a disposed instance must never silently
        // resurrect itself. dispose() called mid-init instead DEFERS
        // physical teardown until the in-flight call (which owns the only
        // active inference) actually finishes.
        it('lets an in-flight inference complete successfully even if dispose() arrives mid-flight, then tears down afterward', async () => {
            const { pipeline } = await import('@xenova/transformers');
            const pipelineMock = pipeline as unknown as ReturnType<typeof vi.fn>;
            let resolveInit: ((fn: unknown) => void) | undefined;
            pipelineMock.mockImplementationOnce(() => new Promise((resolve) => { resolveInit = resolve; }));

            const svc = new LocalOnnxEmbeddingService();
            const inFlight = svc.generateEmbedding('will be disposed mid-flight');

            // The mock's Promise executor (which captures resolveInit) only
            // runs once execution reaches the `pipeline(...)` call inside
            // getPipeline()'s IIFE — which is itself preceded by an awaited
            // dynamic import. Wait for that microtask chain to actually get
            // there before disposing, or dispose() races ahead of it.
            await vi.waitFor(() => { if (!resolveInit) throw new Error('not yet'); });

            const disposePromise = svc.dispose();

            const pipelineDispose = vi.fn().mockResolvedValue(undefined);
            const pipeFn = Object.assign(
                vi.fn().mockResolvedValue({ data: new Float32Array([0.1, 0.2]) }),
                { dispose: pipelineDispose },
            );
            resolveInit!(pipeFn);

            // dispose() must not hang waiting for the in-flight inference —
            // it returns promptly (deferred teardown), not blocked on it.
            await disposePromise;
            expect(pipelineDispose).not.toHaveBeenCalled();

            const result = await inFlight;
            expect(result.success).toBe(true);
            // Only NOW, after the in-flight inference actually finished,
            // is the underlying WASM session torn down.
            expect(pipelineDispose).toHaveBeenCalledTimes(1);
        });

        it('rejects any call after dispose() immediately, never starting a new init (dispose is permanent)', async () => {
            const { pipeline } = await import('@xenova/transformers');
            const pipelineMock = pipeline as unknown as ReturnType<typeof vi.fn>;
            const svc = new LocalOnnxEmbeddingService();
            await svc.generateEmbedding('prime the pipeline');
            await svc.dispose();

            pipelineMock.mockClear();
            const after = await svc.generateEmbedding('after dispose');
            expect(after.success).toBe(false);
            expect(after.error).toBe('Service disposed');
            expect(pipelineMock).not.toHaveBeenCalled();
        });
    });

    describe('dispose', () => {
        it('clears pipeline without error', async () => {
            const svc = new LocalOnnxEmbeddingService();
            await svc.generateEmbedding('prime the pipeline');
            await expect(svc.dispose()).resolves.toBeUndefined();
        });

        // Gemini gate final round G1: clearing our own reference doesn't
        // free the underlying ONNX Runtime Web session's WASM heap — the
        // pipeline object's OWN dispose() must be called explicitly, or
        // repeated toggle/model-switch cycles leak memory until Obsidian
        // OOMs.
        it('calls the underlying pipeline\'s own dispose() to release WASM resources', async () => {
            const pipelineDispose = vi.fn().mockResolvedValue(undefined);
            const { pipeline } = await import('@xenova/transformers');
            const pipelineMock = pipeline as unknown as ReturnType<typeof vi.fn>;
            const pipeFn = Object.assign(
                vi.fn().mockResolvedValue({ data: new Float32Array([0.1, 0.2]) }),
                { dispose: pipelineDispose },
            );
            pipelineMock.mockResolvedValueOnce(pipeFn);

            const svc = new LocalOnnxEmbeddingService();
            await svc.generateEmbedding('prime the pipeline');
            await svc.dispose();

            expect(pipelineDispose).toHaveBeenCalledTimes(1);
        });

        it('does not throw when the underlying pipeline has no dispose() (defensive — matches this test file\'s own plain-function mocks)', async () => {
            const svc = new LocalOnnxEmbeddingService();
            await svc.generateEmbedding('prime the pipeline');
            await expect(svc.dispose()).resolves.toBeUndefined();
        });

        // The dispose-during-in-flight-init race (deferred teardown until
        // the active inference completes) is covered by the "lets an
        // in-flight inference complete successfully..." test in the
        // "concurrent initialization" describe block above.
    });
});
