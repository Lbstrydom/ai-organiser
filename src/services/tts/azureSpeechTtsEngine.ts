/**
 * Azure OpenAI Speech (text-to-speech) engine — flexible-Azure TTS path.
 *
 * Implements the same TtsEngine contract as the Gemini engine: per-chunk
 * synthesis returning mono 24 kHz little-endian Int16Array PCM. Azure OpenAI's
 * `/audio/speech` with `response_format: 'pcm'` returns raw 24 kHz 16-bit signed
 * LE mono PCM — byte-compatible with the Mp3Writer pipeline, no resample.
 *
 * URL comes from the endpoint SSOT (getSpeechEndpoint) — NO manual concat (G2).
 * Only used when the `tts` capability resolves to `kind:'azure'`.
 *
 * Plan: docs/plans/azure-capability-flexibility.md (Phase 4 / Cluster C).
 */

import type AIOrganiserPlugin from '../../main';
import { abortableRequestUrl } from '../../utils/abortableRequestUrl';
import { logger } from '../../utils/logger';
import { resolveAzureCapability } from '../azure/resolveAzureCapability';
import { pcmBytesToInt16 } from './pcmUtils';
import type { TtsEngine } from './ttsEngine';

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

/** Azure OpenAI Speech voices. The narration voice setting uses Gemini voice
 *  names, so map unknowns to a sensible default rather than send an invalid voice. */
const AZURE_VOICES = new Set(['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer']);
const DEFAULT_AZURE_VOICE = 'alloy';

interface AzureSpeechHttpError extends Error {
    httpStatus: number;
    retryable: boolean;
}

function makeAzureSpeechError(status: number, body: string): AzureSpeechHttpError {
    const e = new Error(`Azure Speech error ${status}: ${body.slice(0, 300)}`) as AzureSpeechHttpError;
    e.httpStatus = status;
    e.retryable = RETRYABLE_STATUSES.has(status);
    e.name = 'AzureSpeechTtsError';
    return e;
}

export class AzureSpeechTtsEngine implements TtsEngine {
    readonly providerId = 'azure-openai';

    constructor(
        private readonly apiKey: string,
        private readonly endpoint: string,   // resolved by getSpeechEndpoint (SSOT)
        private readonly model: string,      // tts deployment/model name
    ) {}

    async synthesizeChunk(text: string, voice: string, signal?: AbortSignal): Promise<Int16Array> {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

        const azureVoice = AZURE_VOICES.has(voice) ? voice : DEFAULT_AZURE_VOICE;
        const body = {
            model: this.model || 'tts-1',
            input: text,
            voice: azureVoice,
            response_format: 'pcm',  // 24 kHz 16-bit signed LE mono → matches the contract
        };

        const response = await abortableRequestUrl({
            url: this.endpoint,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'api-key': this.apiKey },
            body: JSON.stringify(body),
            throw: false,
        }, { signal });

        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        if (response.status !== 200) {
            throw makeAzureSpeechError(response.status, response.text || '');
        }

        const buf = response.arrayBuffer;
        if (!buf || buf.byteLength === 0) {
            const err = new Error('Azure Speech returned no audio payload') as AzureSpeechHttpError;
            err.httpStatus = 200;
            err.retryable = false;
            err.name = 'AzureSpeechEmptyPayloadError';
            throw err;
        }
        return pcmBytesToInt16(new Uint8Array(buf));
    }
}

/**
 * Factory — builds the engine ONLY when the tts capability resolves to azure.
 * Returns null otherwise (caller falls back to the BYO provider or surfaces a
 * clear "not available" notice). No silent cross-provider fallback.
 */
export async function createAzureSpeechTtsEngine(plugin: AIOrganiserPlugin): Promise<AzureSpeechTtsEngine | null> {
    const res = await resolveAzureCapability(plugin, 'tts');
    if (res.kind !== 'azure') {
        logger.warn('AudioNarration', `Azure Speech TTS not resolvable (${res.kind === 'unavailable' ? res.reason : res.kind})`);
        return null;
    }
    return new AzureSpeechTtsEngine(res.key, res.endpoint, res.deployment);
}
