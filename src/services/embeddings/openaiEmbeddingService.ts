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
import { logger } from '../../utils/logger';

/**
 * OpenAI Embedding Service Configuration
 */
export interface OpenAIEmbeddingConfig {
    apiKey: string;
    model?: string;
    endpoint?: string;
    /**
     * Auth header style (Plan A — Azure providers).
     * 'bearer' (default) → `Authorization: Bearer` (OpenAI direct).
     * 'api-key' / 'azure' → `api-key` header (Azure OpenAI embeddings).
     */
    authHeaderType?: 'bearer' | 'api-key' | 'azure';
}

/**
 * Azure caps embedding batch size well below OpenAI's 2048 — large arrays 400
 * unless clamped. 16 is a safe per-request batch for the Azure path (plan §5).
 */
export const AZURE_EMBEDDING_BATCH_SIZE = 16;

/**
 * OpenAI Embedding Service Implementation
 * Uses OpenAI's /v1/embeddings endpoint
 */
export class OpenAIEmbeddingService implements IEmbeddingService {
    private apiKey: string;
    private model: string;
    private endpoint: string;
    private dimensions: number;
    private authHeaderType: 'bearer' | 'api-key' | 'azure';
    // OpenAI embedding models support 8191 tokens max
    // Using ~4 chars/token as conservative estimate, with safety margin
    private static readonly MAX_CHARS = 30000; // ~7500 tokens

    constructor(config: OpenAIEmbeddingConfig) {
        this.apiKey = config.apiKey;
        this.model = config.model || 'text-embedding-3-small';
        this.endpoint = config.endpoint || 'https://api.openai.com/v1/embeddings';
        this.dimensions = getEmbeddingDimensions(this.model);
        // Default 'bearer' preserves OpenAI-direct behaviour; Azure callers pass 'api-key'.
        this.authHeaderType = config.authHeaderType ?? 'bearer';
    }

    /** Build auth + content-type headers per configured auth style. */
    private buildHeaders(): Record<string, string> {
        if (this.authHeaderType === 'bearer') {
            return { 'Authorization': `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' };
        }
        // 'api-key' / 'azure' both use the Azure-style api-key header.
        return { 'api-key': this.apiKey, 'Content-Type': 'application/json' };
    }

    /** Whether this service is talking to an Azure endpoint (drives batch clamp). */
    private get isAzure(): boolean {
        return this.authHeaderType === 'api-key' || this.authHeaderType === 'azure';
    }

    /**
     * Truncate text to fit within token limits
     * Uses character-based approximation (~4 chars per token)
     */
    private truncateText(text: string): string {
        if (text.length <= OpenAIEmbeddingService.MAX_CHARS) {
            return text;
        }
        // Truncate at word boundary if possible
        const truncated = text.substring(0, OpenAIEmbeddingService.MAX_CHARS);
        const lastSpace = truncated.lastIndexOf(' ');
        if (lastSpace > OpenAIEmbeddingService.MAX_CHARS * 0.8) {
            return truncated.substring(0, lastSpace);
        }
        return truncated;
    }

    async generateEmbedding(text: string): Promise<EmbeddingResult> {
        try {
            if (!text.trim()) {
                return { success: false, error: 'Empty text provided' };
            }

            // Truncate text to prevent 400 errors from exceeding token limits
            const processedText = this.truncateText(text.trim());

            const requestParams: RequestUrlParam = {
                url: this.endpoint,
                method: 'POST',
                headers: this.buildHeaders(),
                body: JSON.stringify({
                    model: this.model,
                    input: processedText,
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

            const embedding: number[] = data.data[0].embedding;
            if (embedding.length !== this.dimensions) {
                logger.warn('Search', `Embedding dimension mismatch: expected ${this.dimensions}, got ${embedding.length} (model ${this.model})`);
                throw new Error(`Embedding dimension mismatch: expected ${this.dimensions}, got ${embedding.length}`);
            }

            return {
                success: true,
                embedding,
                tokenCount: data.usage?.total_tokens
            };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            logger.error('Search', 'OpenAI embedding error:', errorMessage);
            return { success: false, error: errorMessage };
        }
    }

    async batchGenerateEmbeddings(texts: string[]): Promise<BatchEmbeddingResult> {
        try {
            // Preserve original indices: empty/whitespace entries are skipped from
            // the provider call but still occupy their slot in the output (filled
            // with a zero-vector) so callers zipping with `texts` stay aligned.
            const nonEmpty: { originalIndex: number; text: string }[] = [];
            texts.forEach((t, i) => {
                if (t.trim()) {
                    nonEmpty.push({ originalIndex: i, text: this.truncateText(t.trim()) });
                }
            });

            // Output array sized to the ORIGINAL input; default = zero-vector.
            const zeroVector = (): number[] => new Array(this.dimensions).fill(0);
            const result: number[][] = texts.map(() => zeroVector());

            if (nonEmpty.length === 0) {
                return { success: false, error: 'No valid texts provided' };
            }

            // OpenAI supports batch embedding up to 2048 inputs; Azure caps far
            // lower, so clamp to AZURE_EMBEDDING_BATCH_SIZE on the Azure path.
            const maxBatchSize = this.isAzure ? AZURE_EMBEDDING_BATCH_SIZE : 100;
            let totalTokens = 0;

            for (let start = 0; start < nonEmpty.length; start += maxBatchSize) {
                const slice = nonEmpty.slice(start, start + maxBatchSize);
                const requestParams: RequestUrlParam = {
                    url: this.endpoint,
                    method: 'POST',
                    headers: this.buildHeaders(),
                    body: JSON.stringify({
                        model: this.model,
                        input: slice.map(s => s.text),
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

                // Validate coverage: every slice position must be filled by exactly
                // one provider embedding. A missing / duplicate / out-of-range
                // provider `index` would silently misalign embeddings with their
                // source text, so fail closed with a redacted error instead.
                const covered = new Array<boolean>(slice.length).fill(false);
                for (const item of data.data) {
                    const idx: number = (item as { index: number }).index;
                    if (!Number.isInteger(idx) || idx < 0 || idx >= slice.length) {
                        return { success: false, error: `Batch embedding index out of range (expected 0..${slice.length - 1})` };
                    }
                    if (covered[idx]) {
                        return { success: false, error: 'Batch embedding returned a duplicate index' };
                    }
                    covered[idx] = true;

                    const embedding: number[] = (item as { embedding: number[] }).embedding;
                    if (embedding.length !== this.dimensions) {
                        logger.warn('Search', `Batch embedding dimension mismatch: expected ${this.dimensions}, got ${embedding.length} (model ${this.model})`);
                        return { success: false, error: `Embedding dimension mismatch: expected ${this.dimensions}, got ${embedding.length}` };
                    }
                    result[slice[idx].originalIndex] = embedding;
                }

                if (covered.some((c) => !c)) {
                    return { success: false, error: 'Batch embedding response missing one or more inputs' };
                }

                if (data.usage?.total_tokens) {
                    totalTokens += data.usage.total_tokens;
                }
            }

            return {
                success: true,
                embeddings: result,
                totalTokens
            };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            logger.error('Search', 'OpenAI batch embedding error:', errorMessage);
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
