/**
 * Cohere Embed v4 visual embedding service (plan Phase 5, C2).
 *
 * Two backends, TWO wire shapes (a verified deviation from the plan's C2 "shared
 * serializer" assumption — the live Azure API does NOT expose Cohere's native schema):
 *  - native: POST https://api.cohere.com/v2/embed         Authorization: Bearer <byo>
 *            Cohere v2 shape — `inputs:[{content:[...]}]`, `input_type:'search_document'|
 *            'search_query'`, `embedding_types:['float']`, `output_dimension`; response
 *            `{embeddings:{float:[[...]]}}`. One URL serves both sides.
 *  - azure:  Foundry Models inference shape on the services.ai.azure.com resource —
 *            images: POST <getFoundryImageEmbeddingsEndpoint> `{model, input:[{image}],
 *            input_type:'document'}`; text queries: POST <getFoundryTextEmbeddingsEndpoint>
 *            `{model, input:[...strings], input_type:'query'}`; response
 *            `{data:[{index, embedding:[...]}]}`. Header `api-key` (useMainKeyFallback:false).
 *            Image requests go ONE PER CALL — Azure documents that image batching "may not
 *            be supported" per model; the probe (C3) verifies whichever shape we send.
 *
 * Text and images embed into the SAME space (C1). Runtime zod validators + a hard dim
 * guard reject any vector ≠ `dim` before use. All HTTP via `abortableRequestUrl`; typed
 * `Result.err` on HTTP / parse / dim failure. Pacing is INJECTED (`lease`) so the Phase-6
 * lane wraps Azure calls in the per-deployment pacer and native calls in the Cohere RPM
 * limiter (C2/M5) — the service stays transport-pure.
 */
import { z } from 'zod';
import type { Result } from '../../core/result';
import { ok, err } from '../../core/result';
import { abortableRequestUrl } from '../../utils/abortableRequestUrl';
import { logger } from '../../utils/logger';
import { VISUAL_EMBED_BATCH_SIZE, type EmbeddingBatch, type IVisualEmbeddingService, type VisualBackend } from './types';

const COHERE_NATIVE_URL = 'https://api.cohere.com/v2/embed';

export interface CohereV4Config {
    backend: VisualBackend;
    /** Azure: the resolved Foundry IMAGE-embeddings URL. Native: ignored (fixed endpoint). */
    endpoint?: string;
    /** Azure: the resolved Foundry TEXT-embeddings URL (query side). Native: ignored. */
    textEndpoint?: string;
    apiKey: string;
    modelId: string;
    dim: number;
    /** Optional pacing/abort wrapper (Phase 6 injects the Azure pacer / Cohere limiter). */
    lease?: <T>(fn: () => Promise<T>) => Promise<T>;
    signal?: AbortSignal;
}

const cohereNativeResponseSchema = z.object({
    embeddings: z.object({ float: z.array(z.array(z.number())) }),
});

const foundryResponseSchema = z.object({
    data: z.array(z.object({ index: z.number(), embedding: z.array(z.number()) })),
});

type CohereInput = { content: Array<{ type: 'image_url'; image_url: { url: string } } | { type: 'text'; text: string }> };

interface RawHttpResult { status: number; json: unknown }

export class CohereV4VisualEmbeddingService implements IVisualEmbeddingService {
    readonly backend: VisualBackend;
    readonly dim: number;
    readonly modelId: string;

    constructor(private readonly cfg: CohereV4Config) {
        this.backend = cfg.backend;
        this.dim = cfg.dim;
        this.modelId = cfg.modelId;
    }

    embedImages(images: Array<{ dataUrl: string }>): Promise<Result<EmbeddingBatch>> {
        if (this.backend === 'azure-cohere-v4') return this.azureEmbedImages(images);
        const inputs: CohereInput[] = images.map((i) => ({ content: [{ type: 'image_url', image_url: { url: i.dataUrl } }] }));
        return this.nativeEmbed(inputs, 'search_document');
    }

    embedTextQueries(queries: string[]): Promise<Result<EmbeddingBatch>> {
        if (this.backend === 'azure-cohere-v4') return this.azureEmbedTextQueries(queries);
        const inputs: CohereInput[] = queries.map((q) => ({ content: [{ type: 'text', text: q }] }));
        return this.nativeEmbed(inputs, 'search_query');
    }

    // ── Native backend (Cohere v2 shape) ─────────────────────────────────────

    /** Batched POST loop (≤ VISUAL_EMBED_BATCH_SIZE per request), row-aligned, dim-guarded. */
    private async nativeEmbed(inputs: CohereInput[], inputType: 'search_document' | 'search_query'): Promise<Result<EmbeddingBatch>> {
        if (inputs.length === 0) return ok({ vectors: [] });
        const vectors: number[][] = [];
        for (let i = 0; i < inputs.length; i += VISUAL_EMBED_BATCH_SIZE) {
            const slice = inputs.slice(i, i + VISUAL_EMBED_BATCH_SIZE);
            const body = JSON.stringify({
                model: this.modelId,
                input_type: inputType,
                embedding_types: ['float'],
                output_dimension: this.dim,
                inputs: slice,
            });
            const res = await this.post(COHERE_NATIVE_URL, body);
            if (!res.ok) return res;
            const parsed = cohereNativeResponseSchema.safeParse(res.value.json);
            if (!parsed.success) {
                logger.warn('Search', `Cohere v4 native response shape invalid: ${parsed.error.issues[0]?.message ?? 'unknown'}`);
                return err('parse-failed');
            }
            const floats = parsed.data.embeddings.float;
            const guarded = this.guardRows(floats, slice.length);
            if (!guarded.ok) return guarded;
            vectors.push(...floats);
        }
        return ok({ vectors });
    }

    // ── Azure backend (Foundry Models inference shape) ───────────────────────

    /** ONE image per request (Azure batching is per-model-unsupported; probe-verified). */
    private async azureEmbedImages(images: Array<{ dataUrl: string }>): Promise<Result<EmbeddingBatch>> {
        if (images.length === 0) return ok({ vectors: [] });
        const url = this.cfg.endpoint ?? '';
        if (!url) return err('endpoint-missing');
        const vectors: number[][] = [];
        for (const image of images) {
            const body = JSON.stringify({
                model: this.modelId,
                input: [{ image: image.dataUrl }],
                input_type: 'document',
            });
            const r = await this.azurePostAndParse(url, body, 1);
            if (!r.ok) return r;
            vectors.push(...r.value);
        }
        return ok({ vectors });
    }

    private async azureEmbedTextQueries(queries: string[]): Promise<Result<EmbeddingBatch>> {
        if (queries.length === 0) return ok({ vectors: [] });
        const url = this.cfg.textEndpoint ?? '';
        if (!url) return err('endpoint-missing');
        const vectors: number[][] = [];
        for (let i = 0; i < queries.length; i += VISUAL_EMBED_BATCH_SIZE) {
            const slice = queries.slice(i, i + VISUAL_EMBED_BATCH_SIZE);
            const body = JSON.stringify({
                model: this.modelId,
                input: slice,
                input_type: 'query',
            });
            const r = await this.azurePostAndParse(url, body, slice.length);
            if (!r.ok) return r;
            vectors.push(...r.value);
        }
        return ok({ vectors });
    }

    private async azurePostAndParse(url: string, body: string, expected: number): Promise<Result<number[][]>> {
        const res = await this.post(url, body);
        if (!res.ok) return res;
        const parsed = foundryResponseSchema.safeParse(res.value.json);
        if (!parsed.success) {
            logger.warn('Search', `Foundry embeddings response shape invalid: ${parsed.error.issues[0]?.message ?? 'unknown'}`);
            return err('parse-failed');
        }
        // Row order is index-declared, not positional — validate the index set is
        // EXACTLY {0..expected-1} (integers, unique, in-range) before alignment. A
        // duplicate/missing/fractional index would otherwise silently mis-align
        // vectors to pages (audit H13/H22).
        const seen = new Set<number>();
        for (const d of parsed.data.data) {
            if (!Number.isInteger(d.index) || d.index < 0 || d.index >= expected || seen.has(d.index)) {
                logger.warn('Search', `Foundry embeddings response has an invalid index set (got ${d.index} of ${expected})`);
                return err('parse-failed');
            }
            seen.add(d.index);
        }
        const rows = [...parsed.data.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
        const guarded = this.guardRows(rows, expected);
        if (!guarded.ok) return guarded;
        return ok(rows);
    }

    // ── Shared transport + guards ────────────────────────────────────────────

    private guardRows(rows: number[][], expected: number): Result<void> {
        if (rows.length !== expected) return err('count-mismatch');
        for (const v of rows) {
            if (v.length !== this.dim) return err('dim-mismatch');
        }
        return ok(undefined);
    }

    private async post(url: string, body: string): Promise<Result<RawHttpResult>> {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (this.backend === 'cohere-native') headers['Authorization'] = `Bearer ${this.cfg.apiKey}`;
        else headers['api-key'] = this.cfg.apiKey;

        const doRequest = () => abortableRequestUrl(
            { url, method: 'POST', headers, body, throw: false },
            { signal: this.cfg.signal },
        );
        let res;
        try {
            res = this.cfg.lease ? await this.cfg.lease(doRequest) : await doRequest();
        } catch (e) {
            if (e instanceof Error && e.name === 'AbortError') return err('aborted');
            return err(`network: ${e instanceof Error ? e.message : String(e)}`);
        }
        if (res.status === 429) return err('rate-limited');
        if (res.status === 401 || res.status === 403) return err(`http-${res.status}: unauthorized`);
        if (res.status < 200 || res.status >= 300) return err(`http-${res.status}`);
        return ok({ status: res.status, json: res.json });
    }
}
