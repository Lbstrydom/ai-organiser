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
 * docs/dependency-accepted-risks.md for the update procedure). A caller-
 * supplied `modelId` outside this map (not offered by any UI — the type is
 * an unconstrained string) still falls back to `main` — that residual gap
 * is documented in docs/dependency-accepted-risks.md rather than silently
 * unpinned.
 */
const MODEL_REVISIONS: Record<string, string> = {
    'Xenova/all-MiniLM-L6-v2': '751bff37182d3f1213fa05d7196b954e230abad9',
    'Xenova/bge-small-en-v1.5': 'ea104dacec62c0de699686887e3f920caeb4f3e3',
    'nomic-ai/nomic-embed-text-v1.5': 'e9b6763023c676ca8431644204f50c2b100d9aab',
};

type FeatureExtractionPipeline = (text: string | string[], options?: { pooling?: 'none' | 'cls' | 'mean'; normalize?: boolean }) => Promise<{ data: Float32Array }>;

export class LocalOnnxEmbeddingService implements IEmbeddingService {
    private pipeline: FeatureExtractionPipeline | null = null;
    private modelId: string;

    constructor(modelId = 'Xenova/all-MiniLM-L6-v2') {
        this.modelId = modelId;
    }

    /** Max chunks per single network request (D4.4 — queue dequeue size). */
    get maxBatchSize(): number {
        return 32;
    }

    async generateEmbedding(text: string): Promise<EmbeddingResult> {
        try {
            const pipe = await this.getPipeline();
            const result = await pipe(text, { pooling: 'mean', normalize: true });
            const embedding: number[] = Array.from(result.data);
            return { success: true, embedding };
        } catch (error) {
            return { success: false, error: String(error) };
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

    dispose(): Promise<void> {
        this.pipeline = null;
        this.pipelinePromise = null;
        // audit-caught (M2/M5, round 2): a dispose() call while an init was
        // still in flight cleared these fields, but the in-flight async work
        // kept running regardless and would resurrect `this.pipeline` on a
        // disposed instance once it resolved. A plain boolean flag isn't
        // enough — a SECOND dispose+reinit racing against the first init's
        // still-pending resolution would reset the flag before the first
        // init's completion check ever ran. A monotonic generation counter
        // fixes this: each init captures the generation it started under,
        // and only commits its result if that generation is still current
        // — bumping the generation on EVERY dispose (not just setting a
        // flag) invalidates every init that started before it, regardless
        // of how many dispose/reinit cycles race in between.
        this.generation++;
        return Promise.resolve();
    }

    private pipelinePromise: Promise<FeatureExtractionPipeline> | null = null;
    private generation = 0;

    private async getPipeline(): Promise<FeatureExtractionPipeline> {
        if (this.pipeline) return this.pipeline;
        // audit-caught (M5/M12): cache the IN-FLIGHT promise, not just the
        // resolved pipeline — without this, concurrent first-callers each
        // independently triggered a separate model download/init.
        if (this.pipelinePromise) return this.pipelinePromise;
        const startedAtGeneration = this.generation;
        this.pipelinePromise = (async () => {
            // Dynamic import — not bundled by default
            // @ts-ignore — optional peer dependency
            const { pipeline } = await import('@xenova/transformers');
            const revision = MODEL_REVISIONS[this.modelId];
            const options = revision ? { revision } : undefined;
            const pipe = (await pipeline('feature-extraction', this.modelId, options)) as unknown as FeatureExtractionPipeline;
            if (this.generation !== startedAtGeneration) return pipe;
            this.pipeline = pipe;
            return pipe;
        })();
        try {
            return await this.pipelinePromise;
        } finally {
            // Clear the in-flight marker regardless of outcome — a failed
            // init must not permanently wedge every future call behind a
            // rejected promise; `this.pipeline` (set only on success) is
            // the real completion marker. Only clear it if THIS init is
            // still the current one — a superseded init's `finally` must
            // not clobber a newer init's own in-flight promise.
            if (this.generation === startedAtGeneration) {
                this.pipelinePromise = null;
            }
        }
    }
}
