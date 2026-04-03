import { BaseAdapter } from './baseAdapter';
import { AdapterConfig, ContentPart, MultimodalCapability } from './types';
import * as endpoints from './cloudEndpoints.json';

export class GeminiAdapter extends BaseAdapter {
    constructor(config: AdapterConfig) {
        super({
            ...config,
            endpoint: config.endpoint || endpoints.gemini,
            modelName: config.modelName || 'gemini-3-flash-preview'
        });
        this.provider = {
            name: 'gemini',
            requestFormat: {
                url: '/chat/completions',
                body: {
                    model: this.config.modelName,
                    messages: [],
                    n: 1
                }
            },
            responseFormat: {
                path: ['choices', 0, 'message', 'content'],
                errorPath: ['error', 'message']
            }
        };
    }

    getMultimodalCapability(): MultimodalCapability {
        return 'image+document';
    }

    formatMultimodalRequest(parts: ContentPart[], options?: { maxTokens?: number }): any {
        // Gemini uses OpenAI-compatible endpoint — format as OpenAI content array.
        // Binary content (images, PDFs) passed as data URIs via image_url type;
        // Gemini extracts the MIME type from the data URI and handles all formats.
        const contentItems: any[] = parts.map(part => {
            if (part.type === 'text') {
                return { type: 'text', text: part.text };
            } else if (part.type === 'image' || part.type === 'document') {
                return {
                    type: 'image_url',
                    image_url: {
                        url: `data:${part.mediaType};base64,${part.data}`
                    }
                };
            }
            return null;
        }).filter(item => item !== null);

        return {
            model: this.config.modelName,
            max_tokens: options?.maxTokens || 4096,
            messages: [
                { role: 'user', content: contentItems }
            ]
        };
    }

    getHeaders(): Record<string, string> {
        if (!this.config.apiKey) {
            throw new Error('API key is required for Gemini');
        }
        return {
            'Authorization': `Bearer ${this.config.apiKey}`,
            'Content-Type': 'application/json'
        };
    }

    // Gemini uses OpenAI-compatible endpoint, so SSE streaming works the same way
    supportsStreaming() { return true; }
    formatStreamingRequest(prompt: string) { return this.buildOpenAIStreamingRequest(prompt); }
    parseStreamingChunk(line: string) { return BaseAdapter.parseOpenAISSEChunk(line); }
}
