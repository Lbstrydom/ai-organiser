/**
 * AzureSpeechTtsEngine unit tests — Azure OpenAI /audio/speech contract.
 * Mocks Obsidian's requestUrl.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRequestUrl = vi.fn();
vi.mock('obsidian', async () => {
    const actual = await vi.importActual('./mocks/obsidian');
    return { ...actual, requestUrl: (...args: unknown[]) => mockRequestUrl(...args) };
});

import { AzureSpeechTtsEngine, createAzureSpeechTtsEngine } from '../src/services/tts/azureSpeechTtsEngine';

// 4 bytes = 2 LE int16 samples: 0x0100=256, 0xFFFF=-1
function pcmBuf(): ArrayBuffer {
    return new Uint8Array([0x00, 0x01, 0xFF, 0xFF]).buffer;
}

beforeEach(() => mockRequestUrl.mockReset());

describe('AzureSpeechTtsEngine', () => {
    it('200 + pcm → Int16Array samples', async () => {
        mockRequestUrl.mockResolvedValue({ status: 200, arrayBuffer: pcmBuf() });
        const eng = new AzureSpeechTtsEngine('k', 'https://r.openai.azure.com/openai/v1/audio/speech', 'tts-1');
        const out = await eng.synthesizeChunk('hi', 'alloy');
        expect(Array.from(out)).toEqual([256, -1]);
    });

    it('sends api-key header, pcm format, and the model', async () => {
        mockRequestUrl.mockResolvedValue({ status: 200, arrayBuffer: pcmBuf() });
        const eng = new AzureSpeechTtsEngine('SECRET', 'https://r/audio/speech', 'my-tts');
        await eng.synthesizeChunk('hello', 'nova');
        const call = mockRequestUrl.mock.calls[0][0];
        expect(call.headers['api-key']).toBe('SECRET');
        const body = JSON.parse(call.body);
        expect(body.response_format).toBe('pcm');
        expect(body.model).toBe('my-tts');
        expect(body.voice).toBe('nova');
    });

    it('maps an unknown (Gemini) voice to the default azure voice', async () => {
        mockRequestUrl.mockResolvedValue({ status: 200, arrayBuffer: pcmBuf() });
        const eng = new AzureSpeechTtsEngine('k', 'https://r/audio/speech', 'tts-1');
        await eng.synthesizeChunk('x', 'Charon'); // Gemini voice → not valid on Azure
        expect(JSON.parse(mockRequestUrl.mock.calls[0][0].body).voice).toBe('alloy');
    });

    it('non-200 throws with retryable flag for 429/5xx', async () => {
        mockRequestUrl.mockResolvedValue({ status: 503, text: 'busy' });
        const eng = new AzureSpeechTtsEngine('k', 'https://r/audio/speech', 'tts-1');
        await expect(eng.synthesizeChunk('x', 'alloy')).rejects.toMatchObject({ httpStatus: 503, retryable: true });
    });

    it('non-200 4xx throws non-retryable', async () => {
        mockRequestUrl.mockResolvedValue({ status: 401, text: 'bad key' });
        const eng = new AzureSpeechTtsEngine('k', 'https://r/audio/speech', 'tts-1');
        await expect(eng.synthesizeChunk('x', 'alloy')).rejects.toMatchObject({ httpStatus: 401, retryable: false });
    });

    it('empty payload throws non-retryable', async () => {
        mockRequestUrl.mockResolvedValue({ status: 200, arrayBuffer: new ArrayBuffer(0) });
        const eng = new AzureSpeechTtsEngine('k', 'https://r/audio/speech', 'tts-1');
        await expect(eng.synthesizeChunk('x', 'alloy')).rejects.toMatchObject({ retryable: false });
    });

    it('aborts before the request when the signal is already aborted', async () => {
        const eng = new AzureSpeechTtsEngine('k', 'https://r/audio/speech', 'tts-1');
        const ac = new AbortController();
        ac.abort();
        await expect(eng.synthesizeChunk('x', 'alloy', ac.signal)).rejects.toThrow();
        expect(mockRequestUrl).not.toHaveBeenCalled();
    });
});

describe('createAzureSpeechTtsEngine', () => {
    const makePlugin = (cap: { mode: string; deployment?: string }): any => ({
        settings: {
            cloudServiceType: 'azure-claude',
            azureRoutingMode: 'model-based',
            azureAIEndpoint: 'https://r.services.ai.azure.com',
            azureOpenAIEndpoint: 'https://r.openai.azure.com',
            azureCapabilities: { tts: cap },
            azureApiKey: 'AZ',
        },
        secretStorageService: {
            isAvailable: () => true,
            getSecret: async () => null,
            getProviderKey: async () => null,
            resolveApiKey: async (o: any) => o.plainTextFallback?.primaryKey ?? null,
        },
    });

    it('tts azure → engine', async () => {
        const eng = await createAzureSpeechTtsEngine(makePlugin({ mode: 'azure', deployment: 'tts-1' }));
        expect(eng).toBeInstanceOf(AzureSpeechTtsEngine);
    });

    it('tts off → null (no engine, no silent fallback)', async () => {
        const eng = await createAzureSpeechTtsEngine(makePlugin({ mode: 'off' }));
        expect(eng).toBeNull();
    });

    it('tts byo → null (narration path uses the BYO gemini provider)', async () => {
        const eng = await createAzureSpeechTtsEngine(makePlugin({ mode: 'byo' }));
        expect(eng).toBeNull();
    });
});
