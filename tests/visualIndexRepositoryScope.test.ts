/**
 * VisualIndexRepository — C19 pre-topK scoped search, C8 identity/needs-rebuild
 * blocking, purges (host / attachment / per-pair), and host rekey (C24).
 */
import { describe, it, expect } from 'vitest';
import {
    VisualIndexRepository,
    visualDocId,
    VISUAL_INDEX_PATH,
    type VisualIndexIdentity,
} from '../src/services/visualEmbedding/visualIndexRepository';
import { fakeAdapter, fakeStore } from './helpers/visualFakes';

const IDENTITY: VisualIndexIdentity = { modelId: 'embed-v-4-0', backend: 'azure-cohere-v4', dim: 4 };

function makeRepo(adapter = fakeAdapter(), store = fakeStore()) {
    const app = { vault: { adapter } } as never;
    const repo = new VisualIndexRepository(app, IDENTITY, VISUAL_INDEX_PATH, () => store);
    return { repo, adapter, store, app };
}

const page = (p: number, vector: number[], text = `page ${p}`) => ({ page: p, vector, pageText: text });

describe('C19 — scoped search is pre-topK', () => {
    it('an out-of-scope PDF ranked ABOVE an in-scope one cannot crowd the in-scope hit out of top-k', async () => {
        const { repo } = makeRepo();
        await repo.load();
        // Out-of-scope host has a near-perfect match; in-scope host a weaker one.
        await repo.upsertPages('other/b.md', 'other/big.pdf', { cacheKey: 'k1', contentHash: 'h1' },
            [page(1, [1, 0, 0, 0])]);
        await repo.upsertPages('work/a.md', 'work/deck.pdf', { cacheKey: 'k2', contentHash: 'h2' },
            [page(2, [0.5, 0.5, 0, 0])]);

        const r = await repo.searchByVector([1, 0, 0, 0], { folderScope: 'work' }, 1);
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.value).toHaveLength(1);
            expect(r.value[0].hostNotePath).toBe('work/a.md');
            expect(r.value[0].page).toBe(2);
            expect(r.value[0].renderRef).toEqual({ pdfPath: 'work/deck.pdf', page: 2 });
        }
    });

    it('currentFile is excluded from results', async () => {
        const { repo } = makeRepo();
        await repo.load();
        await repo.upsertPages('work/a.md', 'work/deck.pdf', { cacheKey: 'k', contentHash: 'h' }, [page(1, [1, 0, 0, 0])]);
        const r = await repo.searchByVector([1, 0, 0, 0], { currentFile: 'work/a.md' }, 5);
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value).toHaveLength(0);
    });

    it('unscoped search ranks across all hosts', async () => {
        const { repo } = makeRepo();
        await repo.load();
        await repo.upsertPages('a.md', 'a.pdf', { cacheKey: 'k1', contentHash: 'h1' }, [page(1, [1, 0, 0, 0])]);
        await repo.upsertPages('b.md', 'b.pdf', { cacheKey: 'k2', contentHash: 'h2' }, [page(1, [0, 1, 0, 0])]);
        const r = await repo.searchByVector([0, 1, 0, 0], {}, 2);
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.value[0].hostNotePath).toBe('b.md');
            expect(r.value).toHaveLength(2);
        }
    });

    it('rejects a query vector of the wrong dim (fail-fast, C1)', async () => {
        const { repo } = makeRepo();
        await repo.load();
        const r = await repo.searchByVector([1, 0], {}, 5);
        expect(r).toEqual({ ok: false, error: 'dim-mismatch' });
    });
});

describe('C8 — identity sidecar + needs-rebuild blocking', () => {
    it('identity mismatch on load sets needsRebuild and BLOCKS writes + search', async () => {
        const adapter = fakeAdapter();
        adapter.files.set(`${VISUAL_INDEX_PATH}/visual-meta.json`, JSON.stringify({
            modelId: 'embed-v-3', backend: 'cohere-native', dim: 1024, createdAt: 1, sourceVersion: 1,
        }));
        const { repo } = makeRepo(adapter);
        await repo.load();
        expect(repo.needsRebuild).toBe(true);
        const w = await repo.upsertPages('a.md', 'a.pdf', { cacheKey: 'k', contentHash: 'h' }, [page(1, [1, 0, 0, 0])]);
        expect(w).toEqual({ ok: false, error: 'needs-rebuild' });
        const s = await repo.searchByVector([1, 0, 0, 0], {}, 5);
        expect(s).toEqual({ ok: false, error: 'needs-rebuild' });
    });

    it('matching identity loads clean', async () => {
        const adapter = fakeAdapter();
        adapter.files.set(`${VISUAL_INDEX_PATH}/visual-meta.json`, JSON.stringify({
            ...IDENTITY, createdAt: 1, sourceVersion: 1,
        }));
        const { repo } = makeRepo(adapter);
        await repo.load();
        expect(repo.needsRebuild).toBe(false);
    });

    it('confirmRebuild wipes, adopts the live identity, clears the flag', async () => {
        const adapter = fakeAdapter();
        adapter.files.set(`${VISUAL_INDEX_PATH}/visual-meta.json`, JSON.stringify({
            modelId: 'old', backend: 'cohere-native', dim: 1024, createdAt: 1, sourceVersion: 1,
        }));
        const { repo } = makeRepo(adapter);
        await repo.load();
        expect(repo.needsRebuild).toBe(true);
        const r = await repo.confirmRebuild(IDENTITY);
        expect(r.ok).toBe(true);
        expect(repo.needsRebuild).toBe(false);
        const w = await repo.upsertPages('a.md', 'a.pdf', { cacheKey: 'k', contentHash: 'h' }, [page(1, [1, 0, 0, 0])]);
        expect(w.ok).toBe(true);
    });
});

describe('purges + rekey (C24)', () => {
    it('purgeByHostNote removes the host vectors + registry entry', async () => {
        const { repo, store } = makeRepo();
        await repo.load();
        await repo.upsertPages('a.md', 'a.pdf', { cacheKey: 'k', contentHash: 'h' }, [page(1, [1, 0, 0, 0]), page(2, [0, 1, 0, 0])]);
        const r = await repo.purgeByHostNote('a.md');
        expect(r.ok && r.ok ? (r as { ok: true; value: { removed: number } }).value.removed : 0).toBe(2);
        expect(store.docs.size).toBe(0);
        expect(repo.indexedPdfsOf('a.md')).toEqual([]);
    });

    it('purgeByAttachmentPath removes the PDF across ALL hosts (shared attachment)', async () => {
        const { repo, store } = makeRepo();
        await repo.load();
        await repo.upsertPages('a.md', 'shared.pdf', { cacheKey: 'k1', contentHash: 'h' }, [page(1, [1, 0, 0, 0])]);
        await repo.upsertPages('b.md', 'shared.pdf', { cacheKey: 'k2', contentHash: 'h' }, [page(1, [1, 0, 0, 0])]);
        await repo.upsertPages('b.md', 'own.pdf', { cacheKey: 'k3', contentHash: 'h2' }, [page(1, [0, 1, 0, 0])]);
        const r = await repo.purgeByAttachmentPath('shared.pdf');
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value.removed).toBe(2);
        expect(repo.indexedPdfsOf('a.md')).toEqual([]);
        expect(repo.indexedPdfsOf('b.md')).toEqual(['own.pdf']);
        expect(store.docs.size).toBe(1);
    });

    it('purgeForHost removes ONE (host, pdf) pair only (reconcile primitive)', async () => {
        const { repo, store } = makeRepo();
        await repo.load();
        await repo.upsertPages('a.md', 'x.pdf', { cacheKey: 'k1', contentHash: 'h1' }, [page(1, [1, 0, 0, 0])]);
        await repo.upsertPages('a.md', 'y.pdf', { cacheKey: 'k2', contentHash: 'h2' }, [page(1, [0, 1, 0, 0])]);
        const r = await repo.purgeForHost('a.md', 'x.pdf');
        expect(r.ok).toBe(true);
        expect(repo.indexedPdfsOf('a.md')).toEqual(['y.pdf']);
        expect(store.docs.size).toBe(1);
    });

    it('rekeyHost moves vectors + registry to the new host path', async () => {
        const { repo, store } = makeRepo();
        await repo.load();
        await repo.upsertPages('old.md', 'a.pdf', { cacheKey: 'k', contentHash: 'h' }, [page(3, [1, 0, 0, 0])]);
        const r = await repo.rekeyHost('old.md', 'new.md');
        expect(r.ok).toBe(true);
        expect(repo.indexedPdfsOf('old.md')).toEqual([]);
        expect(repo.indexedPdfsOf('new.md')).toEqual(['a.pdf']);
        const docs = [...store.docs.values()];
        expect(docs).toHaveLength(1);
        expect(docs[0].filePath).toBe('new.md');
        expect(docs[0].id).toBe(visualDocId('new.md', 'a.pdf', 3));
        // Still searchable under the new host.
        const s = await repo.searchByVector([1, 0, 0, 0], {}, 5);
        if (s.ok) expect(s.value[0].hostNotePath).toBe('new.md');
        expect(s.ok).toBe(true);
    });

    it('re-upsert of one (host, pdf) replaces the prior generation (idempotent re-index)', async () => {
        const { repo, store } = makeRepo();
        await repo.load();
        await repo.upsertPages('a.md', 'a.pdf', { cacheKey: 'k1', contentHash: 'h1' }, [page(1, [1, 0, 0, 0]), page(2, [0, 1, 0, 0])]);
        await repo.upsertPages('a.md', 'a.pdf', { cacheKey: 'k2', contentHash: 'h2' }, [page(5, [0, 0, 1, 0])]);
        expect(store.docs.size).toBe(1);
        expect([...store.docs.keys()][0]).toBe(visualDocId('a.md', 'a.pdf', 5));
    });
});
