import type AIOrganiserPlugin from '../main';
import { PLUGIN_SECRET_IDS } from '../core/secretIds';
import type { AdapterType } from './adapters';
import { PROVIDER_DEFAULT_MODEL, PROVIDER_ENDPOINT } from './adapters/providerRegistry';
import type { AIOrganiserSettings } from '../core/settings';

/**
 * Unified specialist provider configuration.
 * All specialist resolvers return this shape (or null).
 */
export interface SpecialistProviderConfig {
    provider: AdapterType;
    apiKey: string;
    model: string;
    endpoint: string;
}

// Backward-compatible type aliases
export type AuditProviderConfig = SpecialistProviderConfig;
export type FlashcardProviderConfig = SpecialistProviderConfig;
export type QuickPeekProviderConfig = SpecialistProviderConfig;

interface ResolveOptions {
    /** Settings key for provider selection (e.g., 'auditProvider') */
    providerKey: keyof AIOrganiserSettings;
    /** Settings key for model override (e.g., 'auditModel') */
    modelKey?: keyof AIOrganiserSettings;
    /** Dedicated secret ID for primary key lookup */
    primarySecretId?: string;
    /** Plain-text settings key for dedicated API key */
    primaryPlainTextKey?: keyof AIOrganiserSettings;
    /** Guard: return null when provider equals this value */
    skipWhenProvider?: string;
    /** Guard: return null when this settings flag is false */
    requiredFlag?: keyof AIOrganiserSettings;
}

/** Resolve API key via plain-text settings fallback chain (no SecretStorage). */
function resolvePlainTextKey(
    settings: AIOrganiserSettings,
    provider: AdapterType,
    primaryPlainTextKey?: keyof AIOrganiserSettings
): string | null {
    if (primaryPlainTextKey) {
        const primary = settings[primaryPlainTextKey] as string;
        if (primary) return primary;
    }
    const providerKey = settings.providerSettings?.[provider]?.apiKey;
    if (providerKey) return providerKey;
    if (settings.cloudServiceType === provider && settings.cloudApiKey) {
        return settings.cloudApiKey;
    }
    return null;
}

/**
 * Unified specialist provider resolution.
 * Consolidates the shared 80% logic across audit, flashcard, quickPeek, and YouTube resolvers.
 */
export async function resolveSpecialistProvider(
    plugin: AIOrganiserPlugin,
    options: ResolveOptions
): Promise<SpecialistProviderConfig | null> {
    const settings = plugin.settings;

    // Guard: required flag check
    if (options.requiredFlag && !settings[options.requiredFlag]) {
        return null;
    }

    const provider = settings[options.providerKey] as AdapterType;

    // Guard: skip when provider matches (e.g., 'main')
    if (options.skipWhenProvider && provider === options.skipWhenProvider) {
        return null;
    }

    // Resolve API key
    const secretStorage = plugin.secretStorageService;
    const apiKey = secretStorage.isAvailable()
        ? await secretStorage.resolveApiKey({
            primaryId: options.primarySecretId,
            providerFallback: provider,
            useMainKeyFallback: settings.cloudServiceType === provider,
            plainTextFallback: {
                primaryKey: options.primaryPlainTextKey ? settings[options.primaryPlainTextKey] as string : undefined,
                providerKey: settings.providerSettings?.[provider]?.apiKey,
                mainCloudKey: settings.cloudApiKey
            }
        })
        : resolvePlainTextKey(settings, provider, options.primaryPlainTextKey);

    if (!apiKey) return null;

    const model = options.modelKey
        ? (settings[options.modelKey] as string) || PROVIDER_DEFAULT_MODEL[provider] || ''
        : PROVIDER_DEFAULT_MODEL[provider] || '';
    const endpoint = PROVIDER_ENDPOINT[provider] || '';

    return { provider, apiKey, model, endpoint };
}

/**
 * Resolve dedicated audit LLM provider.
 * Returns null when auditProvider === 'main' or enableLLMAudit is false.
 */
export async function getAuditProviderConfig(
    plugin: AIOrganiserPlugin
): Promise<SpecialistProviderConfig | null> {
    return resolveSpecialistProvider(plugin, {
        providerKey: 'auditProvider',
        modelKey: 'auditModel',
        requiredFlag: 'enableLLMAudit',
        skipWhenProvider: 'main',
    });
}

/**
 * Resolve audio narration provider.
 *
 * v1: Gemini-only. Uses the canonical specialist resolver — same chain Audit
 * and Flashcard use (SecretStorage → providerSettings → main cloud key when
 * cloudServiceType matches the target provider). v1.1 will expand the registry
 * with OpenAI/ElevenLabs without changing this function's signature.
 *
 * Returns null when no API key is resolvable (caller surfaces NO_API_KEY).
 */
export async function getAudioNarrationProviderConfig(
    plugin: AIOrganiserPlugin
): Promise<SpecialistProviderConfig | null> {
    return resolveSpecialistProvider(plugin, {
        providerKey: 'audioNarrationProvider',
    });
}

/**
 * Get the Gemini API key for YouTube processing.
 *
 * YouTube video ingestion hits Google's `generativelanguage.googleapis.com`
 * directly, so the key MUST be a Gemini key — we can't substitute the main
 * cloud key when the main provider is Claude / OpenAI / etc.
 *
 * Priority: (1) dedicated YouTube secret, (2) Gemini provider's saved key,
 * (3) main cloud key IFF `cloudServiceType === 'gemini'`. Earlier versions
 * routed through `resolveSpecialistProvider` with `providerKey: 'cloudServiceType'`,
 * which treated the main provider as the target — that happily returned the
 * user's Claude key and Google 400'd with "API key not valid" (user report
 * 2026-04-23).
 */
export async function getYouTubeGeminiApiKey(plugin: AIOrganiserPlugin): Promise<string | null> {
    const useMainKeyFallback = plugin.settings.cloudServiceType === 'gemini';
    const secretStorage = plugin.secretStorageService;
    if (secretStorage.isAvailable()) {
        return await secretStorage.resolveApiKey({
            primaryId: PLUGIN_SECRET_IDS.YOUTUBE,
            providerFallback: 'gemini',
            useMainKeyFallback,
            plainTextFallback: {
                primaryKey: plugin.settings.youtubeGeminiApiKey,
                providerKey: plugin.settings.providerSettings?.gemini?.apiKey,
                // Only surface the main cloud key when it's actually a Gemini key.
                // Otherwise the plain-text fallback chain would hand Google a
                // Claude / OpenAI key and trigger "API key not valid" 400s.
                mainCloudKey: useMainKeyFallback ? plugin.settings.cloudApiKey : undefined
            }
        });
    }

    return plugin.settings.youtubeGeminiApiKey
        || plugin.settings.providerSettings?.gemini?.apiKey
        || (useMainKeyFallback ? plugin.settings.cloudApiKey : null)
        || null;
}

/**
 * Get API key for audio transcription (Whisper).
 * Tries selected provider first, then falls back to the other (openai↔groq).
 */
export async function getAudioTranscriptionApiKey(plugin: AIOrganiserPlugin): Promise<{ key: string; provider: 'openai' | 'groq' } | null> {
    const selectedProvider = plugin.settings.audioTranscriptionProvider || 'openai';

    const resolveKey = async (provider: 'openai' | 'groq'): Promise<string | null> => {
        const secretStorage = plugin.secretStorageService;
        if (secretStorage.isAvailable()) {
            return await secretStorage.resolveApiKey({
                primaryId: PLUGIN_SECRET_IDS.AUDIO,
                providerFallback: provider,
                useMainKeyFallback: plugin.settings.cloudServiceType === provider,
                plainTextFallback: {
                    primaryKey: plugin.settings.audioTranscriptionApiKey,
                    providerKey: plugin.settings.providerSettings?.[provider]?.apiKey,
                    mainCloudKey: plugin.settings.cloudApiKey
                }
            });
        }

        return plugin.settings.audioTranscriptionApiKey
            || (plugin.settings.cloudServiceType === provider ? plugin.settings.cloudApiKey : null)
            || plugin.settings.providerSettings?.[provider]?.apiKey
            || null;
    };

    const selectedKey = await resolveKey(selectedProvider);
    if (selectedKey) {
        return { key: selectedKey, provider: selectedProvider };
    }

    const otherProvider = selectedProvider === 'openai' ? 'groq' : 'openai';
    const otherKey = await resolveKey(otherProvider);
    if (otherKey) {
        return { key: otherKey, provider: otherProvider };
    }

    return null;
}

/**
 * Resolve dedicated flashcard LLM provider.
 * Returns null when flashcardProvider === 'main'.
 */
export async function getFlashcardProviderConfig(
    plugin: AIOrganiserPlugin
): Promise<SpecialistProviderConfig | null> {
    return resolveSpecialistProvider(plugin, {
        providerKey: 'flashcardProvider',
        modelKey: 'flashcardModel',
        skipWhenProvider: 'main',
    });
}

/**
 * Resolve dedicated Quick Peek LLM provider.
 * Returns null when quickPeekProvider === 'main'.
 */
export async function getQuickPeekProviderConfig(
    plugin: AIOrganiserPlugin
): Promise<SpecialistProviderConfig | null> {
    return resolveSpecialistProvider(plugin, {
        providerKey: 'quickPeekProvider',
        modelKey: 'quickPeekModel',
        skipWhenProvider: 'main',
    });
}

/**
 * Resolve Claude Web Search API key.
 * AD-4: dedicated research key → main Claude key (when provider is Claude).
 */
export async function getClaudeWebSearchKey(plugin: AIOrganiserPlugin): Promise<string | null> {
    const secretStorage = plugin.secretStorageService;

    const dedicated = await secretStorage.getSecret(
        PLUGIN_SECRET_IDS.RESEARCH_CLAUDE_WEB_SEARCH_KEY,
    );
    if (dedicated) return dedicated;

    if (plugin.settings.cloudServiceType === 'claude') {
        const mainKey = await secretStorage.getSecret('anthropic-api-key');
        if (mainKey) return mainKey;
        return plugin.settings.cloudApiKey || null;
    }
    return null;
}

/**
 * Preflight check: is the main LLM provider actually configured?
 *
 * Returns null when ready to go, or a user-facing error message when the
 * provider has no API key / no endpoint. Call this at the top of any handler
 * that performs destructive actions (content rewrites, deletions) before the
 * LLM call — so an unconfigured plugin can't silently mangle the user's note.
 */
export async function checkMainProviderConfigured(
    plugin: AIOrganiserPlugin
): Promise<string | null> {
    const settings = plugin.settings;

    if (settings.serviceType === 'local') {
        if (!settings.localEndpoint?.trim()) {
            return 'No local LLM endpoint configured. Open Settings → AI Provider to add one.';
        }
        return null;
    }

    const provider = settings.cloudServiceType;
    const secretStorage = plugin.secretStorageService;
    const key = secretStorage.isAvailable()
        ? await secretStorage.getProviderKey(provider)
        : null;

    const plainTextKey = settings.providerSettings?.[provider]?.apiKey || settings.cloudApiKey;
    if (!key && !plainTextKey) {
        const label = provider.charAt(0).toUpperCase() + provider.slice(1);
        return `No API key configured for ${label}. Open Settings → AI Provider to add one.`;
    }

    return null;
}
