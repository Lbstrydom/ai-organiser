/**
 * TTS Engine abstraction — single Gemini TTS transport contract.
 *
 * Shared by newsletter audio podcast and any future narration feature.
 * Moves the Gemini API call out of feature-specific services so retry
 * logic, abort support, and request format live in one place.
 *
 * The `modelId` doubles as the fingerprint salt so files generated before
 * this refactor are recognised as already-current (idempotent).
 */

import { requestUrl } from 'obsidian';

// Google's naming inverted between 2.x and 3.x — 2.5 used `-preview-tts`
// suffix, 3.1 uses `-tts-preview`. Confirmed against official Gemini API
// speech-generation docs (2026-04-20). All TTS models are in Preview status.
// Response schema is unchanged between versions.
export const GEMINI_TTS_MODEL_ID =
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-tts-preview:generateContent';

export interface TtsEngine {
    /** Stable model identifier — used as fingerprint salt. */
    readonly modelId: string;
    /**
     * Synthesise one chunk of text and return base64-encoded PCM audio, or
     * null when the provider returns an empty/invalid payload (caller handles
     * gracefully). Throws on HTTP errors or when `signal` is already aborted.
     */
    synthesizeChunk(text: string, signal?: AbortSignal): Promise<string | null>;
}

export class GeminiTtsEngine implements TtsEngine {
    readonly modelId: string = GEMINI_TTS_MODEL_ID;

    constructor(private readonly apiKey: string, private readonly voice: string) {}

    async synthesizeChunk(text: string, signal?: AbortSignal): Promise<string | null> {
        if (signal?.aborted) throw new Error('Aborted');

        const url = `${this.modelId}?key=${this.apiKey}`;
        const body = {
            contents: [{ parts: [{ text }] }],
            generationConfig: {
                responseModalities: ['AUDIO'],
                speechConfig: {
                    voiceConfig: {
                        prebuiltVoiceConfig: { voiceName: this.voice },
                    },
                },
                // NOTE: no `audioConfig` field — that's Google Cloud TTS's schema.
                // Gemini's generateContent endpoint returns LINEAR16 PCM @ 24kHz
                // by default for TTS; adding audioConfig trips a 400 "unknown
                // field". Persona round 11 console audit (2026-04-20) caught
                // this: three "Request failed, status 400" warnings per run.
            },
        };

        const response = await requestUrl({
            url,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            // Without throw:false, requestUrl auto-throws on 4xx/5xx with the
            // cryptic "Request failed, status 400" and discards the body. Let
            // us read the body so users see WHY Gemini rejected the payload.
            throw: false,
        });

        if (response.status !== 200) {
            throw new Error(`Gemini TTS error ${response.status}: ${response.text.slice(0, 300)}`);
        }

        // Validate response structure before accessing nested fields
        interface GeminiTtsResponse {
            candidates?: Array<{
                content?: {
                    parts?: Array<{
                        inlineData?: { mimeType?: string; data?: string };
                    }>;
                };
            }>;
        }
        const json = response.json as GeminiTtsResponse | null;
        if (!json || !Array.isArray(json.candidates) || json.candidates.length === 0) {
            return null; // unexpected structure — caller handles gracefully
        }
        const inlineData = json.candidates[0]?.content?.parts?.[0]?.inlineData;
        const data = inlineData?.data;
        // Accept any audio MIME type (Gemini returns audio/pcm, audio/wav, etc.)
        const mimeType = inlineData?.mimeType ?? '';
        if (typeof data !== 'string' || data.length === 0 || !mimeType.startsWith('audio')) {
            return null; // no valid audio payload — skip silently
        }
        return data;
    }
}
