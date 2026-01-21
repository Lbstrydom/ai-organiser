/**
 * OpenAI Embedding Service
 * Generates embeddings using OpenAI's text-embedding-3 models
 */

import { requestUrl, RequestUrlParam } from 'obsidian';
import {
    IEmbeddingService,
    EmbeddingResult,
    BatchEmbeddingResult,
    EmbeddingModelInfo,
    getEmbeddingDimensions
} from './types';

/**
 * OpenAI Embedding Service Configuration
 */
export interface OpenAIEmbeddingConfig {
    apiKey: string;
    model?: string;
    endpoint?: string;
}

/**
 * OpenAI Embedding Service Implementation
 * Uses OpenAI's /v1/embeddings endpoint
 */
export class OpenAIEmbeddingService implements IEmbeddingService {
    private apiKey: string;
    private model: string;
    private endpoint: string;
    private dimensions: number;

    constructor(config: OpenAIEmbeddingConfig) {
        this.apiKey = config.apiKey;
        this.model = config.model || 'text-embedding-3-small';
        this.endpoint = config.endpoint || 'https://api.openai.com/v1/embeddings';
        this.dimensions = getEmbeddingDimensions(this.model);
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
                    input: text,
                    encoding_format: 'float'
                })
            };

            const response = await requestUrl(requestParams);

            if (response.status !== 200) {
                const error = response.json?.error?.message || `HTTP ${response.status}`;
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
            console.error('OpenAI embedding error:', errorMessage);
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

            // OpenAI supports batch embedding up to 2048 inputs
            const maxBatchSize = 100;
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
                        encoding_format: 'float'
                    })
                };

                const response = await requestUrl(requestParams);

                if (response.status !== 200) {
                    const error = response.json?.error?.message || `HTTP ${response.status}`;
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
            console.error('OpenAI batch embedding error:', errorMessage);
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
            provider: 'openai',
            model: this.model,
            dimensions: this.dimensions,
            maxTokens: 8191 // OpenAI embedding models support 8191 tokens
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
