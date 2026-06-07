/**
 * Narration provider registry — single source of truth for all TTS providers.
 *
 * v1: Gemini only. v1.1 adds OpenAI / ElevenLabs by appending a registry
 * entry plus a factory; no caller changes (Open/Closed).
 */

import type AIOrganiserPlugin from '../../main';
import { createGeminiTtsEngine, type TtsEngine } from './ttsEngine';
import { createAzureSpeechTtsEngine } from './azureSpeechTtsEngine';

export type NarrationProviderId = 'gemini' | 'azure-openai';

export interface NarrationVoiceEntry {
    /** Provider's voice id (sent to API). */
    readonly id: string;
    /** Dotted i18n path to the user-visible label. */
    readonly labelKey: string;
}

export interface NarrationProviderConfig {
    readonly id: NarrationProviderId;
    readonly displayName: string;
    readonly modelId: string;
    readonly defaultVoice: string;
    readonly voices: ReadonlyArray<NarrationVoiceEntry>;
    /** Approximate USD per million characters of input text. */
    readonly costPerMillionCharsUsd: number;
    /** Key passed to ensurePrivacyConsent — must match an existing notice key. */
    readonly privacyConsentKey: string;
    /** Async factory; returns null when no API key resolvable. */
    readonly factory: (plugin: AIOrganiserPlugin) => Promise<TtsEngine | null>;
    /** Internal Azure-capability engine — NOT offered in the user-facing
     *  narration provider dropdown (selected only via the capability resolver). */
    readonly internalOnly?: boolean;
}

// ⚠ AUDIT-ON-RELEASE — pinned to a concrete version because Gemini's TTS
// product line is preview-only and has no public `*-tts-latest` alias yet.
// Our generic `latest-flash` sentinel (modelCapabilities.ts:pickNewestGemini)
// intentionally excludes TTS variants — `isTts: true` is filtered out so
// users asking for `latest-flash` don't silently get a TTS model.
//
// Bump this string every time Google ships a new Gemini TTS preview.
// Future work: extend `resolveLatestModel` with a `latest-flash-tts` /
// `latest-pro-tts` tier and add a `pickNewestGeminiTts` helper. See
// memory entry `feedback-always-use-latest-model-sentinels`.
const GEMINI_MODEL_ID = 'gemini-3.1-flash-tts-preview';

export const NARRATION_PROVIDERS: Readonly<Record<NarrationProviderId, NarrationProviderConfig>> = {
    gemini: {
        id: 'gemini',
        displayName: 'Google Gemini',
        modelId: GEMINI_MODEL_ID,
        defaultVoice: 'Charon',
        voices: [
            { id: 'Charon', labelKey: 'settings.newsletter.podcastVoiceCharon' },
            { id: 'Puck',   labelKey: 'settings.newsletter.podcastVoicePuck' },
            { id: 'Kore',   labelKey: 'settings.newsletter.podcastVoiceKore' },
        ],
        costPerMillionCharsUsd: 15.00,
        privacyConsentKey: 'gemini',
        factory: (plugin) => createGeminiTtsEngine(plugin, GEMINI_MODEL_ID),
    },
    'azure-openai': {
        id: 'azure-openai',
        displayName: 'Azure OpenAI Speech',
        // Model/deployment is resolved per-request from the tts capability config.
        modelId: 'azure-speech',
        defaultVoice: 'alloy',
        voices: [
            { id: 'alloy', labelKey: 'settings.azureCapabilities.tts' },
            { id: 'nova', labelKey: 'settings.azureCapabilities.tts' },
            { id: 'shimmer', labelKey: 'settings.azureCapabilities.tts' },
        ],
        costPerMillionCharsUsd: 15.00,
        // 'azure-openai' is the user's own resource — not in the external-data
        // consent list, so ensurePrivacyConsent returns true (no wrong Gemini notice).
        privacyConsentKey: 'azure-openai',
        factory: (plugin) => createAzureSpeechTtsEngine(plugin),
        internalOnly: true,
    },
};

export function getProvider(id: NarrationProviderId): NarrationProviderConfig {
    const p = NARRATION_PROVIDERS[id];
    if (!p) {
        throw new Error(`Unknown narration provider: ${id}`);
    }
    return p;
}

export function listProviders(): ReadonlyArray<NarrationProviderConfig> {
    return Object.values(NARRATION_PROVIDERS);
}
