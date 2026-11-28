import { describe, it, expect } from 'vitest';
import { applyAzureGptModel, effectiveAzureGptModel } from '../src/services/azure/azureModelSync';
import { DEFAULT_SETTINGS, type AIOrganiserSettings } from '../src/core/settings';
import { AZURE_DEFAULT_GPT_MODEL } from '../src/core/azureDefaults';

const make = (o: Partial<AIOrganiserSettings>): AIOrganiserSettings => ({ ...DEFAULT_SETTINGS, ...o } as AIOrganiserSettings);

describe('applyAzureGptModel', () => {
    it('writes both values when Azure OpenAI is the main provider', () => {
        const s = make({ cloudServiceType: 'azure-openai', cloudModel: 'a', azureGPTModel: 'a' });
        applyAzureGptModel(s, 'b');
        expect([s.azureGPTModel, s.cloudModel]).toEqual(['b', 'b']);
    });

    it('a blank value (e.g. an imported empty setting) never blanks the chat model', () => {
        const s = make({ cloudServiceType: 'azure-openai', cloudModel: 'keep', azureGPTModel: 'a' });
        applyAzureGptModel(s, '  ');
        expect([s.azureGPTModel, s.cloudModel]).toEqual(['  ', 'keep']);
    });

    it.each(['azure-claude', 'claude', 'openai'] as const)('leaves the chat model alone when main is %s', (type) => {
        const s = make({ cloudServiceType: type, cloudModel: 'keep', azureGPTModel: 'a' });
        applyAzureGptModel(s, 'b');
        expect([s.azureGPTModel, s.cloudModel]).toEqual(['b', 'keep']);
    });
});

describe('effectiveAzureGptModel', () => {
    it('is the chat model when Azure OpenAI is main', () => {
        expect(effectiveAzureGptModel({ cloudServiceType: 'azure-openai', cloudModel: 'chat', azureGPTModel: 'gpt' })).toBe('chat');
    });

    it('falls back to "GPT model" when the chat model is empty', () => {
        expect(effectiveAzureGptModel({ cloudServiceType: 'azure-openai', cloudModel: '', azureGPTModel: 'gpt' })).toBe('gpt');
    });

    it('is "GPT model", else the Azure default, on the other surfaces', () => {
        expect(effectiveAzureGptModel({ cloudServiceType: 'azure-claude', cloudModel: 'c', azureGPTModel: 'gpt' })).toBe('gpt');
        expect(effectiveAzureGptModel({ cloudServiceType: 'azure-claude', azureGPTModel: '' })).toBe(AZURE_DEFAULT_GPT_MODEL);
    });
});
