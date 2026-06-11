import type AIOrganiserPlugin from '../main';
import { PLUGIN_SECRET_IDS, STANDARD_SECRET_IDS } from '../core/secretIds';
import type { AdapterType } from './adapters';
import { PROVIDER_DEFAULT_MODEL, PROVIDER_ENDPOINT } from './adapters/providerRegistry';
import type { AIOrganiserSettings } from '../core/settings';
import { getOpenAIChatEndpoint, getClaudeMessagesEndpoint, isAzureMode } from './azure/endpointResolver';
import { getAzureApiKey } from './azure/azureKey';
import { resolveAzureCapability, capabilityChoice } from './azure/resolveAzureCapability';
import { assertAllowed } from './azure/audioProviderPolicy';
import type { ResolvedTranscriptionConfig } from './audioTranscriptionService';

// Re-export for existing importers (main.ts, pdfTranslationService, providerProfile,
// azureConnectionTest) — the canonical home is now ./azure/azureKey.
export { getAzureApiKey };

/**
 * Resolve the endpoint for a provider.
 *
 * Static providers read from `PROVIDER_ENDPOINT`. Azure providers have EMPTY
 * entries there — their URL is vault-local config resolved from settings at
 * call time (plan AD-4). Returns `''` when the Azure endpoint is unset/invalid
 * (empty-state guidance, no broken network call).
 */
export function resolveEndpoint(provider: AdapterType, plugin: AIOrganiserPlugin): string {
    const staticEndpoint = PROVIDER_ENDPOINT[provider];
    if (staticEndpoint) return staticEndpoint;

    if (provider === 'azure-claude') {
        try {
            // SSOT (G5) — get HTTPS + base-URL validation via normalizeEndpointUrl
            // instead of manual string concat.
            return getClaudeMessagesEndpoint(plugin.settings);
        } catch {
            return '';
        }
    }
    if (provider === 'azure-openai') {
        try {
            return getOpenAIChatEndpoint(plugin.settings);
        } catch {
            // Missing/invalid endpoint → empty-state guidance, no network call.
            return '';
        }
    }
    return '';
}

/**
 * Resolve the Azure API key for an Azure provider.
 *
 * `azure-claude` → AZURE_AI_FOUNDRY secret. `azure-openai` → its own
 * AZURE_OPENAI secret, falling back to the shared AZURE_AI_FOUNDRY key when
 * unset (plan AD-2 — the corporate setup shares one resource/key, but the
 * public store also supports separate keys). `useMainKeyFallback: false`
 * everywhere — an Azure provider must never silently borrow the user's
 * personal Claude/OpenAI key (Deepgram lesson, AD-8).
 */
// getAzureApiKey moved to ./azure/azureKey to break the apiKeyHelpers ↔
// resolveAzureCapability module cycle. Re-exported below for existing importers.

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
    const endpoint = resolveEndpoint(provider, plugin);

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
    // Azure: YouTube has no Azure path — it's BYO-gemini or off. Respect an
    // explicit "off" (default is byo, so an absent entry proceeds to the key chain).
    if (isAzureMode(plugin.settings) && plugin.settings.azureCapabilities?.youtube?.mode === 'off') {
        return null;
    }
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
 * Get the Deepgram API key (v2 diarization).
 *
 * Deepgram has no main-LLM equivalent, so there is no provider-fallback or
 * main-cloud-key fallback. 2-level chain: (1) SecretStorage dedicated id,
 * (2) plain-text in settings (transient — migrated on next save).
 */
export async function getDeepgramApiKey(plugin: AIOrganiserPlugin): Promise<string | null> {
    const secretStorage = plugin.secretStorageService;
    if (secretStorage.isAvailable()) {
        return await secretStorage.resolveApiKey({
            primaryId: PLUGIN_SECRET_IDS.DEEPGRAM,
            // CRITICAL: disable main-key fallback. Deepgram has no main-LLM
            // equivalent — without this flag, resolveApiKey would hand the
            // user's Claude/OpenAI key to Deepgram and trigger http-401.
            useMainKeyFallback: false,
            plainTextFallback: {
                primaryKey: plugin.settings.deepgramApiKey,
            },
        });
    }
    return plugin.settings.deepgramApiKey || null;
}

/**
 * OpenAI-direct key for gpt-audio (azure-audio plan Phase 4 — private/BYO only).
 *
 * gpt-audio is Global-Standard OpenAI egress: the policy refuses it in Azure
 * mode, and this chain must NEVER resolve an Azure key. Chain: OPENAI standard
 * secret → openai provider key → main cloud key ONLY when the main provider IS
 * openai (a direct-OpenAI user reusing their own key — not a borrow).
 */
export async function getGptAudioApiKey(plugin: AIOrganiserPlugin): Promise<string | null> {
    const secretStorage = plugin.secretStorageService;
    const mainIsOpenAI = plugin.settings.cloudServiceType === 'openai';
    if (secretStorage.isAvailable()) {
        return await secretStorage.resolveApiKey({
            primaryId: STANDARD_SECRET_IDS.OPENAI,
            providerFallback: 'openai',
            useMainKeyFallback: mainIsOpenAI,
            plainTextFallback: {
                providerKey: plugin.settings.providerSettings?.openai?.apiKey,
                mainCloudKey: mainIsOpenAI ? plugin.settings.cloudApiKey : undefined,
            },
        });
    }
    return plugin.settings.providerSettings?.openai?.apiKey
        || (mainIsOpenAI ? plugin.settings.cloudApiKey : null)
        || null;
}

/**
 * Cohere-native BYO key for the VISUAL embedding lane (visual-search, C22).
 *
 * DEDICATED secret (`PLUGIN_SECRET_IDS.COHERE_VISUAL`) — independently consented and
 * revocable. It must NEVER inherit the text-lane embedding key or the main LLM key
 * (`useMainKeyFallback: false`, Deepgram lesson): visual indexing transmits page IMAGES,
 * a different consent surface than text embeddings (C5/C18). No plain-text settings
 * fallback — the key is entered through SecretStorage in the visual-search panel only.
 */
export async function getCohereVisualApiKey(plugin: AIOrganiserPlugin): Promise<string | null> {
    const secretStorage = plugin.secretStorageService;
    if (!secretStorage.isAvailable()) return null;
    return await secretStorage.resolveApiKey({
        primaryId: PLUGIN_SECRET_IDS.COHERE_VISUAL,
        useMainKeyFallback: false,
    });
}

/**
 * LLM enhancer key resolution (audioNarration LLM pre-pass).
 *
 * Returns PRIMITIVES only — no audioNarration types imported, so this
 * helper stays a pure utility and doesn't create an upward layering
 * violation. Callers in audioNarration combine the returned apiKey
 * with the `LLM_ENHANCEMENT_PROVIDERS` registry entry locally.
 *
 * Per Deepgram v2 lesson: `useMainKeyFallback: false` for both providers.
 */
export async function resolveLlmEnhancementApiKey(
    plugin: AIOrganiserPlugin,
    providerId: 'gemini' | 'haiku',
): Promise<string | null> {
    const secretStorage = plugin.secretStorageService;
    if (providerId === 'gemini') {
        let resolved: string | null = null;
        if (secretStorage.isAvailable()) {
            resolved = await secretStorage.resolveApiKey({
                primaryId: PLUGIN_SECRET_IDS.LLM_ENHANCER_GEMINI,
                providerFallback: 'gemini',
                useMainKeyFallback: false,
                plainTextFallback: {
                    primaryKey: plugin.settings.llmEnhancerGeminiApiKey,
                    providerKey: plugin.settings.providerSettings?.gemini?.apiKey,
                },
            });
        } else {
            resolved = plugin.settings.llmEnhancerGeminiApiKey
                || plugin.settings.providerSettings?.gemini?.apiKey
                || null;
        }
        // Opt-in YouTube key reuse — uses the FULL getYouTubeGeminiApiKey
        // chain (plaintext + provider key + main cloud when Gemini), so we
        // don't bypass any of the user's existing fallback paths.
        if (!resolved && plugin.settings.llmEnhancerReuseYoutubeKey) {
            return await getYouTubeGeminiApiKey(plugin);
        }
        return resolved;
    }
    // Haiku — Anthropic key
    if (secretStorage.isAvailable()) {
        return await secretStorage.resolveApiKey({
            primaryId: PLUGIN_SECRET_IDS.LLM_ENHANCER_ANTHROPIC,
            providerFallback: 'claude',
            useMainKeyFallback: false,
            plainTextFallback: {
                primaryKey: plugin.settings.llmEnhancerAnthropicApiKey,
                providerKey: plugin.settings.providerSettings?.claude?.apiKey,
            },
        });
    }
    return plugin.settings.llmEnhancerAnthropicApiKey
        || plugin.settings.providerSettings?.claude?.apiKey
        || null;
}

/** Cheap availability check — does NOT expose the key value.
 *  Used by prepareNarration to decide whether to set llmIntent
 *  (per R3 M2 — modal shouldn't promise enhancement we can't deliver). */
export async function hasLlmEnhancementKey(
    plugin: AIOrganiserPlugin,
    providerId: 'gemini' | 'haiku',
): Promise<boolean> {
    const key = await resolveLlmEnhancementApiKey(plugin, providerId);
    return key !== null && key.length > 0;
}

/**
 * Get API key for audio transcription (Whisper).
 *
 * In Azure mode (main provider is ANY azure-* surface), route Whisper through
 * the Azure OpenAI surface using the shared Foundry key + the resolved Whisper
 * endpoint — even when the main model is azure-claude. NO silent fallback: if
 * the Azure key or endpoint is missing/invalid, return null so the caller
 * surfaces "transcription provider not configured" rather than quietly billing
 * a personal OpenAI/Groq key. Direct openai/groq fallback only when NOT in
 * Azure mode.
 */
export async function getAudioTranscriptionApiKey(
    plugin: AIOrganiserPlugin,
): Promise<ResolvedTranscriptionConfig | null> {
    // Azure mode: the per-capability config decides azure / byo / off (flexible
    // Azure routing). resolveAzureCapability is the single decision owner; this
    // is transcription's resolution entry. No silent fallback.
    if (isAzureMode(plugin.settings)) {
        const res = await resolveAzureCapability(plugin, 'transcription');
        if (res.kind === 'azure') {
            // azure-speech uses a DIFFERENT auth header + body shape
            // (Ocp-Apim-Subscription-Key + multipart `definition`) — routed as its
            // own provider so the Whisper path never consumes it (plan D1).
            if (res.surface === 'azure-speech') {
                return { key: res.key, provider: 'azure-speech', azureEndpoint: res.endpoint };
            }
            return { key: res.key, provider: 'azure', azureEndpoint: res.endpoint };
        }
        if (res.kind === 'unavailable') {
            // off / no-deployment / no-endpoint / no-key — caller surfaces the reason.
            return null;
        }
        // res.kind === 'byo' → user explicitly chose a non-Azure provider; fall
        // through to the openai/groq resolution below (no azure fallback).
    }

    const configuredStt = plugin.settings.audioTranscriptionProvider || 'openai';

    // `openai-gpt-audio` (plan Phase 4): OpenAI-direct chain, kept as its OWN
    // provider id so transcribeAudio routes to the bounded short-clip path
    // (wav/mp3 + size caps; ineligible clips fall back to Whisper internally).
    // CALL-TIME policy gate (D5/D8): Azure mode reaches here via the explicit
    // BYO capability choice, where a stale persisted `openai-gpt-audio` must
    // fall back to the user's chosen Whisper, never OpenAI-direct chat egress.
    if (configuredStt === 'openai-gpt-audio'
        && assertAllowed(plugin, { op: 'stt', providerId: 'openai-gpt-audio' }).ok) {
        const key = await getGptAudioApiKey(plugin);
        if (key) return { key, provider: 'openai-gpt-audio' };
        // No OpenAI key at all → fall through to the whisper chain (which may
        // still find a dedicated AUDIO secret usable for whisper).
    }

    const selectedProvider: 'openai' | 'groq' = configuredStt === 'groq' ? 'groq' : 'openai';

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
 * AD-4/AD-8: dedicated research key → main Claude key (when provider is Claude)
 * → Azure AI Foundry key (only when provider is `azure-claude`) → null.
 * No silent fall-through to a personal Anthropic key from the Azure tier.
 */
export async function getClaudeWebSearchKey(plugin: AIOrganiserPlugin): Promise<string | null> {
    const secretStorage = plugin.secretStorageService;

    // AZURE FIRST (plan AD-8): under azure-claude the web-search request is
    // Bearer-authed to the Foundry passthrough. A dedicated research key is for
    // the DIRECT Anthropic transport (x-api-key) — Bearer-sending it to Azure
    // 401s ("invalid subscription key"). So on Azure, always reuse the Foundry
    // key and NEVER honour a (possibly stale / direct-Anthropic) dedicated key.
    // Verified against the live Foundry endpoint 2026-06: the Foundry key 200s
    // for both basic + dynamic web_search; a leftover sk-ant dedicated key 401s.
    // Never a silent cross-boundary fallback to a personal Anthropic key.
    // Azure: per-capability websearch routing. The websearch capability runs on
    // the azure-claude surface for ANY azure main provider (incl. azure-openai).
    // This resolves the KEY only (mode gate) — the endpoint base + Claude
    // deployment are threaded by researchSearchService/the adapter, so we do NOT
    // require them here. mode azure → Foundry key; byo/off → null (researchProvider
    // selects tavily/brightdata, or the feature is off).
    if (isAzureMode(plugin.settings)) {
        const choice = capabilityChoice(plugin, 'websearch');
        return choice.mode === 'azure' ? await getAzureApiKey(plugin, 'azure-claude') : null;
    }

    const dedicated = await secretStorage.getSecret(
        PLUGIN_SECRET_IDS.RESEARCH_CLAUDE_WEB_SEARCH_KEY,
    );
    if (dedicated) return dedicated;

    if (plugin.settings.cloudServiceType === 'claude') {
        const mainKey = await secretStorage.getSecret('anthropic-api-key');
        if (mainKey) return mainKey;
        return plugin.settings.cloudApiKey || null;
    }
    // Azure transport (base + Bearer auth + dynamic-filtering `anthropic-beta`
    // header) is wired in `claudeWebSearchAdapter` via the `azureEndpointBase`
    // option threaded from `researchSearchService`.
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
