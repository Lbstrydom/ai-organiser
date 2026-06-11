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
    // azure-speech surface (azure-audio-adapters plan)
    azureSpeechRegion?: string;
    azureSpeechEndpoint?: string;
    azureSpeechVoice?: string;
    azureSpeechRequired?: boolean;
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
        // azure-speech surface (azure-audio-adapters plan)
        azureSpeechRegion: o.azureSpeechRegion ?? '',
        azureSpeechEndpoint: o.azureSpeechEndpoint ?? '',
        azureSpeechVoice: o.azureSpeechVoice ?? '',
        azureSpeechRequired: o.azureSpeechRequired ?? false,
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

    // ── visual-embeddings (azure-capability-completion-v2 Phase 5) ────────────

    it('visual-embeddings: azure mode + deployment → azure with Foundry image endpoint', async () => {
        const r = await resolveAzureCapability(makePlugin(withAzureKey({
            azureCapabilities: { 'visual-embeddings': { mode: 'azure', deployment: 'embed-v-4-0' } },
        })), 'visual-embeddings');
        expect(r.kind).toBe('azure');
        if (r.kind === 'azure') {
            expect(r.surface).toBe('azure-claude');
            expect(r.deployment).toBe('embed-v-4-0');
            expect(r.endpoint).toBe(`${VALID_AI}/models/images/embeddings?api-version=2024-05-01-preview`);
            expect(r.key).toBe('AZ-KEY');
        }
    });

    it('visual-embeddings: deployment ALWAYS required — even in model-based routing', async () => {
        const r = await resolveAzureCapability(makePlugin(withAzureKey({
            azureRoutingMode: 'model-based',
            azureCapabilities: { 'visual-embeddings': { mode: 'azure' } },
        })), 'visual-embeddings');
        expect(r).toEqual({ kind: 'unavailable', reason: 'no-deployment' });
    });

    it('visual-embeddings byo: TEXT embedding config does NOT satisfy (G2 consent isolation)', async () => {
        const r = await resolveAzureCapability(makePlugin(withAzureKey({
            azureCapabilities: { 'visual-embeddings': { mode: 'byo' } },
            // Fully-configured TEXT lane: provider key + dedicated embedding secret + plaintext.
            embeddingProvider: 'openai',
            providerKeys: { openai: 'oa-key' },
            secrets: { [PLUGIN_SECRET_IDS.EMBEDDING]: 'text-emb-key', [STANDARD_SECRET_IDS.OPENAI]: 'oa' },
        })), 'visual-embeddings');
        expect(r).toEqual({ kind: 'unavailable', reason: 'no-byo-key' });
    });

    it('visual-embeddings byo: ONLY the dedicated COHERE_VISUAL secret satisfies (C22)', async () => {
        const r = await resolveAzureCapability(makePlugin(withAzureKey({
            azureCapabilities: { 'visual-embeddings': { mode: 'byo' } },
            secrets: { [PLUGIN_SECRET_IDS.COHERE_VISUAL]: 'co-visual-key' },
        })), 'visual-embeddings');
        expect(r).toEqual({ kind: 'byo', byoConfigKind: 'visual-embedding' });
    });

    it('visual-embeddings off → unavailable(off)', async () => {
        const r = await resolveAzureCapability(makePlugin(withAzureKey({
            azureCapabilities: { 'visual-embeddings': { mode: 'off' } },
        })), 'visual-embeddings');
        expect(r).toEqual({ kind: 'unavailable', reason: 'off' });
    });

    it('visual-embeddings azure with bad azureAIEndpoint → no-endpoint (never throws)', async () => {
        const r = await resolveAzureCapability(makePlugin(withAzureKey({
            azureAIEndpoint: 'http://insecure.example.com',
            azureCapabilities: { 'visual-embeddings': { mode: 'azure', deployment: 'embed-v-4-0' } },
        })), 'visual-embeddings');
        expect(r).toEqual({ kind: 'unavailable', reason: 'no-endpoint' });
    });
});

// ── azure-speech surface (azure-audio-adapters plan D3/D10/D11) ─────────────

const SPEECH_EP = 'https://res.cognitiveservices.azure.com';

/** Alias retained for readability in the speech describes — makePlugin now
 *  copies the speech fields itself. */
const makeSpeechPlugin = makePlugin;

const speechConfigured = {
    azureSpeechRegion: 'swedencentral',
    azureSpeechEndpoint: SPEECH_EP,
    azureSpeechVoice: 'en-US-AvaNeural',
};

describe('resolveAzureCapability — azure-speech (strict OFF, default)', () => {
    it('tts: speech configured + mode azure → azure-speech with regional TTS endpoint', async () => {
        const r = await resolveAzureCapability(makeSpeechPlugin(withAzureKey({
            azureCapabilities: { tts: { mode: 'azure' } }, ...speechConfigured,
        }) as any), 'tts');
        expect(r.kind).toBe('azure');
        if (r.kind === 'azure') {
            expect(r.surface).toBe('azure-speech');
            expect(r.deployment).toBe('');
            expect(r.endpoint).toBe('https://swedencentral.tts.speech.microsoft.com/cognitiveservices/v1');
            expect(r.key).toBe('AZ-KEY');
        }
    });

    it('transcription: speech configured + mode azure → azure-speech with :transcribe endpoint', async () => {
        const r = await resolveAzureCapability(makeSpeechPlugin(withAzureKey({
            azureCapabilities: { transcription: { mode: 'azure' } }, ...speechConfigured,
        }) as any), 'transcription');
        expect(r.kind).toBe('azure');
        if (r.kind === 'azure') {
            expect(r.surface).toBe('azure-speech');
            expect(r.endpoint).toBe(`${SPEECH_EP}/speechtotext/transcriptions:transcribe?api-version=2025-10-15`);
        }
    });

    it('speech NOT configured → legacy azure-openai whisper (backward compat, byte-identical)', async () => {
        const r = await resolveAzureCapability(makeSpeechPlugin(withAzureKey()) as any, 'transcription');
        expect(r.kind).toBe('azure');
        if (r.kind === 'azure') {
            expect(r.surface).toBe('azure-openai');
            expect(r.endpoint).toContain('/openai/deployments/whisper/audio/transcriptions');
        }
    });

    it('tts: region+key but NO voice → falls through to legacy (strict off, no-voice not terminal)', async () => {
        const r = await resolveAzureCapability(makeSpeechPlugin(withAzureKey({
            azureCapabilities: { tts: { mode: 'azure' } },
            azureSpeechRegion: 'swedencentral', azureSpeechEndpoint: SPEECH_EP,
        }) as any), 'tts');
        // Voice missing → speech unavailable → legacy azure-openai /audio/speech path.
        expect(r.kind).toBe('azure');
        if (r.kind === 'azure') expect(r.surface).toBe('azure-openai');
    });

    it('byo choice is respected when strict is off (speech configured does not override)', async () => {
        const r = await resolveAzureCapability(makeSpeechPlugin(withAzureKey({
            azureCapabilities: { tts: { mode: 'byo' } },
            providerKeys: { gemini: 'g' },
            ...speechConfigured,
        }) as any), 'tts');
        expect(r).toEqual({ kind: 'byo', byoConfigKind: 'tts' });
    });
});

describe('resolveAzureCapability — azure-speech STRICT mode (D3 fail-closed keystone)', () => {
    it('strict + speech configured → azure-speech', async () => {
        const r = await resolveAzureCapability(makeSpeechPlugin(withAzureKey({
            ...speechConfigured, azureSpeechRequired: true,
        }) as any), 'transcription');
        expect(r.kind).toBe('azure');
        if (r.kind === 'azure') expect(r.surface).toBe('azure-speech');
    });

    it('strict + speech unconfigured → unavailable, NEVER the legacy Global-Standard path (H2)', async () => {
        const r = await resolveAzureCapability(makeSpeechPlugin(withAzureKey({
            azureSpeechRequired: true,
        }) as any), 'transcription');
        expect(r).toEqual({ kind: 'unavailable', reason: 'no-endpoint' });
    });

    it('strict tts reasons surface in order: no-region → no-voice → no-key', async () => {
        const noRegion = await resolveAzureCapability(makeSpeechPlugin(withAzureKey({
            azureSpeechRequired: true,
        }) as any), 'tts');
        expect(noRegion).toEqual({ kind: 'unavailable', reason: 'no-region' });

        const noVoice = await resolveAzureCapability(makeSpeechPlugin(withAzureKey({
            azureSpeechRequired: true, azureSpeechRegion: 'swedencentral',
        }) as any), 'tts');
        expect(noVoice).toEqual({ kind: 'unavailable', reason: 'no-voice' });

        const noKey = await resolveAzureCapability(makeSpeechPlugin({
            azureSpeechRequired: true, azureSpeechRegion: 'swedencentral', azureSpeechVoice: 'en-US-AvaNeural',
        }) as any, 'tts');
        expect(noKey).toEqual({ kind: 'unavailable', reason: 'no-key' });
    });

    it('strict overrides a stale byo choice — azure-speech, not byo (D3: speech ONLY)', async () => {
        const r = await resolveAzureCapability(makeSpeechPlugin(withAzureKey({
            azureCapabilities: { tts: { mode: 'byo' } },
            providerKeys: { gemini: 'g' },
            ...speechConfigured, azureSpeechRequired: true,
        }) as any), 'tts');
        expect(r.kind).toBe('azure');
        if (r.kind === 'azure') expect(r.surface).toBe('azure-speech');
    });

    it('strict + mode off stays off (a deliberate off is compliant)', async () => {
        const r = await resolveAzureCapability(makeSpeechPlugin(withAzureKey({
            azureCapabilities: { tts: { mode: 'off' } },
            ...speechConfigured, azureSpeechRequired: true,
        }) as any), 'tts');
        expect(r).toEqual({ kind: 'unavailable', reason: 'off' });
    });

    it('strict only affects audio capabilities — embeddings unchanged', async () => {
        const r = await resolveAzureCapability(makeSpeechPlugin(withAzureKey({
            azureSpeechRequired: true, embeddingProvider: 'openai',
        }) as any), 'embeddings');
        expect(r.kind).toBe('azure');
        if (r.kind === 'azure') expect(r.surface).toBe('azure-openai');
    });

    it('dedicated Speech secret is used for the azure-speech key when present', async () => {
        const r = await resolveAzureCapability(makeSpeechPlugin({
            ...speechConfigured, azureSpeechRequired: true,
            secrets: { [PLUGIN_SECRET_IDS.AZURE_SPEECH]: 'SPEECH-KEY' },
        } as any) as any, 'tts');
        expect(r.kind).toBe('azure');
        if (r.kind === 'azure') expect(r.key).toBe('SPEECH-KEY');
    });
});
