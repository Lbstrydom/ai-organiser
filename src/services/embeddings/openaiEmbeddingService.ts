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
import { EmbeddingCooldown } from './embeddingCooldown';
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
    /**
     * Shared cooldown circuit breaker (D4.2). Injected by the factory. When
     * cooling, calls short-circuit without a network request; a real 429 sets
     * the window. Optional — absent in tests / non-coordinated callers.
     */
    cooldown?: EmbeddingCooldown;
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
    private readonly cooldown?: EmbeddingCooldown;
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
        this.cooldown = config.cooldown;
    }

    /**
     * Max chunks per single network request (D4.4). Must equal the internal
     * per-request slice size below so the queue's one-iteration-one-request
     * invariant holds.
     */
    get maxBatchSize(): number {
        return this.isAzure ? AZURE_EMBEDDING_BATCH_SIZE : 100;
    }

    /** Case-insensitive header read (`requestUrl` lowercases keys, but be safe). */
    private readHeader(headers: Record<string, string> | undefined, name: string): string | undefined {
        if (!headers) return undefined;
        const lower = name.toLowerCase();
        const key = Object.keys(headers).find(k => k.toLowerCase() === lower);
        return key ? headers[key] : undefined;
    }

    /**
     * Classify a non-2xx response into a typed failure, feeding the cooldown on
     * a 429 (D4.2). `requestUrl` THROWS on ≥400 unless `{throw:false}` is set —
     * callers MUST use throw:false so the 429 + its Retry-After reach here.
     */
    private classifyHttpFailure(
        response: { status: number; headers?: Record<string, string>; json?: { error?: { message?: string } } },
    ): { success: false; error: string; reason: 'rate-limit' | 'error' } {
        if (response.status === 429) {
            this.cooldown?.note429(this.readHeader(response.headers, 'retry-after'));
            return { success: false, error: 'Rate limited (429)', reason: 'rate-limit' };
        }
        const error = response.json?.error?.message || `HTTP ${response.status}`;
        return { success: false, error, reason: 'error' };
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
                return { success: false, error: 'Empty text provided', reason: 'error' };
            }

            // Cooldown short-circuit (D4.2 / Gemini-R6-G2 — query-time too): no
            // network while cooling so a 429 storm can't be re-triggered.
            if (this.cooldown?.isCoolingDown()) {
                return { success: false, error: 'Embedding cooldown active', reason: 'cooldown' };
            }

            // Truncate text to prevent 400 errors from exceeding token limits
            const processedText = this.truncateText(text.trim());

            const requestParams: RequestUrlParam = {
                url: this.endpoint,
                method: 'POST',
                headers: this.buildHeaders(),
                // throw:false so a 429 + Retry-After reach classifyHttpFailure
                // instead of requestUrl throwing past the status check.
                throw: false,
                body: JSON.stringify({
                    model: this.model,
                    input: processedText,
                    encoding_format: 'float'
                })
            };

            const response = await requestUrl(requestParams);

            if (response.status !== 200) {
                return this.classifyHttpFailure(response);
            }

            const data = response.json;
            if (!data.data || !data.data[0] || !data.data[0].embedding) {
                return { success: false, error: 'Invalid response format', reason: 'error' };
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
            return { success: false, error: errorMessage, reason: 'error' };
        }
    }

    /**
     * Embed a batch of texts. CONTRACT: handles arrays of ANY size — inputs
     * beyond `maxBatchSize` are split into multiple sequential requests, never
     * truncated — and the returned `embeddings` is ALWAYS exactly `texts.length`
     * (empty/whitespace slots are zero-vectors), so callers always get a strict
     * 1:1 mapping. The EmbeddingQueue additionally passes exactly `maxBatchSize`
     * chunks so each call = one request, but bulk callers (the direct-fallback
     * index path) legitimately pass larger arrays and rely on the split loop.
     */
    async batchGenerateEmbeddings(texts: string[]): Promise<BatchEmbeddingResult> {
        try {
            // Cooldown short-circuit (D4.2): no network while cooling.
            if (this.cooldown?.isCoolingDown()) {
                return { success: false, error: 'Embedding cooldown active', reason: 'cooldown' };
            }

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
                return { success: false, error: 'No valid texts provided', reason: 'error' };
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
                    throw: false,
                    body: JSON.stringify({
                        model: this.model,
                        input: slice.map(s => s.text),
                        encoding_format: 'float'
                    })
                };

                const response = await requestUrl(requestParams);

                if (response.status !== 200) {
                    // Stop on first non-2xx (incl. 429 → cooldown set). The queue
                    // gives exactly maxBatchSize chunks, so this loop runs once —
                    // no completed-slice is ever discarded (no double-billing).
                    return this.classifyHttpFailure(response);
                }

                const data = response.json;
                if (!data.data || !Array.isArray(data.data)) {
                    return { success: false, error: 'Invalid response format', reason: 'error' };
                }

                // Validate coverage: every slice position must be filled by exactly
                // one provider embedding. A missing / duplicate / out-of-range
                // provider `index` would silently misalign embeddings with their
                // source text, so fail closed with a redacted error instead.
                const covered = new Array<boolean>(slice.length).fill(false);
                for (const item of data.data) {
                    const idx: number = (item as { index: number }).index;
                    if (!Number.isInteger(idx) || idx < 0 || idx >= slice.length) {
                        return { success: false, error: `Batch embedding index out of range (expected 0..${slice.length - 1})`, reason: "error" };
                    }
                    if (covered[idx]) {
                        return { success: false, error: 'Batch embedding returned a duplicate index', reason: 'error' };
                    }
                    covered[idx] = true;

                    const embedding: number[] = (item as { embedding: number[] }).embedding;
                    if (embedding.length !== this.dimensions) {
                        logger.warn('Search', `Batch embedding dimension mismatch: expected ${this.dimensions}, got ${embedding.length} (model ${this.model})`);
                        return { success: false, error: `Embedding dimension mismatch: expected ${this.dimensions}, got ${embedding.length}`, reason: "error" };
                    }
                    result[slice[idx].originalIndex] = embedding;
                }

                if (covered.some((c) => !c)) {
                    return { success: false, error: 'Batch embedding response missing one or more inputs', reason: 'error' };
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
            return { success: false, error: errorMessage, reason: 'error' };
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
