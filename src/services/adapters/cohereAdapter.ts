import { BaseAdapter } from './baseAdapter';
import { BaseResponse, RequestBody, AdapterConfig } from './types';
import * as endpoints from './cloudEndpoints.json';
import { SYSTEM_PROMPT } from '../../utils/constants';

export class CohereAdapter extends BaseAdapter {
    private readonly defaultConfig = {
        temperature: 0.7,
        stream: false
    };

    constructor(config: AdapterConfig) {
        super({
            ...config,
            endpoint: config.endpoint || endpoints.cohere
        });
        this.provider = {
            name: 'cohere',
            requestFormat: {
                url: '',
                headers: {},
                body: {
                    model: config.modelName,
                    messages: [],
                    ...this.defaultConfig
                }
            },
            responseFormat: {
                // Cohere v2 response: message.content[0].text
                path: ['message', 'content', '0', 'text'],
                contentPath: ['message', 'content', '0', 'text'],
                errorPath: ['message']
            }
        };
    }

    public formatRequest(prompt: string): RequestBody {
        // Cohere v2 uses OpenAI-compatible messages format (industry standard)
        return {
            model: this.config.modelName,
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: prompt }
            ],
            ...this.defaultConfig
        };
    }

    public parseResponse(response: any): BaseResponse {
        try {
            // Cohere v2 response: message.content[0].text
            const content = response.message?.content?.[0]?.text;
            if (!content) {
                throw new Error('Invalid response format: missing content');
            }
            const jsonContent = this.extractJsonFromContent(content);
            if (!Array.isArray(jsonContent?.matchedTags) || !Array.isArray(jsonContent?.newTags)) {
                throw new Error('Invalid response format: missing required arrays');
            }
            return {
                text: content,
                matchedExistingTags: jsonContent.matchedTags,
                suggestedTags: jsonContent.newTags
            };
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            throw new Error(`Failed to parse Cohere response: ${message}`);
        }
    }

    public validateConfig(): string | null {
        if (!this.config.apiKey) {
            return 'API key is required for Cohere';
        }
        if (!this.config.endpoint) {
            return 'Endpoint is required for Cohere';
        }
        if (!this.config.modelName) {
            return 'Model name is required for Cohere';
        }
        return null;
    }

    public extractError(error: any): string {
        return error.message ||
            error.response?.data?.message ||
            'Unknown error occurred';
    }

    public getHeaders(): Record<string, string> {
        if (!this.config.apiKey) {
            throw new Error('API key is required for Cohere');
        }
        return {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.config.apiKey}`,
            'Accept': 'application/json'
        };
    }
}
