/**
 * Audio Narration Service
 *
 * General-purpose text-to-speech narration using the shared TtsEngine
 * abstraction. Serves as the reference pattern for:
 *   TtsEngine + retryWithBackoff + AbortSignal
 *
 * Callers split their script into chunks, call executeNarration, then encode
 * the returned PCM base64 segments into an audio file.
 */

import type AIOrganiserPlugin from '../../main';
import { NARRATION_PROVIDERS } from '../tts/ttsProviderRegistry';
import { retryWithBackoff } from '../tts/ttsRetry';
import { getAudioNarrationProviderConfig } from '../apiKeyHelpers';

const MAX_RETRY_ATTEMPTS = 3;

export interface NarrationResult {
    success: boolean;
    /** Raw PCM audio segments, base64-encoded (LINEAR16 @ provider sample rate). */
    pcmBase64?: string[];
    error?: string;
}

/**
 * Synthesise each chunk and return the raw base64 PCM segments.
 *
 * Each chunk is attempted up to MAX_RETRY_ATTEMPTS times with exponential
 * backoff before the whole operation fails. The caller is responsible for
 * concatenating the PCM segments and encoding the final audio file.
 *
 * @param plugin Plugin instance — used to resolve the TTS provider config.
 * @param chunks Script chunks to synthesise (see splitScriptForTts).
 * @param signal  Optional AbortSignal for cancellation.
 */
export async function executeNarration(
    plugin: AIOrganiserPlugin,
    chunks: string[],
    signal?: AbortSignal,
): Promise<NarrationResult> {
    const config = await getAudioNarrationProviderConfig(plugin);
    if (!config) {
        return { success: false, error: 'No audio narration provider configured — add a Gemini API key in Settings' };
    }

    const providerEntry = NARRATION_PROVIDERS[config.provider];
    if (!providerEntry) {
        return { success: false, error: `Unknown TTS provider: ${config.provider}` };
    }
    const engine = providerEntry.factory(config.apiKey, config.voice);

    const pcmBase64: string[] = [];
    for (let i = 0; i < chunks.length; i++) {
        if (signal?.aborted) {
            return { success: false, error: 'Aborted' };
        }
        let result: string | null;
        try {
            result = await retryWithBackoff(
                () => engine.synthesizeChunk(chunks[i], signal),
                MAX_RETRY_ATTEMPTS,
                signal,
            );
        } catch (err) {
            return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
        if (result === null) {
            return { success: false, error: `TTS returned no audio for chunk ${i + 1}/${chunks.length}` };
        }
        pcmBase64.push(result);
    }
    return { success: true, pcmBase64 };
}
