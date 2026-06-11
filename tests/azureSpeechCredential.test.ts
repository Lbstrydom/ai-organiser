import { describe, it, expect } from 'vitest';
import {
    resolveAzureSpeechCredential,
    isAzureSpeechTtsConfigured,
    isAzureSpeechFastTranscriptionConfigured,
} from '../src/services/azure/azureSpeechCredential';
import { PLUGIN_SECRET_IDS } from '../src/core/secretIds';

interface MockOpts {
    azureSpeechRegion?: string;
    azureSpeechEndpoint?: string;
    azureApiKey?: string;
    secrets?: Record<string, string>;
    secretsAvailable?: boolean;
    secretsThrow?: boolean;
}

function makePlugin(o: MockOpts = {}): any {
    const secrets = o.secrets ?? {};
    return {
        settings: {
            cloudServiceType: 'azure-claude',
            azureSpeechRegion: o.azureSpeechRegion ?? '',
            azureSpeechEndpoint: o.azureSpeechEndpoint ?? '',
            azureApiKey: o.azureApiKey ?? '',
        },
        secretStorageService: {
            isAvailable: () => o.secretsAvailable ?? true,
            getSecret: async (id: string) => {
                if (o.secretsThrow) throw new Error('storage exploded');
                return secrets[id] ?? null;
            },
            resolveApiKey: async (opts: { primaryId: string; plainTextFallback?: { primaryKey?: string } }) =>
                secrets[opts.primaryId] ?? opts.plainTextFallback?.primaryKey ?? null,
        },
    };
}

describe('resolveAzureSpeechCredential (plan D9)', () => {
    it('dedicated Speech secret wins over the shared Foundry key', async () => {
        const plugin = makePlugin({
            secrets: {
                [PLUGIN_SECRET_IDS.AZURE_SPEECH]: 'SPEECH-KEY',
                [PLUGIN_SECRET_IDS.AZURE_AI_FOUNDRY]: 'FOUNDRY-KEY',
            },
            azureSpeechRegion: 'swedencentral',
        });
        const r = await resolveAzureSpeechCredential(plugin);
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value.key).toBe('SPEECH-KEY');
    });

    it('falls back to the shared Foundry key when no dedicated secret', async () => {
        const plugin = makePlugin({ secrets: { [PLUGIN_SECRET_IDS.AZURE_AI_FOUNDRY]: 'FOUNDRY-KEY' } });
        const r = await resolveAzureSpeechCredential(plugin);
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value.key).toBe('FOUNDRY-KEY');
    });

    it('falls back to plaintext azureApiKey via the Foundry chain', async () => {
        const plugin = makePlugin({ azureApiKey: 'PLAIN-KEY' });
        const r = await resolveAzureSpeechCredential(plugin);
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value.key).toBe('PLAIN-KEY');
    });

    it('no key anywhere → err(no-key)', async () => {
        const r = await resolveAzureSpeechCredential(makePlugin());
        expect(r).toEqual({ ok: false, error: 'no-key' });
    });

    it('never throws — a throwing secret store degrades to the Foundry chain', async () => {
        const plugin = makePlugin({ secretsThrow: true, azureApiKey: '' });
        // resolveApiKey also consults the throwing store? Our mock resolveApiKey
        // does not throw; the dedicated getSecret throw must be swallowed.
        const r = await resolveAzureSpeechCredential(plugin);
        expect(r.ok).toBe(false);
    });

    it('returns trimmed endpoint + region alongside the key', async () => {
        const plugin = makePlugin({
            azureApiKey: 'K',
            azureSpeechRegion: '  swedencentral  ',
            azureSpeechEndpoint: ' https://res.cognitiveservices.azure.com ',
        });
        const r = await resolveAzureSpeechCredential(plugin);
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.value.region).toBe('swedencentral');
            expect(r.value.endpoint).toBe('https://res.cognitiveservices.azure.com');
        }
    });
});

describe('readiness predicates (plan D10 — separate per op)', () => {
    it('TTS configured = region + key', async () => {
        expect(await isAzureSpeechTtsConfigured(makePlugin({ azureSpeechRegion: 'swedencentral', azureApiKey: 'K' }))).toBe(true);
    });

    it('TTS not configured without region (even with key)', async () => {
        expect(await isAzureSpeechTtsConfigured(makePlugin({ azureApiKey: 'K' }))).toBe(false);
    });

    it('TTS not configured without key (even with region)', async () => {
        expect(await isAzureSpeechTtsConfigured(makePlugin({ azureSpeechRegion: 'swedencentral' }))).toBe(false);
    });

    it('Fast Transcription configured = explicit endpoint + key', async () => {
        expect(await isAzureSpeechFastTranscriptionConfigured(makePlugin({
            azureSpeechEndpoint: 'https://res.cognitiveservices.azure.com', azureApiKey: 'K',
        }))).toBe(true);
    });

    it('Fast Transcription NOT derived from region alone — explicit endpoint required (D10)', async () => {
        expect(await isAzureSpeechFastTranscriptionConfigured(makePlugin({
            azureSpeechRegion: 'swedencentral', azureApiKey: 'K',
        }))).toBe(false);
    });
});
