/**
 * Cohere v4 visual embedding service tests (plan Phase 5, C1/C2).
 *
 * Verifies BOTH wire shapes: Cohere-native v2 (`inputs:[{content}]` →
 * `{embeddings:{float}}`) and Azure Foundry inference (`{model, input:[{image}]}` →
 * `{data:[{index, embedding}]}`), plus the dim/count guards and error taxonomy
 * the probe's CA2 classification depends on.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const requestMock = vi.fn();
vi.mock('../src/utils/abortableRequestUrl', () => ({
    abortableRequestUrl: (...args: unknown[]) => requestMock(...args),
}));

import { CohereV4VisualEmbeddingService, type CohereV4Config } from '../src/services/visualEmbedding/cohereV4VisualEmbeddingService';
import { VISUAL_EMBED_BATCH_SIZE } from '../src/services/visualEmbedding/types';

const DIM = 4;
const vec = (fill = 0.5) => new Array(DIM).fill(fill);

function nativeCfg(overrides: Partial<CohereV4Config> = {}): CohereV4Config {
    return { backend: 'cohere-native', apiKey: 'co-key', modelId: 'embed-v4.0', dim: DIM, ...overrides };
}

function azureCfg(overrides: Partial<CohereV4Config> = {}): CohereV4Config {
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

const nativeOk = (count: number) => ({ status: 200, json: { embeddings: { float: new Array(count).fill(0).map(() => vec()) } } });
const foundryOk = (count: number) => ({ status: 200, json: { data: new Array(count).fill(0).map((_, i) => ({ index: i, embedding: vec() })) } });

beforeEach(() => { requestMock.mockReset(); });

describe('native backend (Cohere v2 shape)', () => {
    it('embedImages sends the v2 body with search_document + output_dimension', async () => {
        requestMock.mockResolvedValue(nativeOk(2));
        const svc = new CohereV4VisualEmbeddingService(nativeCfg());
        const r = await svc.embedImages([{ dataUrl: 'data:image/png;base64,AA' }, { dataUrl: 'data:image/png;base64,BB' }]);
        expect(r.ok).toBe(true);
        const [params] = requestMock.mock.calls[0] as [{ url: string; headers: Record<string, string>; body: string }];
        expect(params.url).toBe('https://api.cohere.com/v2/embed');
        expect(params.headers['Authorization']).toBe('Bearer co-key');
        const body = JSON.parse(params.body);
        expect(body.input_type).toBe('search_document');
        expect(body.output_dimension).toBe(DIM);
        expect(body.embedding_types).toEqual(['float']);
        expect(body.inputs).toHaveLength(2);
        expect(body.inputs[0].content[0].type).toBe('image_url');
    });

    it('embedTextQueries uses search_query in the SAME space (C1)', async () => {
        requestMock.mockResolvedValue(nativeOk(1));
        const svc = new CohereV4VisualEmbeddingService(nativeCfg());
        const r = await svc.embedTextQueries(['charts about revenue']);
        expect(r.ok).toBe(true);
        const body = JSON.parse((requestMock.mock.calls[0][0] as { body: string }).body);
        expect(body.input_type).toBe('search_query');
        expect(body.inputs[0].content[0]).toEqual({ type: 'text', text: 'charts about revenue' });
    });

    it('batches above VISUAL_EMBED_BATCH_SIZE into multiple requests, row-aligned', async () => {
        const n = VISUAL_EMBED_BATCH_SIZE + 3;
        requestMock
            .mockResolvedValueOnce(nativeOk(VISUAL_EMBED_BATCH_SIZE))
            .mockResolvedValueOnce(nativeOk(3));
        const svc = new CohereV4VisualEmbeddingService(nativeCfg());
        const r = await svc.embedImages(new Array(n).fill({ dataUrl: 'data:image/png;base64,AA' }));
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value.vectors).toHaveLength(n);
        expect(requestMock).toHaveBeenCalledTimes(2);
    });

    it('dim mismatch → err(dim-mismatch)', async () => {
        requestMock.mockResolvedValue({ status: 200, json: { embeddings: { float: [[0.1, 0.2]] } } });
        const r = await new CohereV4VisualEmbeddingService(nativeCfg()).embedImages([{ dataUrl: 'x' }]);
        expect(r).toEqual({ ok: false, error: 'dim-mismatch' });
    });

    it('row count mismatch → err(count-mismatch)', async () => {
        requestMock.mockResolvedValue(nativeOk(1));
        const r = await new CohereV4VisualEmbeddingService(nativeCfg()).embedImages([{ dataUrl: 'a' }, { dataUrl: 'b' }]);
        expect(r).toEqual({ ok: false, error: 'count-mismatch' });
    });

    it('empty input short-circuits with no HTTP call', async () => {
        const r = await new CohereV4VisualEmbeddingService(nativeCfg()).embedImages([]);
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value.vectors).toEqual([]);
        expect(requestMock).not.toHaveBeenCalled();
    });
});

describe('azure backend (Foundry inference shape)', () => {
    it('embedImages sends ONE image per request with the Foundry body + api-key header', async () => {
        requestMock.mockResolvedValue(foundryOk(1));
        const svc = new CohereV4VisualEmbeddingService(azureCfg());
        const r = await svc.embedImages([{ dataUrl: 'data:image/png;base64,AA' }, { dataUrl: 'data:image/png;base64,BB' }]);
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value.vectors).toHaveLength(2);
        expect(requestMock).toHaveBeenCalledTimes(2);
        const [params] = requestMock.mock.calls[0] as [{ url: string; headers: Record<string, string>; body: string }];
        expect(params.url).toContain('/models/images/embeddings');
        expect(params.headers['api-key']).toBe('az-key');
        expect(params.headers['Authorization']).toBeUndefined();
        const body = JSON.parse(params.body);
        expect(body).toEqual({
            model: 'embed-v-4-0',
            input: [{ image: 'data:image/png;base64,AA' }],
            input_type: 'document',
        });
    });

    it('embedTextQueries posts string batches to the TEXT endpoint with input_type query', async () => {
        requestMock.mockResolvedValue(foundryOk(2));
        const svc = new CohereV4VisualEmbeddingService(azureCfg());
        const r = await svc.embedTextQueries(['q1', 'q2']);
        expect(r.ok).toBe(true);
        const [params] = requestMock.mock.calls[0] as [{ url: string; body: string }];
        expect(params.url).toContain('/models/embeddings?');
        const body = JSON.parse(params.body);
        expect(body).toEqual({ model: 'embed-v-4-0', input: ['q1', 'q2'], input_type: 'query' });
    });

    it('sorts response rows by declared index (not positional)', async () => {
        requestMock.mockResolvedValue({
            status: 200,
            json: { data: [{ index: 1, embedding: vec(0.9) }, { index: 0, embedding: vec(0.1) }] },
        });
        const r = await new CohereV4VisualEmbeddingService(azureCfg()).embedTextQueries(['a', 'b']);
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.value.vectors[0][0]).toBe(0.1);
            expect(r.value.vectors[1][0]).toBe(0.9);
        }
    });

    it('rejects an invalid index set — duplicate index would mis-align rows (H13/H22)', async () => {
        requestMock.mockResolvedValue({
            status: 200,
            json: { data: [{ index: 0, embedding: vec(0.1) }, { index: 0, embedding: vec(0.9) }] },
        });
        const r = await new CohereV4VisualEmbeddingService(azureCfg()).embedTextQueries(['a', 'b']);
        expect(r).toEqual({ ok: false, error: 'parse-failed' });
    });

    it('rejects out-of-range and fractional indexes (H13/H22)', async () => {
        requestMock.mockResolvedValue({ status: 200, json: { data: [{ index: 5, embedding: vec() }] } });
        const r1 = await new CohereV4VisualEmbeddingService(azureCfg()).embedTextQueries(['a']);
        expect(r1).toEqual({ ok: false, error: 'parse-failed' });
        requestMock.mockResolvedValue({ status: 200, json: { data: [{ index: 0.5, embedding: vec() }] } });
        const r2 = await new CohereV4VisualEmbeddingService(azureCfg()).embedTextQueries(['a']);
        expect(r2).toEqual({ ok: false, error: 'parse-failed' });
    });

    it('missing images endpoint → err(endpoint-missing)', async () => {
        const r = await new CohereV4VisualEmbeddingService(azureCfg({ endpoint: '' })).embedImages([{ dataUrl: 'x' }]);
        expect(r).toEqual({ ok: false, error: 'endpoint-missing' });
    });

    it('missing text endpoint → err(endpoint-missing)', async () => {
        const r = await new CohereV4VisualEmbeddingService(azureCfg({ textEndpoint: '' })).embedTextQueries(['q']);
        expect(r).toEqual({ ok: false, error: 'endpoint-missing' });
    });

    it('malformed Foundry response → err(parse-failed)', async () => {
        requestMock.mockResolvedValue({ status: 200, json: { embeddings: { float: [vec()] } } }); // native shape on azure
        const r = await new CohereV4VisualEmbeddingService(azureCfg()).embedImages([{ dataUrl: 'x' }]);
        expect(r).toEqual({ ok: false, error: 'parse-failed' });
    });
});

describe('shared transport error taxonomy (probe CA2 depends on these strings)', () => {
    it('429 → rate-limited', async () => {
        requestMock.mockResolvedValue({ status: 429, json: {} });
        const r = await new CohereV4VisualEmbeddingService(nativeCfg()).embedImages([{ dataUrl: 'x' }]);
        expect(r).toEqual({ ok: false, error: 'rate-limited' });
    });

    it('401 → http-401: unauthorized', async () => {
        requestMock.mockResolvedValue({ status: 401, json: {} });
        const r = await new CohereV4VisualEmbeddingService(nativeCfg()).embedImages([{ dataUrl: 'x' }]);
        expect(r).toEqual({ ok: false, error: 'http-401: unauthorized' });
    });

    it('500 → http-500', async () => {
        requestMock.mockResolvedValue({ status: 500, json: {} });
        const r = await new CohereV4VisualEmbeddingService(azureCfg()).embedImages([{ dataUrl: 'x' }]);
        expect(r).toEqual({ ok: false, error: 'http-500' });
    });

    it('AbortError → aborted', async () => {
        const abortErr = new Error('aborted');
        abortErr.name = 'AbortError';
        requestMock.mockRejectedValue(abortErr);
        const r = await new CohereV4VisualEmbeddingService(nativeCfg()).embedImages([{ dataUrl: 'x' }]);
        expect(r).toEqual({ ok: false, error: 'aborted' });
    });

    it('network throw → network: <message>', async () => {
        requestMock.mockRejectedValue(new Error('ECONNREFUSED'));
        const r = await new CohereV4VisualEmbeddingService(nativeCfg()).embedImages([{ dataUrl: 'x' }]);
        expect(r).toEqual({ ok: false, error: 'network: ECONNREFUSED' });
    });

    it('injected lease wraps the HTTP call (pacer seam)', async () => {
        requestMock.mockResolvedValue(nativeOk(1));
        let leaseCalls = 0;
        const lease = <T,>(fn: () => Promise<T>): Promise<T> => { leaseCalls++; return fn(); };
        const svc = new CohereV4VisualEmbeddingService(nativeCfg({ lease }));
        await svc.embedImages([{ dataUrl: 'x' }]);
        expect(leaseCalls).toBe(1);
    });
});
