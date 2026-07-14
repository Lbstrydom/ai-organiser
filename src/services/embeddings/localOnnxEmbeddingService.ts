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
 * user with no version bump or code change on our side. Verified
 * 2026-07-13 against https://huggingface.co/api/models/Xenova/all-MiniLM-L6-v2
 * (see docs/dependency-accepted-risks.md for the update procedure). Only
 * the default model is currently pinned — a model not in this map falls
 * back to `main` (documented gap, not a silent unpinned default: this is
 * the ONLY model this plan's security review verified).
 */
const MODEL_REVISIONS: Record<string, string> = {
    'Xenova/all-MiniLM-L6-v2': '751bff37182d3f1213fa05d7196b954e230abad9',
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
