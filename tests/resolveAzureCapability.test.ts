import { describe, it, expect } from 'vitest';
import { resolveAzureCapability } from '../src/services/azure/resolveAzureCapability';
import { PLUGIN_SECRET_IDS, STANDARD_SECRET_IDS } from '../src/core/secretIds';

const VALID_AI = 'https://res.services.ai.azure.com';
const VALID_OAI = 'https://res.openai.azure.com';

interface MockOpts {
    cloudServiceType?: string;
    cloudModel?: string;
    azureRoutingMode?: 'model-based' | 'deployment-based';
    azureAIEndpoint?: string;
    azureOpenAIEndpoint?: string;
    azureWhisperDeployment?: string;
    azureDeployments?: { chat?: string; embeddings?: string };
    azureCapabilities?: Record<string, { mode: string; deployment?: string }>;
    embeddingProvider?: string;
    researchProvider?: string;
    azureApiKey?: string;
    secrets?: Record<string, string>;
    providerKeys?: Record<string, string>;
    secretsAvailable?: boolean;
}

function makePlugin(o: MockOpts = {}): any {
    const secrets = o.secrets ?? {};
    const providerKeys = o.providerKeys ?? {};
    const settings = {
        cloudServiceType: o.cloudServiceType ?? 'azure-claude',
        cloudModel: o.cloudModel ?? 'claude-sonnet-4-6',
        azureRoutingMode: o.azureRoutingMode ?? 'model-based',
        azureAIEndpoint: o.azureAIEndpoint ?? VALID_AI,
        azureOpenAIEndpoint: o.azureOpenAIEndpoint ?? VALID_OAI,
        azureWhisperDeployment: o.azureWhisperDeployment ?? 'whisper',
        azureDeployments: o.azureDeployments ?? {},
        azureCapabilities: o.azureCapabilities ?? {},
        azureApiVersionOverride: {},
        embeddingProvider: o.embeddingProvider ?? 'openai',
        researchProvider: o.researchProvider ?? 'claude-web-search',
        azureApiKey: o.azureApiKey ?? '',
        embeddingApiKey: '',
        audioTranscriptionApiKey: '',
        providerSettings: {},
    };
    const secretStorageService = {
        isAvailable: () => o.secretsAvailable ?? true,
        getSecret: async (id: string) => secrets[id] ?? null,
        getProviderKey: async (p: string) => providerKeys[p] ?? null,
        resolveApiKey: async (opts: { primaryId: string; plainTextFallback?: { primaryKey?: string } }) =>
            secrets[opts.primaryId] ?? opts.plainTextFallback?.primaryKey ?? null,
    };
    return { settings, secretStorageService };
}

const withAzureKey = (o: MockOpts = {}): MockOpts => ({ ...o, azureApiKey: 'AZ-KEY' });

describe('resolveAzureCapability', () => {
    it('fail-closed off-Azure: non-azure main provider never gets azure routing (H3)', async () => {
        const r = await resolveAzureCapability(makePlugin(withAzureKey({ cloudServiceType: 'claude' })), 'transcription');
        expect(r).toEqual({ kind: 'unavailable', reason: 'no-azure-path' });
    });

    it('transcription: default azure → kind azure with whisper endpoint', async () => {
        const r = await resolveAzureCapability(makePlugin(withAzureKey()), 'transcription');
        expect(r.kind).toBe('azure');
        if (r.kind === 'azure') {
            expect(r.surface).toBe('azure-openai');
            expect(r.endpoint).toContain('/openai/deployments/whisper/audio/transcriptions');
            expect(r.key).toBe('AZ-KEY');
        }
    });

    it('mode off → unavailable(off)', async () => {
        const r = await resolveAzureCapability(makePlugin(withAzureKey({ azureCapabilities: { transcription: { mode: 'off' } } })), 'transcription');
        expect(r).toEqual({ kind: 'unavailable', reason: 'off' });
    });

    it('azure but no key → unavailable(no-key)', async () => {
        const r = await resolveAzureCapability(makePlugin({ azureApiKey: '' }), 'transcription');
        expect(r).toEqual({ kind: 'unavailable', reason: 'no-key' });
    });

    it('byo with provider key present → kind byo', async () => {
        const r = await resolveAzureCapability(makePlugin({
            azureCapabilities: { transcription: { mode: 'byo' } },
            secrets: { [STANDARD_SECRET_IDS.OPENAI]: 'sk-x' },
        }), 'transcription');
        expect(r).toEqual({ kind: 'byo', byoConfigKind: 'transcription' });
    });

    it('byo with no key → unavailable(no-byo-key)', async () => {
        const r = await resolveAzureCapability(makePlugin({ azureCapabilities: { transcription: { mode: 'byo' } } }), 'transcription');
        expect(r).toEqual({ kind: 'unavailable', reason: 'no-byo-key' });
    });

    it('embeddings model-based azure needs no deployment', async () => {
        const r = await resolveAzureCapability(makePlugin(withAzureKey({ embeddingProvider: 'openai' })), 'embeddings');
        expect(r.kind).toBe('azure');
        if (r.kind === 'azure') expect(r.endpoint).toContain('/openai/v1/embeddings');
    });

    it('embeddings byo local-onnx → byo (no key required)', async () => {
        const r = await resolveAzureCapability(makePlugin({
            embeddingProvider: 'local-onnx',
            azureCapabilities: { embeddings: { mode: 'byo' } },
        }), 'embeddings');
        expect(r).toEqual({ kind: 'byo', byoConfigKind: 'embedding' });
    });

    it('websearch azure-claude main → azure, deployment = cloudModel', async () => {
        const r = await resolveAzureCapability(makePlugin(withAzureKey({ cloudServiceType: 'azure-claude', cloudModel: 'claude-opus-4-6' })), 'websearch');
        expect(r.kind).toBe('azure');
        if (r.kind === 'azure') {
            expect(r.surface).toBe('azure-claude');
            expect(r.deployment).toBe('claude-opus-4-6');
            expect(r.endpoint).toContain('/anthropic/v1/messages');
        }
    });

    it('websearch azure-openai main, blank claude deployment → no-deployment', async () => {
        const r = await resolveAzureCapability(makePlugin(withAzureKey({ cloudServiceType: 'azure-openai', azureCapabilities: { websearch: { mode: 'azure' } } })), 'websearch');
        expect(r).toEqual({ kind: 'unavailable', reason: 'no-deployment' });
    });

    it('websearch azure-openai main, claude deployment set → azure', async () => {
        const r = await resolveAzureCapability(makePlugin(withAzureKey({ cloudServiceType: 'azure-openai', azureCapabilities: { websearch: { mode: 'azure', deployment: 'claude-sonnet' } } })), 'websearch');
        expect(r.kind).toBe('azure');
        if (r.kind === 'azure') expect(r.deployment).toBe('claude-sonnet');
    });

    it('websearch azure but azureAIEndpoint missing → no-endpoint (never throws)', async () => {
        const r = await resolveAzureCapability(makePlugin(withAzureKey({ cloudServiceType: 'azure-claude', azureAIEndpoint: '' })), 'websearch');
        expect(r).toEqual({ kind: 'unavailable', reason: 'no-endpoint' });
    });

    it('youtube (support none) default byo, gemini key present → byo', async () => {
        const r = await resolveAzureCapability(makePlugin({ providerKeys: { gemini: 'g-key' } }), 'youtube');
        expect(r).toEqual({ kind: 'byo', byoConfigKind: 'youtube' });
    });

    it('youtube off → unavailable(off)', async () => {
        const r = await resolveAzureCapability(makePlugin({ azureCapabilities: { youtube: { mode: 'off' } }, providerKeys: { gemini: 'g' } }), 'youtube');
        expect(r).toEqual({ kind: 'unavailable', reason: 'off' });
    });

    it('youtube can never resolve to azure even if mode=azure (no azure path)', async () => {
        const r = await resolveAzureCapability(makePlugin(withAzureKey({ azureCapabilities: { youtube: { mode: 'azure' } } })), 'youtube');
        // support==='none' → coerced to byo intent; no gemini key → no-byo-key
        expect(r).toEqual({ kind: 'unavailable', reason: 'no-byo-key' });
    });

    it('tts byo gemini present → byo (not the llm-enhancement key)', async () => {
        const r = await resolveAzureCapability(makePlugin({ azureCapabilities: { tts: { mode: 'byo' } }, providerKeys: { gemini: 'g' } }), 'tts');
        expect(r).toEqual({ kind: 'byo', byoConfigKind: 'tts' });
    });
});
