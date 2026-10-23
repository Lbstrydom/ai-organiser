/**
 * Newsletter TTS resolution — which voice service speaks a newsletter audio.
 *
 * The ONE authority for the daily audio and the catch-up episodes. The logic is the pipeline's
 * original key/engine resolution, moved here unchanged so the two paths cannot drift:
 *
 *  - Azure mode: the `tts` capability decides — an Azure Speech engine, or the user's own
 *    Gemini key ("byo"), or nothing. There is NO silent fallback to a personal key.
 *  - otherwise: SecretStorage -> providerSettings.gemini -> the main key when the main
 *    provider IS Gemini.
 *
 * It never shows a notice itself: it returns the exact text (and ms) so each caller decides
 * (the daily audio shows it as before; catch-up maps it to guidance).
 */

import type AIOrganiserPlugin from '../../main';
import { isAzureMode } from '../azure/endpointResolver';
import type { TtsEngine } from '../tts/ttsEngine';

export type NewsletterTtsResolution =
    | {
        ok: true;
        /** Pre-built engine (Azure). Absent => the caller builds Gemini from `apiKey`. */
        engine?: TtsEngine;
        modelId?: string;
        apiKey: string;
    }
    | {
        ok: false;
        notice: string;
        noticeMs: number;
        /** Logged as a warning by the caller (only the missing-Gemini-key case has one). */
        logWarn?: string;
    };

export async function resolveNewsletterTts(plugin: AIOrganiserPlugin): Promise<NewsletterTtsResolution> {
    const settings = plugin.settings;
    let azureTtsEngine: TtsEngine | undefined;
    let azureTtsModelId: string | undefined;
    if (isAzureMode(settings)) {
        const { resolveAzureCapability } = await import('../azure/resolveAzureCapability');
        const ttsRes = await resolveAzureCapability(plugin, 'tts');
        if (ttsRes.kind === 'azure' && ttsRes.surface === 'azure-speech') {
            // In-region Cognitive Speech engine (azure-audio plan Phase 3).
            const { createCognitiveSpeechTtsEngine } = await import('../tts/cognitiveSpeechTtsEngine');
            azureTtsEngine = (await createCognitiveSpeechTtsEngine(plugin)) ?? undefined;
            azureTtsModelId = 'azure-cognitive-speech-v1';
            if (!azureTtsEngine) {
                return { ok: false, notice: 'Audio podcast skipped — azure AI speech needs a region, key, and voice (set them under azure capabilities)', noticeMs: 6000 };
            }
        } else if (ttsRes.kind === 'azure') {
            const { createAzureSpeechTtsEngine } = await import('../tts/azureSpeechTtsEngine');
            azureTtsEngine = (await createAzureSpeechTtsEngine(plugin)) ?? undefined;
            azureTtsModelId = ttsRes.deployment || 'azure-speech';
            if (!azureTtsEngine) {
                return { ok: false, notice: 'Audio podcast skipped — azure speech needs a tts deployment (set it under azure capabilities)', noticeMs: 6000 };
            }
        } else if (ttsRes.kind === 'unavailable') {
            return { ok: false, notice: "Audio podcast isn't configured for azure — set audio narration to a tts deployment, or add a Gemini key, in settings", noticeMs: 6000 };
        }
        // ttsRes.kind === 'byo' → fall through to the Gemini key resolution below.
    }

    let geminiApiKey = '';
    if (!azureTtsEngine) {
        const secretKey = plugin.secretStorageService.isAvailable()
            ? await plugin.secretStorageService.getProviderKey('gemini')
            : null;
        geminiApiKey =
            secretKey ||
            settings.providerSettings?.['gemini']?.apiKey ||
            (settings.cloudServiceType === 'gemini' ? settings.cloudApiKey : '') ||
            '';
        if (!geminiApiKey) {
            return {
                ok: false,
                logWarn: 'Audio podcast skipped — no Gemini API key configured (checked SecretStorage + providerSettings + cloudApiKey)',
                notice: isAzureMode(settings)
                    ? "Audio podcast isn't configured for Azure — set Audio narration to a TTS deployment, or add a gemini key, in settings."
                    : 'Audio podcast skipped — add a gemini key in settings to enable',
                noticeMs: 6000,
            };
        }
    }

    return { ok: true, engine: azureTtsEngine, modelId: azureTtsModelId, apiKey: geminiApiKey };
}
