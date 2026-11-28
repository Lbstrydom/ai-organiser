// @vitest-environment happy-dom
/**
 * Azure OpenAI as main provider: changing the "GPT model" must change the model
 * the LIVE chat service sends. Drives the real settings handlers (picker and
 * config import) on a real plugin instance whose save re-initialises the LLM
 * service, then captures the next request from `plugin.llmService`.
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';

const importHandlers = vi.hoisted(() => [] as Array<(raw: string) => Promise<void>>);

vi.mock('obsidian', async () => ({
    ...await import('./mocks/obsidian'),
    ...(await import('./helpers/settingsHarness')).settingsObsidianOverrides(),
    requestUrl: vi.fn(),
}));

vi.mock('../src/ui/modals/AzureConfigImportModal', () => ({
    AzureConfigImportModal: class {
        constructor(_app: unknown, _t: unknown, onSubmit: (raw: string) => Promise<void>) { importHandlers.push(onSubmit); }
        open() {}
    },
}));

import { requestUrl } from 'obsidian';
import AIOrganiserPlugin from '../src/main';
import { DEFAULT_SETTINGS } from '../src/core/settings';
import { en } from '../src/i18n/en';
import { LLMSettingsSection } from '../src/ui/settings/LLMSettingsSection';
import { disposeAzurePacers } from '../src/services/azure/azureRequestPacer';
import { setupSettingsDom, makeSettingsPlugin, recordedSettings } from './helpers/settingsHarness';

const mockRequestUrl = requestUrl as unknown as ReturnType<typeof vi.fn>;
const OAI = 'https://my-resource.openai.azure.com';

beforeAll(setupSettingsDom);

beforeEach(() => {
    vi.clearAllMocks();
    recordedSettings.length = 0;
    importHandlers.length = 0;
    disposeAzurePacers();
    mockRequestUrl.mockResolvedValue({
        status: 200, headers: {}, text: '', json: { choices: [{ message: { content: 'ok' } }] },
    });
});

/** A real plugin with Azure OpenAI as main provider; saving re-initialises the chat service. */
function makePlugin(overrides: Record<string, unknown>) {
    return makeSettingsPlugin({ Plugin: AIOrganiserPlugin, defaults: DEFAULT_SETTINGS, t: en }, {
        serviceType: 'cloud',
        azureFirstMode: true,
        cloudServiceType: 'azure-openai',
        cloudModel: 'gpt-5.5',
        azureGPTModel: 'gpt-5.5',
        azureOpenAIEndpoint: OAI,
        azureAIEndpoint: 'https://my-resource.services.ai.azure.com',
        azureApiKey: 'AZ-KEY',
        ...overrides,
    });
}

function renderSettings(plugin: AIOrganiserPlugin) {
    new LLMSettingsSection(plugin as never, document.createElement('div'), { display: vi.fn() } as never).display();
}

function control(name: string, kind: 'change' | 'click', index = 0) {
    const found = recordedSettings.find(s => s.name === name)?.controls.filter(c => c[kind])[index]?.[kind];
    if (!found) throw new Error(`no ${kind} control "${name}"`);
    return found as (v?: unknown) => unknown;
}

async function sendChat(plugin: AIOrganiserPlugin) {
    mockRequestUrl.mockClear();
    await (plugin as unknown as { llmService: { summarizeText(t: string): Promise<unknown> } }).llmService.summarizeText('hello');
    const call = mockRequestUrl.mock.calls[0][0] as { url: string; body: string };
    return { url: call.url, model: (JSON.parse(call.body) as { model: string }).model };
}

const routing = [
    { name: 'model-based', settings: { azureRoutingMode: 'model-based' }, url: () => `${OAI}/openai/v1/chat/completions` },
    {
        name: 'deployment-based without a chat deployment',
        settings: { azureRoutingMode: 'deployment-based', azureDeployments: {} },
        url: (m: string) => `${OAI}/openai/deployments/${m}/chat/completions?api-version=2025-03-01-preview`,
    },
] as const;

describe('Azure OpenAI main provider: the live chat service follows "GPT model"', () => {
    for (const mode of routing) {
        it(`picker change reaches the next request (${mode.name})`, async () => {
            const { plugin, settled } = await makePlugin({ ...mode.settings });
            expect((await sendChat(plugin)).model).toBe('gpt-5.5');

            renderSettings(plugin);
            control(en.settings.llm.azure.gptModel, 'change')('gpt-custom-new');
            await settled();

            expect(await sendChat(plugin)).toEqual({ url: mode.url('gpt-custom-new'), model: 'gpt-custom-new' });
        });

        it(`config import reaches the next request (${mode.name})`, async () => {
            const { plugin, settled } = await makePlugin({ ...mode.settings });
            renderSettings(plugin);
            control(en.settings.llm.azure.configTransfer, 'click', 1)();
            await importHandlers[0](JSON.stringify({ azureGPTModel: 'gpt-imported' }));
            await settled();

            expect(await sendChat(plugin)).toEqual({ url: mode.url('gpt-imported'), model: 'gpt-imported' });
        });
    }

    it('Claude as main provider: the GPT picker leaves the chat model alone', async () => {
        const { plugin, settled } = await makePlugin({ cloudServiceType: 'azure-claude', cloudModel: 'claude-sonnet-5-5' });
        renderSettings(plugin);
        control(en.settings.llm.azure.gptModel, 'change')('gpt-custom-new');
        await settled();
        expect(plugin.settings.azureGPTModel).toBe('gpt-custom-new');
        expect(plugin.settings.cloudModel).toBe('claude-sonnet-5-5');
    });

    it('no silent migration: differing stored values survive load of the service and opening settings', async () => {
        const { plugin } = await makePlugin({ cloudModel: 'gpt-chat-dep', azureGPTModel: 'gpt-other' });
        renderSettings(plugin);
        expect(plugin.settings.cloudModel).toBe('gpt-chat-dep');
        expect(plugin.settings.azureGPTModel).toBe('gpt-other');
        expect((await sendChat(plugin)).model).toBe('gpt-chat-dep');
    });
});
