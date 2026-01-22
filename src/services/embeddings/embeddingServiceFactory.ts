/**
 * Embedding Service Factory
 * Creates the appropriate embedding service based on configuration
 */

import { AIOrganiserSettings } from '../../core/settings';
import { IEmbeddingService, EmbeddingServiceConfig } from './types';
import { OpenAIEmbeddingService } from './openaiEmbeddingService';
import { OllamaEmbeddingService } from './ollamaEmbeddingService';
import { GeminiEmbeddingService } from './geminiEmbeddingService';
import { CohereEmbeddingService } from './cohereEmbeddingService';
import { VoyageEmbeddingService } from './voyageEmbeddingService';

/**
 * Supported embedding providers
 */
export type EmbeddingProvider = 'openai' | 'ollama' | 'gemini' | 'cohere' | 'voyage' | 'openrouter';

/**
 * Create an embedding service from configuration
 */
export function createEmbeddingService(config: EmbeddingServiceConfig): IEmbeddingService {
    switch (config.provider) {
        case 'openai':
            if (!config.apiKey) {
                throw new Error('OpenAI API key is required');
            }
            return new OpenAIEmbeddingService({
                apiKey: config.apiKey,
                model: config.model,
                endpoint: config.endpoint
            });

        case 'ollama':
            return new OllamaEmbeddingService({
                model: config.model,
                endpoint: config.endpoint || 'http://localhost:11434'
            });

        case 'gemini':
            if (!config.apiKey) {
                throw new Error('Gemini API key is required');
            }
            return new GeminiEmbeddingService({
                apiKey: config.apiKey,
                model: config.model
            });

        case 'cohere':
            if (!config.apiKey) {
                throw new Error('Cohere API key is required');
            }
            return new CohereEmbeddingService({
                apiKey: config.apiKey,
                model: config.model
            });

        case 'voyage':
            if (!config.apiKey) {
                throw new Error('Voyage API key is required');
            }
            return new VoyageEmbeddingService({
                apiKey: config.apiKey,
                model: config.model
            });

        case 'openrouter':
            // OpenRouter uses OpenAI-compatible API for embeddings
            if (!config.apiKey) {
                throw new Error('OpenRouter API key is required');
            }
            return new OpenAIEmbeddingService({
                apiKey: config.apiKey,
                model: config.model || 'openai/text-embedding-3-small',
                endpoint: 'https://openrouter.ai/api/v1/embeddings'
            });

        default:
            throw new Error(`Unsupported embedding provider: ${config.provider}`);
    }
}

/**
 * Create an embedding service from plugin settings
 * Handles API key inheritance and defaults
 */
export function createEmbeddingServiceFromSettings(settings: AIOrganiserSettings): IEmbeddingService | null {
    if (!settings.enableSemanticSearch) {
        return null;
    }

    const provider = settings.embeddingProvider;

    // Get API key with inheritance chain:
    // 1. Dedicated embedding API key
    // 2. Provider-specific settings
    // 3. Cloud API key (if same provider)
    let apiKey = settings.embeddingApiKey;

    if (!apiKey && provider !== 'ollama') {
        // Try provider settings
        const providerKey = settings.providerSettings?.[provider as keyof typeof settings.providerSettings];
        if (providerKey?.apiKey) {
            apiKey = providerKey.apiKey;
        }

        // Try cloud API key if embedding provider matches cloud provider
        if (!apiKey && provider === settings.cloudServiceType) {
            apiKey = settings.cloudApiKey;
        }
    }

    // For cloud providers, API key is required
    if (!apiKey && provider !== 'ollama') {
        console.warn(`No API key found for embedding provider: ${provider}`);
        return null;
    }

    try {
        // Only pass custom endpoint for providers that support it (Ollama)
        // Other providers use their default endpoints unless explicitly configured
        const endpoint = provider === 'ollama' ? settings.embeddingEndpoint : undefined;

        return createEmbeddingService({
            provider: provider as any,
            model: settings.embeddingModel,
            apiKey,
            endpoint
        });
    } catch (error) {
        console.error('Failed to create embedding service:', error);
        return null;
    }
}

/**
 * Get default model for a provider
 */
export function getDefaultEmbeddingModel(provider: EmbeddingProvider): string {
    switch (provider) {
        case 'openai':
            return 'text-embedding-3-small';
        case 'ollama':
            return 'nomic-embed-text';
        case 'gemini':
            return 'text-embedding-004';
        case 'cohere':
            return 'embed-english-v3.0';
        case 'voyage':
            return 'voyage-3';
        case 'openrouter':
            return 'openai/text-embedding-3-small';
        default:
            return 'text-embedding-3-small';
    }
}

/**
 * Get available models for a provider
 */
export function getAvailableEmbeddingModels(provider: EmbeddingProvider): string[] {
    switch (provider) {
        case 'openai':
            return [
                'text-embedding-3-small',
                'text-embedding-3-large',
                'text-embedding-ada-002'
            ];
        case 'ollama':
            return [
                'nomic-embed-text',
                'all-minilm',
                'mxbai-embed-large',
                'bge-small',
                'bge-base',
                'bge-large'
            ];
        case 'gemini':
            return [
                'text-embedding-004',
                'embedding-001'
            ];
        case 'cohere':
            return [
                'embed-english-v3.0',
                'embed-multilingual-v3.0',
                'embed-english-light-v3.0',
                'embed-multilingual-light-v3.0'
            ];
        case 'voyage':
            return [
                'voyage-3',
                'voyage-3-lite',
                'voyage-code-3',
                'voyage-large-2'
            ];
        case 'openrouter':
            return [
                'openai/text-embedding-3-small',
                'openai/text-embedding-3-large',
                'cohere/embed-english-v3.0'
            ];
        default:
            return [];
    }
}

/**
 * Check if a provider requires an API key
 */
export function requiresApiKey(provider: EmbeddingProvider): boolean {
    return provider !== 'ollama';
}
