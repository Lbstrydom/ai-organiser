/**
 * Gemini Embedding Service
 * Generates embeddings using Google's Gemini text-embedding models
 */

import { requestUrl, RequestUrlParam } from 'obsidian';
import {
    IEmbeddingService,
    EmbeddingResult,
    BatchEmbeddingResult,
    EmbeddingModelInfo
} from './types';

/**
 * Gemini Embedding Service Configuration
 */
export interface GeminiEmbeddingConfig {
    apiKey: string;
    model?: string;
}

// Gemini embedding model dimensions
const GEMINI_DIMENSIONS: Record<string, number> = {
    'embedding-001': 768,
    'text-embedding-004': 768,
    'default': 768
};

/**
 * Gemini Embedding Service Implementation
 * Uses Google's Generative AI API for embeddings
 */
export class GeminiEmbeddingService implements IEmbeddingService {
    private apiKey: string;
    private model: string;
    private dimensions: number;
    private baseUrl: string = 'https://generativelanguage.googleapis.com/v1beta';

    constructor(config: GeminiEmbeddingConfig) {
        this.apiKey = config.apiKey;
        this.model = config.model || 'text-embedding-004';
        this.dimensions = GEMINI_DIMENSIONS[this.model] || GEMINI_DIMENSIONS['default'];
    }

    async generateEmbedding(text: string): Promise<EmbeddingResult> {
        try {
            if (!text.trim()) {
                return { success: false, error: 'Empty text provided' };
            }

            // Gemini embedding endpoint
            const url = `${this.baseUrl}/models/${this.model}:embedContent?key=${this.apiKey}`;

            const requestParams: RequestUrlParam = {
                url,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: `models/${this.model}`,
                    content: {
                        parts: [{ text }]
                    }
                })
            };

            const response = await requestUrl(requestParams);

            if (response.status !== 200) {
                const error = response.json?.error?.message || `HTTP ${response.status}`;
                return { success: false, error };
            }

            const data = response.json;
            if (!data.embedding || !data.embedding.values) {
                return { success: false, error: 'Invalid response format' };
            }

            return {
                success: true,
                embedding: data.embedding.values,
                tokenCount: Math.ceil(text.length / 4) // Approximate
            };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            console.error('Gemini embedding error:', errorMessage);
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

            // Gemini supports batch embedding via batchEmbedContents
            const url = `${this.baseUrl}/models/${this.model}:batchEmbedContents?key=${this.apiKey}`;

            const requests = validTexts.map(text => ({
                model: `models/${this.model}`,
                content: {
                    parts: [{ text }]
                }
            }));

            const requestParams: RequestUrlParam = {
                url,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ requests })
            };

            const response = await requestUrl(requestParams);

            if (response.status !== 200) {
                const error = response.json?.error?.message || `HTTP ${response.status}`;
                return { success: false, error };
            }

            const data = response.json;
            if (!data.embeddings || !Array.isArray(data.embeddings)) {
                return { success: false, error: 'Invalid response format' };
            }

            const embeddings = data.embeddings.map((e: any) => e.values);
            const totalTokens = validTexts.reduce((sum, t) => sum + Math.ceil(t.length / 4), 0);

            return {
                success: true,
                embeddings,
                totalTokens
            };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            console.error('Gemini batch embedding error:', errorMessage);
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
            provider: 'gemini',
            model: this.model,
            dimensions: this.dimensions,
            maxTokens: 2048 // Gemini embedding models
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
