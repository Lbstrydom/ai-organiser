/**
 * Probe tests (plan Phase 5, C3 / DP-2 / CA2).
 *
 * CA2: definitive rejections (4xx / wrong shape / wrong dim) → `unsupported` (cacheable);
 * transient failures (429 / 5xx / network / abort) → `needs-retry` (NEVER cached, never
 * fresh) so a startup hiccup can't permanently disable visual search.
 * G2: the probe identity includes the apiKey hash so a corrected credential re-probes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const requestMock = vi.fn();
vi.mock('../src/utils/abortableRequestUrl', () => ({
    abortableRequestUrl: (...args: unknown[]) => requestMock(...args),
}));

import {
    probeAzureCohereV4Image,
    computeProbeIdentity,
    classifyProbeFailure,
    isProbeFresh,
    PROBE_ONE_PX_PNG,
    type VisualProbeResult,
} from '../src/services/visualEmbedding/azureCohereV4ImageProbe';
import { fnv1a64Hex } from '../src/services/visualEmbedding/visualBackendResolver';
import type { CohereV4Config } from '../src/services/visualEmbedding/cohereV4VisualEmbeddingService';

const DIM = 4;
const now = () => 1_000;

function cfg(overrides: Partial<CohereV4Config> = {}): CohereV4Config {
    return {
        backend: 'azure-cohere-v4',
        endpoint: 'https://res.services.ai.azure.com/models/images/embeddings?api-version=2024-05-01-preview',
        textEndpoint: 'https://res.services.ai.azure.com/models/embeddings?api-version=2024-05-01-preview',
        apiKey: 'az-key',
        modelId: 'embed-v-4-0',
        dim: DIM,
        ...overrides,
    };
}

beforeEach(() => { requestMock.mockReset(); });

describe('classifyProbeFailure (CA2)', () => {
    it.each([
        ['rate-limited', 'needs-retry'],
        ['aborted', 'needs-retry'],
        ['network: ECONNREFUSED', 'needs-retry'],
        ['http-500', 'needs-retry'],
        ['http-503', 'needs-retry'],
        ['http-400', 'unsupported'],
        ['http-401: unauthorized', 'unsupported'],
        ['http-403: unauthorized', 'unsupported'],
        ['http-404', 'unsupported'],
        ['http-422', 'unsupported'],
        ['dim-mismatch', 'unsupported'],
        ['count-mismatch', 'unsupported'],
        ['parse-failed', 'unsupported'],
        ['endpoint-missing', 'unsupported'],
    ])('%s → %s', (error, expected) => {
        expect(classifyProbeFailure(error)).toBe(expected);
    });
});

describe('probeAzureCohereV4Image', () => {
    it('green: dim-length vector → supported', async () => {
        requestMock.mockResolvedValue({ status: 200, json: { data: [{ index: 0, embedding: [1, 2, 3, 4] }] } });
        const r = await probeAzureCohereV4Image(cfg(), fnv1a64Hex, now);
        expect(r.status).toBe('supported');
        expect(r.checkedAt).toBe(1_000);
        // The probe sends the minimal 1×1 PNG payload.
        const body = JSON.parse((requestMock.mock.calls[0][0] as { body: string }).body);
        expect(body.input[0].image).toBe(PROBE_ONE_PX_PNG);
    });

    it('definitive 401 → unsupported with reason', async () => {
        requestMock.mockResolvedValue({ status: 401, json: {} });
        const r = await probeAzureCohereV4Image(cfg(), fnv1a64Hex, now);
        expect(r.status).toBe('unsupported');
        expect(r.reason).toBe('http-401: unauthorized');
    });

    it('transient 503 → needs-retry (NOT a definitive rejection)', async () => {
        requestMock.mockResolvedValue({ status: 503, json: {} });
        const r = await probeAzureCohereV4Image(cfg(), fnv1a64Hex, now);
        expect(r.status).toBe('needs-retry');
    });

    it('network throw → needs-retry, never throws', async () => {
        requestMock.mockRejectedValue(new Error('DNS fail'));
        const r = await probeAzureCohereV4Image(cfg(), fnv1a64Hex, now);
        expect(r.status).toBe('needs-retry');
        expect(r.reason).toBe('network: DNS fail');
    });

    it('wrong dim on a 200 → unsupported(dim-mismatch)', async () => {
        requestMock.mockResolvedValue({ status: 200, json: { data: [{ index: 0, embedding: [1, 2] }] } });
        const r = await probeAzureCohereV4Image(cfg(), fnv1a64Hex, now);
        expect(r.status).toBe('unsupported');
        expect(r.reason).toBe('dim-mismatch');
    });
});

describe('probe identity + freshness (C3/G2)', () => {
    it('identity changes when the apiKey changes (G2 — corrected key re-probes)', () => {
        const a = computeProbeIdentity(cfg(), fnv1a64Hex);
        const b = computeProbeIdentity(cfg({ apiKey: 'corrected-key' }), fnv1a64Hex);
        expect(a).not.toBe(b);
    });

    it('identity changes when endpoint host / model / dim change', () => {
        const base = computeProbeIdentity(cfg(), fnv1a64Hex);
        expect(computeProbeIdentity(cfg({ endpoint: 'https://other.services.ai.azure.com/models/images/embeddings' }), fnv1a64Hex)).not.toBe(base);
        expect(computeProbeIdentity(cfg({ modelId: 'embed-v-5' }), fnv1a64Hex)).not.toBe(base);
        expect(computeProbeIdentity(cfg({ dim: 1024 }), fnv1a64Hex)).not.toBe(base);
    });

    it('a fresh supported/unsupported result is fresh; identity drift is stale', () => {
        const id = computeProbeIdentity(cfg(), fnv1a64Hex);
        const cached: VisualProbeResult = { status: 'supported', identityHash: id, checkedAt: 1 };
        expect(isProbeFresh(cached, cfg(), fnv1a64Hex)).toBe(true);
        expect(isProbeFresh(cached, cfg({ apiKey: 'new' }), fnv1a64Hex)).toBe(false);
        expect(isProbeFresh(undefined, cfg(), fnv1a64Hex)).toBe(false);
        expect(isProbeFresh(null, cfg(), fnv1a64Hex)).toBe(false);
    });

    it('a needs-retry result is NEVER fresh (CA2)', () => {
        const id = computeProbeIdentity(cfg(), fnv1a64Hex);
        const cached: VisualProbeResult = { status: 'needs-retry', identityHash: id, checkedAt: 1 };
        expect(isProbeFresh(cached, cfg(), fnv1a64Hex)).toBe(false);
    });
});

describe('fnv1a64Hex', () => {
    it('is deterministic and 16 hex chars', () => {
        expect(fnv1a64Hex('abc')).toBe(fnv1a64Hex('abc'));
        expect(fnv1a64Hex('abc')).toMatch(/^[0-9a-f]{16}$/);
        expect(fnv1a64Hex('abc')).not.toBe(fnv1a64Hex('abd'));
    });
});
