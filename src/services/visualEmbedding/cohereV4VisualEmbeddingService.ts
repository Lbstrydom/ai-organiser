/**
 * Cohere Embed v4 visual embedding service (plan Phase 5, C2).
 *
 * Both backends share request/response shape; only base URL + auth header differ:
 *  - native:  POST https://api.cohere.com/v2/embed   Authorization: Bearer <byo>
 *  - azure:   POST <endpointResolver Cohere v4 URL>   api-key: <azure>   (useMainKeyFallback:false)
 *
 * Text and images embed into the SAME space (C1). A runtime zod validator + a hard dim guard
 * reject any vector ≠ `dim` before use. All HTTP via `abortableRequestUrl`; typed `Result.err`
 * on HTTP / parse / dim failure. Pacing is INJECTED (`lease`) so the Phase-6 lane wraps Azure
 * calls in the per-deployment pacer and native calls in the Cohere RPM limiter (C2/M5) — the
 * service stays transport-pure.
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
    /** Azure: the resolved Cohere v4 URL. Native: ignored (uses the fixed endpoint). */
    endpoint?: string;
    apiKey: string;
    modelId: string;
    dim: number;
    /** Optional pacing/abort wrapper (Phase 6 injects the Azure pacer / Cohere limiter). */
    lease?: <T>(fn: () => Promise<T>) => Promise<T>;
    signal?: AbortSignal;
}

const cohereResponseSchema = z.object({
    embeddings: z.object({ float: z.array(z.array(z.number())) }),
});

type CohereInput = { content: Array<{ type: 'image_url'; image_url: { url: string } } | { type: 'text'; text: string }> };

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
        const inputs: CohereInput[] = images.map((i) => ({ content: [{ type: 'image_url', image_url: { url: i.dataUrl } }] }));
        return this.embed(inputs, 'search_document');
    }

    embedTextQueries(queries: string[]): Promise<Result<EmbeddingBatch>> {
        const inputs: CohereInput[] = queries.map((q) => ({ content: [{ type: 'text', text: q }] }));
        return this.embed(inputs, 'search_query');
    }

    /** Batched POST loop (≤ VISUAL_EMBED_BATCH_SIZE per request), row-aligned, dim-guarded. */
    private async embed(inputs: CohereInput[], inputType: 'search_document' | 'search_query'): Promise<Result<EmbeddingBatch>> {
        if (inputs.length === 0) return ok({ vectors: [] });
        const vectors: number[][] = [];
        for (let i = 0; i < inputs.length; i += VISUAL_EMBED_BATCH_SIZE) {
            const slice = inputs.slice(i, i + VISUAL_EMBED_BATCH_SIZE);
            const r = await this.postBatch(slice, inputType);
            if (!r.ok) return r;
            vectors.push(...r.value);
        }
        return ok({ vectors });
    }

    private async postBatch(inputs: CohereInput[], inputType: string): Promise<Result<number[][]>> {
        const url = this.backend === 'cohere-native' ? COHERE_NATIVE_URL : (this.cfg.endpoint ?? '');
        if (!url) return err('endpoint-missing');
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (this.backend === 'cohere-native') headers['Authorization'] = `Bearer ${this.cfg.apiKey}`;
        else headers['api-key'] = this.cfg.apiKey;

        const body = JSON.stringify({
            model: this.modelId,
            input_type: inputType,
            embedding_types: ['float'],
            output_dimension: this.dim,
            inputs,
        });

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

        const parsed = cohereResponseSchema.safeParse(res.json);
        if (!parsed.success) {
            logger.warn('Search', `Cohere v4 response shape invalid: ${parsed.error.issues[0]?.message ?? 'unknown'}`);
            return err('parse-failed');
        }
        const floats = parsed.data.embeddings.float;
        if (floats.length !== inputs.length) return err('count-mismatch');
        for (const v of floats) {
            if (v.length !== this.dim) return err('dim-mismatch');
        }
        return ok(floats);
    }
}
