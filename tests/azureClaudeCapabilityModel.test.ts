/**
 * The optional "Claude model" on Azure: the deployment name is what is sent,
 * the model is what capabilities are read from.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('obsidian', async () => {
    const mod = await import('./mocks/obsidian');
    return { ...mod, requestUrl: vi.fn() };
});

import { requestUrl, App } from 'obsidian';
import { CloudLLMService } from '../src/services/cloudService';
import AIOrganiserPlugin from '../src/main';
import { DEFAULT_SETTINGS, migrateOldSettings } from '../src/core/settings';
import { en } from '../src/i18n/en';
import { resolveRequestModels } from '../src/services/adapters/modelCapabilities';
import { disposeAzurePacers } from '../src/services/azure/azureRequestPacer';
import type { BaseAdapter } from '../src/services/adapters/baseAdapter';
import type { SummarizeOptions } from '../src/services/types';

const mockRequestUrl = requestUrl as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
    vi.clearAllMocks();
    disposeAzurePacers();
    mockRequestUrl.mockResolvedValue({ status: 200, headers: {}, text: '', json: { content: [{ type: 'text', text: 'ok' }] } });
});

function make(modelName: string, capabilityModel: string | undefined, thinkingMode: 'standard' | 'adaptive' = 'standard') {
    const service = new CloudLLMService({
        type: 'azure-claude', endpoint: 'https://r.services.ai.azure.com/anthropic/v1/messages',
        apiKey: 'k', modelName, capabilityModel, language: 'en', thinkingMode,
    }, {} as App);
    const adapter = (service as unknown as { adapter: BaseAdapter }).adapter;
    return { service, adapter };
}

async function summarize(service: CloudLLMService, options?: SummarizeOptions) {
    mockRequestUrl.mockClear();
    await service.summarizeText('hello', options);
    return JSON.parse((mockRequestUrl.mock.calls[0][0] as { body: string }).body) as Record<string, unknown>;
}

type Body = Record<string, unknown>;
const without = (body: unknown, key: string): Body => { const b = { ...(body as Body) }; delete b[key]; return b; };

describe('azure-claude with a custom deployment and a Claude model', () => {
    for (const mode of ['standard', 'adaptive'] as const) {
        it(`sends the deployment name and behaves like the model (${mode})`, async () => {
            const custom = make('team-sonnet', 'claude-sonnet-5-5', mode);
            const known = make('claude-sonnet-5-5', undefined, mode);
            const pairs: Array<[unknown, unknown]> = [
                [custom.adapter.formatRequest('hello'), known.adapter.formatRequest('hello')],
                [custom.adapter.formatMultimodalRequest!([{ type: 'text', text: 'hello' }]), known.adapter.formatMultimodalRequest!([{ type: 'text', text: 'hello' }])],
                [await summarize(custom.service), await summarize(known.service)],
                [await summarize(custom.service, { maxTokens: 200000, enableThinking: true }), await summarize(known.service, { maxTokens: 200000, enableThinking: true })],
            ];
            for (const [mine, theirs] of pairs) {
                expect((mine as Body).model).toBe('team-sonnet');
                expect(without(mine, 'model')).toEqual(without(theirs, 'model'));
            }
        });
    }

    it('without the model, a custom deployment name loses those capabilities', async () => {
        expect(await summarize(make('team-sonnet', undefined).service)).not.toHaveProperty('output_config');
        expect(await summarize(make('team-sonnet', 'claude-sonnet-5-5').service)).toHaveProperty('output_config');
    });

    it('a blank Claude model counts as unset', () => {
        expect(make('team-sonnet', '  ').adapter.formatRequest('x')).toEqual(make('team-sonnet', undefined).adapter.formatRequest('x'));
    });

    it('a per-call override decides both the model sent and the capabilities', async () => {
        const custom = make('team-sonnet', 'claude-sonnet-5-5', 'adaptive');
        const sent = await summarize(custom.service, { modelOverride: 'claude-haiku-4-5' });
        expect(sent.model).toBe('claude-haiku-4-5');
        expect(sent).toEqual(await summarize(make('claude-sonnet-5-5', undefined, 'adaptive').service, { modelOverride: 'claude-haiku-4-5' }));
        expect(sent).not.toHaveProperty('thinking');
    });
});

describe('resolveRequestModels', () => {
    const config = { modelName: 'dep', capabilityModel: 'claude-sonnet-5-5' };

    it('keeps the deployment body model with the configured capability model', () => {
        expect(resolveRequestModels(config)).toEqual({ bodyModel: 'dep', capabilityModel: 'claude-sonnet-5-5' });
        expect(resolveRequestModels({ modelName: 'dep' })).toEqual({ bodyModel: 'dep', capabilityModel: 'dep' });
    });

    it('lets a resolved override govern both, including one absent from any catalog', () => {
        expect(resolveRequestModels(config, 'my-other')).toEqual({ bodyModel: 'my-other', capabilityModel: 'my-other' });
    });

    it('treats a dropped (blank or unresolved) override as none', () => {
        expect(resolveRequestModels(config, '')).toEqual({ bodyModel: 'dep', capabilityModel: 'claude-sonnet-5-5' });
    });
});

describe('the setting', () => {
    async function liveRequest(overrides: Record<string, unknown>) {
        const plugin = new AIOrganiserPlugin(new App() as never, {
            id: 'test', version: '1.0.0', name: 'Test', author: 'Test', minAppVersion: '0.0.0', description: 'Test',
        } as never);
        plugin.settings = {
            ...structuredClone(DEFAULT_SETTINGS), serviceType: 'cloud', cloudServiceType: 'azure-claude', cloudModel: 'team-sonnet',
            azureAIEndpoint: 'https://r.services.ai.azure.com', azureApiKey: 'k', ...overrides,
        };
        plugin.t = en;
        (plugin as unknown as { secretStorageService: unknown }).secretStorageService = {
            isAvailable: () => false, getSecret: async () => null, getProviderKey: async () => null,
            resolveApiKey: async (o: { plainTextFallback?: { primaryKey?: string } }) => o.plainTextFallback?.primaryKey ?? null,
        };
        await (plugin as unknown as { initializeLLMService(): Promise<void> }).initializeLLMService();
        return summarize((plugin as unknown as { llmService: CloudLLMService }).llmService);
    }

    it('reaches the live chat service', async () => {
        const sent = await liveRequest({ azureClaudeModel: 'claude-sonnet-5-5' });
        expect(sent.model).toBe('team-sonnet');
        expect(sent).toHaveProperty('output_config');
    });

    it('is not applied to a direct Claude provider', async () => {
        const sent = await liveRequest({
            cloudServiceType: 'claude', cloudEndpoint: 'https://api.anthropic.com/v1/messages', cloudApiKey: 'k',
            cloudModel: 'my-name', azureClaudeModel: 'claude-sonnet-5-5',
        });
        expect(sent).not.toHaveProperty('output_config');
    });

    it('defaults to empty, and migration neither fills it nor renames the deployment', () => {
        expect(DEFAULT_SETTINGS.azureClaudeModel).toBe('');
        const stored: Record<string, unknown> = { cloudServiceType: 'azure-claude', cloudModel: 'team-sonnet', azureFirstMode: true };
        migrateOldSettings(stored);
        expect(stored.cloudModel).toBe('team-sonnet');
        expect(stored.azureClaudeModel ?? '').toBe('');
    });
});
