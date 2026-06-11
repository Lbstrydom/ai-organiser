/**
 * Azure AI Speech (Cognitive Services) real-time TTS engine — the in-region
 * `azure-speech` surface (azure-audio plan Phase 3).
 *
 * SIBLING of `azureSpeechTtsEngine` (which, despite its name, targets Azure
 * OPENAI `/audio/speech` — JSON body + `api-key` header). This engine speaks
 * the Cognitive host: SSML body + `Ocp-Apim-Subscription-Key` +
 * `X-Microsoft-OutputFormat: raw-24khz-16bit-mono-pcm` → Int16Array matching
 * the `TtsEngine` 24 kHz mono LE contract (no resample needed, M4).
 *
 * The SSML document comes ONLY from `ssmlBuilder` (escapes untrusted note
 * text, validates the voice, budgets size — D11/H6). Pacing through the
 * resource-level azure-speech lease (R2-H2).
 */

import type AIOrganiserPlugin from '../../main';
import { abortableRequestUrl } from '../../utils/abortableRequestUrl';
import { logger } from '../../utils/logger';
import { resolveAzureCapability } from '../azure/resolveAzureCapability';
import { resolveAzureSpeechCredential } from '../azure/azureSpeechCredential';
import { withAzureLease, buildAzureSpeechKey } from '../azure/azureRequestPacer';
import { assertAllowed } from '../azure/audioProviderPolicy';
import { pcmBytesToInt16 } from './pcmUtils';
import { buildSsml, isValidAzureVoiceName } from './ssmlBuilder';
import type { TtsEngine } from './ttsEngine';

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const OUTPUT_FORMAT = 'raw-24khz-16bit-mono-pcm';

interface CognitiveSpeechHttpError extends Error {
    httpStatus: number;
    retryable: boolean;
}

function makeError(status: number, body: string, name = 'CognitiveSpeechTtsError'): CognitiveSpeechHttpError {
    const e = new Error(`Azure AI Speech TTS error ${status}: ${body.slice(0, 300)}`) as CognitiveSpeechHttpError;
    e.httpStatus = status;
    e.retryable = RETRYABLE_STATUSES.has(status);
    e.name = name;
    return e;
}

export class CognitiveSpeechTtsEngine implements TtsEngine {
    readonly providerId = 'azure-speech';

    constructor(
        private readonly apiKey: string,
        private readonly endpoint: string,   // resolved by getSpeechRealtimeTtsEndpoint (SSOT)
        private readonly boundVoice: string, // settings.azureSpeechVoice — the validated selection
    ) {}

    async synthesizeChunk(text: string, voice: string, signal?: AbortSignal): Promise<Int16Array> {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

        // The narration voice setting carries OTHER providers' voice ids
        // (Gemini names like 'Charon') — use the bound Azure voice unless the
        // caller passed a valid Azure voice name explicitly.
        const effectiveVoice = isValidAzureVoiceName(voice) ? voice : this.boundVoice;
        const ssml = buildSsml(text, effectiveVoice);
        if (!ssml.ok) {
            // Not transient — a malformed chunk/voice will not improve on retry.
            const e = new Error(`SSML build failed: ${ssml.error}`) as CognitiveSpeechHttpError;
            e.httpStatus = 0;
            e.retryable = false;
            e.name = 'CognitiveSpeechSsmlError';
            throw e;
        }

        const paceKey = buildAzureSpeechKey(this.endpoint, 'tts');
        const response = await withAzureLease(paceKey, signal, () => abortableRequestUrl({
            url: this.endpoint,
            method: 'POST',
            headers: {
                'Ocp-Apim-Subscription-Key': this.apiKey,
                'Content-Type': 'application/ssml+xml',
                'X-Microsoft-OutputFormat': OUTPUT_FORMAT,
            },
            body: ssml.value,
            throw: false,
        }, { signal }));

        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        if (response.status !== 200) {
            throw makeError(response.status, response.text || '');
        }
        const buf = response.arrayBuffer;
        if (!buf || buf.byteLength === 0) {
            throw makeError(200, 'empty audio payload', 'CognitiveSpeechEmptyPayloadError');
        }
        return pcmBytesToInt16(new Uint8Array(buf));
    }
}

/**
 * Factory — builds the engine ONLY when the tts capability resolves to the
 * azure-speech surface AND the policy allows it. Returns null otherwise
 * (caller surfaces a clear notice). No silent cross-surface fallback.
 */
export async function createCognitiveSpeechTtsEngine(plugin: AIOrganiserPlugin): Promise<CognitiveSpeechTtsEngine | null> {
    const policy = assertAllowed(plugin, { op: 'tts', providerId: 'azure-speech' });
    if (!policy.ok) {
        logger.warn('AudioNarration', `Cognitive Speech TTS denied: ${policy.error}`);
        return null;
    }
    const res = await resolveAzureCapability(plugin, 'tts');
    if (res.kind !== 'azure' || res.surface !== 'azure-speech') {
        logger.warn('AudioNarration', `Cognitive Speech TTS not resolvable (${res.kind === 'unavailable' ? res.reason : res.kind})`);
        return null;
    }
    // res.endpoint = the realtime TTS endpoint; key from the credential chain.
    const cred = await resolveAzureSpeechCredential(plugin);
    if (!cred.ok) return null;
    const voice = typeof plugin.settings.azureSpeechVoice === 'string' ? plugin.settings.azureSpeechVoice.trim() : '';
    if (!isValidAzureVoiceName(voice)) {
        logger.warn('AudioNarration', 'Cognitive Speech TTS: no valid voice configured');
        return null;
    }
    return new CognitiveSpeechTtsEngine(cred.value.key, res.endpoint, voice);
}
