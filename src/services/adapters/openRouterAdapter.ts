import { BaseAdapter } from './baseAdapter';
import { BaseResponse, AdapterConfig } from './types';
import * as endpoints from './cloudEndpoints.json';

export class OpenRouterAdapter extends BaseAdapter {
    constructor(config: AdapterConfig) {
        super({
            ...config,
            endpoint: config.endpoint || endpoints.openrouter
        });
        this.provider = {
            name: 'openrouter',
            requestFormat: {
                body: {
                    model: this.config.modelName
                }
            },
            responseFormat: {
                path: ['choices', '0', 'message', 'content'],
                errorPath: ['error', 'message']
            }
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
            throw new Error(`Failed to parse OpenRouter response: ${message}`);
        }
    }

    public validateConfig(): string | null {
        if (!this.config.apiKey) {
            return 'API key is required for OpenRouter';
        }
        if (!this.config.endpoint) {
            return 'Endpoint is required for OpenRouter';
        }
        if (!this.config.modelName) {
            return 'Model name is required for OpenRouter';
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
            throw new Error('API key is required for OpenRouter');
        }
        return {
            ...super.getHeaders(),
            'Authorization': `Bearer ${this.config.apiKey}`,
            'HTTP-Referer': 'https://github.com/obsidian-ai-organiser',
            'X-Title': 'Obsidian AI Organiser'
        };
    }

    supportsStreaming() { return true; }
    formatStreamingRequest(prompt: string) { return this.buildOpenAIStreamingRequest(prompt); }
    parseStreamingChunk(line: string) { return BaseAdapter.parseOpenAISSEChunk(line); }
}
