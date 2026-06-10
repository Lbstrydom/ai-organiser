/**
 * VisualRetrievalService (Phase 7 / C1) — owns query embedding (same space as the page
 * images); graceful-by-contract: every unavailability yields ok([]) so visual retrieval
 * can never break text RAG.
 */
import { describe, it, expect, vi } from 'vitest';
import { VisualRetrievalService } from '../src/services/visualEmbedding/visualRetrievalService';
import { VisualIndexRepository, VISUAL_INDEX_PATH } from '../src/services/visualEmbedding/visualIndexRepository';
import type { IVisualEmbeddingService } from '../src/services/visualEmbedding/types';
import { ok, err } from '../src/core/result';
import { fakeAdapter, fakeStore } from './helpers/visualFakes';

const IDENTITY = { modelId: 'embed-v-4-0', backend: 'azure-cohere-v4' as const, dim: 4 };

function embedder(vector: number[] | null = [1, 0, 0, 0], fail = false): IVisualEmbeddingService {
    return {
        backend: 'azure-cohere-v4',
        dim: 4,
        modelId: 'embed-v-4-0',
        embedImages: vi.fn(),
        embedTextQueries: vi.fn(async () => fail ? err('rate-limited') : ok({ vectors: vector ? [vector] : [] })),
    } as unknown as IVisualEmbeddingService;
}

async function repoWithPage(): Promise<VisualIndexRepository> {
    const app = { vault: { adapter: fakeAdapter() } } as never;
    const repo = new VisualIndexRepository(app, IDENTITY, VISUAL_INDEX_PATH, () => fakeStore());
    await repo.load();
    await repo.upsertPages('research/a.md', 'figs.pdf', { cacheKey: 'k', contentHash: 'h' },
        [{ page: 2, vector: [1, 0, 0, 0], pageText: 'revenue chart' }]);
    return repo;
}

function service(over: {
    repo?: VisualIndexRepository | null;
    embed?: IVisualEmbeddingService | null;
    enabled?: boolean;
} = {}) {
    return new VisualRetrievalService({
        getRepository: () => over.repo ?? null,
        getEmbedder: async () => over.embed ?? null,
        isEnabled: () => over.enabled ?? true,
    });
}

describe('happy path (C1: text query → same-space vector → page hits)', () => {
    it('returns scoped hits with renderRef + pageText', async () => {
        const repo = await repoWithPage();
        const r = await service({ repo, embed: embedder() }).search('revenue charts', {}, 5);
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.value).toHaveLength(1);
            expect(r.value[0]).toMatchObject({
                hostNotePath: 'research/a.md',
                pdfPath: 'figs.pdf',
                page: 2,
                pageText: 'revenue chart',
                renderRef: { pdfPath: 'figs.pdf', page: 2 },
            });
        }
    });

    it('threads the scope to the repository (C19 pre-topK — out-of-folder host excluded)', async () => {
        const repo = await repoWithPage();
        const r = await service({ repo, embed: embedder() }).search('revenue', { folderScope: 'journal' }, 5);
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value).toEqual([]);
    });
});

describe('graceful unavailability — always ok([]), never err/throw', () => {
    it('feature disabled', async () => {
        const repo = await repoWithPage();
        const r = await service({ repo, embed: embedder(), enabled: false }).search('q', {}, 5);
        expect(r).toEqual({ ok: true, value: [] });
    });

    it('no repository (lane down)', async () => {
        const r = await service({ repo: null, embed: embedder() }).search('q', {}, 5);
        expect(r).toEqual({ ok: true, value: [] });
    });

    it('repository needs rebuild', async () => {
        const adapter = fakeAdapter();
        adapter.files.set(`${VISUAL_INDEX_PATH}/visual-meta.json`, JSON.stringify({
            modelId: 'stale', backend: 'cohere-native', dim: 1024, createdAt: 1, sourceVersion: 1,
        }));
        const app = { vault: { adapter } } as never;
        const repo = new VisualIndexRepository(app, IDENTITY, VISUAL_INDEX_PATH, () => fakeStore());
        await repo.load();
        const r = await service({ repo, embed: embedder() }).search('q', {}, 5);
        expect(r).toEqual({ ok: true, value: [] });
    });

    it('no embedder available (probe pending / missing key)', async () => {
        const repo = await repoWithPage();
        const r = await service({ repo, embed: null }).search('q', {}, 5);
        expect(r).toEqual({ ok: true, value: [] });
    });

    it('query embed failure (rate-limited)', async () => {
        const repo = await repoWithPage();
        const r = await service({ repo, embed: embedder(null, true) }).search('q', {}, 5);
        expect(r).toEqual({ ok: true, value: [] });
    });

    it('blank query / non-positive limit', async () => {
        const repo = await repoWithPage();
        expect(await service({ repo, embed: embedder() }).search('   ', {}, 5)).toEqual({ ok: true, value: [] });
        expect(await service({ repo, embed: embedder() }).search('q', {}, 0)).toEqual({ ok: true, value: [] });
    });

    it('an embedder that THROWS is contained', async () => {
        const repo = await repoWithPage();
        const throwing = {
            ...embedder(),
            embedTextQueries: vi.fn(async () => { throw new Error('boom'); }),
        } as unknown as IVisualEmbeddingService;
        const r = await service({ repo, embed: throwing }).search('q', {}, 5);
        expect(r).toEqual({ ok: true, value: [] });
    });
});
