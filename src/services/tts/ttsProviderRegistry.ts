/**
 * Narration provider registry — single source of truth for all TTS providers.
 *
 * v1: Gemini only. v1.1 adds OpenAI / ElevenLabs by appending a registry
 * entry plus a factory; no caller changes (Open/Closed).
 */

import type AIOrganiserPlugin from '../../main';
import { createGeminiTtsEngine, type TtsEngine } from './ttsEngine';

export type NarrationProviderId = 'gemini';

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
}

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
