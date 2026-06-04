/**
 * Embedding Service Factory
 * Creates the appropriate embedding service based on configuration
 */

import { AIOrganiserSettings } from '../../core/settings';
import { IEmbeddingService, EmbeddingServiceConfig } from './types';
import type { EmbeddingCooldown } from './embeddingCooldown';
import { logger } from '../../utils/logger';
import { EMBEDDING_DEFAULT_MODEL, EMBEDDING_MODELS, EmbeddingProvider } from './embeddingRegistry';
import { OpenAIEmbeddingService } from './openaiEmbeddingService';
import { OllamaEmbeddingService } from './ollamaEmbeddingService';
import { GeminiEmbeddingService } from './geminiEmbeddingService';
import { CohereEmbeddingService } from './cohereEmbeddingService';
import { VoyageEmbeddingService } from './voyageEmbeddingService';
import { getOpenAIEmbeddingsEndpoint, isAzureMode } from '../azure/endpointResolver';

// EmbeddingProvider type is imported from embeddingRegistry.ts
export type { EmbeddingProvider } from './embeddingRegistry';

/**
 * Create an embedding service from configuration
 */
export async function createEmbeddingService(config: EmbeddingServiceConfig): Promise<IEmbeddingService> {
    switch (config.provider) {
        case 'openai':
            if (!config.apiKey) {
                throw new Error('OpenAI API key is required');
            }
            return new OpenAIEmbeddingService({
                apiKey: config.apiKey,
                model: config.model,
                endpoint: config.endpoint,
                authHeaderType: config.authHeaderType,
                cooldown: config.cooldown
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
                endpoint: 'https://openrouter.ai/api/v1/embeddings',
                cooldown: config.cooldown
            });

        case 'local-onnx': {
            const { LocalOnnxEmbeddingService } = await import('./localOnnxEmbeddingService');
            return new LocalOnnxEmbeddingService(config.model || 'Xenova/all-MiniLM-L6-v2');
        }

        default:
            throw new Error(`Unsupported embedding provider: ${config.provider}`);
    }
}

/**
 * Create an embedding service from plugin settings
 * Handles API key inheritance and defaults
 *
 * @param settings - Plugin settings
 * @param apiKeyOverride - Optional API key from SecretStorage (takes precedence over settings)
 * @param cooldown - Optional shared cooldown circuit breaker (D4.2), injected into network providers
 */
export async function createEmbeddingServiceFromSettings(
    settings: AIOrganiserSettings,
    apiKeyOverride?: string,
    cooldown?: EmbeddingCooldown
): Promise<IEmbeddingService | null> {
    if (!settings.enableSemanticSearch) {
        return null;
    }

    try {
        const provider = settings.embeddingProvider;

        // API key inheritance chain:
        // 1. apiKeyOverride (from SecretStorage, resolved by caller)
        // 2. settings.embeddingApiKey (dedicated embedding key in settings)
        // 3. providerSettings[provider].apiKey (provider-specific key in settings)
        // 4. cloudApiKey (main LLM key - last resort)
        const providerKey = (provider in (settings.providerSettings || {}))
            ? settings.providerSettings?.[provider as keyof typeof settings.providerSettings]?.apiKey
            : undefined;
        const apiKey = apiKeyOverride || settings.embeddingApiKey || providerKey || settings.cloudApiKey || '';

        // Azure embeddings ride the `openai` provider with an Azure endpoint
        // + 'api-key' auth (plan §3). In Azure mode (any azure-* main provider)
        // openai-embeddings auto-route to the Azure embeddings surface.
        const useAzure = provider === 'openai' && isAzureMode(settings);

        if (useAzure) {
            // No silent fallback in Azure mode: the key MUST be the Azure key
            // (apiKeyOverride from the caller's Azure resolution, or a dedicated
            // embedding key) — NEVER the personal OpenAI providerKey or the main
            // cloudApiKey. Missing key OR invalid endpoint returns null so
            // semantic search reports "Azure embeddings not configured" rather
            // than silently embedding with local-onnx or a personal key.
            const azureKey = apiKeyOverride || settings.embeddingApiKey || '';
            if (!azureKey) {
                logger.error('Search', 'Azure embeddings not configured — no Azure key resolved.');
                return null;
            }
            let azureEndpoint: string | undefined;
            try {
                azureEndpoint = getOpenAIEmbeddingsEndpoint(settings);
            } catch {
                azureEndpoint = undefined;
            }
            if (!azureEndpoint) {
                logger.error('Search', 'Azure embeddings not configured — Azure OpenAI endpoint missing or invalid.');
                return null;
            }
            return await createEmbeddingService({
                provider: 'openai',
                model: settings.embeddingModel,
                apiKey: azureKey,
                endpoint: azureEndpoint,
                authHeaderType: 'api-key',
                cooldown
            });
        }

        // If provider needs an API key but none is available, fall back to built-in local-onnx
        if (requiresApiKey(provider) && !apiKey) {
            const { LocalOnnxEmbeddingService } = await import('./localOnnxEmbeddingService');
            return new LocalOnnxEmbeddingService();
        }

        // Endpoint for Ollama only (other providers use defaults)
        const endpoint = provider === 'ollama' ? settings.localEndpoint : undefined;

        return await createEmbeddingService({
            provider,
            model: settings.embeddingModel,
            apiKey,
            endpoint,
            cooldown
        });
    } catch (error) {
        logger.error('Search', 'Failed to create embedding service:', error);
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
    return provider !== 'ollama' && provider !== 'local-onnx';
}
