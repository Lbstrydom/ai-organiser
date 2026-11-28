/**
 * Azure Claude request bodies with no "Claude model" set, recorded before that
 * setting existed. They must stay byte-identical: do not update the snapshot for
 * a change to the optional capability model.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('obsidian', async () => {
    const mod = await import('./mocks/obsidian');
    return { ...mod, requestUrl: vi.fn() };
});

import { requestUrl, App } from 'obsidian';
import { CloudLLMService } from '../src/services/cloudService';
import { disposeAzurePacers } from '../src/services/azure/azureRequestPacer';
import type { BaseAdapter } from '../src/services/adapters/baseAdapter';
import type { SummarizeOptions } from '../src/services/types';

const mockRequestUrl = requestUrl as unknown as ReturnType<typeof vi.fn>;
const STABLE = 'Stable instructions. '.repeat(600);

beforeEach(() => {
    vi.clearAllMocks();
    disposeAzurePacers();
    mockRequestUrl.mockResolvedValue({ status: 200, headers: {}, text: '', json: { content: [{ type: 'text', text: 'ok' }] } });
});

async function bodies(modelName: string, thinkingMode: 'standard' | 'adaptive') {
    const service = new CloudLLMService({
        type: 'azure-claude', endpoint: 'https://r.services.ai.azure.com/anthropic/v1/messages',
        apiKey: 'k', modelName, language: 'en', thinkingMode,
    }, {} as App);
    const adapter = (service as unknown as { adapter: BaseAdapter & {
        formatCachedRequest(p: string, s: string): unknown;
    } }).adapter;
    const summarize = async (options?: SummarizeOptions): Promise<string> => {
        mockRequestUrl.mockClear();
        await service.summarizeText('hello', options);
        return (mockRequestUrl.mock.calls[0][0] as { body: string }).body;
    };
    return {
        tag: JSON.stringify(adapter.formatRequest('hello')),
        cachedTag: JSON.stringify(adapter.formatCachedRequest('hello', STABLE)),
        multimodal: JSON.stringify(adapter.formatMultimodalRequest([{ type: 'text', text: 'hello' }])),
        headers: adapter.getHeaders(),
        summarize: await summarize(),
        summarizeLarge: await summarize({ maxTokens: 200000, enableThinking: true, stablePrefix: STABLE }),
        override: await summarize({ modelOverride: 'claude-opus-5-5' }),
    };
}

describe('azure-claude requests without a Claude model set', () => {
    for (const model of ['team-sonnet', 'claude-sonnet-5-5']) {
        for (const mode of ['standard', 'adaptive'] as const) {
            it(`${model}, ${mode}`, async () => {
                expect(await bodies(model, mode)).toMatchSnapshot();
            });
        }
    }
});
