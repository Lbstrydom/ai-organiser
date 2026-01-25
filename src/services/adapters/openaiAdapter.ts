import { BaseAdapter } from './baseAdapter';
import { AdapterConfig } from './types';
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

    getHeaders(): Record<string, string> {
        if (!this.config.apiKey) {
            throw new Error('API key is required for OpenAI');
        }
        return {
            'Authorization': `Bearer ${this.config.apiKey}`,
            'Content-Type': 'application/json'
        };
    }
}
