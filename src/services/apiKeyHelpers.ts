import type AIOrganiserPlugin from '../main';
import { PLUGIN_SECRET_IDS } from '../core/secretIds';

/**
 * Get the Gemini API key for YouTube processing
 * Priority: 1) dedicated YouTube key, 2) main Gemini key if provider is Gemini, 3) provider settings
 */
export async function getYouTubeGeminiApiKey(plugin: AIOrganiserPlugin): Promise<string | null> {
    const secretStorage = plugin.secretStorageService;
    const useMainGeminiKey = plugin.settings.cloudServiceType === 'gemini';

    if (secretStorage.isAvailable()) {
        return await secretStorage.resolveApiKey({
            primaryId: PLUGIN_SECRET_IDS.YOUTUBE,
            providerFallback: 'gemini',
            useMainKeyFallback: useMainGeminiKey,
            plainTextFallback: {
                primaryKey: plugin.settings.youtubeGeminiApiKey,
                providerKey: plugin.settings.providerSettings?.gemini?.apiKey,
                mainCloudKey: plugin.settings.cloudApiKey
            }
        });
    }

    if (plugin.settings.youtubeGeminiApiKey) {
        return plugin.settings.youtubeGeminiApiKey;
    }

    if (useMainGeminiKey && plugin.settings.cloudApiKey) {
        return plugin.settings.cloudApiKey;
    }

    if (plugin.settings.providerSettings?.gemini?.apiKey) {
        return plugin.settings.providerSettings.gemini.apiKey;
    }

    return null;
}

/**
 * Get the API key for audio transcription (Whisper)
 * Priority: 1) dedicated transcription key, 2) main key if provider matches, 3) provider settings
 */
export async function getAudioTranscriptionApiKey(plugin: AIOrganiserPlugin): Promise<{ key: string; provider: 'openai' | 'groq' } | null> {
    const selectedProvider = plugin.settings.audioTranscriptionProvider || 'openai';
    const secretStorage = plugin.secretStorageService;

    const resolveKey = async (provider: 'openai' | 'groq'): Promise<string | null> => {
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

        if (plugin.settings.audioTranscriptionApiKey) {
            return plugin.settings.audioTranscriptionApiKey;
        }

        if (plugin.settings.cloudServiceType === provider && plugin.settings.cloudApiKey) {
            return plugin.settings.cloudApiKey;
        }

        const providerKey = plugin.settings.providerSettings?.[provider]?.apiKey;
        return providerKey || null;
    };

    const selectedKey = await resolveKey(selectedProvider);
    if (selectedKey) {
        return { key: selectedKey, provider: selectedProvider };
    }

    const otherProvider = selectedProvider === 'openai' ? 'groq' : 'openai';
    const otherKey = await resolveKey(otherProvider);
    if (otherKey) {
        return { key: otherKey, provider: otherProvider as 'openai' | 'groq' };
    }

    return null;
}
