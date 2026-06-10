/**
 * Visual-search teardown (C14 + CA3): `deleteAll()` leaves NO files under
 * `.ai-organiser/vector-index-visual*` (index + sidecars + cache + temp rebuild paths),
 * and the coordinator's `unregister` stops dispatching to the removed consumer BEFORE
 * it is disposed (no dead-service dispatch).
 */
import { describe, it, expect, vi } from 'vitest';
import { VisualIndexRepository, VISUAL_INDEX_PATH } from '../src/services/visualEmbedding/visualIndexRepository';
import { AttachmentLifecycleCoordinator, type AttachmentConsumer } from '../src/services/attachmentLifecycleCoordinator';
import { ok } from '../src/core/result';
import { fakeAdapter, fakeStore } from './helpers/visualFakes';

const IDENTITY = { modelId: 'embed-v-4-0', backend: 'azure-cohere-v4' as const, dim: 4 };

describe('C14 — deleteAll purges the WHOLE visual namespace', () => {
    it('no files remain under vector-index-visual* after teardown', async () => {
        const adapter = fakeAdapter();
        // Pre-seed a temp rebuild path too (C14 names it explicitly).
        adapter.files.set(`${VISUAL_INDEX_PATH}-rebuild/index.voy`, 'tmp');
        const app = { vault: { adapter } } as never;
        const repo = new VisualIndexRepository(app, IDENTITY, VISUAL_INDEX_PATH, () => fakeStore());
        await repo.load();
        await repo.upsertPages('a.md', 'a.pdf', { cacheKey: 'k', contentHash: 'h' }, [{ page: 1, vector: [1, 0, 0, 0], pageText: 't' }]);

        // Sidecars exist before teardown.
        expect([...adapter.files.keys()].some((p) => p.startsWith(VISUAL_INDEX_PATH))).toBe(true);

        const r = await repo.deleteAll();
        expect(r.ok).toBe(true);
        const leftover = [...adapter.files.keys()].filter((p) => p.startsWith(VISUAL_INDEX_PATH));
        expect(leftover).toEqual([]);
        expect(adapter.dirs.has(VISUAL_INDEX_PATH)).toBe(false);
    });

    it('deleteAll resets the in-memory registry (no resurrected hosts)', async () => {
        const adapter = fakeAdapter();
        const app = { vault: { adapter } } as never;
        const repo = new VisualIndexRepository(app, IDENTITY, VISUAL_INDEX_PATH, () => fakeStore());
        await repo.load();
        await repo.upsertPages('a.md', 'a.pdf', { cacheKey: 'k', contentHash: 'h' }, [{ page: 1, vector: [1, 0, 0, 0], pageText: 't' }]);
        await repo.deleteAll();
        expect(repo.indexedPdfsOf('a.md')).toEqual([]);
        expect(repo.hostCount()).toBe(0);
        const s = await repo.searchByVector([1, 0, 0, 0], {}, 5);
        expect(s.ok).toBe(true);
        if (s.ok) expect(s.value).toEqual([]);
    });
});

describe('CA3 — coordinator unregister', () => {
    function makeConsumer(): AttachmentConsumer & { events: number } {
        const c = {
            events: 0,
            onAttachmentChanged: vi.fn(async () => { c.events++; return ok(undefined); }),
            purgeByAttachmentPath: vi.fn(async () => ok({ removed: 0 })),
        };
        return c;
    }

    it('an unregistered consumer receives NO further dispatches', async () => {
        const coord = new AttachmentLifecycleCoordinator(() => ({ resolvedLinks: {}, unresolvedLinks: {} }));
        const text = makeConsumer();
        const visual = makeConsumer();
        coord.register(text);
        coord.register(visual);

        await coord.handleChange('modify', 'deck.pdf');
        expect(text.events).toBe(1);
        expect(visual.events).toBe(1);

        coord.unregister(visual); // CA3: BEFORE the service is disposed
        await coord.handleChange('delete', 'deck.pdf');
        expect(text.events).toBe(2);
        expect(visual.events).toBe(1); // dead service never dispatched
    });

    it('unregistering an unknown consumer is a no-op', () => {
        const coord = new AttachmentLifecycleCoordinator(() => ({ resolvedLinks: {}, unresolvedLinks: {} }));
        const a = makeConsumer();
        coord.register(a);
        coord.unregister(makeConsumer()); // never registered
        expect(coord.hasConsumers).toBe(true);
    });
});
