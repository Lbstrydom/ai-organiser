// @vitest-environment happy-dom
/**
 * The AI provider settings screen: opening it writes nothing.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

vi.mock('obsidian', async () => ({
    ...await import('./mocks/obsidian'),
    ...(await import('./helpers/settingsHarness')).settingsObsidianOverrides(),
    requestUrl: vi.fn(),
}));

import { requestUrl } from 'obsidian';
import { setupSettingsDom, makeSettingsPlugin, flushRender, recordedSettings } from './helpers/settingsHarness';
import { SETTINGS_FIXTURES } from './helpers/settingsFixtures';
import AIOrganiserPlugin from '../src/main';
import { DEFAULT_SETTINGS } from '../src/core/settings';
import { en } from '../src/i18n/en';
import { FEATURE_REGISTRY } from '../src/core/features';
import { LLMSettingsSection } from '../src/ui/settings/LLMSettingsSection';

const mockRequestUrl = requestUrl as unknown as ReturnType<typeof vi.fn>;
const DEPS = { Plugin: AIOrganiserPlugin, defaults: DEFAULT_SETTINGS, t: en };

beforeAll(setupSettingsDom);
beforeEach(() => {
    vi.clearAllMocks();
    recordedSettings.length = 0;
    mockRequestUrl.mockResolvedValue({ status: 200, headers: {}, text: '', json: {} });
});

async function render(fixture: Record<string, unknown>) {
    const { plugin } = await makeSettingsPlugin(DEPS, structuredClone(fixture));
    const container = document.createElement('div');
    const settingTab = { display: vi.fn() };
    new LLMSettingsSection(plugin as never, container, settingTab as never).display();
    await flushRender();
    return { plugin, container };
}

describe('opening the AI provider settings', () => {
    for (const [name, fixture] of Object.entries(SETTINGS_FIXTURES)) {
        it(`writes nothing: ${name}`, async () => {
            const { plugin: before } = await makeSettingsPlugin(DEPS, structuredClone(fixture));
            const expected = JSON.stringify(before.settings);

            const { plugin } = await render(fixture);

            expect(JSON.stringify(plugin.settings)).toBe(expected);
            expect(plugin.saveSettings).not.toHaveBeenCalled();
        });
    }
});

const az = en.settings.llm.azure;
const ALL_FEATURES = Object.fromEntries(FEATURE_REGISTRY.filter(f => !f.core).map(f => [f.id, true]));

/** Headings, setting names and the Advanced summary, in screen order. */
async function outline(fixture: string, extra: Record<string, unknown> = {}) {
    recordedSettings.length = 0;
    const rendered = await render({ ...SETTINGS_FIXTURES[fixture], featureFlags: ALL_FEATURES, ...extra });
    const details = rendered.container.querySelectorAll('details');
    const names = (root: ParentNode) => Array.from(root.querySelectorAll('[data-setting], h4, summary'))
        .map(n => (n as HTMLElement).dataset.setting ?? `# ${n.textContent}`);
    return { ...rendered, details, all: names(rendered.container), advanced: details[0] ? names(details[0]) : [] };
}

const AZURE_ADVANCED_NAMES = [
    az.routingMode, az.claudeViaGateway, az.maxConcurrent, az.maxRpm, az.perDeploymentRpm,
    en.settings.azureSpeech.apiKey, en.settings.azureSpeech.maxSpeakers, en.settings.azureSpeech.strictMode,
    en.settings.azureCapabilities.youtube, en.settings.llm.debugMode,
];

describe('Azure-first layout', () => {
    it('shows every control once, grouped in the approved order', async () => {
        const { all } = await outline('azure deployment-based (OpenAI main)');
        const caps = en.settings.azureCapabilities;
        expect(all.filter(Boolean)).toEqual([
            az.firstMode,
            `# ${az.groupConnection}`, az.apiKey, az.aiEndpoint, az.openAIEndpoint, az.testConfig, az.configTransfer,
            `# ${az.groupChat}`, az.mainProviderChoice, az.defaultModel, az.customModelName, az.gptModel, az.chatDeployment,
            `# ${az.groupSearch}`, az.source, az.embeddingModel, az.embeddingsDeployment, caps.visualEmbeddings, caps.deploymentLabel,
            `# ${az.groupTranscription}`, az.source, en.settings.azureSpeech.endpoint, az.whisperDeployment, en.diarization.providerLabel,
            `# ${az.groupReadAloud}`, az.source, az.deployment, en.settings.azureSpeech.region, en.settings.azureSpeech.voice,
            `# ${az.groupWebSearch}`, az.source, az.deployment,
            en.commands.replaceModelName,
            `# ${az.advancedOneOverride}`, ...AZURE_ADVANCED_NAMES,
        ]);
    });

    it('has one Advanced disclosure, closed, holding the routing and limit settings', async () => {
        const { details, advanced } = await outline('azure deployment-based (OpenAI main)');
        expect(details).toHaveLength(1);
        expect(details[0].open).toBe(false);
        expect(advanced.filter(Boolean).slice(1)).toEqual(AZURE_ADVANCED_NAMES);
    });

    it('counts overrides in the summary', async () => {
        const two = await outline('azure model-based (Claude main)', { azureMaxRpm: 5, debugMode: true });
        expect(two.advanced[0]).toBe(`# ${az.advancedOverrides.replace('{count}', '2')}`);
        const none = await outline('azure model-based (Claude main)');
        expect(none.advanced[0]).toBe(`# ${az.advanced}`);
    });

    it('keeps the model fields under deployment routing and hides deployments under model routing', async () => {
        const deployment = await outline('azure deployment-based (OpenAI main)');
        expect(deployment.all).toContain(az.gptModel);
        expect(deployment.all).toContain(az.embeddingModel);
        const model = await outline('azure model-based (Claude main)');
        expect(model.all).not.toContain(az.chatDeployment);
        // Read aloud sends its deployment as the model, so it stays in either mode.
        expect(model.all).toContain(az.deployment);
    });

    it('asks for a web search deployment only when GPT is the main provider', async () => {
        const claude = await outline('azure model-based (Claude main)');
        const after = claude.all.slice(claude.all.indexOf(`# ${az.groupWebSearch}`));
        expect(after.filter(Boolean).slice(0, 3)).toEqual([`# ${az.groupWebSearch}`, az.source, en.commands.replaceModelName]);
    });

    it('says when a deployment field edits a per-feature override, and writes to it', async () => {
        const { plugin } = await outline('azure per-feature override');
        const field = recordedSettings.find(r => r.name === az.whisperDeployment)!;
        expect(field.desc).toContain(az.overrideNote);
        expect(field.controls[0].value).toBe('override-whisper');
        field.controls[0].change!('next-whisper');
        expect(plugin.settings.azureCapabilities.transcription?.deployment).toBe('next-whisper');
        expect(plugin.settings.azureWhisperDeployment).toBe('legacy-whisper');
    });

    it('shows a differing chat model and changes it only on the button', async () => {
        const { plugin, container } = await outline('azure deployment-based (OpenAI main)');
        const notice = container.querySelector('.ai-organiser-azure-model-mismatch')!;
        expect(notice.textContent).toContain('gpt-chat-dep');
        expect(plugin.settings.cloudModel).toBe('gpt-chat-dep');
        const label = az.useForChat.replace('{gpt}', 'gpt-other');
        recordedSettings.flatMap(r => r.controls).find(c => c.buttonText === label)!.click!();
        expect(plugin.settings.cloudModel).toBe('gpt-other');
    });

    it('offers an optional Claude model under the deployment only when Claude is main', async () => {
        const claude = await outline('azure model-based (Claude main)');
        expect(claude.all.indexOf(az.claudeModel)).toBeGreaterThan(claude.all.indexOf(az.defaultModel));
        const field = recordedSettings.find(r => r.name === az.claudeModel)!;
        expect(field.controls[0].value).toBe('');
        field.controls[0].change!(' claude-sonnet-5-5 ');
        expect(claude.plugin.settings.azureClaudeModel).toBe('claude-sonnet-5-5');
        expect(claude.plugin.settings.cloudModel).toBe('claude-sonnet-5-5');
        const gpt = await outline('azure deployment-based (OpenAI main)');
        expect(gpt.all).not.toContain(az.claudeModel);
    });

    it('describes the read aloud deployment', async () => {
        await outline('azure model-based (Claude main)');
        // Model-based routing draws one "Deployment" outside Search's visual row: read aloud's.
        const described = recordedSettings.filter(r => r.name === az.deployment).map(r => r.desc);
        expect(described).toContain(az.ttsDeploymentDesc);
    });

    it('labels the toggle as changing the provider and model', async () => {
        await outline('azure model-based (Claude main)');
        expect(recordedSettings.find(r => r.name === az.firstMode)!.desc).toBe(az.firstModeDesc);
    });
});

describe('Azure controls write the same settings as before', () => {
    const writes: Array<[string, unknown, (s: Record<string, any>) => unknown]> = [
        [az.apiKey, 'NEW-KEY', s => s.azureApiKey],
        [az.aiEndpoint, 'https://a.services.ai.azure.com', s => s.azureAIEndpoint],
        [az.openAIEndpoint, 'https://o.openai.azure.com', s => s.azureOpenAIEndpoint],
        [az.routingMode, 'model-based', s => s.azureRoutingMode],
        [az.claudeViaGateway, true, s => s.azureClaudeViaOpenAIGateway],
        [az.maxConcurrent, '7', s => String(s.azureMaxConcurrentRequests)],
        [az.maxRpm, '90', s => String(s.azureMaxRpm)],
        [en.settings.azureSpeech.region, 'swedencentral', s => s.azureSpeechRegion],
        [en.settings.azureSpeech.endpoint, 'https://r.cognitiveservices.azure.com', s => s.azureSpeechEndpoint],
        [en.settings.azureSpeech.voice, 'en-GB-Voice', s => s.azureSpeechVoice],
        [en.settings.azureSpeech.maxSpeakers, 6, s => s.azureSpeechMaxSpeakers],
        [en.settings.azureSpeech.strictMode, true, s => s.azureSpeechRequired],
        [en.settings.llm.debugMode, true, s => s.debugMode],
    ];
    for (const [name, value, read] of writes) {
        it(name, async () => {
            const { plugin } = await outline('azure deployment-based (OpenAI main)');
            recordedSettings.find(r => r.name === name)!.controls.find(c => c.change)!.change!(value);
            expect(read(plugin.settings as unknown as Record<string, any>)).toBe(value);
        });
    }
});

describe('other layouts', () => {
    it('direct cloud: provider, key and model first, endpoint under Advanced, Azure at the bottom', async () => {
        const { all, advanced, details } = await outline('direct openai');
        const llm = en.settings.llm;
        expect(all.filter(Boolean)).toEqual([
            llm.serviceType, llm.cloudProvider, llm.apiKey, llm.modelName, 'Refresh models from provider',
            llm.connectionTest, en.commands.replaceModelName,
            `# ${az.advanced}`, llm.apiEndpoint, llm.debugMode,
            `# ${az.usingAzureHeading}`, az.firstMode,
        ]);
        expect(details).toHaveLength(1);
        expect(advanced).toContain(llm.apiEndpoint);
    });

    it('an OpenAI-compatible service keeps its endpoint on screen', async () => {
        const { all, advanced } = await outline('direct openai', { cloudServiceType: 'openai-compatible', cloudEndpoint: 'https://x.example/v1' });
        expect(all).toContain(en.settings.llm.apiEndpoint);
        expect(advanced).not.toContain(en.settings.llm.apiEndpoint);
    });

    it('local: no provider and no key', async () => {
        const { all } = await outline('local ollama');
        expect(all).not.toContain(en.settings.llm.cloudProvider);
        expect(all).not.toContain(en.settings.llm.apiKey);
        expect(all).toContain(en.settings.llm.localEndpoint);
    });
});
