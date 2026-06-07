/**
 * azureConnectionTest — per-capability probe gating (G2).
 * Mocks Obsidian's requestUrl so no real network calls happen.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
