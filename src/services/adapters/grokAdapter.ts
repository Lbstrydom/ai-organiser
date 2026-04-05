import { BaseAdapter } from './baseAdapter';
import { BaseResponse, RequestBody, AdapterConfig } from './types';
import * as endpoints from './cloudEndpoints.json';
// SYSTEM_PROMPT available if needed for future use

export class GrokAdapter extends BaseAdapter {
    private readonly defaultConfig = {
        max_tokens: 2048,
        temperature: 0.7
    };

    constructor(config: AdapterConfig) {
        super({
            ...config,
            endpoint: config.endpoint || endpoints.grok
        });
        this.provider = {
            name: 'grok',
            requestFormat: {
                url: '/v1/chat/completions',
                headers: {},
                body: {
                    model: config.modelName,
                    messages: [],
                    ...this.defaultConfig
                }
            },
            responseFormat: {
                path: ['choices', '0', 'message', 'content'],
                errorPath: ['error', 'message']
            }
        };
    }

    public formatRequest(prompt: string): RequestBody {
        const baseRequest = super.formatRequest(prompt);
        
        return {
            ...baseRequest,
            ...this.defaultConfig
        };
    }

    public parseResponse(response: unknown): BaseResponse {
        try {
            const responseObj = response as { choices?: Array<{ message?: { content?: string } }> };
            const content = responseObj.choices?.[0]?.message?.content;
            if (!content) {
                throw new Error('Invalid response format: missing content');
            }

            const jsonContent = this.extractJsonFromContent(content);
            if (!Array.isArray(jsonContent?.matchedTags) || !Array.isArray(jsonContent?.newTags)) {
                throw new Error('Invalid response format: missing required arrays');
            }

            return {
                text: content,
                matchedExistingTags: jsonContent.matchedTags as string[],
                suggestedTags: jsonContent.newTags as string[]
            };
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            throw new Error(`Failed to parse Grok response: ${message}`);
        }
    }

    public validateConfig(): string | null {
        if (!this.config.apiKey) {
            return 'API key is required for Grok';
        }
        if (!this.config.endpoint) {
            return 'Endpoint is required for Grok';
        }
        if (!this.config.modelName) {
            return 'Model name is required for Grok';
        }
        return null;
    }

    public extractError(error: unknown): string {
        const err = error as { error?: { message?: string }; response?: { data?: { error?: { message?: string } } }; message?: string };
        return err.error?.message ||
            err.response?.data?.error?.message ||
            err.message ||
            'Unknown error occurred';
    }

    public getHeaders(): Record<string, string> {
        if (!this.config.apiKey) {
            throw new Error('API key is required for Grok');
        }
        return {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.config.apiKey}`
        };
    }

    supportsStreaming() { return true; }
    formatStreamingRequest(prompt: string) { return this.buildOpenAIStreamingRequest(prompt); }
    parseStreamingChunk(line: string) { return BaseAdapter.parseOpenAISSEChunk(line); }
}
