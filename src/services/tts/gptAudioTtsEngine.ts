/**
 * gpt-audio TTS engine — the private/BYO voice path (azure-audio plan Phase 4).
 *
 * OpenAI-DIRECT Chat Completions with audio output (`modalities:['text','audio']`,
 * `audio:{voice, format:'pcm16'}`). Global-Standard processing — selectable ONLY
 * when NOT in Azure mode (plan D5; `AudioProviderPolicy` enforces at the factory
 * AND every narration entry).
 *
 * PCM contract (M4): OpenAI's `pcm16` chat-audio output is 24 kHz mono 16-bit
 * little-endian — byte-compatible with the `TtsEngine` contract and the
 * `Mp3Writer` pipeline (no resample). If OpenAI ever changes the sample rate,
 * narration speed/pitch would audibly break — locked by the documented format
 * param (`pcm16`) which is specified at 24 kHz.
 *
 * Model id follows the latest-sentinel rule: the newest `gpt-audio-*` model in
 * the live OpenAI catalog wins; the pinned fallback is only used offline.
 */

import type AIOrganiserPlugin from '../../main';
import { abortableRequestUrl } from '../../utils/abortableRequestUrl';
import { logger } from '../../utils/logger';
import { assertAllowed } from '../azure/audioProviderPolicy';
import { getGptAudioApiKey } from '../apiKeyHelpers';
import { PROVIDER_ENDPOINT } from '../adapters/providerRegistry';
import { getCachedModels } from '../adapters/dynamicModelService';
import { base64ToUint8Array, pcmBytesToInt16 } from './pcmUtils';
import type { TtsEngine } from './ttsEngine';

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

/** Pinned offline fallback — the live catalog supersedes this (latest-sentinel rule). */
const GPT_AUDIO_FALLBACK = 'gpt-audio-1.5';

/** OpenAI chat-audio voices; unknown ids (e.g. Gemini 'Charon') map to the default. */
const OPENAI_AUDIO_VOICES = new Set(['alloy', 'ash', 'ballad', 'cedar', 'coral', 'echo', 'fable', 'marin', 'onyx', 'nova', 'sage', 'shimmer', 'verse']);
const DEFAULT_OPENAI_VOICE = 'alloy';

/**
 * Resolve the newest gpt-audio model from the live OpenAI catalog
 * (`gpt-audio-<version>` sorted numerically), falling back to the pin.
 * Excludes `-mini` variants (quality-first for narration).
 */
export function resolveGptAudioModel(): string {
    const live = getCachedModels('openai')?.map((m) => m.id) ?? [];
    const versioned = live
        .map((id) => /^gpt-audio-(\d+(?:\.\d+)?)$/.exec(id))
        .filter((m): m is RegExpExecArray => m !== null)
        .sort((a, b) => Number(b[1]) - Number(a[1]));
    return versioned[0]?.[0] ?? GPT_AUDIO_FALLBACK;
}

interface GptAudioHttpError extends Error {
    httpStatus: number;
    retryable: boolean;
}

function makeError(status: number, body: string, name = 'GptAudioTtsError'): GptAudioHttpError {
    const e = new Error(`GPT audio TTS error ${status}: ${body.slice(0, 300)}`) as GptAudioHttpError;
    e.httpStatus = status;
    e.retryable = RETRYABLE_STATUSES.has(status);
    e.name = name;
    return e;
}

interface GptAudioResponse {
    choices?: Array<{ message?: { audio?: { data?: string } } }>;
}

export class GptAudioTtsEngine implements TtsEngine {
    readonly providerId = 'openai-gpt-audio';

    constructor(
        private readonly apiKey: string,
        private readonly modelId: string,
    ) {}

    async synthesizeChunk(text: string, voice: string, signal?: AbortSignal): Promise<Int16Array> {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

        const effVoice = OPENAI_AUDIO_VOICES.has(voice) ? voice : DEFAULT_OPENAI_VOICE;
        const body = {
            model: this.modelId,
            modalities: ['text', 'audio'],
            audio: { voice: effVoice, format: 'pcm16' },
            messages: [
                {
                    role: 'system',
                    content: 'You are a text-to-speech engine. Read the user message aloud exactly as written, verbatim, with natural pacing. Do not add, omit, summarize, or comment.',
                },
                { role: 'user', content: text },
            ],
        };

        // Endpoint from the provider registry (R2-M5) — never a literal URL here.
        const response = await abortableRequestUrl({
            url: PROVIDER_ENDPOINT.openai,
            method: 'POST',
            headers: {
                Authorization: `Bearer ${this.apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
            throw: false,
        }, { signal });

        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        if (response.status !== 200) {
            throw makeError(response.status, response.text || '');
        }
        const json = response.json as GptAudioResponse | null;
        const data = json?.choices?.[0]?.message?.audio?.data;
        if (typeof data !== 'string' || data.length === 0) {
            throw makeError(200, 'no audio payload in response', 'GptAudioEmptyPayloadError');
        }
        return pcmBytesToInt16(base64ToUint8Array(data));
    }
}

/**
 * Factory — policy-gated (D5/D8): builds the engine ONLY outside Azure mode,
 * with an OpenAI-direct key. Returns null otherwise.
 */
export async function createGptAudioTtsEngine(plugin: AIOrganiserPlugin): Promise<GptAudioTtsEngine | null> {
    const policy = assertAllowed(plugin, { op: 'tts', providerId: 'openai-gpt-audio' });
    if (!policy.ok) {
        logger.warn('AudioNarration', `GPT audio TTS denied: ${policy.error}`);
        return null;
    }
    const key = await getGptAudioApiKey(plugin);
    if (!key) {
        logger.warn('AudioNarration', 'No OpenAI key resolvable for GPT audio TTS');
        return null;
    }
    return new GptAudioTtsEngine(key, resolveGptAudioModel());
}
