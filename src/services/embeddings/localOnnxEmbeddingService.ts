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
        try {
            await this.generateEmbedding('test');
            return { success: true };
        } catch (error) {
            return { success: false, error: String(error) };
        }
    }

    dispose(): Promise<void> {
        this.pipeline = null;
        return Promise.resolve();
    }

    private async getPipeline(): Promise<FeatureExtractionPipeline> {
        if (this.pipeline) return this.pipeline;
        // Dynamic import — not bundled by default
        // @ts-ignore — optional peer dependency
        const { pipeline } = await import('@xenova/transformers');
        const revision = MODEL_REVISIONS[this.modelId];
        const options = revision ? { revision } : undefined;
        this.pipeline = (await pipeline('feature-extraction', this.modelId, options)) as unknown as FeatureExtractionPipeline;
        return this.pipeline;
    }
}
