/**
 * ProviderProfile SSOT (D1) — validity, mode, host extraction, fail-closed
 * Azure error messaging. The keystone HTTP-boundary negative test lives in
 * azureMode.test.ts; this file covers the resolver's value-object correctness.
 */
import { describe, it, expect } from 'vitest';
import { resolveProviderProfile, extractHost } from '../src/services/providerProfile';

const AI_ENDPOINT = 'https://my-resource.services.ai.azure.com';
const OAI_ENDPOINT = 'https://my-resource.openai.azure.com';

/** Minimal plugin stub — SecretStorage unavailable → plain-text key chain. */
function makePlugin(overrides: Record<string, unknown> = {}): any {
    const settings: Record<string, unknown> = {
        serviceType: 'cloud',
        cloudServiceType: 'azure-claude',
        azureApiKey: 'azure-key-123',
        azureAIEndpoint: AI_ENDPOINT,
        azureOpenAIEndpoint: OAI_ENDPOINT,
        azureRoutingMode: 'model-based',
        azureDeployments: {},
        azureApiVersionOverride: {},
        azureGPTModel: 'gpt-5.3-chat',
        cloudModel: 'claude-sonnet-4-6',
        cloudEndpoint: '',
        cloudApiKey: '',
        localEndpoint: 'http://localhost:11434',
        localModel: 'llama3',
        providerSettings: {},
        ...overrides,
    };
    return {
        settings,
        secretStorageService: { isAvailable: () => false },
    };
}

describe('extractHost', () => {
    it('returns host for a valid URL', () => {
        expect(extractHost('https://api.anthropic.com/v1/messages')).toBe('api.anthropic.com');
    });
    it('returns empty string for a malformed URL', () => {
        expect(extractHost('not-a-url/path')).toBe('');
        expect(extractHost('')).toBe('');
    });
});

describe('resolveProviderProfile — Azure', () => {
    it('valid Azure → valid, mode azure, host, no error', async () => {
        const profile = await resolveProviderProfile(makePlugin());
        expect(profile.valid).toBe(true);
        expect(profile.mode).toBe('azure');
        expect(profile.provider).toBe('azure-claude');
        expect(profile.providerLabel).toBe('Claude');
        expect(profile.endpointHost).toBe('my-resource.services.ai.azure.com');
        expect(profile.keySource).toBe('azure-foundry');
        expect(profile.error).toBeUndefined();
    });

    it('missing key → invalid with key-specific error', async () => {
        const profile = await resolveProviderProfile(makePlugin({ azureApiKey: '' }));
        expect(profile.valid).toBe(false);
        expect(profile.error).toMatch(/key/i);
    });

    it('missing endpoint → invalid with endpoint-specific error', async () => {
        const profile = await resolveProviderProfile(makePlugin({ azureAIEndpoint: '' }));
        expect(profile.valid).toBe(false);
        expect(profile.endpointHost).toBe('');
        expect(profile.error).toMatch(/endpoint/i);
    });

    it('missing both → invalid mentioning endpoint and key', async () => {
        const profile = await resolveProviderProfile(makePlugin({ azureApiKey: '', azureAIEndpoint: '' }));
        expect(profile.valid).toBe(false);
        expect(profile.error).toMatch(/endpoint/i);
        expect(profile.error).toMatch(/key/i);
    });

    it('malformed endpoint URL → invalid (host-extraction failure, R1-L1)', async () => {
        const profile = await resolveProviderProfile(makePlugin({ azureAIEndpoint: 'not-a-url' }));
        expect(profile.valid).toBe(false);
        expect(profile.endpointHost).toBe('');
    });

    it('insecure http:// endpoint → invalid (H7 — HTTPS required)', async () => {
        const profile = await resolveProviderProfile(makePlugin({
            azureAIEndpoint: 'http://my-resource.services.ai.azure.com',
        }));
        expect(profile.valid).toBe(false);
    });

    it('whitespace-only key → invalid (M8 — trimmed key check)', async () => {
        const profile = await resolveProviderProfile(makePlugin({ azureApiKey: '   ' }));
        expect(profile.valid).toBe(false);
        expect(profile.error).toMatch(/key/i);
    });
});

describe('resolveProviderProfile — personal / local', () => {
    it('personal cloud with key → valid, mode personal', async () => {
        const profile = await resolveProviderProfile(makePlugin({
            cloudServiceType: 'claude',
            cloudApiKey: 'sk-ant-personal',
        }));
        expect(profile.valid).toBe(true);
        expect(profile.mode).toBe('personal');
        expect(profile.provider).toBe('claude');
        expect(profile.providerLabel).toBe('Claude');
        expect(profile.keySource).toBe('provider');
    });

    it('personal cloud without key → invalid', async () => {
        const profile = await resolveProviderProfile(makePlugin({
            cloudServiceType: 'openai',
            cloudApiKey: '',
            providerSettings: {},
        }));
        expect(profile.valid).toBe(false);
        expect(profile.providerLabel).toBe('OpenAI');
        expect(profile.error).toMatch(/api key/i);
    });

    it('local with endpoint → valid, mode local', async () => {
        const profile = await resolveProviderProfile(makePlugin({ serviceType: 'local' }));
        expect(profile.valid).toBe(true);
        expect(profile.mode).toBe('local');
        expect(profile.provider).toBe('local');
        expect(profile.providerLabel).toBe('Local');
        expect(profile.endpointHost).toBe('localhost:11434');
    });

    it('local without endpoint → invalid', async () => {
        const profile = await resolveProviderProfile(makePlugin({ serviceType: 'local', localEndpoint: '' }));
        expect(profile.valid).toBe(false);
        expect(profile.mode).toBe('local');
    });
});
