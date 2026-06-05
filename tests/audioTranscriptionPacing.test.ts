vi.mock('obsidian', async () => {
    const mod = await import('./mocks/obsidian');
    return { ...mod, requestUrl: vi.fn() };
});
vi.mock('../src/utils/abortableSleep', () => ({ abortableSleep: vi.fn(async () => {}) }));
// Spy on the lease wrapper while keeping the real key builders / isAzureHost.
vi.mock('../src/services/azure/azureRequestPacer', async (orig) => {
    const actual = await orig<typeof import('../src/services/azure/azureRequestPacer')>();
    return { ...actual, withAzureLease: vi.fn((_k: string, _s: unknown, fn: () => Promise<unknown>) => fn()) };
});

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { requestUrl } from 'obsidian';
import { withAzureLease, buildAzureOpenAIDeploymentKey } from '../src/services/azure/azureRequestPacer';
import { resolveWhisperPacingKey, pacedWhisperRequest } from '../src/services/audioTranscriptionService';

const mockRequestUrl = requestUrl as unknown as ReturnType<typeof vi.fn>;
const leaseSpy = withAzureLease as unknown as ReturnType<typeof vi.fn>;
const AZURE = 'https://res.openai.azure.com/openai/deployments/whisper-prod/audio/transcriptions?api-version=2024-06-01';
const OPENAI = 'https://api.openai.com/v1/audio/transcriptions';
const param = { url: AZURE, method: 'POST' as const, body: 'x', throw: false };

beforeEach(() => vi.clearAllMocks());

describe('resolveWhisperPacingKey (self-detect)', () => {
    it('derives the Whisper deployment key from an Azure endpoint', () => {
        expect(resolveWhisperPacingKey(AZURE)).toBe(buildAzureOpenAIDeploymentKey(AZURE, 'whisper-prod'));
    });
    it('falls back to the literal "whisper" deployment when the URL is model-routed', () => {
        const modelRouted = 'https://res.openai.azure.com/openai/audio/transcriptions';
        expect(resolveWhisperPacingKey(modelRouted)).toBe(buildAzureOpenAIDeploymentKey(modelRouted, 'whisper'));
    });
    it('returns null for a non-Azure endpoint (un-paced)', () => {
        expect(resolveWhisperPacingKey(OPENAI)).toBeNull();
    });
});

describe('pacedWhisperRequest', () => {
    it('Azure endpoint ⇒ acquires a lease on the Whisper key', async () => {
        mockRequestUrl.mockResolvedValue({ status: 200, headers: {}, json: { text: 'hi' } });
        await pacedWhisperRequest(AZURE, param);
        expect(leaseSpy).toHaveBeenCalledTimes(1);
        expect(leaseSpy.mock.calls[0][0]).toBe(buildAzureOpenAIDeploymentKey(AZURE, 'whisper-prod'));
    });

    it('non-Azure endpoint ⇒ NO lease, a direct request', async () => {
        mockRequestUrl.mockResolvedValue({ status: 200, headers: {}, json: { text: 'hi' } });
        await pacedWhisperRequest(OPENAI, { ...param, url: OPENAI });
        expect(leaseSpy).not.toHaveBeenCalled();
        expect(mockRequestUrl).toHaveBeenCalledTimes(1);
    });

    it('a timeout rejects AND stops the retry loop (no zombie — audit consolidated-R1 H1)', async () => {
        // requestUrl never resolves; the internal timeout (10ms) must win and abort.
        mockRequestUrl.mockReturnValue(new Promise(() => { /* hangs forever */ }));
        await expect(pacedWhisperRequest(AZURE, param, 10)).rejects.toThrow(/timeout/i);
        // Only the single in-flight attempt was started — the loop did not spin further.
        expect(mockRequestUrl).toHaveBeenCalledTimes(1);
    });

    it('a 429 is retried under the lease (released before the backoff)', async () => {
        mockRequestUrl
            .mockResolvedValueOnce({ status: 429, headers: { 'x-ratelimit-reset-requests': '1' }, json: {} })
            .mockResolvedValueOnce({ status: 200, headers: {}, json: { text: 'ok' } });
        const r = await pacedWhisperRequest(AZURE, param);
        expect(r.status).toBe(200);
        expect(mockRequestUrl).toHaveBeenCalledTimes(2);
        expect(leaseSpy).toHaveBeenCalledTimes(2); // one lease per attempt
    });
});
