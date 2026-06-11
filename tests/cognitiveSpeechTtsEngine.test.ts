/**
 * Cognitive Speech TTS engine tests (azure-audio plan Phase 3).
 * Matrix (plan §9): success · provider-error · empty payload · abort ·
 * invalid config (factory null paths) · policy-denied.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRequestUrl = vi.fn();
vi.mock('obsidian', async () => {
    const actual = await vi.importActual('./mocks/obsidian');
    return {
        ...actual,
        requestUrl: (...args: unknown[]) => mockRequestUrl(...args),
    };
});

import { CognitiveSpeechTtsEngine, createCognitiveSpeechTtsEngine } from '../src/services/tts/cognitiveSpeechTtsEngine';
import { PLUGIN_SECRET_IDS } from '../src/core/secretIds';

const TTS_EP = 'https://swedencentral.tts.speech.microsoft.com/cognitiveservices/v1';

function pcmResponse(samples = 4): any {
    const buf = new ArrayBuffer(samples * 2);
    new Int16Array(buf).set(Array.from({ length: samples }, (_, i) => i * 100));
    return { status: 200, text: '', json: null, headers: {}, arrayBuffer: buf };
}

function makePlugin(overrides: Record<string, unknown> = {}): any {
    return {
        settings: {
            cloudServiceType: 'azure-claude',
            azureSpeechRegion: 'swedencentral',
            azureSpeechEndpoint: 'https://res.cognitiveservices.azure.com',
            azureSpeechVoice: 'en-US-AvaNeural',
            azureSpeechRequired: false,
            azureCapabilities: { tts: { mode: 'azure' } },
            azureApiKey: '',
            ...overrides,
        },
        secretStorageService: {
            isAvailable: () => true,
            getSecret: async (id: string) => (id === PLUGIN_SECRET_IDS.AZURE_SPEECH ? 'SPEECH-KEY' : null),
            resolveApiKey: async () => null,
        },
    };
}

describe('CognitiveSpeechTtsEngine.synthesizeChunk', () => {
    let engine: CognitiveSpeechTtsEngine;

    beforeEach(() => {
        mockRequestUrl.mockReset();
        engine = new CognitiveSpeechTtsEngine('KEY', TTS_EP, 'en-US-AvaNeural');
    });

    it('POSTs SSML with the Cognitive headers + raw PCM output format', async () => {
        mockRequestUrl.mockResolvedValueOnce(pcmResponse());
        const out = await engine.synthesizeChunk('Hello world', 'en-US-AvaNeural');
        expect(out).toBeInstanceOf(Int16Array);
        expect(out.length).toBe(4);
        const call = mockRequestUrl.mock.calls[0][0];
        expect(call.url).toBe(TTS_EP);
        expect(call.headers['Ocp-Apim-Subscription-Key']).toBe('KEY');
        expect(call.headers['Content-Type']).toBe('application/ssml+xml');
        expect(call.headers['X-Microsoft-OutputFormat']).toBe('raw-24khz-16bit-mono-pcm');
        expect(call.body).toContain('<voice name="en-US-AvaNeural">Hello world</voice>');
    });

    it('non-Azure voice ids (e.g. Gemini Charon) fall back to the bound voice', async () => {
        mockRequestUrl.mockResolvedValueOnce(pcmResponse());
        await engine.synthesizeChunk('Hi', 'Charon');
        const call = mockRequestUrl.mock.calls[0][0];
        expect(call.body).toContain('name="en-US-AvaNeural"');
        expect(call.body).not.toContain('Charon');
    });

    it('throws retryable error on 429/5xx', async () => {
        mockRequestUrl.mockResolvedValueOnce({ status: 429, text: 'slow down', json: null, headers: {}, arrayBuffer: null });
        await expect(engine.synthesizeChunk('Hi', 'en-US-AvaNeural')).rejects.toMatchObject({
            httpStatus: 429, retryable: true,
        });
    });

    it('throws non-retryable on 401', async () => {
        mockRequestUrl.mockResolvedValueOnce({ status: 401, text: 'denied', json: null, headers: {}, arrayBuffer: null });
        await expect(engine.synthesizeChunk('Hi', 'en-US-AvaNeural')).rejects.toMatchObject({
            httpStatus: 401, retryable: false,
        });
    });

    it('throws non-retryable on empty payload (contract violation)', async () => {
        mockRequestUrl.mockResolvedValueOnce({ status: 200, text: '', json: null, headers: {}, arrayBuffer: new ArrayBuffer(0) });
        await expect(engine.synthesizeChunk('Hi', 'en-US-AvaNeural')).rejects.toMatchObject({
            name: 'CognitiveSpeechEmptyPayloadError', retryable: false,
        });
    });

    it('throws non-retryable SSML error for unbuildable input (no egress)', async () => {
        await expect(engine.synthesizeChunk('', 'en-US-AvaNeural')).rejects.toMatchObject({
            name: 'CognitiveSpeechSsmlError', retryable: false,
        });
        expect(mockRequestUrl).not.toHaveBeenCalled();
    });

    it('aborts before egress on a pre-aborted signal', async () => {
        const ctrl = new AbortController();
        ctrl.abort();
        await expect(engine.synthesizeChunk('Hi', 'en-US-AvaNeural', ctrl.signal)).rejects.toThrow(/abort/i);
        expect(mockRequestUrl).not.toHaveBeenCalled();
    });
});

describe('createCognitiveSpeechTtsEngine — factory gating', () => {
    beforeEach(() => mockRequestUrl.mockReset());

    it('builds the engine when tts resolves to azure-speech', async () => {
        const engine = await createCognitiveSpeechTtsEngine(makePlugin());
        expect(engine).toBeInstanceOf(CognitiveSpeechTtsEngine);
    });

    it('returns null when speech is unconfigured (no voice)', async () => {
        const engine = await createCognitiveSpeechTtsEngine(makePlugin({ azureSpeechVoice: '' }));
        expect(engine).toBeNull();
    });

    it('returns null when not in Azure mode (policy-denied)', async () => {
        const engine = await createCognitiveSpeechTtsEngine(makePlugin({ cloudServiceType: 'claude' }));
        expect(engine).toBeNull();
    });

    it('returns null when speech is unconfigured + legacy surface would serve (never cross-surface)', async () => {
        // Region missing → resolver falls back to azure-openai surface → this factory refuses.
        const engine = await createCognitiveSpeechTtsEngine(makePlugin({
            azureSpeechRegion: '',
            azureOpenAIEndpoint: 'https://res.openai.azure.com',
            azureApiKey: 'AZ',
        }));
        expect(engine).toBeNull();
    });
});
