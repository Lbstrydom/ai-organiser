/**
 * DP-2 backend selector tests: Azure-served if the probe is green, else BYO
 * Cohere-native, else unavailable-with-notice. Probe-needed carries the exact
 * config to probe; `needs-retry` cached results never wedge the selector (CA2).
 */
import { describe, it, expect } from 'vitest';
import { selectVisualBackend, fnv1a64Hex, COHERE_NATIVE_MODEL_ID, shouldAutoEnableVisualSearch } from '../src/services/visualEmbedding/visualBackendResolver';
import { computeProbeIdentity, type VisualProbeResult } from '../src/services/visualEmbedding/azureCohereV4ImageProbe';
import { PLUGIN_SECRET_IDS } from '../src/core/secretIds';

const VALID_AI = 'https://res.services.ai.azure.com';
const IMG_URL = `${VALID_AI}/models/images/embeddings?api-version=2024-05-01-preview`;

interface MockOpts {
    cloudServiceType?: string;
    azureAIEndpoint?: string;
    azureApiKey?: string;
    azureCapabilities?: Record<string, { mode: string; deployment?: string }>;
    secrets?: Record<string, string>;
    azureVisualImageProbe?: VisualProbeResult | null;
    visualEmbeddingDim?: number;
}

function makePlugin(o: MockOpts = {}): any {
    const secrets = o.secrets ?? {};
    return {
        settings: {
            cloudServiceType: o.cloudServiceType ?? 'azure-claude',
            cloudModel: 'claude-sonnet-4-6',
            azureRoutingMode: 'model-based',
            azureAIEndpoint: o.azureAIEndpoint ?? VALID_AI,
            azureOpenAIEndpoint: 'https://res.openai.azure.com',
            azureCapabilities: o.azureCapabilities ?? {},
            azureApiVersionOverride: {},
            azureApiKey: o.azureApiKey ?? '',
            azureVisualImageProbe: o.azureVisualImageProbe ?? null,
            visualEmbeddingDim: o.visualEmbeddingDim ?? 1536,
            providerSettings: {},
        },
        secretStorageService: {
            isAvailable: () => true,
            getSecret: async (id: string) => secrets[id] ?? null,
            getProviderKey: async () => null,
            resolveApiKey: async (opts: { primaryId: string; plainTextFallback?: { primaryKey?: string } }) =>
                secrets[opts.primaryId] ?? opts.plainTextFallback?.primaryKey ?? null,
        },
    };
}

const azureReady = (o: MockOpts = {}): MockOpts => ({
    azureApiKey: 'AZ-KEY',
    azureCapabilities: { 'visual-embeddings': { mode: 'azure', deployment: 'embed-v-4-0' } },
    ...o,
});

/** A cached probe matching the azureReady() config identity. */
function freshProbe(status: 'supported' | 'unsupported'): VisualProbeResult {
    const identityHash = computeProbeIdentity(
        { endpoint: IMG_URL, modelId: 'embed-v-4-0', dim: 1536, apiKey: 'AZ-KEY' },
        fnv1a64Hex,
    );
    return { status, identityHash, checkedAt: 1 };
}

describe('selectVisualBackend — non-Azure main', () => {
    it('with COHERE_VISUAL key → ready cohere-native', async () => {
        const r = await selectVisualBackend(makePlugin({
            cloudServiceType: 'claude',
            secrets: { [PLUGIN_SECRET_IDS.COHERE_VISUAL]: 'co-key' },
        }));
        expect(r.kind).toBe('ready');
        if (r.kind === 'ready') {
            expect(r.cfg.backend).toBe('cohere-native');
            expect(r.cfg.modelId).toBe(COHERE_NATIVE_MODEL_ID);
            expect(r.cfg.apiKey).toBe('co-key');
        }
    });

    it('without key → unavailable(missing-key)', async () => {
        const r = await selectVisualBackend(makePlugin({ cloudServiceType: 'claude' }));
        expect(r).toEqual({ kind: 'unavailable', reason: 'missing-key' });
    });
});

describe('selectVisualBackend — Azure main', () => {
    it('no cached probe → probe-needed with the full azure config', async () => {
        const r = await selectVisualBackend(makePlugin(azureReady()));
        expect(r.kind).toBe('probe-needed');
        if (r.kind === 'probe-needed') {
            expect(r.cfg.backend).toBe('azure-cohere-v4');
            expect(r.cfg.endpoint).toBe(IMG_URL);
            expect(r.cfg.textEndpoint).toContain('/models/embeddings?');
            expect(r.cfg.modelId).toBe('embed-v-4-0');
            expect(r.cfg.apiKey).toBe('AZ-KEY');
        }
    });

    it('fresh supported probe → ready azure', async () => {
        const r = await selectVisualBackend(makePlugin(azureReady({ azureVisualImageProbe: freshProbe('supported') })));
        expect(r.kind).toBe('ready');
        if (r.kind === 'ready') expect(r.cfg.backend).toBe('azure-cohere-v4');
    });

    it('fresh unsupported probe + BYO key → ready cohere-native (fallback)', async () => {
        const r = await selectVisualBackend(makePlugin(azureReady({
            azureVisualImageProbe: freshProbe('unsupported'),
            secrets: { [PLUGIN_SECRET_IDS.COHERE_VISUAL]: 'co-key' },
        })));
        expect(r.kind).toBe('ready');
        if (r.kind === 'ready') expect(r.cfg.backend).toBe('cohere-native');
    });

    it('fresh unsupported probe, no BYO key → azure-unsupported-no-byo', async () => {
        const r = await selectVisualBackend(makePlugin(azureReady({ azureVisualImageProbe: freshProbe('unsupported') })));
        expect(r).toEqual({ kind: 'unavailable', reason: 'azure-unsupported-no-byo' });
    });

    it('stale probe (identity drift after key change) → probe-needed again (G2)', async () => {
        const stale = { ...freshProbe('unsupported'), identityHash: 'stale-id' };
        const r = await selectVisualBackend(makePlugin(azureReady({ azureVisualImageProbe: stale })));
        expect(r.kind).toBe('probe-needed');
    });

    it('capability off → unavailable(off)', async () => {
        const r = await selectVisualBackend(makePlugin(azureReady({
            azureCapabilities: { 'visual-embeddings': { mode: 'off' } },
        })));
        expect(r).toEqual({ kind: 'unavailable', reason: 'off' });
    });

    it('azure intent, no deployment → no-deployment (precise gap, no silent BYO fall-through)', async () => {
        const r = await selectVisualBackend(makePlugin({
            azureApiKey: 'AZ-KEY',
            azureCapabilities: { 'visual-embeddings': { mode: 'azure' } },
        }));
        expect(r).toEqual({ kind: 'unavailable', reason: 'no-deployment' });
    });

    it('azure intent, no key → no-key', async () => {
        const r = await selectVisualBackend(makePlugin({
            azureCapabilities: { 'visual-embeddings': { mode: 'azure', deployment: 'embed-v-4-0' } },
        }));
        expect(r).toEqual({ kind: 'unavailable', reason: 'no-key' });
    });

    it('capability byo + key → ready cohere-native', async () => {
        const r = await selectVisualBackend(makePlugin(azureReady({
            azureCapabilities: { 'visual-embeddings': { mode: 'byo' } },
            secrets: { [PLUGIN_SECRET_IDS.COHERE_VISUAL]: 'co-key' },
        })));
        expect(r.kind).toBe('ready');
        if (r.kind === 'ready') expect(r.cfg.backend).toBe('cohere-native');
    });

    it('auto-enable eligibility: untouched flag → yes; EXPLICIT disable → no; already on → no', () => {
        expect(shouldAutoEnableVisualSearch({})).toBe(true);
        expect(shouldAutoEnableVisualSearch(undefined)).toBe(true);
        expect(shouldAutoEnableVisualSearch({ 'visual-search': false })).toBe(false); // user said no — respected
        expect(shouldAutoEnableVisualSearch({ 'visual-search': true })).toBe(false);  // nothing to do
        expect(shouldAutoEnableVisualSearch({ 'semantic-search': true })).toBe(true); // other flags irrelevant
    });

    it('dim setting flows into the selected config', async () => {
        const r = await selectVisualBackend(makePlugin({
            cloudServiceType: 'claude',
            visualEmbeddingDim: 1024,
            secrets: { [PLUGIN_SECRET_IDS.COHERE_VISUAL]: 'co-key' },
        }));
        if (r.kind === 'ready') expect(r.cfg.dim).toBe(1024);
        expect(r.kind).toBe('ready');
    });
});
