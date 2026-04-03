/**
 * Cohere Embedding Service
 * Generates embeddings using Cohere's embed-v3 models
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
 * Cohere Embedding Service Configuration
 */
export interface CohereEmbeddingConfig {
    apiKey: string;
    model?: string;
}

// Cohere embedding model dimensions
const COHERE_DIMENSIONS: Record<string, number> = {
    'embed-english-v3.0': 1024,
    'embed-multilingual-v3.0': 1024,
    'embed-english-light-v3.0': 384,
    'embed-multilingual-light-v3.0': 384,
    'default': 1024
};

/**
 * Cohere Embedding Service Implementation
 * Uses Cohere's /v1/embed endpoint
 */
export class CohereEmbeddingService implements IEmbeddingService {
    private apiKey: string;
    private model: string;
    private dimensions: number;
    private endpoint: string = 'https://api.cohere.com/v1/embed';

    constructor(config: CohereEmbeddingConfig) {
        this.apiKey = config.apiKey;
        this.model = config.model || 'embed-english-v3.0';
        this.dimensions = COHERE_DIMENSIONS[this.model] || COHERE_DIMENSIONS['default'];
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
                    texts: [text],
                    input_type: 'search_document',
                    embedding_types: ['float']
                })
            };

            const response = await requestUrl(requestParams);

            if (response.status !== 200) {
                const error = response.json?.message || `HTTP ${response.status}`;
                return { success: false, error };
            }

            const data = response.json;
            // Cohere returns embeddings in embeddings.float array
            const embeddings = data.embeddings?.float || data.embeddings;
            if (!embeddings || !embeddings[0]) {
                return { success: false, error: 'Invalid response format' };
            }

            return {
                success: true,
                embedding: embeddings[0],
                tokenCount: data.meta?.billed_units?.input_tokens
            };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            logger.error('Search', 'Cohere embedding error:', errorMessage);
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

            // Cohere supports batch embedding up to 96 texts
            const maxBatchSize = 96;
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
                        texts: batch,
                        input_type: 'search_document',
                        embedding_types: ['float']
                    })
                };

                const response = await requestUrl(requestParams);

                if (response.status !== 200) {
                    const error = response.json?.message || `HTTP ${response.status}`;
                    return { success: false, error };
                }

                const data = response.json;
                const embeddings = data.embeddings?.float || data.embeddings;
                if (!embeddings || !Array.isArray(embeddings)) {
                    return { success: false, error: 'Invalid response format' };
                }

                allEmbeddings.push(...embeddings);

                if (data.meta?.billed_units?.input_tokens) {
                    totalTokens += data.meta.billed_units.input_tokens;
                }
            }

            return {
                success: true,
                embeddings: allEmbeddings,
                totalTokens
            };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            logger.error('Search', 'Cohere batch embedding error:', errorMessage);
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
            provider: 'cohere',
            model: this.model,
            dimensions: this.dimensions,
            maxTokens: 512 // Cohere embed models
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
