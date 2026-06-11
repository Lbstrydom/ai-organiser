/**
 * gpt-audio TTS engine tests (azure-audio plan Phase 4).
 * Matrix (plan §9): success · provider-error · empty payload · abort ·
 * policy-denied factory gating · latest-model resolution.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRequestUrl = vi.fn();
const mockGetCachedModels = vi.fn();
vi.mock('obsidian', async () => {
    const actual = await vi.importActual('./mocks/obsidian');
    return {
        ...actual,
        requestUrl: (...args: unknown[]) => mockRequestUrl(...args),
    };
});
vi.mock('../src/services/adapters/dynamicModelService', () => ({
    getCachedModels: (...args: unknown[]) => mockGetCachedModels(...args),
}));

import {
    GptAudioTtsEngine,
    createGptAudioTtsEngine,
    resolveGptAudioModel,
} from '../src/services/tts/gptAudioTtsEngine';
import {
    isGptAudioSttEligible,
    GPT_AUDIO_STT_MAX_BYTES,
    PROVIDER_PRODUCES_TIMESTAMPS,
} from '../src/services/audioTranscriptionService';
import { STANDARD_SECRET_IDS } from '../src/core/secretIds';

function pcmBase64(samples = 4): string {
    const buf = new ArrayBuffer(samples * 2);
    new Int16Array(buf).set(Array.from({ length: samples }, (_, i) => i * 50));
    return Buffer.from(new Uint8Array(buf)).toString('base64');
}

function okResponse(audioData: string | undefined): any {
    return {
        status: 200,
        text: '',
        json: { choices: [{ message: { audio: audioData !== undefined ? { data: audioData } : undefined } }] },
        headers: {},
        arrayBuffer: new ArrayBuffer(0),
    };
}

function makePlugin(overrides: Record<string, unknown> = {}): any {
    return {
        settings: {
            cloudServiceType: 'claude',
            azureSpeechRequired: false,
            providerSettings: { openai: { apiKey: '' } },
            cloudApiKey: '',
            ...overrides,
        },
        secretStorageService: {
            isAvailable: () => true,
            getSecret: async () => null,
            resolveApiKey: async (opts: { primaryId: string }) =>
                opts.primaryId === STANDARD_SECRET_IDS.OPENAI ? 'sk-openai' : null,
        },
    };
}

describe('resolveGptAudioModel — latest-sentinel rule', () => {
    beforeEach(() => mockGetCachedModels.mockReset());

    it('picks the newest gpt-audio-<version> from the live catalog', () => {
        mockGetCachedModels.mockReturnValue([
            { id: 'gpt-5.5' }, { id: 'gpt-audio-1.5' }, { id: 'gpt-audio-2' }, { id: 'gpt-audio-mini-2' },
        ]);
        expect(resolveGptAudioModel()).toBe('gpt-audio-2');
    });

    it('orders versions segment-wise — 1.10 ranks above 1.9 (rC L5)', () => {
        mockGetCachedModels.mockReturnValue([
            { id: 'gpt-audio-1.9' }, { id: 'gpt-audio-1.10' },
        ]);
        expect(resolveGptAudioModel()).toBe('gpt-audio-1.10');
    });

    it('falls back to the pin when the catalog is absent', () => {
        mockGetCachedModels.mockReturnValue(null);
        expect(resolveGptAudioModel()).toBe('gpt-audio-1.5');
    });

    it('ignores non-matching ids (mini variants, unrelated models)', () => {
        mockGetCachedModels.mockReturnValue([{ id: 'gpt-audio-mini-3' }, { id: 'whisper-1' }]);
        expect(resolveGptAudioModel()).toBe('gpt-audio-1.5');
    });
});

describe('GptAudioTtsEngine.synthesizeChunk', () => {
    let engine: GptAudioTtsEngine;

    beforeEach(() => {
        mockRequestUrl.mockReset();
        engine = new GptAudioTtsEngine('sk-key', 'gpt-audio-1.5');
    });

    it('POSTs chat completions with audio modality + pcm16 and decodes the payload', async () => {
        mockRequestUrl.mockResolvedValueOnce(okResponse(pcmBase64(4)));
        const out = await engine.synthesizeChunk('Hello', 'nova');
        expect(out).toBeInstanceOf(Int16Array);
        expect(out.length).toBe(4);
        const call = mockRequestUrl.mock.calls[0][0];
        expect(call.url).toBe('https://api.openai.com/v1/chat/completions');
        expect(call.headers.Authorization).toBe('Bearer sk-key');
        const body = JSON.parse(call.body);
        expect(body.model).toBe('gpt-audio-1.5');
        expect(body.modalities).toEqual(['text', 'audio']);
        expect(body.audio).toEqual({ voice: 'nova', format: 'pcm16' });
        expect(body.messages[1].content).toBe('Hello');
    });

    it('maps non-OpenAI voice ids (e.g. Gemini Charon) to the default', async () => {
        mockRequestUrl.mockResolvedValueOnce(okResponse(pcmBase64()));
        await engine.synthesizeChunk('Hi', 'Charon');
        const body = JSON.parse(mockRequestUrl.mock.calls[0][0].body);
        expect(body.audio.voice).toBe('alloy');
    });

    it('throws retryable on 429, non-retryable on 401', async () => {
        mockRequestUrl.mockResolvedValueOnce({ status: 429, text: 'slow', json: null, headers: {} });
        await expect(engine.synthesizeChunk('Hi', 'alloy')).rejects.toMatchObject({ httpStatus: 429, retryable: true });
        mockRequestUrl.mockResolvedValueOnce({ status: 401, text: 'denied', json: null, headers: {} });
        await expect(engine.synthesizeChunk('Hi', 'alloy')).rejects.toMatchObject({ httpStatus: 401, retryable: false });
    });

    it('throws non-retryable on missing audio payload', async () => {
        mockRequestUrl.mockResolvedValueOnce(okResponse(undefined));
        await expect(engine.synthesizeChunk('Hi', 'alloy')).rejects.toMatchObject({
            name: 'GptAudioEmptyPayloadError', retryable: false,
        });
    });

    it('aborts before egress on a pre-aborted signal', async () => {
        const ctrl = new AbortController();
        ctrl.abort();
        await expect(engine.synthesizeChunk('Hi', 'alloy', ctrl.signal)).rejects.toThrow(/abort/i);
        expect(mockRequestUrl).not.toHaveBeenCalled();
    });
});

describe('createGptAudioTtsEngine — factory gating (D5/D8)', () => {
    beforeEach(() => {
        mockRequestUrl.mockReset();
        mockGetCachedModels.mockReturnValue(null);
    });

    it('builds the engine for a non-Azure user with an OpenAI key', async () => {
        const engine = await createGptAudioTtsEngine(makePlugin());
        expect(engine).toBeInstanceOf(GptAudioTtsEngine);
    });

    it('returns null in Azure mode (Global-Standard egress refused, D5)', async () => {
        expect(await createGptAudioTtsEngine(makePlugin({ cloudServiceType: 'azure-claude' }))).toBeNull();
        expect(await createGptAudioTtsEngine(makePlugin({ cloudServiceType: 'azure-openai' }))).toBeNull();
    });

    it('returns null in strict Azure mode (stale persisted provider, keystone)', async () => {
        expect(await createGptAudioTtsEngine(makePlugin({
            cloudServiceType: 'azure-claude', azureSpeechRequired: true,
        }))).toBeNull();
    });

    it('returns null without an OpenAI key', async () => {
        const plugin = makePlugin();
        plugin.secretStorageService.resolveApiKey = async () => null;
        expect(await createGptAudioTtsEngine(plugin)).toBeNull();
    });
});

describe('gpt-audio STT bounds (plan G1/G2)', () => {
    it('accepts short wav/mp3 clips', () => {
        expect(isGptAudioSttEligible('clip.mp3', 1024 * 1024).eligible).toBe(true);
        expect(isGptAudioSttEligible('clip.WAV', 4 * 1024 * 1024).eligible).toBe(true);
    });

    it('refuses other formats — recorder webm/m4a/ogg are NOT offered (G2)', () => {
        for (const f of ['rec.webm', 'rec.m4a', 'rec.mp4', 'rec.ogg', 'noext']) {
            expect(isGptAudioSttEligible(f, 1024)).toEqual({ eligible: false, reason: 'format' });
        }
    });

    it('refuses over-cap clips (G1 — context-window safety)', () => {
        expect(isGptAudioSttEligible('long.mp3', GPT_AUDIO_STT_MAX_BYTES.mp3 + 1))
            .toEqual({ eligible: false, reason: 'size' });
        expect(isGptAudioSttEligible('long.wav', GPT_AUDIO_STT_MAX_BYTES.wav + 1))
            .toEqual({ eligible: false, reason: 'size' });
    });

    it('gpt-audio declares NO timestamps; all Whisper/Speech providers declare them (R2-M4)', () => {
        expect(PROVIDER_PRODUCES_TIMESTAMPS['openai-gpt-audio']).toBe(false);
        expect(PROVIDER_PRODUCES_TIMESTAMPS.openai).toBe(true);
        expect(PROVIDER_PRODUCES_TIMESTAMPS.groq).toBe(true);
        expect(PROVIDER_PRODUCES_TIMESTAMPS.azure).toBe(true);
        expect(PROVIDER_PRODUCES_TIMESTAMPS['azure-speech']).toBe(true);
    });
});
