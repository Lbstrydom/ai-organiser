// @vitest-environment happy-dom
/**
 * Azure OpenAI as main provider: changing the "GPT model" must change the model
 * the LIVE chat service sends. Drives the real settings handlers (picker and
 * config import) on a real plugin instance whose save re-initialises the LLM
 * service, then captures the next request from `plugin.llmService`.
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';

interface Recorded { name: string; changes: Array<(v: string) => unknown>; clicks: Array<() => unknown> }
const settingsSeen = vi.hoisted(() => [] as unknown[]);
const importHandlers = vi.hoisted(() => [] as Array<(raw: string) => Promise<void>>);

vi.mock('obsidian', async () => {
    const mod = await import('./mocks/obsidian');
    // A Setting that records every control's handlers, so a test can fire them.
    class RecordingSetting {
        rec = { name: '', changes: [] as Array<(v: string) => unknown>, clicks: [] as Array<() => unknown> };
        settingEl: HTMLElement;
        constructor(containerEl: HTMLElement) {
            this.settingEl = containerEl.appendChild(document.createElement('div'));
            settingsSeen.push(this.rec);
        }
        setName(name: string) { this.rec.name = name; return this; }
        setDesc() { return this; }
        setClass() { return this; }
        setHeading() { return this; }
        private control(cb: (c: unknown) => unknown) {
            const inputEl = document.createElement('input') as HTMLInputElement & { show(): void; hide(): void };
            inputEl.show = () => {};
            inputEl.hide = () => {};
            const rec = this.rec;
            const control: unknown = new Proxy({}, {
                get(_t, prop) {
                    if (prop === 'inputEl' || prop === 'buttonEl') return inputEl;
                    if (prop === 'onChange') return (fn: (v: string) => unknown) => { rec.changes.push(fn); return control; };
                    if (prop === 'onClick') return (fn: () => unknown) => { rec.clicks.push(fn); return control; };
                    return () => control;
                },
            });
            cb(control);
            return this;
        }
        addDropdown(cb: (c: unknown) => unknown) { return this.control(cb); }
        addText(cb: (c: unknown) => unknown) { return this.control(cb); }
        addTextArea(cb: (c: unknown) => unknown) { return this.control(cb); }
        addToggle(cb: (c: unknown) => unknown) { return this.control(cb); }
        addSlider(cb: (c: unknown) => unknown) { return this.control(cb); }
        addButton(cb: (c: unknown) => unknown) { return this.control(cb); }
        addExtraButton(cb: (c: unknown) => unknown) { return this.control(cb); }
    }
    return { ...mod, Setting: RecordingSetting, requestUrl: vi.fn() };
});

vi.mock('../src/ui/modals/AzureConfigImportModal', () => ({
    AzureConfigImportModal: class {
        constructor(_app: unknown, _t: unknown, onSubmit: (raw: string) => Promise<void>) { importHandlers.push(onSubmit); }
        open() {}
    },
}));

import { App, requestUrl } from 'obsidian';
import AIOrganiserPlugin from '../src/main';
import { DEFAULT_SETTINGS } from '../src/core/settings';
import { en } from '../src/i18n/en';
import { LLMSettingsSection } from '../src/ui/settings/LLMSettingsSection';
import { disposeAzurePacers } from '../src/services/azure/azureRequestPacer';

const mockRequestUrl = requestUrl as unknown as ReturnType<typeof vi.fn>;
const OAI = 'https://my-resource.openai.azure.com';

beforeAll(() => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const proto = HTMLElement.prototype as any;
    const make = function (this: HTMLElement, tag: string, opts: { cls?: string; text?: string } = {}) {
        const el = document.createElement(tag);
        if (opts.cls) el.className = opts.cls;
        if (opts.text !== undefined) el.textContent = opts.text;
        this.appendChild(el);
        return el;
    };
    proto.createEl ??= make;
    proto.createDiv ??= function (o: object) { return this.createEl('div', o); };
    proto.createSpan ??= function (o: object) { return this.createEl('span', o); };
    proto.empty ??= function () { this.replaceChildren(); };
    proto.addClass ??= function (c: string) { this.classList.add(c); };
    proto.setText ??= function (t: string) { this.textContent = t; };
    proto.show ??= function () {};
    proto.hide ??= function () {};
    proto.setCssProps ??= function () {};
    /* eslint-enable @typescript-eslint/no-explicit-any */
});

beforeEach(() => {
    vi.clearAllMocks();
    settingsSeen.length = 0;
    importHandlers.length = 0;
    disposeAzurePacers();
    mockRequestUrl.mockResolvedValue({
        status: 200, headers: {}, text: '', json: { choices: [{ message: { content: 'ok' } }] },
    });
});

type Internals = { initializeLLMService(): Promise<void> };

async function makePlugin(overrides: Record<string, unknown>) {
    const app = new App();
    const plugin = new AIOrganiserPlugin(app as never, {
        id: 'test', version: '1.0.0', name: 'Test', author: 'Test', minAppVersion: '0.0.0', description: 'Test',
    } as never);
    plugin.settings = {
        ...structuredClone(DEFAULT_SETTINGS),
        serviceType: 'cloud',
        azureFirstMode: true,
        cloudServiceType: 'azure-openai',
        cloudModel: 'gpt-5.5',
        azureGPTModel: 'gpt-5.5',
        azureOpenAIEndpoint: OAI,
        azureAIEndpoint: 'https://my-resource.services.ai.azure.com',
        azureApiKey: 'AZ-KEY',
        ...overrides,
    };
    plugin.t = en;
    (plugin as unknown as { secretStorageService: unknown }).secretStorageService = {
        isAvailable: () => false,
        getSecret: async () => null,
        getProviderKey: async () => null,
        resolveApiKey: async (o: { plainTextFallback?: { primaryKey?: string } }) => o.plainTextFallback?.primaryKey ?? null,
    };
    const pending: Array<Promise<void>> = [];
    // Real chain ending: saveSettings -> initializeLLMService (persistence skipped).
    plugin.saveSettings = () => {
        const p = (plugin as unknown as Internals).initializeLLMService();
        pending.push(p);
        return p;
    };
    await (plugin as unknown as Internals).initializeLLMService();
    return { plugin, settled: () => Promise.all(pending) };
}

function renderSettings(plugin: AIOrganiserPlugin) {
    const section = new LLMSettingsSection(plugin as never, document.createElement('div'), { display: vi.fn() } as never);
    section.display();
}

function recorded(name: string): Recorded {
    const found = (settingsSeen as Recorded[]).find(s => s.name === name);
    if (!found) throw new Error(`no setting "${name}"`);
    return found;
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
            recorded(en.settings.llm.azure.gptModel).changes[0]('gpt-custom-new');
            await settled();

            expect(await sendChat(plugin)).toEqual({ url: mode.url('gpt-custom-new'), model: 'gpt-custom-new' });
        });

        it(`config import reaches the next request (${mode.name})`, async () => {
            const { plugin, settled } = await makePlugin({ ...mode.settings });
            renderSettings(plugin);
            recorded(en.settings.llm.azure.configTransfer).clicks[1]();
            await importHandlers[0](JSON.stringify({ azureGPTModel: 'gpt-imported' }));
            await settled();

            expect(await sendChat(plugin)).toEqual({ url: mode.url('gpt-imported'), model: 'gpt-imported' });
        });
    }

    it('Claude as main provider: the GPT picker leaves the chat model alone', async () => {
        const { plugin, settled } = await makePlugin({ cloudServiceType: 'azure-claude', cloudModel: 'claude-sonnet-5-5' });
        renderSettings(plugin);
        recorded(en.settings.llm.azure.gptModel).changes[0]('gpt-custom-new');
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
