import { describe, it, expect } from 'vitest';
import { buildAzureConfigExport, applyAzureConfigImport } from '../src/services/azure/azureConfigTransfer';
import { DEFAULT_SETTINGS, type AIOrganiserSettings } from '../src/core/settings';

function makeSettings(overrides: Partial<AIOrganiserSettings> = {}): AIOrganiserSettings {
    return { ...DEFAULT_SETTINGS, ...overrides } as AIOrganiserSettings;
}

describe('buildAzureConfigExport', () => {
    it('never includes the API key or any secret-shaped field', () => {
        const settings = makeSettings({ azureApiKey: 'super-secret-key' });
        const json = JSON.stringify(buildAzureConfigExport(settings));
        expect(json).not.toContain('super-secret-key');
        expect(json).not.toContain('azureApiKey');
    });

    it('includes the fields a team actually needs to sync', () => {
        const settings = makeSettings({
            azureAIEndpoint: 'https://foo.services.ai.azure.com',
            azureOpenAIEndpoint: 'https://foo.azure-api.net/foundry',
            azureRoutingMode: 'deployment-based',
            azureDeployments: { chat: 'gpt-5.6-terra', embeddings: 'text-embedding-3-large' },
            azureClaudeViaOpenAIGateway: true,
            azurePerDeploymentRpm: { 'gpt-5.6-terra': 250 },
        });
        const exported = buildAzureConfigExport(settings);
        expect(exported.schemaVersion).toBe(1);
        expect(exported.azureAIEndpoint).toBe('https://foo.services.ai.azure.com');
        expect(exported.azureDeployments).toEqual({ chat: 'gpt-5.6-terra', embeddings: 'text-embedding-3-large' });
        expect(exported.azureClaudeViaOpenAIGateway).toBe(true);
        expect(exported.azurePerDeploymentRpm).toEqual({ 'gpt-5.6-terra': 250 });
    });
});

describe('applyAzureConfigImport', () => {
    it('applies well-typed fields and reports which ones', () => {
        const settings = makeSettings();
        const result = applyAzureConfigImport(settings, {
            azureAIEndpoint: 'https://new.services.ai.azure.com',
            azureRoutingMode: 'deployment-based',
            azureDeployments: { chat: 'gpt-5.6-terra' },
            azureClaudeViaOpenAIGateway: true,
        });
        expect(result.ok).toBe(true);
        expect(result.appliedFields).toContain('azureAIEndpoint');
        expect(result.appliedFields).toContain('azureRoutingMode');
        expect(result.appliedFields).toContain('azureDeployments');
        expect(settings.azureAIEndpoint).toBe('https://new.services.ai.azure.com');
        expect(settings.azureRoutingMode).toBe('deployment-based');
        expect(settings.azureDeployments?.chat).toBe('gpt-5.6-terra');
        expect(settings.azureClaudeViaOpenAIGateway).toBe(true);
    });

    it('rejects a non-object payload without throwing', () => {
        const settings = makeSettings();
        const result = applyAzureConfigImport(settings, 'not an object');
        expect(result.ok).toBe(false);
        expect(result.error).toBeTruthy();
    });

    it('skips malformed fields instead of applying garbage or throwing', () => {
        const settings = makeSettings({ azureMaxRpm: 60 });
        const result = applyAzureConfigImport(settings, {
            azureRoutingMode: 'not-a-real-mode',
            azureMaxRpm: 'sixty', // wrong type — must be skipped, not coerced
            azureAIEndpoint: 'https://valid.services.ai.azure.com', // this one is fine
        });
        expect(result.ok).toBe(true);
        expect(result.appliedFields).not.toContain('azureRoutingMode');
        expect(result.appliedFields).not.toContain('azureMaxRpm');
        expect(settings.azureMaxRpm).toBe(60); // unchanged
        expect(settings.azureAIEndpoint).toBe('https://valid.services.ai.azure.com');
    });

    it('never applies an azureApiKey field even if present in the payload (defense in depth)', () => {
        const settings = makeSettings({ azureApiKey: 'original' });
        applyAzureConfigImport(settings, { azureApiKey: 'injected-from-import' });
        expect(settings.azureApiKey).toBe('original');
    });

    it('an empty/unrecognized payload applies nothing and reports not-ok', () => {
        const settings = makeSettings();
        const result = applyAzureConfigImport(settings, { someRandomField: 'x' });
        expect(result.ok).toBe(false);
        expect(result.appliedFields).toEqual([]);
    });

    it('round-trips export -> import cleanly', () => {
        const source = makeSettings({
            azureAIEndpoint: 'https://a.services.ai.azure.com',
            azureOpenAIEndpoint: 'https://a.azure-api.net/foundry',
            azureRoutingMode: 'deployment-based',
            azureDeployments: { chat: 'gpt-5.6-terra', embeddings: 'text-embedding-3-large' },
            azurePerDeploymentRpm: { 'gpt-5.6-terra': 250, 'claude-sonnet-5': 501 },
            azureSpeechRegion: 'swedencentral',
        });
        const exported = buildAzureConfigExport(source);
        const target = makeSettings();
        const result = applyAzureConfigImport(target, JSON.parse(JSON.stringify(exported)));
        expect(result.ok).toBe(true);
        expect(target.azureAIEndpoint).toBe(source.azureAIEndpoint);
        expect(target.azureDeployments).toEqual(source.azureDeployments);
        expect(target.azurePerDeploymentRpm).toMatchObject(source.azurePerDeploymentRpm);
        expect(target.azureSpeechRegion).toBe(source.azureSpeechRegion);
    });
});
