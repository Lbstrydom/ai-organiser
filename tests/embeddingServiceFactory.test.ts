/**
 * npm-audit-remediation plan, Cluster 4 — the local-onnx consent gate.
 *
 * Covers:
 *  - resolveLocalOnnxEmbeddingService() is the sole enforcement point:
 *    denies when unconsented, constructs when consented.
 *  - classifyEmbeddingAvailability() — the pure classifier shared by the
 *    dispatcher and the settings-UI banner, including the Azure-mode
 *    no-fallback branch (Gemini gate round 3 G2).
 *  - createEmbeddingServiceFromSettings() end-to-end: explicit provider and
 *    auto-fallback paths, both flag directions, no thrown exceptions.
 *  - Concurrent calls never cross-contaminate `unavailableReason` (no
 *    shared module state — Gemini gate round 2 M1).
 */
import { describe, it, expect, vi } from 'vitest';
import {
    resolveLocalOnnxEmbeddingService,
    classifyEmbeddingAvailability,
    createEmbeddingServiceFromSettings,
} from '../src/services/embeddings/embeddingServiceFactory';

/** Minimal settings stub — mirrors the pattern in tests/azureMode.test.ts. */
function makeSettings(overrides: Record<string, unknown> = {}): any {
    return {
        cloudServiceType: 'openai',
        embeddingProvider: 'openai',
        embeddingModel: 'text-embedding-3-small',
        embeddingApiKey: '',
        enableSemanticSearch: true,
        enableLocalOnnxEmbeddings: false,
        providerSettings: {},
        cloudApiKey: '',
        ...overrides,
    };
}

describe('resolveLocalOnnxEmbeddingService — the sole construction point', () => {
    it('denies with a typed reason when not consented', async () => {
        const settings = makeSettings({ enableLocalOnnxEmbeddings: false });
        const result = await resolveLocalOnnxEmbeddingService(settings);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toBe('local-onnx-not-consented');
    });

    it('constructs the service when consented', async () => {
        const settings = makeSettings({ enableLocalOnnxEmbeddings: true });
        const result = await resolveLocalOnnxEmbeddingService(settings);
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.value.getModelName()).toBe('Xenova/all-MiniLM-L6-v2');
        }
    });

    it('never throws — denial is a Result, not an exception', async () => {
        // L3 audit fix: `resolves.not.toThrow()` only proves the promise
        // settled, not that the settled value is the expected typed err(...).
        // Assert the exact shape instead.
        const settings = makeSettings({ enableLocalOnnxEmbeddings: false });
        const result = await resolveLocalOnnxEmbeddingService(settings);
        expect(result).toEqual({ ok: false, error: 'local-onnx-not-consented' });
    });

    it('M1/M8/M16: a failed dynamic import resolves to a typed err(...), never a rejected promise', async () => {
        // The Result<T> boundary must be total — a corrupt/missing optional
        // dependency must surface through the same Result channel as a
        // denied-consent outcome, not escape as an unhandled rejection.
        vi.resetModules();
        vi.doMock('../src/services/embeddings/localOnnxEmbeddingService', () => {
            throw new Error('simulated module load failure');
        });
        try {
            const { resolveLocalOnnxEmbeddingService: freshResolve } = await import(
                '../src/services/embeddings/embeddingServiceFactory'
            );
            const settings = makeSettings({ enableLocalOnnxEmbeddings: true });
            await expect(freshResolve(settings)).resolves.not.toThrow();
            const result = await freshResolve(settings);
            expect(result.ok).toBe(false);
            if (!result.ok) expect(result.error).toBe('local-onnx-load-failed');
        } finally {
            vi.doUnmock('../src/services/embeddings/localOnnxEmbeddingService');
            vi.resetModules();
        }
    });
});

describe('classifyEmbeddingAvailability — pure classifier, shared source of truth', () => {
    it('explicit local-onnx selection, consented → local-onnx', () => {
        expect(classifyEmbeddingAvailability('local-onnx', false, true, false)).toBe('local-onnx');
    });

    it('explicit local-onnx selection, NOT consented → local-onnx-not-consented', () => {
        expect(classifyEmbeddingAvailability('local-onnx', false, false, false)).toBe('local-onnx-not-consented');
    });

    it('cloud provider with a key → cloud', () => {
        expect(classifyEmbeddingAvailability('openai', true, false, false)).toBe('cloud');
    });

    it('cloud provider without a key, not consented for fallback → local-onnx-not-consented', () => {
        expect(classifyEmbeddingAvailability('openai', false, false, false)).toBe('local-onnx-not-consented');
    });

    it('cloud provider without a key, consented for fallback → local-onnx', () => {
        expect(classifyEmbeddingAvailability('openai', false, true, false)).toBe('local-onnx');
    });

    it('ollama (no key required) with no key → cloud (requiresApiKey is false for ollama)', () => {
        expect(classifyEmbeddingAvailability('ollama', false, false, false)).toBe('cloud');
    });

    // Gemini gate round 3 G2: Azure mode NEVER falls back to local-onnx,
    // unconditionally, regardless of the consent flag.
    it('Azure mode with a key → cloud, regardless of consent', () => {
        expect(classifyEmbeddingAvailability('openai', true, false, true)).toBe('cloud');
        expect(classifyEmbeddingAvailability('openai', true, true, true)).toBe('cloud');
    });

    it('Azure mode without a key → credentials-missing, NEVER local-onnx-not-consented', () => {
        expect(classifyEmbeddingAvailability('openai', false, false, true)).toBe('credentials-missing');
        expect(classifyEmbeddingAvailability('openai', false, true, true)).toBe('credentials-missing');
    });

    it('Azure mode + explicit local-onnx provider selection → still governed by Azure branch, not local-onnx branch', () => {
        // isAzureMode short-circuits before the provider check — matches the
        // dispatcher's real branch ordering (useAzure checked before the
        // local-onnx dispatch).
        expect(classifyEmbeddingAvailability('local-onnx', false, true, true)).toBe('credentials-missing');
    });
});

describe('createEmbeddingServiceFromSettings — end to end', () => {
    it('semantic-search feature disabled → unavailable, reason none', async () => {
        // isFeatureEnabled reads settings.featureFlags (FT-11) — the legacy
        // enableSemanticSearch field only matters during one-time migration,
        // not live gating.
        const settings = makeSettings({ featureFlags: { 'semantic-search': false } });
        const { service, unavailableReason } = await createEmbeddingServiceFromSettings(settings);
        expect(service).toBeNull();
        expect(unavailableReason).toBe('none');
    });

    it('cloud provider configured with a key → returns a service', async () => {
        const settings = makeSettings({ embeddingProvider: 'openai', embeddingApiKey: 'sk-test' });
        const { service, unavailableReason } = await createEmbeddingServiceFromSettings(settings);
        expect(service).not.toBeNull();
        expect(unavailableReason).toBe('none');
    });

    it('auto-fallback: cloud provider, no key, flag off → unavailable with local-onnx-not-consented, no throw', async () => {
        const settings = makeSettings({ embeddingProvider: 'openai', embeddingApiKey: '', enableLocalOnnxEmbeddings: false });
        const { service, unavailableReason } = await createEmbeddingServiceFromSettings(settings);
        expect(service).toBeNull();
        expect(unavailableReason).toBe('local-onnx-not-consented');
    });

    it('auto-fallback: cloud provider, no key, flag on → constructs the local-onnx service', async () => {
        const settings = makeSettings({ embeddingProvider: 'openai', embeddingApiKey: '', enableLocalOnnxEmbeddings: true });
        const { service, unavailableReason } = await createEmbeddingServiceFromSettings(settings);
        expect(service).not.toBeNull();
        expect(unavailableReason).toBe('none');
    });

    it('explicit provider: local-onnx, flag off → unavailable, no throw (audit H2 round 2 — closes the crash scenario)', async () => {
        const settings = makeSettings({ embeddingProvider: 'local-onnx', enableLocalOnnxEmbeddings: false });
        await expect(createEmbeddingServiceFromSettings(settings)).resolves.not.toThrow();
        const { service, unavailableReason } = await createEmbeddingServiceFromSettings(settings);
        expect(service).toBeNull();
        expect(unavailableReason).toBe('local-onnx-not-consented');
    });

    it('explicit provider: local-onnx, flag on → constructs the service (same enforcement point as auto-fallback, no special-case)', async () => {
        const settings = makeSettings({ embeddingProvider: 'local-onnx', enableLocalOnnxEmbeddings: true });
        const { service, unavailableReason } = await createEmbeddingServiceFromSettings(settings);
        expect(service).not.toBeNull();
        expect(unavailableReason).toBe('none');
    });

    // Gemini gate round 2 M1: the reason travels WITH the specific call's
    // result, not through shared module state — two concurrent calls with
    // different outcomes must never cross-contaminate each other.
    it('two concurrent calls with different outcomes do not cross-contaminate unavailableReason', async () => {
        const denied = makeSettings({ embeddingProvider: 'local-onnx', enableLocalOnnxEmbeddings: false });
        const allowed = makeSettings({ embeddingProvider: 'local-onnx', enableLocalOnnxEmbeddings: true });

        const [deniedResult, allowedResult] = await Promise.all([
            createEmbeddingServiceFromSettings(denied),
            createEmbeddingServiceFromSettings(allowed),
        ]);

        expect(deniedResult.unavailableReason).toBe('local-onnx-not-consented');
        expect(deniedResult.service).toBeNull();
        expect(allowedResult.unavailableReason).toBe('none');
        expect(allowedResult.service).not.toBeNull();
    });
});
