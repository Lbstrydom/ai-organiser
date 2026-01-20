import { LLMResponse, LLMServiceConfig, ConnectionTestResult, ConnectionTestError } from './types';
import { BaseLLMService } from './baseService';
import { AdapterType, createAdapter, BaseAdapter } from './adapters';
import { TaggingMode } from './prompts/types';
import { LanguageCode } from './types';
import { App, requestUrl } from 'obsidian';

export class CloudLLMService extends BaseLLMService {
    private adapter: BaseAdapter;
    private readonly adapterType: AdapterType;
    private readonly MAX_CONTENT_LENGTH = 4000; // Reasonable limit for most APIs
    private readonly MAX_RETRIES = 3;
    private readonly RETRY_DELAY = 1000; // 1 second

    constructor(config: Omit<LLMServiceConfig, 'type'> & { type: AdapterType }, app: App) {
        super(config, app);
        this.adapterType = config.type;
        this.adapter = createAdapter(config.type, {
            endpoint: config.endpoint,
            apiKey: config.apiKey || '',
            modelName: config.modelName,
            language: config.language
        });
    }

    private validateCloudConfig(): string | null {
        const baseError = this.validateConfig();
        if (baseError) return baseError;

        const adapterError = this.adapter.validateConfig();
        if (adapterError) return adapterError;

        return null;
    }

    private async makeRequest(prompt: string, timeoutMs: number): Promise<any> {
        try {
            const validationError = this.validateCloudConfig();
            if (validationError) {
                throw new Error(validationError);
            }

            const response = await requestUrl({
                url: this.adapter.getEndpoint(),
                method: 'POST',
                headers: this.adapter.getHeaders(),
                body: JSON.stringify(this.adapter.formatRequest(prompt)),
                throw: false
            });

            return response;
        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') {
                throw new Error('Request timed out');
            }
            throw error;
        }
    }

    private async makeRequestWithRetry(prompt: string, timeoutMs: number): Promise<any> {
        let lastError: Error | null = null;

        for (let i = 0; i < this.MAX_RETRIES; i++) {
            try {
                const response = await this.makeRequest(prompt, timeoutMs);
                // requestUrl returns {status, json, text, etc.} - status 200-299 is success
                if ((response.status >= 200 && response.status < 300) || response.status === 401) { // Don't retry auth errors
                    return response;
                }
                lastError = new Error(`HTTP error ${response.status}`);
            } catch (error) {
                lastError = error instanceof Error ? error : new Error('Unknown error');
                if (error instanceof Error && error.message.includes('Invalid API key')) {
                    throw error; // Don't retry auth errors
                }
            }

            if (i < this.MAX_RETRIES - 1) {
                await new Promise(resolve => setTimeout(resolve, this.RETRY_DELAY * (i + 1)));
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
        const response = await this.makeRequestWithRetry(prompt, this.TIMEOUT);

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
    async summarizeText(prompt: string): Promise<{ success: boolean; content?: string; error?: string }> {
        try {
            const content = await this.sendSummarizeRequest(prompt);
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
    private async sendSummarizeRequest(prompt: string): Promise<string> {
        const validationError = this.validateCloudConfig();
        if (validationError) {
            throw new Error(validationError);
        }

        // Build request body without the tagging system prompt
        // The prompt already contains all necessary summarization instructions
        const requestBody = this.adapter.formatSummarizeRequest
            ? this.adapter.formatSummarizeRequest(prompt)
            : this.buildSummarizeRequestBody(prompt);

        const endpoint = this.adapter.getEndpoint();

        // Debug logging
        if (this.debugMode) {
            console.log('[AI Organiser] Summarize request:');
            console.log('  - adapterType:', this.adapterType);
            console.log('  - endpoint:', endpoint);
            console.log('  - model:', requestBody.model);
            console.log('  - prompt length:', prompt.length);
        }

        const response = await requestUrl({
            url: endpoint,
            method: 'POST',
            headers: this.adapter.getHeaders(),
            body: JSON.stringify(requestBody),
            throw: false
        });

        if (response.status < 200 || response.status >= 300) {
            const responseText = response.text;
            // Debug logging for errors
            if (this.debugMode) {
                console.log('[AI Organiser] Summarize API error:');
                console.log('  - status:', response.status);
                console.log('  - response:', responseText.substring(0, 500));
            }
            // Parse the error response to get detailed message
            let errorMessage = `API error: ${response.status}`;
            try {
                const errorJson = JSON.parse(responseText);
                errorMessage = errorJson.error?.message || errorJson.message || errorMessage;
            } catch {
                // If JSON parsing fails, include raw response
                errorMessage = `${errorMessage} - ${responseText.substring(0, 200)}`;
            }
            throw new Error(errorMessage);
        }

        const responseText = response.text;
        try {
            const data = JSON.parse(responseText);
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
     * Builds a request body for summarization without tagging system prompt
     * @param prompt - The user prompt
     * @returns Request body object
     */
    private buildSummarizeRequestBody(prompt: string): any {
        // Use a neutral, general-purpose system prompt
        const summarizeSystemPrompt = 'You are a helpful assistant that summarizes content accurately and thoroughly.';

        // Use the stored adapter type for reliable detection
        if (this.adapterType === 'claude') {
            return {
                model: this.adapter['config']?.modelName || 'claude-sonnet-4-5-20250929',
                max_tokens: 4096,
                system: summarizeSystemPrompt,
                messages: [
                    { role: 'user', content: prompt }
                ]
            };
        } else if (this.adapterType === 'gemini') {
            return {
                contents: [
                    {
                        parts: [{ text: prompt }]
                    }
                ],
                systemInstruction: {
                    parts: [{ text: summarizeSystemPrompt }]
                },
                generationConfig: {
                    maxOutputTokens: 4096
                }
            };
        } else {
            // OpenAI-compatible format (default for openai, groq, deepseek, openrouter, etc.)
            const modelName = this.adapter['config']?.modelName || 'gpt-4';

            // Newer OpenAI models (gpt-4o, gpt-5, o1, o3, etc.) use max_completion_tokens
            // Older models and other providers use max_tokens
            const isNewerOpenAIModel = this.adapterType === 'openai' &&
                (modelName.startsWith('gpt-4o') ||
                 modelName.startsWith('gpt-5') ||
                 modelName.startsWith('o1') ||
                 modelName.startsWith('o3'));

            const baseRequest: any = {
                model: modelName,
                messages: [
                    { role: 'system', content: summarizeSystemPrompt },
                    { role: 'user', content: prompt }
                ],
                temperature: 0.3
            };

            // Use the appropriate token limit parameter
            if (isNewerOpenAIModel) {
                baseRequest.max_completion_tokens = 4096;
            } else {
                baseRequest.max_tokens = 4096;
            }

            return baseRequest;
        }
    }

    /**
     * Summarize PDF document using multimodal capabilities
     * @param pdfBase64 - Base64 encoded PDF data
     * @param prompt - The prompt with summarization instructions
     * @returns Promise resolving to summarization result
     */
    async summarizePdf(pdfBase64: string, prompt: string): Promise<{ success: boolean; content?: string; error?: string }> {
        try {
            const validationError = this.validateCloudConfig();
            if (validationError) {
                throw new Error(validationError);
            }

            // Build multimodal request based on adapter type
            let requestBody: any;

            if (this.adapterType === 'claude') {
                // Claude Messages API with document type
                requestBody = {
                    model: this.adapter['config']?.modelName || 'claude-sonnet-4-5-20250929',
                    max_tokens: 4096,
                    messages: [
                        {
                            role: 'user',
                            content: [
                                {
                                    type: 'document',
                                    source: {
                                        type: 'base64',
                                        media_type: 'application/pdf',
                                        data: pdfBase64
                                    }
                                },
                                {
                                    type: 'text',
                                    text: prompt
                                }
                            ]
                        }
                    ]
                };
            } else if (this.adapterType === 'gemini') {
                // Gemini API with inline_data
                requestBody = {
                    contents: [
                        {
                            parts: [
                                {
                                    inline_data: {
                                        mime_type: 'application/pdf',
                                        data: pdfBase64
                                    }
                                },
                                {
                                    text: prompt
                                }
                            ]
                        }
                    ],
                    generationConfig: {
                        maxOutputTokens: 4096
                    }
                };
            } else {
                return { success: false, error: 'PDF summarization not supported for this provider' };
            }

            const response = await requestUrl({
                url: this.adapter.getEndpoint(),
                method: 'POST',
                headers: this.adapter.getHeaders(),
                body: JSON.stringify(requestBody),
                throw: false
            });

            if (response.status < 200 || response.status >= 300) {
                const responseText = response.text;
                try {
                    const errorJson = JSON.parse(responseText);
                    throw new Error(errorJson.error?.message || errorJson.message || `API error: ${response.status}`);
                } catch {
                    throw new Error(`API error: ${response.status}`);
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
     * Analyze image using multimodal capabilities
     * @param imageBase64 - Base64 encoded image data
     * @param mimeType - Image MIME type (e.g., 'image/png', 'image/jpeg')
     * @param prompt - The prompt with analysis instructions
     * @returns Promise resolving to analysis result
     */
    async analyzeImage(imageBase64: string, mimeType: string, prompt: string): Promise<{ success: boolean; content?: string; error?: string }> {
        try {
            const validationError = this.validateCloudConfig();
            if (validationError) {
                throw new Error(validationError);
            }

            // Build multimodal request based on adapter type
            let requestBody: any;

            if (this.adapterType === 'claude') {
                // Claude Messages API with image type
                requestBody = {
                    model: this.adapter['config']?.modelName || 'claude-sonnet-4-5-20250929',
                    max_tokens: 4096,
                    messages: [
                        {
                            role: 'user',
                            content: [
                                {
                                    type: 'image',
                                    source: {
                                        type: 'base64',
                                        media_type: mimeType,
                                        data: imageBase64
                                    }
                                },
                                {
                                    type: 'text',
                                    text: prompt
                                }
                            ]
                        }
                    ]
                };
            } else if (this.adapterType === 'gemini') {
                // Gemini API with inline_data
                requestBody = {
                    contents: [
                        {
                            parts: [
                                {
                                    inline_data: {
                                        mime_type: mimeType,
                                        data: imageBase64
                                    }
                                },
                                {
                                    text: prompt
                                }
                            ]
                        }
                    ],
                    generationConfig: {
                        maxOutputTokens: 4096
                    }
                };
            } else {
                return { success: false, error: 'Image analysis not supported for this provider' };
            }

            const response = await requestUrl({
                url: this.adapter.getEndpoint(),
                method: 'POST',
                headers: this.adapter.getHeaders(),
                body: JSON.stringify(requestBody),
                throw: false
            });

            if (response.status < 200 || response.status >= 300) {
                const responseText = response.text;
                try {
                    const errorJson = JSON.parse(responseText);
                    throw new Error(errorJson.error?.message || errorJson.message || `API error: ${response.status}`);
                } catch {
                    throw new Error(`API error: ${response.status}`);
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
     * Analyze multiple content items (images, PDFs) with text
     * @param items - Array of content items with their base64 data and MIME types
     * @param prompt - The prompt with analysis instructions
     * @returns Promise resolving to analysis result
     */
    async analyzeMultipleContent(
        items: Array<{ base64: string; mimeType: string }>,
        prompt: string
    ): Promise<{ success: boolean; content?: string; error?: string }> {
        try {
            const validationError = this.validateCloudConfig();
            if (validationError) {
                throw new Error(validationError);
            }

            // Build multimodal request based on adapter type
            let requestBody: any;

            if (this.adapterType === 'claude') {
                // Claude Messages API with multiple content items
                const contentItems: any[] = items.map(item => {
                    if (item.mimeType === 'application/pdf') {
                        return {
                            type: 'document',
                            source: {
                                type: 'base64',
                                media_type: item.mimeType,
                                data: item.base64
                            }
                        };
                    } else {
                        return {
                            type: 'image',
                            source: {
                                type: 'base64',
                                media_type: item.mimeType,
                                data: item.base64
                            }
                        };
                    }
                });

                // Add the text prompt at the end
                contentItems.push({
                    type: 'text',
                    text: prompt
                });

                requestBody = {
                    model: this.adapter['config']?.modelName || 'claude-sonnet-4-5-20250929',
                    max_tokens: 8192,
                    messages: [
                        {
                            role: 'user',
                            content: contentItems
                        }
                    ]
                };
            } else if (this.adapterType === 'gemini') {
                // Gemini API with multiple inline_data parts
                const parts: any[] = items.map(item => ({
                    inline_data: {
                        mime_type: item.mimeType,
                        data: item.base64
                    }
                }));

                // Add the text prompt at the end
                parts.push({ text: prompt });

                requestBody = {
                    contents: [
                        {
                            parts: parts
                        }
                    ],
                    generationConfig: {
                        maxOutputTokens: 8192
                    }
                };
            } else {
                return { success: false, error: 'Multimodal analysis not supported for this provider' };
            }

            const response = await requestUrl({
                url: this.adapter.getEndpoint(),
                method: 'POST',
                headers: this.adapter.getHeaders(),
                body: JSON.stringify(requestBody),
                throw: false
            });

            if (response.status < 200 || response.status >= 300) {
                const responseText = response.text;
                try {
                    const errorJson = JSON.parse(responseText);
                    throw new Error(errorJson.error?.message || errorJson.message || `API error: ${response.status}`);
                } catch {
                    throw new Error(`API error: ${response.status}`);
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
}
