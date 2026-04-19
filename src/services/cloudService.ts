import { LLMResponse, LLMServiceConfig, ConnectionTestResult, ConnectionTestError, MultimodalLLMService, SummarizeOptions, LanguageCode } from './types';
import { BaseLLMService } from './baseService';
import { AdapterType, createAdapter, BaseAdapter } from './adapters';
import { ContentPart } from './adapters/types';
import { PROVIDER_DEFAULT_MODEL } from './adapters/providerRegistry';
import { TaggingMode } from './prompts/types';
import { App, requestUrl } from 'obsidian';
import { logger } from '../utils/logger';

export class CloudLLMService extends BaseLLMService implements MultimodalLLMService {
    private adapter: BaseAdapter;
    private readonly adapterType: AdapterType;
    private readonly MAX_CONTENT_LENGTH = 4000; // Reasonable limit for most APIs
    private readonly MAX_RETRIES = 3;
    private readonly RETRY_DELAY = 1000; // 1 second base for exponential backoff
    /** Cap on fallback exponential backoff delay only. Explicit Retry-After values are honoured in full. */
    private readonly MAX_RETRY_DELAY_MS = 60_000; // 60 seconds

    constructor(config: Omit<LLMServiceConfig, 'type'> & { type: AdapterType; thinkingMode?: 'standard' | 'adaptive' }, app: App) {
        super(config, app);
        this.adapterType = config.type;
        this.adapter = createAdapter(config.type, {
            endpoint: config.endpoint,
            apiKey: config.apiKey || '',
            modelName: config.modelName,
            language: config.language,
            thinkingMode: config.thinkingMode
        });
    }

    private validateCloudConfig(): string | null {
        const baseError = this.validateConfig();
        if (baseError) return baseError;

        const adapterError = this.adapter.validateConfig();
        if (adapterError) return adapterError;

        return null;
    }

    private async makeRequest(prompt: string, timeoutMs: number): Promise<import('obsidian').RequestUrlResponse> {
        try {
            const validationError = this.validateCloudConfig();
            if (validationError) {
                throw new Error(validationError);
            }

            const response = await this.requestWithTimeout(
                requestUrl({
                    url: this.adapter.getEndpoint(),
                    method: 'POST',
                    headers: this.adapter.getHeaders(),
                    body: JSON.stringify(this.adapter.formatRequest(prompt)),
                    throw: false
                }),
                timeoutMs
            );
            return response;

        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') {
                throw new Error('Request timed out');
            }
            throw error;
        }
    }

    /** Case-insensitive header lookup. HTTP headers are case-insensitive (RFC 7230),
     *  and `RequestUrlResponse.headers` is a plain object whose key casing depends on the platform. */
    private getHeader(headers: Record<string, string> | undefined, name: string): string | undefined {
        if (!headers) return undefined;
        const lower = name.toLowerCase();
        const key = Object.keys(headers).find(k => k.toLowerCase() === lower);
        return key ? headers[key] : undefined;
    }

    /** Parse `Retry-After` header supporting both delta-seconds and HTTP-date formats.
     *  Returns raw milliseconds to wait, or 0 if absent/unparseable.
     *  HTTP-date clock skew: if client clock is ahead, `Date.now()` may exceed the server date,
     *  yielding 0 — this gracefully degrades to exponential backoff via the `headerMs > 0` guard. */
    private parseRetryAfterMs(header: string | undefined): number {
        if (!header) return 0;
        // Delta-seconds: "120"
        const secs = Number.parseInt(header, 10);
        if (!Number.isNaN(secs) && secs > 0) return secs * 1000;
        // HTTP-date: "Wed, 21 Oct 2025 07:28:00 GMT"
        const dateMs = Date.parse(header);
        if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
        return 0;
    }

    /** Retriable HTTP status codes: 429 rate-limit, Anthropic 529 overload, standard 5xx transients. */
    private readonly RETRIABLE_STATUSES = new Set([429, 502, 503, 504, 529]);

    /** Sleep with jitter on transient network errors. Returns false if retries exhausted (caller should rethrow). */
    private async retryOnNetworkError(attempt: number): Promise<boolean> {
        if (attempt >= this.MAX_RETRIES - 1) return false;
        const jitteredMs = Math.min(
            this.RETRY_DELAY * Math.pow(2, attempt) * (0.5 + Math.random()),
            this.MAX_RETRY_DELAY_MS
        );
        logger.warn('LLM', `Network error. Retrying in ${Math.round(jitteredMs / 1000)}s (attempt ${attempt + 1}/${this.MAX_RETRIES})`);
        await new Promise(resolve => setTimeout(resolve, jitteredMs));
        return true;
    }

    /** Evaluate HTTP status and sleep if the request should be retried.
     *  Returns false when the caller should stop retrying (non-retriable status or retries exhausted).
     *  Explicit `Retry-After` values are honoured in full — batch tasks use `setTimeout` which does not
     *  block the UI thread, so long server-directed waits are safe. The `MAX_RETRY_DELAY_MS` cap applies
     *  only to the fallback exponential delay when no `Retry-After` header is present. */
    private async retryOnHttpStatus(response: import('obsidian').RequestUrlResponse, attempt: number): Promise<boolean> {
        if (response.status === 401 || response.status === 403) return false;
        if (!this.RETRIABLE_STATUSES.has(response.status)) return false;
        if (attempt >= this.MAX_RETRIES - 1) return false;
        const headerMs = this.parseRetryAfterMs(this.getHeader(response.headers, 'retry-after'));
        const fallbackMs = Math.min(
            this.RETRY_DELAY * Math.pow(2, attempt) * (0.5 + Math.random()),
            this.MAX_RETRY_DELAY_MS
        );
        const waitMs = headerMs > 0 ? headerMs : fallbackMs;
        logger.warn('LLM', `HTTP ${response.status}. Retrying in ${Math.round(waitMs / 1000)}s (attempt ${attempt + 1}/${this.MAX_RETRIES})`);
        await new Promise(resolve => setTimeout(resolve, waitMs));
        return true;
    }

    /** POST to `url` with retry/backoff on 429 rate-limit and transient 5xx responses.
     *  Never retries 401/403 or other client errors.
     *  `timeoutMs` applies per-attempt; total max duration = MAX_RETRIES × timeoutMs + backoff.
     *
     *  NOTE: A future transport-layer refactor should consolidate this and makeRequestWithRetry
     *  into a single retry primitive; for now they are intentionally kept separate to avoid
     *  touching the tagging path within this targeted bug-fix scope. */
    private async postWithRetry(
        url: string,
        headers: Record<string, string>,
        body: string,
        timeoutMs: number
    ): Promise<import('obsidian').RequestUrlResponse> {
        let lastResponse: import('obsidian').RequestUrlResponse | null = null;
        for (let attempt = 0; attempt < this.MAX_RETRIES; attempt++) {
            try {
                lastResponse = await this.requestWithTimeout(
                    requestUrl({ url, method: 'POST', headers, body, throw: false }),
                    timeoutMs
                );
            } catch (networkErr) {
                if (!await this.retryOnNetworkError(attempt)) throw networkErr;
                continue;
            }
            if (lastResponse.status >= 200 && lastResponse.status < 300) break;
            if (!await this.retryOnHttpStatus(lastResponse, attempt)) break;
        }
        return lastResponse!;
    }

    private async makeRequestWithRetry(prompt: string, timeoutMs: number): Promise<import('obsidian').RequestUrlResponse> {
        let lastError: Error | null = null;

        for (let i = 0; i < this.MAX_RETRIES; i++) {
            try {
                const response = await this.makeRequest(prompt, timeoutMs);
                // requestUrl returns {status, json, text, etc.} - status 200-299 is success
                if (response.status >= 200 && response.status < 300) {
                    return response;
                }

                // Never retry auth or permission errors
                if (response.status === 401 || response.status === 403) {
                    throw new Error(`HTTP error ${response.status}`);
                }

                // Handle 429 Too Many Requests — respect Retry-After if present
                if (response.status === 429) {
                    const retryAfterSec = parseInt(response.headers?.['retry-after'] ?? '0', 10);
                    const waitMs = retryAfterSec > 0
                        ? retryAfterSec * 1000
                        : this.RETRY_DELAY * Math.pow(2, i); // exponential backoff fallback
                    if (i < this.MAX_RETRIES - 1) {
                        await new Promise(resolve => setTimeout(resolve, waitMs));
                    }
                    lastError = new Error('Rate limit exceeded (429): too many requests');
                    continue;
                }

                // Retry on transient server errors (500/502/503/504)
                lastError = new Error(`HTTP error ${response.status}`);
            } catch (error) {
                lastError = error instanceof Error ? error : new Error('Unknown error');
                // Don't retry auth errors or explicit throws from above
                if (error instanceof Error &&
                    (error.message.includes('Invalid API key') ||
                     error.message.includes('HTTP error 401') ||
                     error.message.includes('HTTP error 403'))) {
                    throw error;
                }
            }

            if (i < this.MAX_RETRIES - 1) {
                await new Promise(resolve => setTimeout(resolve, this.RETRY_DELAY * Math.pow(2, i)));
            }
        }

        throw lastError || new Error('Max retries exceeded');
    }

    async testConnection(): Promise<{ result: ConnectionTestResult; error?: ConnectionTestError }> {
        try {
            const response = await this.makeRequestWithRetry('Connection test', 10000);

            const responseText = response.text;

            if (response.status < 200 || response.status >= 300) {
                if (response.status === 401) {
                    throw new Error('Authentication failed: Invalid API key');
                } else if (response.status === 404) {
                    throw new Error('API endpoint not found: Please verify the URL');
                }

                try {
                    const errorJson = JSON.parse(responseText);
                    throw new Error(errorJson.error?.message || errorJson.message || `HTTP error ${response.status}`);
                } catch {
                    throw new Error(`HTTP error ${response.status}: ${responseText}`);
                }
            }

            // Verify we can parse the response - don't check specific format
            // since different providers have different response structures
            const data = JSON.parse(responseText);

            // Just verify we got some kind of valid response
            if (!data || typeof data !== 'object') {
                throw new Error('Invalid API response format');
            }

            return { result: ConnectionTestResult.Success };
        } catch (error) {
            let testError: ConnectionTestError = {
                type: "unknown",
                message: "Unknown error occurred during connection test"
            };

            if (error instanceof Error) {
                if (error.name === 'AbortError') {
                    testError = {
                        type: "timeout",
                        message: "Connection timeout: Please check your network status"
                    };
                } else if (error.message.includes('Failed to fetch')) {
                    testError = {
                        type: "network",
                        message: "Network error: Unable to reach the API endpoint"
                    };
                } else if (error.message.includes('Authentication failed')) {
                    testError = {
                        type: "auth",
                        message: "Authentication failed: Please verify your API key"
                    };
                } else if (error.message.includes('API endpoint not found')) {
                    testError = {
                        type: "network",
                        message: "API endpoint not found: Please verify the URL"
                    };
                } else {
                    testError = {
                        type: "unknown",
                        message: `Error: ${error.message}`
                    };
                }
            }

            return {
                result: ConnectionTestResult.Failed,
                error: testError
            };
        }
    }

    /**
     * Analyzes content and returns tag suggestions
     * @param content - Content to analyze
     * @param existingTags - Array of existing tags to consider
     * @param mode - Tagging mode
     * @param maxTags - Maximum number of tags to return
     * @param language - Language for generated tags
     * @returns Promise resolving to tag analysis result
     */
    async analyzeTags(content: string, existingTags: string[], mode: TaggingMode, maxTags: number, language?: LanguageCode): Promise<LLMResponse> {
        // Use the base class implementation
        return super.analyzeTags(content, existingTags, mode, maxTags, language);
    }

    /**
     * Sends a request to the LLM service and returns the response
     * @param prompt - The prompt to send
     * @returns Promise resolving to the response
     */
    protected async sendRequest(prompt: string): Promise<string> {
        const response = await this.makeRequestWithRetry(prompt, this.getRequestTimeoutMs());

        if (response.status < 200 || response.status >= 300) {
            const responseText = response.text;
            try {
                const errorJson = JSON.parse(responseText);
                throw new Error(errorJson.error?.message || errorJson.message || `API error: ${response.status}`);
            } catch {
                throw new Error(`API error: ${response.status}`);
            }
        }

        const responseText = response.text;
        try {
            const data = JSON.parse(responseText);
            // Try to get the completion content based on adapter or standard format
            const content = this.adapter.parseResponseContent(data);
            if (!content) {
                throw new Error('No content found in response');
            }
            return content;
        } catch (error) {
            if (error instanceof Error) {
                throw error;
            }
            throw new Error(`Failed to parse response: ${responseText.substring(0, 100)}...`);
        }
    }

    /**
     * Gets the maximum content length for this service
     * @returns Maximum content length
     */
    protected getMaxContentLength(): number {
        return this.MAX_CONTENT_LENGTH;
    }

    /**
     * Summarize text content
     * Uses a neutral system prompt instead of the tagging-focused one
     * @param prompt - The prompt containing the content and instructions
     * @returns Promise resolving to summarization result
     */
    async summarizeText(prompt: string, options?: SummarizeOptions): Promise<{ success: boolean; content?: string; error?: string }> {
        try {
            const content = await this.sendSummarizeRequest(prompt, options);
            return { success: true, content };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            return { success: false, error: errorMessage };
        }
    }

    /**
     * Sends a summarization request without the tagging-focused system prompt
     * @param prompt - The prompt to send (should contain all necessary instructions)
     * @returns Promise resolving to the response content
     */
    /** Parse the raw text from a successful summarize response, throwing on empty/malformed content. */
    private parseSummarizeResponseText(responseText: string): string {
        const data = JSON.parse(responseText);
        logger.debug('LLM', 'Summarize response keys:', data && typeof data === 'object' && !Array.isArray(data) ? Object.keys(data) : typeof data);
        logger.debug('LLM', 'Summarize response preview:', responseText.substring(0, 300));
        const content = this.adapter.parseResponseContent(data);
        logger.debug('LLM', 'Parsed content length:', content?.length ?? 0);
        logger.debug('LLM', 'Parsed content preview:', content?.substring(0, 300));
        const stopReason = data.stop_reason ?? data.choices?.[0]?.finish_reason;
        if (stopReason) logger.debug('LLM', 'Stop reason:', stopReason);
        if (!content) {
            const finishReason = data.stop_reason ?? data.choices?.[0]?.finish_reason;
            if (finishReason === 'length') {
                logger.warn('LLM', 'Model returned empty content with finish_reason: "length". Reasoning models may exhaust max_completion_tokens on internal reasoning.', { choices0: JSON.stringify(data.choices?.[0])?.substring(0, 300) });
                throw new Error('Model output truncated -- the content was too long for the token limit. Try a shorter note or a non-reasoning model.');
            }
            logger.warn('LLM', 'No content in summarize response.', {
                responseKeys: data && typeof data === 'object' && !Array.isArray(data) ? Object.keys(data) : typeof data,
                choices0: JSON.stringify(data.choices?.[0])?.substring(0, 300)
            });
            throw new Error('No content found in response');
        }
        return content;
    }

    private async sendSummarizeRequest(prompt: string, options?: SummarizeOptions): Promise<string> {
        const validationError = this.validateCloudConfig();
        if (validationError) throw new Error(validationError);

        const requestBody = this.adapter.formatSummarizeRequest
            ? this.adapter.formatSummarizeRequest(prompt)
            : this.buildSummarizeRequestBody(prompt, options);

        const endpoint = this.adapter.getEndpoint();
        const timeoutMs = options?.timeoutMs ?? this.getSummarizeTimeoutMs();

        logger.debug('LLM', 'Summarize request:', {
            adapterType: this.adapterType,
            endpoint,
            model: requestBody.model,
            promptLength: prompt.length,
            ...(options?.maxTokens ? { maxTokens: options.maxTokens } : {}),
            ...(options?.disableThinking ? { thinking: 'disabled' } : {})
        });

        // postWithRetry handles 429 backoff so batch operations (e.g. newsletter triage)
        // don't silently fall back to truncated content when a rate limit is hit.
        const response = await this.postWithRetry(
            endpoint,
            this.adapter.getHeaders(),
            JSON.stringify(requestBody),
            timeoutMs
        );

        if (response.status < 200 || response.status >= 300) {
            logger.debug('LLM', 'Summarize API error:', { status: response.status, response: response.text.substring(0, 500) });
            let errorMessage = `API error: ${response.status}`;
            try {
                const errorJson = JSON.parse(response.text);
                errorMessage = errorJson.error?.message || errorJson.message || errorMessage;
            } catch {
                errorMessage = `${errorMessage} - ${response.text.substring(0, 200)}`;
            }
            throw new Error(errorMessage);
        }

        const responseText = response.text;
        try {
            return this.parseSummarizeResponseText(responseText);
        } catch (error) {
            if (error instanceof Error) throw error;
            throw new Error(`Failed to parse response: ${responseText.substring(0, 100)}...`);
        }
    }

    /**
     * Builds a request body for summarization without tagging system prompt
     * @param prompt - The user prompt
     * @returns Request body object
     */
    private buildSummarizeRequestBody(prompt: string, options?: SummarizeOptions): Record<string, unknown> {
        // Use a neutral, general-purpose system prompt
        const summarizeSystemPrompt = 'You are a helpful assistant that summarizes content accurately and thoroughly.';

        // Use the stored adapter type for reliable detection
        if (this.adapterType === 'claude') {
            return this.buildClaudeSummarizeBody(prompt, summarizeSystemPrompt, options);
        } else if (this.adapterType === 'gemini') {
            // Gemini's endpoint is the OpenAI-compat path
            // (/v1beta/openai/chat/completions), so send OpenAI-format body.
            // Previously built the native Gemini body (contents + systemInstruction
            // + generationConfig), which the OpenAI-compat endpoint rejects with
            // HTTP 400. Caught by persona round 10 multi-provider quality matrix
            // (tag worked because it routes through adapter.formatRequest which
            // is already OpenAI-format; summarize has its own path).
            const modelName = this.adapter['config']?.modelName?.trim()
                || PROVIDER_DEFAULT_MODEL.gemini;
            return {
                model: modelName,
                messages: [
                    { role: 'system', content: summarizeSystemPrompt },
                    { role: 'user', content: prompt }
                ],
                max_tokens: options?.maxTokens || 8192
            };
        } else {
            // OpenAI-compatible format (default for openai, groq, deepseek, openrouter, etc.)
            // modelOverride allows per-call model switching (e.g., presentation pipeline
            // routes generation to Opus and audits to Sonnet non-reasoning).
            const modelName = options?.modelOverride
                || (this.adapter['config']?.modelName && this.adapter['config'].modelName.trim())
                || PROVIDER_DEFAULT_MODEL[this.adapterType]
                || PROVIDER_DEFAULT_MODEL.openai;

            // Detect OpenAI-family model capabilities by model name, not adapter type.
            // This ensures correct behavior when reasoning models are used via OpenRouter,
            // Groq, DeepSeek, or other OpenAI-compatible providers.
            const isNewerOpenAIModel =
                modelName.startsWith('gpt-4o') ||
                modelName.startsWith('gpt-5') ||
                modelName.startsWith('o1') ||
                modelName.startsWith('o3');

            // Reasoning models (o1, o3, gpt-5, and any model ending in '-reasoning')
            // do not accept `temperature`. They also use max_completion_tokens for BOTH
            // internal reasoning tokens AND visible output.
            const isReasoningModel =
                modelName.startsWith('gpt-5') ||
                modelName.startsWith('o1') ||
                modelName.startsWith('o3') ||
                modelName.endsWith('-reasoning');

            const defaultTokens = isReasoningModel ? 16384 : 8192;
            const tokenBudget = options?.maxTokens || defaultTokens;

            const baseRequest: Record<string, unknown> = {
                model: modelName,
                messages: [
                    { role: 'system', content: summarizeSystemPrompt },
                    { role: 'user', content: prompt }
                ],
            };

            // Reasoning models reject temperature — simply omit it.
            if (!isReasoningModel) {
                baseRequest.temperature = 0.3;
            }

            if (isNewerOpenAIModel) {
                baseRequest.max_completion_tokens = tokenBudget;
            } else {
                baseRequest.max_tokens = tokenBudget;
            }

            return baseRequest;
        }
    }

    /**
     * Build Claude-specific request body, respecting per-call SummarizeOptions.
     * - disableThinking: skip adaptive thinking entirely (for structured extraction)
     * - maxTokens: override the default token budget
     * - When thinking is active and no explicit maxTokens, uses 64K default
     */
    private buildClaudeSummarizeBody(prompt: string, systemPrompt: string, options?: SummarizeOptions): Record<string, unknown> {
        const modelName = (this.adapter['config']?.modelName && this.adapter['config'].modelName.trim()) || PROVIDER_DEFAULT_MODEL[this.adapterType];
        const thinkingMode = this.adapter['config']?.thinkingMode;
        const modelSupportsThinking = thinkingMode === 'adaptive' && (modelName.startsWith('claude-opus-4-6') || modelName.startsWith('claude-sonnet-4-6'));

        // Per-call override: disableThinking skips thinking even if model supports it
        const useThinking = modelSupportsThinking && !options?.disableThinking;

        let maxTokens: number;
        if (options?.maxTokens) {
            // Caller specified an explicit budget — respect it.
            // The caller is responsible for budgeting thinking + output headroom.
            maxTokens = options.maxTokens;
        } else {
            // Default: 64K with thinking (gives ample room for reasoning), 8192 without
            maxTokens = useThinking ? 64000 : 8192;
        }

        const body: Record<string, unknown> = {
            model: modelName,
            max_tokens: maxTokens,
            system: systemPrompt,
            messages: [{ role: 'user', content: prompt }]
        };

        if (useThinking) {
            body.thinking = { type: 'adaptive' };
        }

        return body;
    }

    /**
     * Send multimodal content (text, images, documents) to the LLM
     * Unified method that replaces analyzeImage, summarizePdf, and analyzeMultipleContent
     * @param parts - Array of content parts (text, image, or document)
     * @param options - Optional configuration including maxTokens
     * @returns Promise resolving to LLM response
     */
    async sendMultimodal(
        parts: ContentPart[],
        options?: { maxTokens?: number }
    ): Promise<{ success: boolean; content?: string; error?: string }> {
        try {
            const validationError = this.validateCloudConfig();
            if (validationError) {
                throw new Error(validationError);
            }

            // Validate capability BEFORE processing — strict failure, no silent fallback
            const capability = this.adapter.getMultimodalCapability();
            const hasImage = parts.some(p => p.type === 'image');
            const hasDocument = parts.some(p => p.type === 'document');

            if (hasImage && capability === 'text-only') {
                return {
                    success: false,
                    error: 'Provider does not support image content. Switch to Claude, Gemini, or OpenAI.'
                };
            }
            if (hasDocument && (capability === 'text-only' || capability === 'image')) {
                return {
                    success: false,
                    error: 'Provider does not support document content. Switch to Claude or Gemini.'
                };
            }

            // Use adapter's formatMultimodalRequest method
            const requestBody = this.adapter.formatMultimodalRequest(parts, options);

            const response = await this.requestWithTimeout(
                requestUrl({
                    url: this.adapter.getEndpoint(),
                    method: 'POST',
                    headers: this.adapter.getHeaders(),
                    body: JSON.stringify(requestBody),
                    throw: false
                }),
                this.getSummarizeTimeoutMs() // Use configurable summarize timeout for multimodal content
            );

            if (response.status < 200 || response.status >= 300) {
                const responseText = response.text;
                logger.error('LLM', `Multimodal API error ${response.status}:`, responseText?.substring(0, 500));
                logger.error('LLM', 'Request URL:', this.adapter.getEndpoint());
                try {
                    const errorJson = JSON.parse(responseText);
                    const msg = errorJson.error?.message || errorJson.message || `API error: ${response.status}`;
                    throw new Error(msg);
                } catch (parseError) {
                    if (parseError instanceof Error && parseError.message !== `API error: ${response.status}` && !parseError.message.startsWith('Unexpected')) {
                        throw parseError; // Re-throw the meaningful error from above
                    }
                    throw new Error(`API error: ${response.status} - ${responseText?.substring(0, 200)}`);
                }
            }

            const data = JSON.parse(response.text);
            const content = this.adapter.parseResponseContent(data);

            if (!content) {
                throw new Error('No content found in response');
            }

            return { success: true, content };

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            return { success: false, error: errorMessage };
        }
    }

    /**
     * Get the multimodal capability of the current adapter
     * Allows callers to check capability before attempting multimodal operations
     * @returns The capability level: 'text-only' | 'image' | 'document' | 'image+document'
     */
    getMultimodalCapability(): import('./adapters/types').MultimodalCapability {
        return this.adapter.getMultimodalCapability();
    }

    /**
     * Stream LLM response via SSE using native fetch().
     * Obsidian's requestUrl doesn't support streaming — native fetch is required.
     * Feature-gated by enableResearchStreamingSynthesis (default false).
     */
    async summarizeTextStream(
        prompt: string,
        onChunk: (chunk: string) => void,
        signal?: AbortSignal
    ): Promise<{ success: boolean; content?: string; error?: string }> {
        // Check adapter streaming support
        if (!this.adapter.supportsStreaming?.()) {
            throw new Error('Streaming not supported by this adapter');
        }

        const { url, headers, body } = this.adapter.formatStreamingRequest!(prompt);

        // SSE streaming requires native fetch(); requestUrl doesn't support ReadableStream
        const response = await globalThis.fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal,
        });

        if (!response.ok) {
            return { success: false, error: `HTTP ${response.status}` };
        }

        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let fullContent = '';
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || ''; // keep incomplete line in buffer
            for (const line of lines) {
                const chunk = this.adapter.parseStreamingChunk!(line);
                if (chunk) {
                    fullContent += chunk;
                    onChunk(chunk);
                }
            }
        }
        // Process any remaining buffer
        if (buffer.trim()) {
            const chunk = this.adapter.parseStreamingChunk!(buffer);
            if (chunk) {
                fullContent += chunk;
                onChunk(chunk);
            }
        }

        return { success: true, content: fullContent };
    }

}
