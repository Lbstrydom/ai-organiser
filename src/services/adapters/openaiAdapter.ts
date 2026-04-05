import { BaseAdapter } from './baseAdapter';
import { AdapterConfig, ContentPart, MultimodalCapability } from './types';
import * as endpoints from './cloudEndpoints.json';
import { PROVIDER_DEFAULT_MODEL } from './providerRegistry';

export class OpenAIAdapter extends BaseAdapter {
    constructor(config: AdapterConfig) {
        super({
            ...config,
            endpoint: config.endpoint || endpoints.openai,
            modelName: config.modelName || PROVIDER_DEFAULT_MODEL.openai
        });
        this.provider = {
            name: 'openai',
            requestFormat: {
                url: '/v1/chat/completions',
                body: {
                    model: this.config.modelName,
                    messages: []
                }
            },
            responseFormat: {
                path: ['choices', '0', 'message', 'content'],
                errorPath: ['error', 'message']
            }
        };
    }

    getMultimodalCapability(): MultimodalCapability {
        return 'image';
    }

    formatMultimodalRequest(parts: ContentPart[], options?: { maxTokens?: number }): Record<string, unknown> {
        // Hard error for document parts — OpenAI doesn't support PDF/documents
        const hasDocument = parts.some(p => p.type === 'document');
        if (hasDocument) {
            throw new Error('OpenAI does not support document/PDF content. Use Claude or Gemini for PDF processing.');
        }

        const contentItems = parts.map((part): Record<string, unknown> | null => {
            if (part.type === 'text') {
                return { type: 'text', text: part.text };
            } else if (part.type === 'image') {
                return {
                    type: 'image_url',
                    image_url: {
                        url: `data:${part.mediaType};base64,${part.data}`
                    }
                };
            }
            return null;
        }).filter((item): item is Record<string, unknown> => item !== null);

        // Consistent token handling with text path — reasoning models need max_completion_tokens
        const modelName = this.config.modelName || '';
        const isReasoningModel =
            modelName.startsWith('gpt-5') ||
            modelName.startsWith('o1') ||
            modelName.startsWith('o3');

        const tokenParam = isReasoningModel
            ? { max_completion_tokens: options?.maxTokens || 16384 }
            : { max_tokens: options?.maxTokens };

        return {
            model: this.config.modelName,
            ...tokenParam,
            messages: [
                { role: 'user', content: contentItems }
            ]
        };
    }

    getHeaders(): Record<string, string> {
        if (!this.config.apiKey) {
            throw new Error('API key is required for OpenAI');
        }
        return {
            'Authorization': `Bearer ${this.config.apiKey}`,
            'Content-Type': 'application/json'
        };
    }

    supportsStreaming() { return true; }
    formatStreamingRequest(prompt: string) { return this.buildOpenAIStreamingRequest(prompt); }
    parseStreamingChunk(line: string) { return BaseAdapter.parseOpenAISSEChunk(line); }
}
