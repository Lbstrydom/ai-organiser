/**
 * Voyage AI Embedding Service
 * Generates embeddings using Voyage AI models (high quality embeddings)
 */

import { requestUrl, RequestUrlParam } from 'obsidian';
import {
    IEmbeddingService,
    EmbeddingResult,
    BatchEmbeddingResult,
    EmbeddingModelInfo
} from './types';
import { logger } from '../../utils/logger';

/**
 * Voyage Embedding Service Configuration
 */
export interface VoyageEmbeddingConfig {
    apiKey: string;
    model?: string;
}

// Voyage embedding model dimensions
const VOYAGE_DIMENSIONS: Record<string, number> = {
    'voyage-3': 1024,
    'voyage-3-lite': 512,
    'voyage-code-3': 1024,
    'voyage-finance-2': 1024,
    'voyage-law-2': 1024,
    'voyage-large-2': 1536,
    'voyage-2': 1024,
    'default': 1024
};

/**
 * Voyage AI Embedding Service Implementation
 * Uses Voyage AI's /v1/embeddings endpoint
 */
export class VoyageEmbeddingService implements IEmbeddingService {
    private apiKey: string;
    private model: string;
    private dimensions: number;
    private endpoint: string = 'https://api.voyageai.com/v1/embeddings';

    constructor(config: VoyageEmbeddingConfig) {
        this.apiKey = config.apiKey;
        this.model = config.model || 'voyage-3';
        this.dimensions = VOYAGE_DIMENSIONS[this.model] || VOYAGE_DIMENSIONS['default'];
    }

    async generateEmbedding(text: string): Promise<EmbeddingResult> {
        try {
            if (!text.trim()) {
                return { success: false, error: 'Empty text provided' };
            }

            const requestParams: RequestUrlParam = {
                url: this.endpoint,
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: this.model,
                    input: [text],
                    input_type: 'document'
                })
            };

            const response = await requestUrl(requestParams);

            if (response.status !== 200) {
                const error = response.json?.detail || response.json?.error || `HTTP ${response.status}`;
                return { success: false, error };
            }

            const data = response.json;
            if (!data.data || !data.data[0] || !data.data[0].embedding) {
                return { success: false, error: 'Invalid response format' };
            }

            return {
                success: true,
                embedding: data.data[0].embedding,
                tokenCount: data.usage?.total_tokens
            };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            logger.error('Search', 'Voyage embedding error:', errorMessage);
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

            // Voyage supports batch embedding up to 128 texts
            const maxBatchSize = 128;
            const batches: string[][] = [];
            for (let i = 0; i < validTexts.length; i += maxBatchSize) {
                batches.push(validTexts.slice(i, i + maxBatchSize));
            }

            const allEmbeddings: number[][] = [];
            let totalTokens = 0;

            for (const batch of batches) {
                const requestParams: RequestUrlParam = {
                    url: this.endpoint,
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${this.apiKey}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        model: this.model,
                        input: batch,
                        input_type: 'document'
                    })
                };

                const response = await requestUrl(requestParams);

                if (response.status !== 200) {
                    const error = response.json?.detail || response.json?.error || `HTTP ${response.status}`;
                    return { success: false, error };
                }

                const data = response.json;
                if (!data.data || !Array.isArray(data.data)) {
                    return { success: false, error: 'Invalid response format' };
                }

                // Sort by index to maintain order
                const sortedData = data.data.sort((a: any, b: any) => a.index - b.index);
                for (const item of sortedData) {
                    allEmbeddings.push(item.embedding);
                }

                if (data.usage?.total_tokens) {
                    totalTokens += data.usage.total_tokens;
                }
            }

            return {
                success: true,
                embeddings: allEmbeddings,
                totalTokens
            };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            logger.error('Search', 'Voyage batch embedding error:', errorMessage);
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
            provider: 'voyage',
            model: this.model,
            dimensions: this.dimensions,
            maxTokens: 32000 // Voyage-3 supports up to 32k tokens
        };
    }

    async testConnection(): Promise<{ success: boolean; error?: string }> {
        try {
            const result = await this.generateEmbedding('test');
            return result.success
                ? { success: true }
                : { success: false, error: result.error };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            return { success: false, error: errorMessage };
        }
    }

    async dispose(): Promise<void> {
        // No resources to clean up
    }
}
