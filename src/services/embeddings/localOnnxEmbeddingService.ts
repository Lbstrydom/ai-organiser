import type { IEmbeddingService, EmbeddingResult, BatchEmbeddingResult, EmbeddingModelInfo } from './types';

const MODEL_DIMENSIONS: Record<string, number> = {
    'Xenova/all-MiniLM-L6-v2': 384,
    'Xenova/bge-small-en-v1.5': 384,
    'nomic-ai/nomic-embed-text-v1.5': 768,
};

/**
 * Pin known models to an immutable commit SHA rather than Hugging Face
 * Hub's mutable `main` branch default (npm-audit-remediation plan,
 * Cluster 4, Gemini gate round 3 G1) — a compromise of the upstream HF
 * account could otherwise push different model bytes to every opted-in
 * user with no version bump or code change on our side. All three models
 * offered by the local-onnx model dropdown (embeddingRegistry.ts
 * EMBEDDING_MODELS['local-onnx']) are pinned — audit H3/M9/H8 caught that
 * only the default was covered, while the other two are equally reachable
 * via the settings UI. Verified 2026-07-13/14 against
 * https://huggingface.co/api/models/<id> (see
 * docs/dependency-accepted-risks.md for the update procedure).
 *
 * `getPipeline()` REJECTS any modelId outside this map (audit H4/M3/H7,
 * round 3) rather than falling back to `main` — this is intentionally a
 * SECOND enforcement point, not the only one: `resolveLocalOnnxEmbeddingService()`
 * (embeddingServiceFactory.ts) already validates against this same set
 * before ever constructing this class, but relying solely on the one
 * caller currently doing that would leave the guarantee dependent on
 * every future caller remembering to re-implement it. The class enforces
 * its own invariant regardless of who constructs it.
 */
const MODEL_REVISIONS: Record<string, string> = {
    'Xenova/all-MiniLM-L6-v2': '751bff37182d3f1213fa05d7196b954e230abad9',
    'Xenova/bge-small-en-v1.5': 'ea104dacec62c0de699686887e3f920caeb4f3e3',
    'nomic-ai/nomic-embed-text-v1.5': 'e9b6763023c676ca8431644204f50c2b100d9aab',
};

// `dispose` is optional in the type — Transformers.js attaches it to the
// callable pipeline object it returns, but this codebase's own mocks/tests
// construct plain functions without it (Gemini gate final round G1: the
// underlying ONNX Runtime Web session holds WASM heap memory that is NOT
// reliably garbage-collected by the JS engine and must be explicitly
// released, or repeated toggle/model-switch/init-race cycles leak memory
// until Obsidian OOMs).
type FeatureExtractionPipeline = ((text: string | string[], options?: { pooling?: 'none' | 'cls' | 'mean'; normalize?: boolean }) => Promise<{ data: Float32Array }>) & { dispose?: () => Promise<void> };

export class LocalOnnxEmbeddingService implements IEmbeddingService {
    private pipeline: FeatureExtractionPipeline | null = null;
    private modelId: string;
    private isDisposed = false;
    private activeInferences = 0;

    constructor(modelId = 'Xenova/all-MiniLM-L6-v2') {
        this.modelId = modelId;
    }

    /** Max chunks per single network request (D4.4 — queue dequeue size). */
    get maxBatchSize(): number {
        return 32;
    }

    async generateEmbedding(text: string): Promise<EmbeddingResult> {
        // Gemini gate final round 2, G2: a permanently-disposed instance
        // must never silently "resurrect" itself by starting a new init —
        // a long-running batchGenerateEmbeddings() loop that outlives a
        // dispose() call (e.g. the user toggled the feature off mid-index)
        // would otherwise keep downloading/running inference indefinitely.
        if (this.isDisposed) {
            return { success: false, error: 'Service disposed' };
        }
        this.activeInferences++;
        try {
            const pipe = await this.getPipeline();
            const result = await pipe(text, { pooling: 'mean', normalize: true });
            const embedding: number[] = Array.from(result.data);
            return { success: true, embedding };
        } catch (error) {
            return { success: false, error: String(error) };
        } finally {
            this.activeInferences--;
            // Gemini gate final round 2, G1 (self-correction of the round-1
            // fix): a dispose() that arrived while THIS inference was
            // actively inside the WASM pipeline call deferred physical
            // teardown (see dispose()) rather than freeing memory out from
            // under an active prediction. Once the last active inference
            // finishes, complete the deferred teardown.
            if (this.isDisposed && this.activeInferences === 0) {
                await this.teardownPipeline();
            }
        }
    }

    async batchGenerateEmbeddings(texts: string[]): Promise<BatchEmbeddingResult> {
        try {
            const embeddings: number[][] = [];
            for (const text of texts) {
                const result = await this.generateEmbedding(text);
                if (!result.success || !result.embedding) {
                    return { success: false, error: result.error };
                }
                embeddings.push(result.embedding);
            }
            return { success: true, embeddings };
        } catch (error) {
            return { success: false, error: String(error) };
        }
    }

    getModelDimensions(): number {
        return MODEL_DIMENSIONS[this.modelId] ?? 384;
    }

    getModelName(): string {
        return this.modelId;
    }

    getModelInfo(): EmbeddingModelInfo {
        return {
            provider: 'local-onnx',
            model: this.modelId,
            dimensions: this.getModelDimensions(),
            maxTokens: 512,
        };
    }

    async testConnection(): Promise<{ success: boolean; error?: string }> {
        // audit-caught (H2/M15): generateEmbedding() never throws — it
        // catches pipeline/import/inference failures internally and
        // returns a failure Result. Awaiting it without inspecting
        // `.success` meant this reported success unconditionally, even
        // when the embedding backend was completely unavailable.
        try {
            const result = await this.generateEmbedding('test');
            if (!result.success) {
                return { success: false, error: result.error ?? 'Embedding test failed' };
            }
            return { success: true };
        } catch (error) {
            return { success: false, error: String(error) };
        }
    }

    async dispose(): Promise<void> {
        // Permanent — this instance never does new work again, matching the
        // real call pattern (main.ts always discards a disposed instance
        // and constructs a fresh one for whatever comes next; it never
        // reuses one). Set BEFORE the active-inference check so no new
        // generateEmbedding() call can start in the window while we decide
        // whether to tear down immediately or defer.
        this.isDisposed = true;
        if (this.activeInferences > 0) {
            // Gemini gate final round 2, G1: freeing the WASM session's
            // memory while generateEmbedding() is actively inside
            // pipe(text, ...) can crash the Obsidian renderer (the C++ WASM
            // bindings access linear memory that would be pulled out from
            // under them mid-call). Defer physical teardown — the last
            // active inference's own `finally` block (in generateEmbedding)
            // completes it once it's actually safe. No new inference can
            // start in the meantime (isDisposed is already true above).
            return;
        }
        await this.teardownPipeline();
    }

    private async teardownPipeline(): Promise<void> {
        // Gemini gate final round 1, G1: release the underlying ONNX
        // Runtime Web session's WASM heap explicitly — clearing our own
        // reference doesn't free it, and it isn't reliably garbage-collected.
        // Safe to call more than once: `?.` no-ops once `this.pipeline` is
        // already null.
        await this.pipeline?.dispose?.();
        this.pipeline = null;
        this.pipelinePromise = null;
    }

    private pipelinePromise: Promise<FeatureExtractionPipeline> | null = null;

    private async getPipeline(): Promise<FeatureExtractionPipeline> {
        if (this.pipeline) return this.pipeline;
        // audit-caught (M5/M12): cache the IN-FLIGHT promise, not just the
        // resolved pipeline — without this, concurrent first-callers each
        // independently triggered a separate model download/init.
        if (this.pipelinePromise) return this.pipelinePromise;
        // audit-caught (H4/M3/H7, round 3): reject an unpinned model id
        // HERE, at the class's own enforcement point, rather than relying
        // solely on the factory's pre-construction check — a defense-in-
        // depth guarantee that holds regardless of how this instance was
        // constructed. Thrown (not a silent fallback to `main`);
        // generateEmbedding()'s try/catch converts it to a failure Result.
        const revision = MODEL_REVISIONS[this.modelId];
        if (!revision) {
            throw new Error(`Unsupported local-onnx model id: ${this.modelId}`);
        }
        this.pipelinePromise = (async () => {
            // Dynamic import — not bundled by default
            // @ts-ignore — optional peer dependency
            const { pipeline } = await import('@xenova/transformers');
            const pipe = (await pipeline('feature-extraction', this.modelId, { revision })) as unknown as FeatureExtractionPipeline;
            // No isDisposed special-case here (Gemini gate final round 2):
            // the only way this init is still running after dispose() is
            // that dispose() saw activeInferences > 0 and deferred — i.e.
            // THIS specific in-flight generateEmbedding() call is exactly
            // the active inference being waited on. Storing the pipeline
            // normally lets that call's own `finally` block find and
            // dispose it via the shared teardownPipeline() path once its
            // inference completes — no separate disposal path needed here.
            this.pipeline = pipe;
            return pipe;
        })();
        try {
            return await this.pipelinePromise;
        } finally {
            this.pipelinePromise = null;
        }
    }
}
