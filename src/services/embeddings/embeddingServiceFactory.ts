/**
 * Embedding Service Factory
 * Creates the appropriate embedding service based on configuration
 */

import { AIOrganiserSettings } from '../../core/settings';
import { IEmbeddingService, EmbeddingServiceConfig } from './types';
import { EMBEDDING_DEFAULT_MODEL, EMBEDDING_MODELS, EmbeddingProvider } from './embeddingRegistry';
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

    try {
        const provider = settings.embeddingProvider;
        
        // API key inheritance chain: embeddingApiKey → providerSettings[provider].apiKey → cloudApiKey
        const providerKey = settings.providerSettings?.[provider]?.apiKey;
        const apiKey = settings.embeddingApiKey || providerKey || settings.cloudApiKey || '';
        
        // Endpoint for Ollama only (other providers use defaults)
        const endpoint = provider === 'ollama' ? settings.ollamaEndpoint : undefined;

        return createEmbeddingService({
            provider,
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
    return EMBEDDING_DEFAULT_MODEL[provider] || EMBEDDING_DEFAULT_MODEL.openai;
}

/**
 * Get available models for a provider
 */
export function getAvailableEmbeddingModels(provider: EmbeddingProvider): string[] {
    return EMBEDDING_MODELS[provider] || EMBEDDING_MODELS.openai;
}

/**
 * Check if a provider requires an API key
 */
export function requiresApiKey(provider: EmbeddingProvider): boolean {
    return provider !== 'ollama';
}
