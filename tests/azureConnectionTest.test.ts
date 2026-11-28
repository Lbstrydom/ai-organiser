/**
 * azureConnectionTest — per-capability probe gating (G2).
 * Mocks Obsidian's requestUrl so no real network calls happen.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockRequestUrl = vi.fn();
vi.mock('obsidian', async () => {
    const actual = await vi.importActual('./mocks/obsidian');
    return { ...actual, requestUrl: (...args: unknown[]) => mockRequestUrl(...args) };
});

import { testAzureConnection } from '../src/services/azure/azureConnectionTest';

function makePlugin(azureCapabilities: Record<string, { mode: string; deployment?: string }> = {}): any {
    return {
        settings: {
            cloudServiceType: 'azure-claude',
            cloudModel: 'claude-sonnet-4-6',
            azureRoutingMode: 'model-based',
            azureAIEndpoint: 'https://res.services.ai.azure.com',
            azureOpenAIEndpoint: 'https://res.openai.azure.com',
            azureWhisperDeployment: 'whisper',
            azureGPTModel: 'gpt-5.3-chat',
            embeddingModel: 'text-embedding-3-large',
            azureDeployments: {},
            azureApiVersionOverride: {},
            azureApiKey: 'AZ-KEY',
            azureKeyStored: false,
            azureCapabilities,
            taskModels: {},
        },
        secretStorageService: {
            isAvailable: () => true,
            resolveApiKey: async (o: any) => o.plainTextFallback?.primaryKey ?? null,
        },
    };
}

beforeEach(() => {
    mockRequestUrl.mockReset();
    // Generic 200 with fields satisfying every surface's success check.
    mockRequestUrl.mockResolvedValue({
        status: 200,
        json: { content: [{ type: 'text', text: 'ok' }], choices: [{ message: {} }], data: [{ embedding: [0.1, 0.2] }] },
    });
});

describe('testAzureConnection — capability probe gating (G2)', () => {
    it('probes tts + websearch when those capabilities are set to Azure (default)', async () => {
        const report = await testAzureConnection(makePlugin({ tts: { mode: 'azure', deployment: 'tts-1' }, websearch: { mode: 'azure' } }));
        const surfaces = report.surfaces.map(s => s.surface);
        expect(surfaces).toContain('azure-tts');
        expect(surfaces).toContain('azure-websearch');
        expect(report.surfaces.find(s => s.surface === 'azure-tts')?.ok).toBe(true);
        expect(report.surfaces.find(s => s.surface === 'azure-websearch')?.ok).toBe(true);
    });

    it('SKIPS tts (off) and websearch (byo) probes when not set to Azure', async () => {
        const report = await testAzureConnection(makePlugin({ tts: { mode: 'off' }, websearch: { mode: 'byo' } }));
        const surfaces = report.surfaces.map(s => s.surface);
        expect(surfaces).not.toContain('azure-tts');
        expect(surfaces).not.toContain('azure-websearch');
        // legacy surfaces still probed
        expect(surfaces).toContain('azure-claude');
    });

    it('tts 400 still counts as connected (deployment + key proven, like whisper)', async () => {
        mockRequestUrl.mockImplementation((req: any) => {
            if (typeof req.url === 'string' && req.url.includes('/audio/speech')) return Promise.resolve({ status: 400, json: {} });
            return Promise.resolve({ status: 200, json: { content: [{}], choices: [{}], data: [{ embedding: [0.1] }] } });
        });
        const report = await testAzureConnection(makePlugin({ tts: { mode: 'azure', deployment: 'tts-1' } }));
        const tts = report.surfaces.find(s => s.surface === 'azure-tts');
        expect(tts?.ok).toBe(true);
        expect(tts?.status).toBe(400);
    });

    it('websearch 404 (deployment missing) → not ok', async () => {
        mockRequestUrl.mockImplementation((req: any) => {
            if (typeof req.url === 'string' && req.url.includes('/anthropic/v1/messages')) return Promise.resolve({ status: 404, json: {} });
            return Promise.resolve({ status: 200, json: { content: [{}], choices: [{}], data: [{ embedding: [0.1] }] } });
        });
        const report = await testAzureConnection(makePlugin({ websearch: { mode: 'azure' } }));
        const ws = report.surfaces.find(s => s.surface === 'azure-websearch');
        expect(ws?.ok).toBe(false);
        expect(ws?.status).toBe(404);
    });
});

describe('testAzureConnection — GPT chat token field', () => {
    it.each(['gpt-5.3-chat', 'gpt-6.1-terra', 'gpt-6-luna'])('sends max_completion_tokens for %s', async (model) => {
        const plugin = makePlugin();
        plugin.settings.azureGPTModel = model;
        await testAzureConnection(plugin);
        const chat = mockRequestUrl.mock.calls
            .map(([req]) => req as { url: string; body?: unknown })
            .find((req) => req.url.includes('/chat/completions'));
        const body = JSON.parse(String(chat?.body));
        expect(body.max_completion_tokens).toBe(16);
        expect(body.max_tokens).toBeUndefined();
    });
});

describe('testAzureConnection — Whisper probe', () => {
    const surfacesFor = async (settings: Record<string, unknown>, capabilities?: Record<string, { mode: string }>) => {
        const plugin = makePlugin(capabilities);
        Object.assign(plugin.settings, settings);
        return (await testAzureConnection(plugin)).surfaces.map((s) => s.surface);
    };
    const SPEECH = { azureSpeechEndpoint: 'https://res.cognitiveservices.azure.com' };
    // The Speech transcription probe uses window timers.
    beforeEach(() => { vi.stubGlobal('window', globalThis); });
    afterEach(() => { vi.unstubAllGlobals(); });

    it('probes Whisper when Azure AI Speech is not configured', async () => {
        expect(await surfacesFor({})).toContain('azure-openai-whisper');
    });

    it('skips Whisper when Azure AI Speech serves transcription', async () => {
        const surfaces = await surfacesFor(SPEECH);
        expect(surfaces).toContain('azure-speech-stt');
        expect(surfaces).not.toContain('azure-openai-whisper');
    });

    it('still probes Whisper when the Speech endpoint is unusable', async () => {
        expect(await surfacesFor({ azureSpeechEndpoint: 'https://example.com' })).toContain('azure-openai-whisper');
    });

    it('skips Whisper in strict Speech mode, even before Speech is set up', async () => {
        expect(await surfacesFor({ azureSpeechRequired: true })).not.toContain('azure-openai-whisper');
    });

    it.each(['off', 'byo'])('skips Whisper when transcription is set to %s', async (mode) => {
        expect(await surfacesFor({}, { transcription: { mode } })).not.toContain('azure-openai-whisper');
    });
});

describe('testAzureConnection — chat probe uses the model chat sends', () => {
    const chatBodyModel = (): string => {
        const call = mockRequestUrl.mock.calls
            .map(c => c[0] as { url: string; body: string })
            .find(r => r.url.includes('/chat/completions'));
        return (JSON.parse(call!.body) as { model: string }).model;
    };

    it('azure-openai main: probes cloudModel even when "GPT model" differs', async () => {
        const plugin = makePlugin();
        plugin.settings.cloudServiceType = 'azure-openai';
        plugin.settings.cloudModel = 'gpt-chat-dep';
        plugin.settings.azureGPTModel = 'gpt-other';
        await testAzureConnection(plugin);
        expect(chatBodyModel()).toBe('gpt-chat-dep');
    });

    it('azure-claude main: probes "GPT model" for the OpenAI surface', async () => {
        const plugin = makePlugin();
        plugin.settings.azureGPTModel = 'gpt-other';
        await testAzureConnection(plugin);
        expect(chatBodyModel()).toBe('gpt-other');
    });
});

describe('testAzureConnection — Claude model', () => {
    const claudeProbe = () => mockRequestUrl.mock.calls
        .map(c => c[0] as { url: string; body: string })
        .find(r => r.url.includes('/anthropic/'))!.body;

    it('probes the same request with or without it, and names both in the report', async () => {
        await testAzureConnection(makePlugin());
        const without = claudeProbe();
        mockRequestUrl.mockClear();
        const plugin = makePlugin();
        plugin.settings.azureClaudeModel = 'claude-opus-5-5';
        const report = await testAzureConnection(plugin);
        expect(claudeProbe()).toBe(without);
        const claude = report.surfaces.find(s => s.surface === 'azure-claude')!;
        expect(claude.target).toBe('claude-sonnet-4-6');
        expect(claude.capabilityModel).toBe('claude-opus-5-5');
    });
});
