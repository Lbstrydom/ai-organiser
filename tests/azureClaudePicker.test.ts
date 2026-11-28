// @vitest-environment happy-dom
/**
 * The Azure Claude deployment and "Claude model" pickers come from the model
 * catalog, and a changed deployment never keeps the model of the previous one.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('obsidian', async () => ({
    ...await import('./mocks/obsidian'),
    ...(await import('./helpers/settingsHarness')).settingsObsidianOverrides(),
    requestUrl: vi.fn(),
}));

import { requestUrl } from 'obsidian';
import AIOrganiserPlugin from '../src/main';
import { DEFAULT_SETTINGS, type AIOrganiserSettings } from '../src/core/settings';
import { en } from '../src/i18n/en';
import { getAzureClaudeModels, getAzureModelPresets } from '../src/core/modelCatalog';
import { AZURE_DEFAULT_CLAUDE_MODEL } from '../src/core/azureDefaults';
import { applyAzureClaudeDeployment } from '../src/services/azure/azureModelSync';
import { getPdfProviderConfig } from '../src/services/pdfTranslationService';
import { LLMSettingsSection } from '../src/ui/settings/LLMSettingsSection';
import { disposeAzurePacers } from '../src/services/azure/azureRequestPacer';
import { setupSettingsDom, makeSettingsPlugin, flushRender, recordedSettings } from './helpers/settingsHarness';

const mockRequestUrl = requestUrl as unknown as ReturnType<typeof vi.fn>;
const az = en.settings.llm.azure;
const make = (o: Partial<AIOrganiserSettings> = {}): AIOrganiserSettings => ({ ...structuredClone(DEFAULT_SETTINGS), ...o });
const CLAUDE = {
    serviceType: 'cloud', azureFirstMode: true, cloudServiceType: 'azure-claude', cloudModel: 'team-sonnet',
    azureAIEndpoint: 'https://r.services.ai.azure.com', azureApiKey: 'k',
} as const;

beforeAll(setupSettingsDom);
beforeEach(() => {
    vi.clearAllMocks();
    recordedSettings.length = 0;
    disposeAzurePacers();
    mockRequestUrl.mockResolvedValue({ status: 200, headers: {}, text: '', json: { content: [{ type: 'text', text: 'ok' }] } });
});

async function render(overrides: Record<string, unknown> = {}) {
    const made = await makeSettingsPlugin({ Plugin: AIOrganiserPlugin, defaults: DEFAULT_SETTINGS, t: en }, { ...CLAUDE, ...overrides });
    new LLMSettingsSection(made.plugin as never, document.createElement('div'), { display: vi.fn() } as never).display();
    await flushRender();
    const row = (name: string) => recordedSettings.find(r => r.name === name)!;
    const control = (name: string, kind: string) => row(name).controls.find(c => c.kind === kind)!;
    return { ...made, control };
}

const options = (c: { options?: Array<[string, string]> }) => (c.options ?? []).map(([value]) => value);

describe('catalog', () => {
    it('offers the current Claude models, newest first, including the Azure default', () => {
        const ids = getAzureModelPresets('claude').map(p => p.id);
        expect(ids[0]).toBe(AZURE_DEFAULT_CLAUDE_MODEL);
        expect(ids).toEqual(['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-sonnet-5', 'claude-opus-5']);
    });

    it('knows every Claude model for the "Claude model" field, older ones too', () => {
        const ids = getAzureClaudeModels().map(p => p.id);
        expect(ids).toEqual(expect.arrayContaining([...getAzureModelPresets('claude').map(p => p.id), 'claude-sonnet-4-6', 'claude-opus-4-7']));
        expect(ids.every(id => id.startsWith('claude-'))).toBe(true);
    });
});

describe('Claude deployment picker', () => {
    it('lists the catalog presets, the stored custom name and "Custom"', async () => {
        const { control } = await render();
        expect(options(control(az.defaultModel, 'dropdown')))
            .toEqual([...getAzureModelPresets('claude').map(p => p.id), 'team-sonnet', '__custom__']);
        expect(control(az.defaultModel, 'dropdown').value).toBe('team-sonnet');
    });

    it('a deployment name can still be typed', async () => {
        const { plugin, control } = await render();
        control(az.defaultModel, 'text').change!(' my-claude ');
        expect(plugin.settings.cloudModel).toBe('my-claude');
        expect(plugin.settings.taskModels.chat).toBe('my-claude');
    });

    for (const how of ['text', 'dropdown'] as const) {
        it(`changing it (${how}) drops the Claude model and shows "None"`, async () => {
            const { plugin, control } = await render({ azureClaudeModel: 'claude-opus-5-5' });
            control(az.defaultModel, how).change!(how === 'text' ? 'another-dep' : 'claude-opus-5');
            expect(plugin.settings.azureClaudeModel).toBe('');
            expect(control(az.claudeModel, 'dropdown').value).toBe('');
        });
    }

    it('writing the same deployment keeps the Claude model', () => {
        const settings = make({ cloudServiceType: 'azure-claude', cloudModel: 'dep', azureClaudeModel: 'claude-opus-5-5' });
        applyAzureClaudeDeployment(settings, ' dep ');
        settings.cloudModel = ' dep ';
        applyAzureClaudeDeployment(settings, 'dep');
        expect(settings.azureClaudeModel).toBe('claude-opus-5-5');
    });
});

describe('"Claude model" picker', () => {
    it('is a dropdown of known models plus "None", with no free text', async () => {
        const { control } = await render();
        const dropdown = control(az.claudeModel, 'dropdown');
        expect(options(dropdown)).toEqual(['', ...getAzureClaudeModels().map(p => p.id)]);
        expect(dropdown.options![0][1]).toBe(az.claudeModelNone);
        expect(recordedSettings.find(r => r.name === az.claudeModel)!.controls).toHaveLength(1);
    });

    it('keeps a stored value that is not in the list, unchanged', async () => {
        const { plugin, control } = await render({ azureClaudeModel: 'claude-haiku-4-5' });
        expect(options(control(az.claudeModel, 'dropdown'))).toContain('claude-haiku-4-5');
        expect(control(az.claudeModel, 'dropdown').value).toBe('claude-haiku-4-5');
        expect(plugin.settings.azureClaudeModel).toBe('claude-haiku-4-5');
    });

    it('"None" sends byte-identical requests to a setup that never had the field', async () => {
        const body = async (plugin: AIOrganiserPlugin) => {
            mockRequestUrl.mockClear();
            await (plugin as unknown as { llmService: { summarizeText(t: string): Promise<unknown> } }).llmService.summarizeText('hello');
            return (mockRequestUrl.mock.calls[0][0] as { body: string }).body;
        };
        const plain = await body((await render()).plugin);
        recordedSettings.length = 0;
        const chosen = await render({ azureClaudeModel: 'claude-opus-5-5' });
        expect(await body(chosen.plugin)).not.toBe(plain);
        chosen.control(az.claudeModel, 'dropdown').change!('');
        await chosen.settled();
        expect(await body(chosen.plugin)).toBe(plain);
    });
});

describe('PDF provider in Azure mode', () => {
    const config = (o: Partial<AIOrganiserSettings>) => getPdfProviderConfig({
        settings: make({ azureAIEndpoint: 'https://r.services.ai.azure.com', azureApiKey: 'k', ...o }),
        secretStorageService: { isAvailable: () => false, resolveApiKey: async () => 'k' },
    } as never);

    it('with GPT as main, sends the Claude deployment, never the GPT chat model', async () => {
        const result = await config({
            cloudServiceType: 'azure-openai', cloudModel: 'gpt-5.5', azureClaudeModel: 'claude-opus-5-5',
            taskModels: { ...DEFAULT_SETTINGS.taskModels, chat: 'team-claude' },
        });
        expect(result).toMatchObject({ provider: 'azure-claude', model: 'team-claude' });
        expect(result!.capabilityModel).toBeUndefined();
    });

    it('with Claude as main, sends the main deployment', async () => {
        expect(await config({ cloudServiceType: 'azure-claude', cloudModel: 'team-sonnet' })).toMatchObject({ model: 'team-sonnet' });
    });
});

describe('settings screens name no model themselves', () => {
    const MODEL_ID = /['"`](claude|gpt|gemini|o\d|whisper|text-embedding|deepseek|qwen|llama|mistral|voyage|embed)-[A-Za-z0-9._-]*\d[A-Za-z0-9._-]*['"`]/g;
    /** Older specialist PDF list (direct providers), recorded as a finding; nothing may be added to it. */
    const KNOWN: Record<string, number> = { 'SpecialistProvidersSettingsSection.ts': 9 };
    const dir = join(__dirname, '..', 'src', 'ui', 'settings');

    it('the pattern finds a hard-coded id', () => {
        expect(".addOption('claude-sonnet-5-5', x)".match(MODEL_ID)).toHaveLength(1);
        expect("'latest-sonnet'".match(MODEL_ID)).toBeNull();
    });

    it('no file under ui/settings holds a model id', () => {
        const found: Record<string, number> = {};
        for (const file of readdirSync(dir).filter(f => f.endsWith('.ts'))) {
            const code = readFileSync(join(dir, file), 'utf8').split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
            const hits = code.match(MODEL_ID)?.length ?? 0;
            if (hits) found[file] = hits;
        }
        expect(found).toEqual(KNOWN);
    });
});
