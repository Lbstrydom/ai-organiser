import type { IEmbeddingService, EmbeddingResult, BatchEmbeddingResult, EmbeddingModelInfo } from './types';

const MODEL_DIMENSIONS: Record<string, number> = {
    'Xenova/all-MiniLM-L6-v2': 384,
    'Xenova/bge-small-en-v1.5': 384,
    'nomic-ai/nomic-embed-text-v1.5': 768,
};

export class LocalOnnxEmbeddingService implements IEmbeddingService {
    private pipeline: any = null;
    private modelId: string;

    constructor(modelId = 'Xenova/all-MiniLM-L6-v2') {
        this.modelId = modelId;
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

    async dispose(): Promise<void> {
        this.pipeline = null;
    }

    private async getPipeline(): Promise<any> {
        if (this.pipeline) return this.pipeline;
        // Dynamic import — not bundled by default
        // @ts-ignore — optional peer dependency
        const { pipeline } = await import('@xenova/transformers');
        this.pipeline = await pipeline('feature-extraction', this.modelId);
        return this.pipeline;
    }
}
