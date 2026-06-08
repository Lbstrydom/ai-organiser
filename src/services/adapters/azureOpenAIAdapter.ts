import { BaseAdapter } from './baseAdapter';
import { AdapterConfig, ContentPart, MultimodalCapability } from './types';

/**
 * Azure OpenAI adapter.
 *
 * Talks to Azure OpenAI (`/openai/...`, native OpenAI wire format). Identical
 * request/response/streaming/multimodal shaping to the direct OpenAIAdapter —
 * only the endpoint path and auth header differ:
 * - URL path: `/openai/v1/responses` (endpoint host resolved from settings)
 * - Auth: `api-key: <key>` header (NOT `Authorization: Bearer`)
 *
 * In deployment-based routing the deployment is baked into the URL (resolved by
 * endpointResolver / apiKeyHelpers) and the body `model` override is dropped by
 * cloudService's `blockOverride` guard. Concrete catalog ids only.
 */
export class AzureOpenAIAdapter extends BaseAdapter {
    constructor(config: AdapterConfig) {
        super({
            ...config,
            endpoint: config.endpoint || '',
            modelName: config.modelName || 'gpt-5.5'
        });
        this.provider = {
            name: 'azure-openai',
            requestFormat: {
                url: '/openai/v1/responses',
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
            throw new Error('Azure OpenAI does not support document/PDF content. Use Claude or Gemini for PDF processing.');
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
            throw new Error('API key is required for Azure OpenAI');
        }
        return {
            'api-key': this.config.apiKey,
            'Content-Type': 'application/json'
        };
    }

    supportsStreaming() { return true; }
    formatStreamingRequest(prompt: string) { return this.buildOpenAIStreamingRequest(prompt); }
    parseStreamingChunk(line: string) { return BaseAdapter.parseOpenAISSEChunk(line); }
}
