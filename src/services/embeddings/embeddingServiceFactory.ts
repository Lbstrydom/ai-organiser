/**
 * Embedding Service Factory
 * Creates the appropriate embedding service based on configuration
 */

import { AIOrganiserSettings } from '../../core/settings';
import { isFeatureEnabled } from '../featureService';
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
import { Result, ok, err } from '../../core/result';

// EmbeddingProvider type is imported from embeddingRegistry.ts
export type { EmbeddingProvider } from './embeddingRegistry';

/** The local ONNX embedding fallback (npm-audit-remediation plan, Cluster 4)
 *  carries a critical, unpatched RCE-class vulnerability chain
 *  (@xenova/transformers -> onnxruntime-web -> protobufjs). It is gated
 *  behind `settings.enableLocalOnnxEmbeddings`, and this is the ONLY
 *  function in this module that reads that flag AND can construct
 *  `LocalOnnxEmbeddingService` — policy-check and construction are
 *  inseparable in one function body, not merely co-located by convention,
 *  so no other call site can bypass the consent gate. See
 *  docs/dependency-accepted-risks.md. */
export async function resolveLocalOnnxEmbeddingService(
    settings: AIOrganiserSettings,
    modelId?: string,
): Promise<Result<IEmbeddingService>> {
    // audit-caught (H3, round 3): a strict `=== true` check, not a truthy
    // check — `AIOrganiserSettings.enableLocalOnnxEmbeddings` is typed as
    // `boolean`, but settings are loaded from a persisted JSON file
    // (`data.json`), which TypeScript's type system cannot verify at
    // runtime. A hand-edited or corrupted file with a non-boolean truthy
    // value (e.g. the string `"false"`) must not be interpreted as
    // consent at exactly the boundary this cluster exists to guard.
    if (settings.enableLocalOnnxEmbeddings !== true) {
        return err('local-onnx-not-consented');
    }
    // audit-caught (H1/H4/H5/H7/M4, recurring across two rounds): an
    // unrecognised model id used to fall through to construction anyway,
    // which the service resolves against Hugging Face Hub's mutable `main`
    // branch (no immutable-revision pin exists for it) — a fail-OPEN
    // outcome at exactly the trust boundary this whole cluster exists to
    // fail CLOSED at. `EMBEDDING_MODELS['local-onnx']` is the same list
    // that drives the settings dropdown (embeddingRegistry.ts) — the only
    // 3 models a user can ever actually select — so validating against it
    // rejects anything else (corrupted/hand-edited settings, a future code
    // path) before construction, rather than silently downloading and
    // running an unreviewed model.
    const effectiveModelId = modelId || EMBEDDING_DEFAULT_MODEL['local-onnx'];
    if (!EMBEDDING_MODELS['local-onnx'].includes(effectiveModelId)) {
        logger.error('Search', `Rejected unsupported local-onnx model id: ${effectiveModelId}`);
        return err('local-onnx-model-unsupported');
    }
    // audit-caught (M1/M8/M16): the advertised Result<T> boundary must be
    // total — a failed dynamic import (optional dependency missing/corrupt)
    // or a throwing constructor must surface as `err(...)`, not a rejected
    // promise that bypasses every caller's Result-handling.
    try {
        const { LocalOnnxEmbeddingService } = await import('./localOnnxEmbeddingService');
        return ok(new LocalOnnxEmbeddingService(effectiveModelId));
    } catch (error) {
        logger.error('Search', 'Failed to load local ONNX embedding service:', error);
        return err('local-onnx-load-failed');
    }
}

/** Pure primitives in, no lookups — takes an already-resolved `hasApiKey`
 *  rather than resolving a key itself (API-key resolution is async and has
 *  Azure-specific branching that a synchronous, settings-only function
 *  can't perform). Both real callers (the dispatcher below, which already
 *  computes `apiKey`; the settings UI, via its own key-presence check)
 *  already have this value cheaply, so nothing is duplicated. This is the
 *  single source of truth for embedding availability — the dispatcher and
 *  the settings-UI banner both call it, so they can never drift apart. */
export type EmbeddingAvailability = 'cloud' | 'local-onnx' | 'credentials-missing' | 'local-onnx-not-consented';

export function classifyEmbeddingAvailability(
    provider: EmbeddingProvider,
    hasApiKey: boolean,
    isConsented: boolean,
    isAzureMode: boolean,
): EmbeddingAvailability {
    // Azure mode has its own explicit no-fallback rule (see
    // createEmbeddingServiceFromSettings's `useAzure` branch below) — it
    // NEVER falls back to local-onnx, unconditionally, regardless of
    // enableLocalOnnxEmbeddings.
    if (isAzureMode) {
        return hasApiKey ? 'cloud' : 'credentials-missing';
    }
    if (provider === 'local-onnx') {
        // audit-caught (M1/M2, round 4): match resolveLocalOnnxEmbeddingService()'s
        // strict `=== true` check, not a truthy check — this classifier and
        // the resolver must never interpret a persisted/caller-provided
        // non-boolean truthy value differently from each other.
        return isConsented === true ? 'local-onnx' : 'local-onnx-not-consented';
    }
    if (requiresApiKey(provider) && !hasApiKey) {
        // audit-caught (M1/M2, round 4): match resolveLocalOnnxEmbeddingService()'s
        // strict `=== true` check, not a truthy check — this classifier and
        // the resolver must never interpret a persisted/caller-provided
        // non-boolean truthy value differently from each other.
        return isConsented === true ? 'local-onnx' : 'local-onnx-not-consented';
    }
    return 'cloud';
}

/** `createEmbeddingService()`'s config no longer admits `'local-onnx'` at
 *  the type level — a caller must go through `resolveLocalOnnxEmbeddingService()`
 *  instead. This makes the bypass unrepresentable to ordinary TypeScript
 *  callers, not just a runtime convention. */
type NonLocalEmbeddingServiceConfig = Omit<EmbeddingServiceConfig, 'provider'> & {
    provider: Exclude<EmbeddingServiceConfig['provider'], 'local-onnx'>;
};

/**
 * Create an embedding service from configuration. Does NOT construct the
 * local-onnx provider — see `resolveLocalOnnxEmbeddingService()`.
 */
export function createEmbeddingService(config: NonLocalEmbeddingServiceConfig): IEmbeddingService {
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

        default:
            throw new Error(`Unsupported embedding provider: ${config.provider}`);
    }
}

/** The outcome of resolving an embedding service from settings — an object,
 *  not a bare nullable, so the reason travels WITH the specific `await`
 *  that produced it. Two concurrent calls (e.g. plugin-load racing a
 *  settings-change reinit) can never cross-contaminate each other's
 *  reason, since neither stores it anywhere shared. */
export interface EmbeddingServiceResolution {
    service: IEmbeddingService | null;
    unavailableReason: 'none' | 'credentials-missing' | 'local-onnx-not-consented' | 'local-onnx-load-failed' | 'local-onnx-model-unsupported';
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
): Promise<EmbeddingServiceResolution> {
    const unavailable = (reason: EmbeddingServiceResolution['unavailableReason']): EmbeddingServiceResolution =>
        ({ service: null, unavailableReason: reason });

    // FT-11: gate on the feature (semantic-search absorbed enableSemanticSearch).
    if (!isFeatureEnabled(settings, 'semantic-search')) {
        return unavailable('none');
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
            // cloudApiKey. Missing key OR invalid endpoint returns unavailable so
            // semantic search reports "Azure embeddings not configured" rather
            // than silently embedding with local-onnx or a personal key. Azure
            // mode NEVER falls back to local-onnx — see classifyEmbeddingAvailability.
            const azureKey = apiKeyOverride || settings.embeddingApiKey || '';
            if (!azureKey) {
                logger.error('Search', 'Azure embeddings not configured — no Azure key resolved.');
                return unavailable('credentials-missing');
            }
            let azureEndpoint: string | undefined;
            try {
                azureEndpoint = getOpenAIEmbeddingsEndpoint(settings);
            } catch {
                azureEndpoint = undefined;
            }
            if (!azureEndpoint) {
                logger.error('Search', 'Azure embeddings not configured — Azure OpenAI endpoint missing or invalid.');
                return unavailable('credentials-missing');
            }
            const service = createEmbeddingService({
                provider: 'openai',
                model: settings.embeddingModel,
                apiKey: azureKey,
                endpoint: azureEndpoint,
                authHeaderType: 'api-key',
                cooldown
            });
            return { service, unavailableReason: 'none' };
        }

        // Explicit local-onnx selection, or the auto-fallback condition
        // (provider needs an API key but none is available) — both route
        // through the SAME consent-gated resolver, no special-casing.
        //
        // audit-caught (H3/M6 round 2): `settings.embeddingModel` only
        // means "a local-onnx model id" when `embeddingProvider` is ITSELF
        // 'local-onnx' — the model the user picked via the dropdown. In the
        // auto-fallback branch, `embeddingProvider` is still a DIFFERENT
        // cloud provider (e.g. 'openai') and `embeddingModel` is that
        // provider's model string (e.g. 'text-embedding-3-small'), which
        // resolveLocalOnnxEmbeddingService() would otherwise try to load as
        // a HuggingFace repo id. This was the root cause behind three
        // separate UI mutators each needing their own "also switch provider
        // + model" patch (M9/H3/M6 across two audit rounds) — fixing it
        // ONCE here, at the boundary that actually has both pieces of
        // context (which branch is executing), means no UI callback needs
        // to coordinate consent + provider + model as a bundle.
        const localOnnxModelId = provider === 'local-onnx' ? settings.embeddingModel : undefined;
        if (provider === 'local-onnx' || (requiresApiKey(provider) && !apiKey)) {
            const result = await resolveLocalOnnxEmbeddingService(settings, localOnnxModelId);
            if (!result.ok) {
                // audit-caught (M7): resolveLocalOnnxEmbeddingService() can
                // fail for THREE distinct reasons (not consented, the
                // package/model failed to load, or an unsupported model id
                // was rejected) — collapsing them all into
                // 'local-onnx-not-consented' hid real failures behind a
                // message telling an already-consented user to "enable"
                // something they'd already enabled.
                const reason = result.error === 'local-onnx-load-failed' || result.error === 'local-onnx-model-unsupported'
                    ? result.error
                    : 'local-onnx-not-consented';
                return unavailable(reason);
            }
            return { service: result.value, unavailableReason: 'none' };
        }

        // Endpoint for Ollama only (other providers use defaults)
        const endpoint = provider === 'ollama' ? settings.localEndpoint : undefined;

        const service = createEmbeddingService({
            provider,
            model: settings.embeddingModel,
            apiKey,
            endpoint,
            cooldown
        });
        return { service, unavailableReason: 'none' };
    } catch (error) {
        logger.error('Search', 'Failed to create embedding service:', error);
        return unavailable('credentials-missing');
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
