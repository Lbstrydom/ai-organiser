import { BaseLLMService } from "../baseService";
import { AdapterConfig, ContentPart, MultimodalCapability } from "./types";
import { SYSTEM_PROMPT } from "../../utils/constants";
import { TaggingMode } from "../prompts/types";
import { extractTextFromParts } from "../../utils/adapterUtils";

export abstract class BaseAdapter extends BaseLLMService {
    protected config: AdapterConfig;
    protected provider: any;

    /**
     * Formats a request for the cloud service
     * Handles provider-specific request formats
     * @param prompt - The prompt to send to the LLM
     * @param language - Optional language code
     * @returns Formatted request body
     */
    public formatRequest(prompt: string, language?: string): any {
        if (this.provider?.requestFormat?.body) {
            // For providers that need specific request format
            return {
                ...this.provider.requestFormat.body,
                messages: [
                    { role: 'system', content: SYSTEM_PROMPT },
                    { role: 'user', content: prompt }
                ]
            };
        }
        
        // If no provider-specific format, use the parent class implementation
        return super.formatRequest(prompt, language);
    }

    public parseResponse(response: any): any {
        if (!this.provider?.responseFormat?.path) {
            throw new Error('Provider response format not configured');
        }

        try {
            if (response.error && this.provider.responseFormat.errorPath) {
                let errorMsg = response;
                for (const key of this.provider.responseFormat.errorPath) {
                    errorMsg = errorMsg[key];
                }
                throw new Error(errorMsg || 'Unknown error');
            }

            let result = response;
            for (const key of this.provider.responseFormat.path) {
                if (!result || typeof result !== 'object') {
                    throw new Error('Invalid response structure');
                }
                result = result[key];
            }

            // Extract JSON from content if needed
            if (typeof result === 'string') {
                try {
                    result = this.extractJsonFromContent(result);
                } catch (error) {
                    //console.error('Failed to parse JSON from response:', error);
                    // If JSON parsing fails, try to extract tags directly
                    const tags = this.extractTagsFromText(result);
                    result = {
                        matchedTags: [],
                        newTags: tags
                    };
                }
            }

            // Ensure both matchedTags and newTags are arrays of strings
            if (result.matchedTags && !Array.isArray(result.matchedTags)) {
                result.matchedTags = [];
            }
            if (result.newTags && !Array.isArray(result.newTags)) {
                result.newTags = [];
            }

            result.matchedTags = (result.matchedTags || []).map((tag: any) => String(tag).trim());
            result.newTags = (result.newTags || []).map((tag: any) => String(tag).trim());

            return result;
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            throw new Error(`Failed to parse response: ${message}`);
        }
    }

    private extractTagsFromText(text: string): string[] {
        // Look for hashtags in the response
        const hashtagRegex = /#[\p{L}\p{N}-]+/gu;
        const hashtags = text.match(hashtagRegex) || [];
        
        if (hashtags.length > 0) {
            return hashtags;
        }
        
        // If no hashtags found, look for potential tags in quotes or lists
        const potentialTagsRegex = /["']([a-zA-Z0-9-]+)["']|\s+[-*]\s+([a-zA-Z0-9-]+)/g;
        const potentialTags: string[] = [];
        let match;
        
        while ((match = potentialTagsRegex.exec(text)) !== null) {
            const tag = match[1] || match[2];
            if (tag) {
                potentialTags.push(`#${tag}`);
            }
        }
        
        return potentialTags;
    }

    public validateConfig(): string | null {
        return super.validateConfig();
    }

    constructor(config: AdapterConfig) {
        super({
            ...config,
            endpoint: config.endpoint ?? "",
            modelName: config.modelName ?? ""
        }, null as any);  // Pass null for app as it's not needed in the adapter
        this.config = config;
    }

    async analyzeTags(content: string, existingTags: string[]): Promise<any> {
        const prompt = this.buildPrompt(content, existingTags, TaggingMode.Hybrid, 10, this.config.language);
        const response = await this.makeRequest(prompt);
        return this.parseResponse(response);
    }

    async testConnection(): Promise<{ result: any; error?: any }> {
        try {
            const response = await this.makeRequest('test');
            return { result: { success: true } };
        } catch (error) {
            return { result: { success: false }, error };
        }
    }

    protected async makeRequest(prompt: string): Promise<any> {
        // This method should not be called directly.
        // HTTP requests should be made through CloudLLMService which uses Obsidian's requestUrl
        // to avoid CORS issues. Adapters are meant to format/parse requests, not make them.
        throw new Error('BaseAdapter.makeRequest should not be called directly. Use CloudLLMService instead.');
    }

    getEndpoint(): string {
        return this.config.endpoint ?? "";
    }

    getHeaders(): Record<string, string> {
        return {
            'Content-Type': 'application/json'
        };
    }

    protected extractJsonFromContent(content: string): any {
        try {
            const jsonMatch = content.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
            if (jsonMatch) {
                return JSON.parse(jsonMatch[1]);
            }
            const standaloneJson = content.match(/\{[\s\S]*\}/);
            if (standaloneJson) {
                return JSON.parse(standaloneJson[0]);
            }
            throw new Error('No JSON found in response');
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            throw new Error(`Failed to parse JSON: ${message}`);
        }
    }

    /**
     * Formats a request for summarization (without tagging system prompt)
     * Optional - if not provided, CloudLLMService will use a default implementation
     * @param prompt - The prompt containing summarization instructions and content
     * @returns Formatted request body
     */
    public formatSummarizeRequest?(prompt: string): any;

    /** Whether this adapter supports SSE streaming. Default: false. */
    supportsStreaming?(): boolean;

    /** Build the streaming request (endpoint URL, headers, body). */
    formatStreamingRequest?(prompt: string): { url: string; headers: Record<string, string>; body: object };

    /** Parse a single SSE line into a content chunk. Returns null for non-content lines. */
    parseStreamingChunk?(line: string): string | null;

    // ── Shared OpenAI-compatible streaming helpers ──

    /** Build an OpenAI-compatible streaming request using this adapter's endpoint/headers/model. */
    protected buildOpenAIStreamingRequest(prompt: string): { url: string; headers: Record<string, string>; body: object } {
        return {
            url: this.getEndpoint(),
            headers: this.getHeaders(),
            body: {
                model: this.config.modelName,
                messages: [
                    { role: 'system', content: 'You are a helpful assistant that summarizes content accurately and thoroughly.' },
                    { role: 'user', content: prompt },
                ],
                stream: true,
            },
        };
    }

    /** Parse an OpenAI-compatible SSE line into a content delta. */
    static parseOpenAISSEChunk(line: string): string | null {
        if (!line.startsWith('data: ')) return null;
        const data = line.slice(6).trim();
        if (data === '[DONE]') return null;
        try { return JSON.parse(data)?.choices?.[0]?.delta?.content ?? null; }
        catch { return null; }
    }

    /**
     * Extracts the main content from a cloud provider response
     * @param response The response object from the cloud provider
     * @returns The extracted content as a string
     */
    public parseResponseContent(response: any): string {
        try {
            if (!this.provider?.responseFormat?.contentPath) {
                // Default OpenAI-like format
                return response.choices?.[0]?.message?.content || '';
            }

            // Follow provider-specific content path
            let content = response;
            for (const key of this.provider.responseFormat.contentPath) {
                if (!content || typeof content !== 'object') {
                    throw new Error('Invalid response structure');
                }
                content = content[key];
            }
            
            return typeof content === 'string' ? content : JSON.stringify(content);
        } catch (error) {
            //console.error('Failed to parse response content:', error);
            return '';
        }
    }

    /**
     * Sends a request to the LLM service
     * Abstract method implementation required by BaseLLMService
     * @param prompt - The prompt to send
     * @returns Promise resolving to the response
     */
    protected async sendRequest(prompt: string): Promise<string> {
        const response = await this.makeRequest(prompt);
        return this.parseResponseContent(response);
    }

    /**
     * Declare multimodal capability of this adapter
     * Override in specific adapters that support images/documents
     * @returns Capability level
     */
    getMultimodalCapability(): MultimodalCapability {
        return 'text-only';  // Safe default for all providers
    }

    /**
     * Format a multimodal request with ContentPart array
     * Default implementation extracts text parts only
     * Override in adapters that support multimodal content
     * @param parts - Array of content parts (text, image, document)
     * @param options - Optional request options
     * @returns Formatted request body
     */
    formatMultimodalRequest(parts: ContentPart[], options?: { maxTokens?: number }): any {
        const textContent = extractTextFromParts(parts);
        return this.formatRequest(textContent);
    }
}
