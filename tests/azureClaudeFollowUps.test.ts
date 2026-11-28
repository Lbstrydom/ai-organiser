/**
 * Follow-ups to the optional "Claude model" setting: setup import reaches the
 * chat model, and everything that sizes a request reads the model behind a
 * custom Claude deployment.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('obsidian', async () => {
    const mod = await import('./mocks/obsidian');
    return { ...mod, requestUrl: vi.fn() };
});

import { DEFAULT_SETTINGS, type AIOrganiserSettings } from '../src/core/settings';
import { applyAzureConfigImport, buildAzureConfigExport } from '../src/services/azure/azureConfigTransfer';
import { azureCapabilityModel, mainCapabilityModel } from '../src/services/azure/azureModelSync';
import { researchDeepThinkingAvailable } from '../src/services/research/researchOrchestrator';
import { getPdfProviderConfig } from '../src/services/pdfTranslationService';
import { ClaudeWebSearchAdapter } from '../src/services/research/adapters/claudeWebSearchAdapter';

const make = (o: Partial<AIOrganiserSettings> = {}): AIOrganiserSettings => ({ ...structuredClone(DEFAULT_SETTINGS), ...o });
const CLAUDE = { serviceType: 'cloud', cloudServiceType: 'azure-claude', cloudModel: 'team-sonnet' } as const;

describe('Azure setup import — Claude as main provider', () => {
    it('makes the imported Claude deployment the chat model', () => {
        const from = make({ ...CLAUDE, cloudModel: 'shared-claude' });
        const to = make({ ...CLAUDE, cloudModel: 'old-claude' });
        const result = applyAzureConfigImport(to, buildAzureConfigExport(from));
        expect(to.cloudModel).toBe('shared-claude');
        expect(to.taskModels.chat).toBe('shared-claude');
        expect(result.appliedFields).toContain('cloudModel');
    });

    it('applies an older export that only carries the task models', () => {
        const to = make({ ...CLAUDE, cloudModel: 'old-claude' });
        applyAzureConfigImport(to, { taskModels: { chat: 'older-claude' } });
        expect(to.cloudModel).toBe('older-claude');
    });

    it('leaves the chat model alone when Azure OpenAI is main', () => {
        const to = make({ cloudServiceType: 'azure-openai', cloudModel: 'gpt-dep' });
        applyAzureConfigImport(to, buildAzureConfigExport(make({ ...CLAUDE, cloudModel: 'shared-claude', azureGPTModel: 'gpt-dep' })));
        expect(to.cloudModel).toBe('gpt-dep');
        expect(to.taskModels.chat).toBe('shared-claude');
    });

    it('a blank deployment changes nothing', () => {
        const to = make({ ...CLAUDE, cloudModel: 'keep' });
        applyAzureConfigImport(to, { azureClaudeDeployment: ' ', taskModels: { chat: '' } });
        expect(to.cloudModel).toBe('keep');
    });

    it('an exporter on Azure OpenAI shares its Claude task model, not its GPT chat model', () => {
        const from = make({ cloudServiceType: 'azure-openai', cloudModel: 'gpt-dep' });
        expect(buildAzureConfigExport(from).azureClaudeDeployment).toBe(from.taskModels.chat);
    });
});

describe('Azure setup import — Claude model', () => {
    const importer = () => make({ ...CLAUDE, azureClaudeModel: 'claude-opus-5-5' });

    it('a blank Claude model in the export clears the stored one', () => {
        const to = importer();
        applyAzureConfigImport(to, buildAzureConfigExport(make(CLAUDE)));
        expect(to.azureClaudeModel).toBe('');
    });

    it('an older export keeps it while the deployment stays the same', () => {
        const to = importer();
        applyAzureConfigImport(to, { taskModels: { chat: 'team-sonnet' } });
        expect(to.azureClaudeModel).toBe('claude-opus-5-5');
    });

    it('an older export that changes the deployment drops the model that described the old one', () => {
        const to = importer();
        applyAzureConfigImport(to, { taskModels: { chat: 'another-dep' } });
        expect(to.azureClaudeModel).toBe('');
    });
});

describe('the model behind a custom Claude deployment', () => {
    const settings = make({ ...CLAUDE, azureClaudeModel: ' claude-opus-5-5 ' });

    it('describes the main deployment only', () => {
        expect(mainCapabilityModel(settings)).toBe('claude-opus-5-5');
        expect(azureCapabilityModel(settings, 'azure-claude', 'team-sonnet')).toBe('claude-opus-5-5');
        expect(azureCapabilityModel(settings, 'azure-claude', 'fast-dep')).toBeUndefined();
        expect(azureCapabilityModel(settings, 'claude', 'team-sonnet')).toBeUndefined();
    });

    it('is the stored model name when unset or on another provider', () => {
        expect(mainCapabilityModel(make(CLAUDE))).toBe('team-sonnet');
        expect(mainCapabilityModel(make({ cloudServiceType: 'openai', cloudModel: 'gpt-5.5', azureClaudeModel: 'claude-opus-5-5' }))).toBe('gpt-5.5');
    });

    it('decides whether deep thinking is offered for research', () => {
        expect(researchDeepThinkingAvailable(make(CLAUDE))).toBe(false);
        expect(researchDeepThinkingAvailable(settings)).toBe(true);
    });

    it('travels with the PDF provider config', async () => {
        const plugin = {
            settings: { ...settings, azureAIEndpoint: 'https://r.services.ai.azure.com', azureApiKey: 'k' },
            secretStorageService: { isAvailable: () => false, resolveApiKey: async () => 'k' },
        };
        const config = await getPdfProviderConfig(plugin as never);
        expect(config).toMatchObject({ model: 'team-sonnet', capabilityModel: 'claude-opus-5-5' });
    });

    it('decides the web search tool while the deployment is what is sent', () => {
        const build = (capabilityModel?: string) => {
            const adapter = new ClaudeWebSearchAdapter(async () => 'k', {
                model: 'team-sonnet', capabilityModel, useDynamicFiltering: true,
                azureEndpointBase: 'https://r.services.ai.azure.com',
            });
            return (adapter as unknown as {
                buildRequestParts(o?: unknown): Promise<{ body: { model: string; tools: Array<{ type: string }> } }>;
            }).buildRequestParts();
        };
        return Promise.all([build(), build('claude-opus-5-5')]).then(([plain, described]) => {
            expect(plain.body.model).toBe('team-sonnet');
            expect(described.body.model).toBe('team-sonnet');
            expect(plain.body.tools[0].type).not.toBe(described.body.tools[0].type);
        });
    });

    it('no sizing call reads the raw deployment name', () => {
        const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
            const path = join(dir, name);
            return statSync(path).isDirectory() ? files(path) : path.endsWith('.ts') ? [path] : [];
        });
        const sizing = /(getMaxContentCharsForModel|computeSourceBudgetChars|maxStoryboardSlides)\([^;]*\bcloudModel\b/;
        const assigned = /const model = [^;]*\b(settings|this\.plugin\.settings|ctx\.plugin\.settings)\.cloudModel\b/;
        // These two name the model that is SENT, not one a budget is read from.
        const sends = ['azureModelSync.ts', 'pdfTranslationService.ts'];
        const offenders = files('src').filter(path => !sends.some(name => path.endsWith(name))).flatMap((path) => readFileSync(path, 'utf8').split('\n')
            .filter((line) => sizing.test(line) || assigned.test(line))
            .map((line) => `${path}: ${line.trim()}`));
        expect(offenders).toEqual([]);
    });
});
