import { requestUrl } from 'obsidian';
import { logger } from '../utils/logger';

export async function fetchLocalModels(endpoint: string): Promise<string[]> {
    try {
        const baseUrl = normalizeEndpoint(endpoint);
        const isOllama = baseUrl.includes('localhost:11434') || baseUrl.includes('ollama');
        const _isLocalAI = baseUrl.includes('localhost:8080') || baseUrl.includes('localai');
        const _isLMStudio = baseUrl.includes('localhost:1234') || baseUrl.includes('lm_studio');

        // Special handling for Ollama
        if (isOllama) {
            try {
                // First try Ollama's specific API endpoint for listing models
                const ollamaResponse = await requestUrl({
                    url: `${baseUrl.replace('/v1', '')}/api/tags`,
                    method: 'GET',
                    headers: { 'Content-Type': 'application/json' }
                });

                if (ollamaResponse.status < 400) {
                    const ollamaData = ollamaResponse.json;
                    if (ollamaData.models && Array.isArray(ollamaData.models)) {
                        return ollamaData.models.map((model: any) => model.name);
                    }
                }

                // If that fails, try the Ollama list API
                const ollamaListResponse = await requestUrl({
                    url: `${baseUrl.replace('/v1', '')}/api/list`,
                    method: 'GET',
                    headers: { 'Content-Type': 'application/json' }
                });

                if (ollamaListResponse.status < 400) {
                    const ollamaListData = ollamaListResponse.json;
                    if (Array.isArray(ollamaListData.models)) {
                        return ollamaListData.models.map((model: any) => model.name);
                    }
                }
            } catch (_error) {
                // Will fall back to standard endpoint
            }
        }

        // Standard OpenAI-compatible API endpoint
        const modelsEndpoint = `${baseUrl}/models`;

        try {
            const response = await requestUrl({
                url: modelsEndpoint,
                method: 'GET',
                headers: { 'Content-Type': 'application/json' }
            });

            if (response.status >= 400) {
                // if (isLocalAI) {
                //     console.error('Failed to connect to LocalAI service. Please make sure it is running on the specified endpoint.');
                // } else if (isOllama) {
                //     console.error('Failed to connect to Ollama service. Please make sure it is running on the specified endpoint.');
                // } else if (isLMStudio) {
                //     console.error('Failed to connect to LM Studio service. Please make sure it is running on the specified endpoint.');
                // } else {
                //     console.error('Failed to connect to the specified API endpoint.');
                // }
                return []; // Return empty array if endpoint doesn't respond properly
            }
    
            const data = response.json;
            
            let models: string[] = [];
            if (Array.isArray(data)) {
                models = data.map(model => typeof model === 'string' ? model : model.id || model.name);
            } else if (data.data && Array.isArray(data.data)) {
                models = data.data.map((model: any) => model.id || model.name);
            } else if (data.models && Array.isArray(data.models)) {
                models = data.models.map((model: any) => model.id || model.name);
            }

            if (models.length === 0) {
                // Service is running but no models found
                // if (isLocalAI) {
                //     console.error('No models found for LocalAI. Please download at least one model before using this service.');
                // } else if (isOllama) {
                //     console.error('No models found for Ollama. Please pull at least one model using the command: ollama pull <model>');
                // } else if (isLMStudio) {
                //     console.error('No models found for LM Studio. Please download at least one model via the LM Studio interface.');
                // } else {
                //     console.error('No models found for the specified service.');
                // }
            }
            
            return models;
        } catch (_error) {
            // Failed to fetch from standard endpoint
        }
        
        return []; // Return empty array if all attempts fail
    } catch (_error) {
        return [];
    }
}

// Extract authentication information from URL and return both clean URL and auth headers
export function extractAuthFromUrl(url: string): { url: string; headers: Record<string, string> } {
    const headers: Record<string, string> = {
        'Content-Type': 'application/json'
    };
    
    try {
        const urlObj = new URL(url);
        
        // Check if URL contains authentication information
        if (urlObj.username && urlObj.password) {
            // Create Basic Auth header
            const authString = `${urlObj.username}:${urlObj.password}`;
            const base64Auth = btoa(authString);
            headers['Authorization'] = `Basic ${base64Auth}`;
            
            // Remove auth info from URL
            urlObj.username = '';
            urlObj.password = '';
            return { url: urlObj.toString(), headers };
        }
    } catch (error) {
        // If URL parsing fails, return original URL
        logger.error('LLM', 'Failed to parse URL:', error);
    }
    
    return { url, headers };
}

function normalizeEndpoint(endpoint: string): string {
    endpoint = endpoint.trim();
    endpoint = endpoint.replace(/\/$/, '');
    
    if (endpoint.endsWith('/v1/chat/completions')) {
        endpoint = endpoint.replace('/v1/chat/completions', '');
    }
    
    if (endpoint.endsWith('/api/generate')) {
        endpoint = endpoint.replace('/api/generate', '');
    }
    
    return endpoint;
}
