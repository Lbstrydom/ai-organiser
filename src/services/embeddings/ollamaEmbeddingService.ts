/**
 * Ollama Embedding Service
 * Generates embeddings using local Ollama models (nomic-embed-text, etc.)
 */

import { requestUrl, RequestUrlParam } from 'obsidian';
import {
    IEmbeddingService,
    EmbeddingResult,
    BatchEmbeddingResult,
    EmbeddingModelInfo,
    getEmbeddingDimensions
} from './types';
import { logger } from '../../utils/logger';

/**
 * Ollama Embedding Service Configuration
 */
export interface OllamaEmbeddingConfig {
    model?: string;
    endpoint?: string;
}

/**
 * Ollama Embedding Service Implementation
 * Uses Ollama's /api/embeddings endpoint (local)
 */
export class OllamaEmbeddingService implements IEmbeddingService {
    private model: string;
    private endpoint: string;
    private dimensions: number;

    constructor(config: OllamaEmbeddingConfig = {}) {
        this.model = config.model || 'nomic-embed-text';
        this.endpoint = config.endpoint || 'http://localhost:11434';
        this.dimensions = getEmbeddingDimensions(this.model);
    }

    async generateEmbedding(text: string): Promise<EmbeddingResult> {
        try {
            if (!text.trim()) {
                return { success: false, error: 'Empty text provided' };
            }

            // Ollama uses /api/embeddings endpoint
            const url = `${this.endpoint}/api/embeddings`;

            const requestParams: RequestUrlParam = {
                url,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: this.model,
                    prompt: text
                })
            };

            const response = await requestUrl(requestParams);

            if (response.status !== 200) {
                const error = response.json?.error || `HTTP ${response.status}`;
                return { success: false, error };
            }

            const data = response.json;
            if (!data.embedding || !Array.isArray(data.embedding)) {
                return { success: false, error: 'Invalid response format' };
            }

            // Update dimensions if we get actual embedding size
            if (data.embedding.length !== this.dimensions) {
                this.dimensions = data.embedding.length;
            }

            return {
                success: true,
                embedding: data.embedding,
                tokenCount: Math.ceil(text.length / 4) // Approximate
            };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';

            // Check for connection refused (Ollama not running)
            if (errorMessage.includes('ECONNREFUSED') || errorMessage.includes('fetch')) {
                return {
                    success: false,
                    error: 'Ollama not running. Start Ollama with: ollama serve'
                };
            }

            logger.error('Search', 'Ollama embedding error:', errorMessage);
            return { success: false, error: errorMessage };
        }
    }

    async batchGenerateEmbeddings(texts: string[]): Promise<BatchEmbeddingResult> {
        try {
            // Filter out empty texts
            const validTexts = texts.filter(t => t.trim());
            if (validTexts.length === 0) {
                return { success: false, error: 'No valid texts provided' };
            }

            // Ollama doesn't support batch embeddings natively
            // We process one at a time (could parallelize with Promise.all)
            const embeddings: number[][] = [];
            let totalTokens = 0;

            // Process in small parallel batches to avoid overwhelming local system
            const batchSize = 5;
            for (let i = 0; i < validTexts.length; i += batchSize) {
                const batch = validTexts.slice(i, i + batchSize);
                const results = await Promise.all(
                    batch.map(text => this.generateEmbedding(text))
                );

                for (const result of results) {
                    if (!result.success || !result.embedding) {
                        return {
                            success: false,
                            error: result.error || 'Failed to generate embedding'
                        };
                    }
                    embeddings.push(result.embedding);
                    totalTokens += result.tokenCount || 0;
                }
            }

            return {
                success: true,
                embeddings,
                totalTokens
            };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            logger.error('Search', 'Ollama batch embedding error:', errorMessage);
            return { success: false, error: errorMessage };
        }
    }

    getModelDimensions(): number {
        return this.dimensions;
    }

    getModelName(): string {
        return this.model;
    }

    getModelInfo(): EmbeddingModelInfo {
        return {
            provider: 'ollama',
            model: this.model,
            dimensions: this.dimensions,
            maxTokens: 8192 // Most Ollama embedding models support 8192
        };
    }

    async testConnection(): Promise<{ success: boolean; error?: string }> {
        try {
            // First check if Ollama is running
            const url = `${this.endpoint}/api/tags`;
            const response = await requestUrl({ url, method: 'GET' });

            if (response.status !== 200) {
                return { success: false, error: 'Ollama not responding' };
            }

            // Check if the model is available
            const models = response.json?.models || [];
            const hasModel = models.some((m: { name: string }) =>
                m.name === this.model ||
                m.name.startsWith(`${this.model}:`)
            );

            if (!hasModel) {
                return {
                    success: false,
                    error: `Model "${this.model}" not found. Install with: ollama pull ${this.model}`
                };
            }

            // Test actual embedding generation
            const result = await this.generateEmbedding('test');
            return result.success
                ? { success: true }
                : { success: false, error: result.error };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';

            if (errorMessage.includes('ECONNREFUSED') || errorMessage.includes('fetch')) {
                return {
                    success: false,
                    error: 'Ollama not running. Start with: ollama serve'
                };
            }

            return { success: false, error: errorMessage };
        }
    }

    async dispose(): Promise<void> {
        // No resources to clean up
    }

    /**
     * List available Ollama models
     */
    async listModels(): Promise<string[]> {
        try {
            const url = `${this.endpoint}/api/tags`;
            const response = await requestUrl({ url, method: 'GET' });

            if (response.status !== 200) {
                return [];
            }

            const models = response.json?.models || [];
            // Filter for embedding models
            return models
                .map((m: { name: string }) => m.name)
                .filter((name: string) =>
                    name.includes('embed') ||
                    name.includes('minilm') ||
                    name.includes('bge') ||
                    name.includes('nomic')
                );
        } catch {
            return [];
        }
    }
}
