/**
 * Narration provider registry — single source of truth for all TTS providers.
 *
 * v1: Gemini only. v1.1 adds OpenAI / ElevenLabs by appending a registry
 * entry plus a factory; no caller changes (Open/Closed).
 */

import type AIOrganiserPlugin from '../../main';
import { createGeminiTtsEngine, type TtsEngine } from './ttsEngine';
import { createAzureSpeechTtsEngine } from './azureSpeechTtsEngine';
import { createCognitiveSpeechTtsEngine } from './cognitiveSpeechTtsEngine';
import { createGptAudioTtsEngine, resolveGptAudioModel } from './gptAudioTtsEngine';
import { getCachedModels } from '../adapters/dynamicModelService';
import { resolveSpecialistModel } from '../adapters/modelCapabilities';

/** `azure-openai` (legacy /audio/speech) + `azure-speech` (in-region Cognitive
 *  Speech) are internalOnly — selected only via the capability resolver.
 *  `openai-gpt-audio` is user-selectable, private/BYO ONLY (policy refuses it
 *  in Azure mode — azure-audio D5). */
export type NarrationProviderId = 'gemini' | 'azure-openai' | 'azure-speech' | 'openai-gpt-audio';

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
    /** Resolve the model actually used at call time (auto-latest). When present it
     *  drives BOTH the engine AND the narration cache fingerprint, so a model rotation
     *  invalidates the cache. Absent → the static `modelId` is used as-is. */
    readonly getEffectiveModelId?: () => string;
    /** Internal Azure-capability engine — NOT offered in the user-facing
     *  narration provider dropdown (selected only via the capability resolver). */
    readonly internalOnly?: boolean;
}

// Gemini's TTS line is preview-only and Google ships NO `*-tts-latest` server alias,
// so we auto-track the newest TTS model OURSELVES: the `latest-flash-tts` sentinel ranks
// the TTS-tagged models in the live `/models` catalog (`pickNewestGeminiTts`). When the
// catalog isn't fetched (no key / offline) we fall back to the known previews, then this
// pinned default. No manual bump needed — a new `gemini-X-flash-tts` is picked up live.
const GEMINI_TTS_FALLBACK = 'gemini-3.1-flash-tts-preview';
const GEMINI_TTS_SENTINEL = 'latest-flash-tts';
// Offline fallback pool of known TTS previews (the live catalog supersedes this).
const GEMINI_TTS_STATIC = [GEMINI_TTS_FALLBACK, 'gemini-2.5-flash-preview-tts', 'gemini-2.5-pro-preview-tts'];

/** Resolve the newest Gemini TTS model: live catalog → known previews → pinned default.
 *  Exported for tests + the cache-fingerprint path (kept consistent with the engine). */
export function resolveGeminiTtsModel(): string {
    const live = getCachedModels('gemini')?.map((m) => m.id) ?? null;
    const resolved = resolveSpecialistModel('gemini', GEMINI_TTS_SENTINEL, { liveIds: live, staticIds: GEMINI_TTS_STATIC });
    // resolveSpecialistModel echoes the sentinel back when nothing matched → use the default.
    return resolved.startsWith('latest-') ? GEMINI_TTS_FALLBACK : resolved;
}

export const NARRATION_PROVIDERS: Readonly<Record<NarrationProviderId, NarrationProviderConfig>> = {
    gemini: {
        id: 'gemini',
        displayName: 'Google Gemini',
        modelId: GEMINI_TTS_FALLBACK,            // display/fallback; actual model via getEffectiveModelId
        getEffectiveModelId: resolveGeminiTtsModel,
        defaultVoice: 'Charon',
        voices: [
            { id: 'Charon', labelKey: 'settings.newsletter.podcastVoiceCharon' },
            { id: 'Puck',   labelKey: 'settings.newsletter.podcastVoicePuck' },
            { id: 'Kore',   labelKey: 'settings.newsletter.podcastVoiceKore' },
        ],
        costPerMillionCharsUsd: 15.00,
        privacyConsentKey: 'gemini',
        factory: (plugin) => createGeminiTtsEngine(plugin, resolveGeminiTtsModel()),
    },
    'openai-gpt-audio': {
        id: 'openai-gpt-audio',
        displayName: 'OpenAI GPT audio',
        modelId: 'gpt-audio-1.5',                 // display/fallback; actual via getEffectiveModelId
        getEffectiveModelId: resolveGptAudioModel, // latest gpt-audio-* from the live catalog
        defaultVoice: 'alloy',
        voices: [
            { id: 'alloy',   labelKey: 'settings.audioNarration.gptAudioVoiceAlloy' },
            { id: 'cedar',   labelKey: 'settings.audioNarration.gptAudioVoiceCedar' },
            { id: 'marin',   labelKey: 'settings.audioNarration.gptAudioVoiceMarin' },
            { id: 'nova',    labelKey: 'settings.audioNarration.gptAudioVoiceNova' },
            { id: 'onyx',    labelKey: 'settings.audioNarration.gptAudioVoiceOnyx' },
            { id: 'shimmer', labelKey: 'settings.audioNarration.gptAudioVoiceShimmer' },
        ],
        costPerMillionCharsUsd: 25.00,
        privacyConsentKey: 'openai',
        factory: (plugin) => createGptAudioTtsEngine(plugin),
    },
    'azure-speech': {
        id: 'azure-speech',
        displayName: 'Azure AI Speech',
        // Voice (not model) is the synthesis selector on this surface; the value
        // here only salts the narration cache fingerprint.
        modelId: 'azure-cognitive-speech-v1',
        defaultVoice: 'en-US-AvaNeural',
        voices: [
            // The real catalog comes from voices/list (settings picker); these
            // are display fallbacks only.
            { id: 'en-US-AvaNeural', labelKey: 'settings.azureSpeech.voice' },
        ],
        costPerMillionCharsUsd: 16.00,
        // The user's own Azure resource — not in the external-data consent list.
        privacyConsentKey: 'azure-openai',
        factory: (plugin) => createCognitiveSpeechTtsEngine(plugin),
        internalOnly: true,
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

/**
 * Enumerate providers for user-facing surfaces. internalOnly entries
 * (capability-resolved Azure engines) are EXCLUDED by default — they must
 * never appear in a narration provider dropdown (azure-audio D5/D8).
 */
export function listProviders(includeInternal = false): ReadonlyArray<NarrationProviderConfig> {
    const all = Object.values(NARRATION_PROVIDERS);
    return includeInternal ? all : all.filter((p) => !p.internalOnly);
}
