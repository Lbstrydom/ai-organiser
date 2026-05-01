/**
 * TTS engine — per-chunk synthesis contract + Gemini implementation.
 *
 * PCM contract (R3-H2): Engine returns mono Int16Array at 24 kHz, native byte
 * order. The Gemini API returns LINEAR16 little-endian; on all Obsidian targets
 * host order is little-endian, so a typed-array view over the response bytes is
 * correct without byteswap.
 *
 * Caller orchestrates the loop: split text → call engine per chunk → push PCM
 * into Mp3Writer. Engine never holds multiple chunks' PCM in memory.
 */

import { requestUrl } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import { logger } from '../../utils/logger';
import { getAudioNarrationProviderConfig } from '../apiKeyHelpers';
import { base64ToUint8Array, pcmBytesToInt16 } from './pcmUtils';

export interface TtsEngine {
    readonly providerId: string;
    /**
     * Synthesise one text chunk. Returns mono LE 24 kHz Int16Array PCM samples.
     * @throws on transport/API failure. Errors with `retryable=true` (HTTP 429/5xx)
     *         are caught by `retryWithBackoff`.
     */
    synthesizeChunk(text: string, voice: string, signal?: AbortSignal): Promise<Int16Array>;
}

const GEMINI_TTS_ENDPOINT_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

interface GeminiTtsResponse {
    candidates?: Array<{
        content?: {
            parts?: Array<{
                inlineData?: { mimeType?: string; data?: string };
            }>;
        };
    }>;
}

interface GeminiHttpError extends Error {
    httpStatus: number;
    retryable: boolean;
}

function makeGeminiError(status: number, body: string): GeminiHttpError {
    const e = new Error(`Gemini TTS error ${status}: ${body.slice(0, 300)}`) as GeminiHttpError;
    e.httpStatus = status;
    e.retryable = RETRYABLE_STATUSES.has(status);
    e.name = 'GeminiTtsError';
    return e;
}

export class GeminiTtsEngine implements TtsEngine {
    readonly providerId = 'gemini';

    constructor(
        private readonly apiKey: string,
        private readonly modelId: string,
    ) {}

    async synthesizeChunk(text: string, voice: string, signal?: AbortSignal): Promise<Int16Array> {
        if (signal?.aborted) {
            throw new DOMException('Aborted', 'AbortError');
        }
        const url = `${GEMINI_TTS_ENDPOINT_BASE}/${encodeURIComponent(this.modelId)}:generateContent?key=${encodeURIComponent(this.apiKey)}`;
        const body = {
            contents: [{ parts: [{ text }] }],
            generationConfig: {
                responseModalities: ['AUDIO'],
                speechConfig: {
                    voiceConfig: {
                        prebuiltVoiceConfig: { voiceName: voice },
                    },
                },
            },
        };

        const response = await requestUrl({
            url,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            throw: false,
        });

        if (signal?.aborted) {
            throw new DOMException('Aborted', 'AbortError');
        }

        if (response.status !== 200) {
            throw makeGeminiError(response.status, response.text || '');
        }

        const json = response.json as GeminiTtsResponse | null;
        const inlineData = json?.candidates?.[0]?.content?.parts?.[0]?.inlineData;
        const data = inlineData?.data;
        const mimeType = inlineData?.mimeType ?? '';
        // Strict mime check (audit H9): Gemini's TTS returns LINEAR16 PCM. We
        // decode bytes via pcmBytesToInt16 which assumes raw 16-bit signed LE.
        // Accept only the PCM-shaped mime types the decoder is actually valid for.
        // If Gemini ever returns audio/wav, audio/opus, etc., fail loudly rather
        // than silently misinterpreting bytes.
        const PCM_MIMES = /^audio\/(L16|pcm)(;|$)/i;
        if (typeof data !== 'string' || data.length === 0) {
            // Structural contract violation — Gemini returned 200 OK but no
            // audio data in the response shape. Not transient; retrying won't
            // help. Surface immediately so the caller sees a clean error.
            const err = new Error('Gemini TTS returned no audio payload') as GeminiHttpError;
            err.httpStatus = 200;
            err.retryable = false;
            err.name = 'GeminiTtsEmptyPayloadError';
            throw err;
        }
        if (!PCM_MIMES.test(mimeType)) {
            const err = new Error(`Gemini TTS returned unsupported mime type: ${mimeType || '(empty)'}`) as GeminiHttpError;
            err.httpStatus = 200;
            err.retryable = false;  // not transient — contract violation
            err.name = 'GeminiTtsMimeError';
            throw err;
        }

        const bytes = base64ToUint8Array(data);
        return pcmBytesToInt16(bytes);
    }
}

/**
 * Factory — used by NARRATION_PROVIDERS.gemini.factory. Delegates key
 * resolution to the canonical apiKeyHelpers chain (R2-H4).
 */
export async function createGeminiTtsEngine(
    plugin: AIOrganiserPlugin,
    modelId: string,
): Promise<GeminiTtsEngine | null> {
    const cfg = await getAudioNarrationProviderConfig(plugin);
    if (!cfg) {
        logger.warn('AudioNarration', 'No API key resolvable for audio narration provider');
        return null;
    }
    if (cfg.provider !== 'gemini') {
        logger.warn('AudioNarration', `createGeminiTtsEngine called with non-gemini provider: ${cfg.provider}`);
        return null;
    }
    return new GeminiTtsEngine(cfg.apiKey, modelId);
}
