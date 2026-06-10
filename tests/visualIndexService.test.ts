/**
 * VisualIndexService — the Phase-6 lane orchestrator: fingerprint-gated indexing (C9),
 * attachment-consumer events (C12), host-note lifecycle + embed reconcile (C24),
 * self-gating (C12), needs-rebuild blocking (C8), pointer-only enqueue (C25).
 */
import { describe, it, expect, vi } from 'vitest';
import { VisualIndexService } from '../src/services/visualEmbedding/visualIndexService';
import { VisualIndexRepository, VISUAL_INDEX_PATH } from '../src/services/visualEmbedding/visualIndexRepository';
import type { VisualPageTask } from '../src/services/visualEmbedding/types';
import type { GenericEmbeddingQueue } from '../src/services/vector/embeddingQueue';
import type { PdfHandlePool } from '../src/services/pdf/pdfHandlePool';
import { ok } from '../src/core/result';
import { createTFile } from './mocks/obsidian';
import { fakeAdapter, fakeStore } from './helpers/visualFakes';

const IDENTITY = { modelId: 'embed-v-4-0', backend: 'azure-cohere-v4' as const, dim: 4 };

interface World {
    service: VisualIndexService;
    repo: VisualIndexRepository;
    enqueues: Array<{ key: string; tasks: VisualPageTask[] }>;
    removedKeys: string[];
    links: Record<string, Record<string, number>>;
    files: Map<string, ReturnType<typeof createTFile>>;
    enabled: { value: boolean };
}

async function makeWorld(opts: { figurePages?: number[]; markdownFiles?: string[] } = {}): Promise<World> {
    const adapter = fakeAdapter();
    const links: Record<string, Record<string, number>> = {};
    const files = new Map<string, ReturnType<typeof createTFile>>();
    const markdownFiles = opts.markdownFiles ?? [];
    const app = {
        vault: {
            adapter,
            getAbstractFileByPath: (p: string) => files.get(p) ?? null,
            readBinary: async () => new Uint8Array([1, 2, 3, 4]).buffer,
            getMarkdownFiles: () => markdownFiles.map((p) => files.get(p)).filter(Boolean),
        },
        metadataCache: { resolvedLinks: links },
    } as never;

    const repo = new VisualIndexRepository(app, IDENTITY, VISUAL_INDEX_PATH, () => fakeStore());
    await repo.load();

    const figurePages = opts.figurePages ?? [1];
    const fakeHandle = {
        numPages: 5,
        getPageText: async (p: number) => `text of page ${p}`,
        detectFigurePages: async () => ({
            pages: figurePages.map((p) => ({ page: p, signals: { image: true, vectorOps: 0, textDensityLow: false } })),
            capped: false,
        }),
        renderPageImage: async () => ok('data:image/jpeg;base64,x'),
        dispose: () => {},
    };
    const pool = {
        lease: async () => ok({ handle: fakeHandle, release: () => {} }),
    } as unknown as PdfHandlePool;

    const enqueues: Array<{ key: string; tasks: VisualPageTask[] }> = [];
    const removedKeys: string[] = [];
    const queue = {
        enqueueKeyed: vi.fn(async (key: string, tasks: VisualPageTask[], onSuccess: (v: number[][]) => Promise<void>) => {
            enqueues.push({ key, tasks });
            await onSuccess(tasks.map(() => [1, 0, 0, 0]));
        }),
        removePath: vi.fn((key: string) => { removedKeys.push(key); }),
    } as unknown as GenericEmbeddingQueue<VisualPageTask>;

    const enabled = { value: true };
    const service = new VisualIndexService({
        app,
        repository: repo,
        queue,
        pool,
        isEnabled: () => enabled.value,
        getIdentity: () => IDENTITY,
        getMaxPagesPerAttachment: () => 20,
    });
    return { service, repo, enqueues, removedKeys, links, files, enabled };
}

function addNoteWithPdf(w: World, notePath: string, pdfPath: string): void {
    w.files.set(notePath, createTFile(notePath));
    w.files.set(pdfPath, createTFile(pdfPath));
    w.links[notePath] = { ...(w.links[notePath] ?? {}), [pdfPath]: 1 };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('indexing pipeline (C9/C25)', () => {
    it('indexes a linked PDF: pointer tasks enqueued, pages persisted with text + provenance', async () => {
        const w = await makeWorld({ figurePages: [2, 4] });
        addNoteWithPdf(w, 'note.md', 'deck.pdf');
        const r = await w.service.indexHostNote('note.md');
        expect(r.ok).toBe(true);
        await flush();

        expect(w.enqueues).toHaveLength(1);
        const { tasks } = w.enqueues[0];
        expect(tasks.map((t) => t.pageNumber)).toEqual([2, 4]);
        // C25: pointers only — no rendered image on the task.
        expect(tasks.every((t) => !('dataUrl' in t))).toBe(true);
        expect(tasks[0].pageText).toBe('text of page 2');

        const s = await w.repo.searchByVector([1, 0, 0, 0], {}, 5);
        expect(s.ok).toBe(true);
        if (s.ok) {
            expect(s.value).toHaveLength(2);
            expect(s.value[0].pdfPath).toBe('deck.pdf');
            expect(s.value[0].hostNotePath).toBe('note.md');
        }
    });

    it('C9: an unchanged PDF is skipped on re-index (cheap prefilter — no second enqueue)', async () => {
        const w = await makeWorld();
        addNoteWithPdf(w, 'note.md', 'deck.pdf');
        await w.service.indexHostNote('note.md');
        await w.service.indexHostNote('note.md');
        expect(w.enqueues).toHaveLength(1);
    });

    it('a changed PDF (new mtime + new bytes) re-indexes', async () => {
        const w = await makeWorld();
        addNoteWithPdf(w, 'note.md', 'deck.pdf');
        await w.service.indexHostNote('note.md');
        w.files.get('deck.pdf')!.stat.mtime += 5000; // content hash includes mtime → changes
        await w.service.indexHostNote('note.md');
        expect(w.enqueues).toHaveLength(2);
    });

    it('a PDF with no figure pages records its cache entry (no rescan churn) but enqueues nothing', async () => {
        const w = await makeWorld({ figurePages: [] });
        addNoteWithPdf(w, 'note.md', 'deck.pdf');
        await w.service.indexHostNote('note.md');
        expect(w.enqueues).toHaveLength(0);
        expect(w.repo.indexedPdfsOf('note.md')).toEqual(['deck.pdf']);
        // Second pass: cache hit, still nothing enqueued.
        await w.service.indexHostNote('note.md');
        expect(w.enqueues).toHaveLength(0);
    });

    it('a deleted host note purges its vectors instead of indexing', async () => {
        const w = await makeWorld();
        addNoteWithPdf(w, 'note.md', 'deck.pdf');
        await w.service.indexHostNote('note.md');
        w.files.delete('note.md'); // vanished between capture and dispatch
        await w.service.indexHostNote('note.md');
        expect(w.repo.indexedPdfsOf('note.md')).toEqual([]);
    });
});

describe('self-gating + needs-rebuild (C12/C8)', () => {
    it('disabled feature → all surfaces are no-ops', async () => {
        const w = await makeWorld();
        addNoteWithPdf(w, 'note.md', 'deck.pdf');
        w.enabled.value = false;
        await w.service.indexHostNote('note.md');
        await w.service.onAttachmentChanged({ path: 'deck.pdf', kind: 'modify', hosts: ['note.md'] });
        await w.service.noteModified('note.md');
        const b = await w.service.backfillVault();
        expect(w.enqueues).toHaveLength(0);
        expect(b.ok && (b as { ok: true; value: { notes: number } }).value.notes).toBe(0);
    });

    it('needs-rebuild blocks indexing with a typed error', async () => {
        const adapter = fakeAdapter();
        adapter.files.set(`${VISUAL_INDEX_PATH}/visual-meta.json`, JSON.stringify({
            modelId: 'stale', backend: 'cohere-native', dim: 1024, createdAt: 1, sourceVersion: 1,
        }));
        const app = {
            vault: { adapter, getAbstractFileByPath: () => null, readBinary: async () => new ArrayBuffer(0), getMarkdownFiles: () => [] },
            metadataCache: { resolvedLinks: {} },
        } as never;
        const repo = new VisualIndexRepository(app, IDENTITY, VISUAL_INDEX_PATH, () => fakeStore());
        await repo.load();
        const service = new VisualIndexService({
            app, repository: repo,
            queue: { enqueueKeyed: vi.fn(), removePath: vi.fn() } as never,
            pool: { lease: vi.fn() } as never,
            isEnabled: () => true,
            getIdentity: () => IDENTITY,
            getMaxPagesPerAttachment: () => 20,
        });
        const r = await service.indexHostNote('note.md');
        expect(r).toEqual({ ok: false, error: 'needs-rebuild' });
    });
});

describe('attachment-consumer events (C12)', () => {
    it('delete purges the PDF across hosts', async () => {
        const w = await makeWorld();
        addNoteWithPdf(w, 'a.md', 'shared.pdf');
        addNoteWithPdf(w, 'b.md', 'shared.pdf');
        await w.service.indexHostNote('a.md');
        await w.service.indexHostNote('b.md');
        const r = await w.service.onAttachmentChanged({ path: 'shared.pdf', kind: 'delete', hosts: ['a.md', 'b.md'] });
        expect(r.ok).toBe(true);
        expect(w.repo.indexedPdfsOf('a.md')).toEqual([]);
        expect(w.repo.indexedPdfsOf('b.md')).toEqual([]);
    });

    it('rename purges the OLD path and re-indexes hosts under the new one', async () => {
        const w = await makeWorld();
        addNoteWithPdf(w, 'a.md', 'old.pdf');
        await w.service.indexHostNote('a.md');
        // The vault renamed old.pdf → new.pdf; links now point at the new path.
        w.links['a.md'] = { 'new.pdf': 1 };
        w.files.set('new.pdf', createTFile('new.pdf'));
        const r = await w.service.onAttachmentChanged({ path: 'new.pdf', kind: 'rename', oldPath: 'old.pdf', hosts: ['a.md'] });
        expect(r.ok).toBe(true);
        expect(w.repo.indexedPdfsOf('a.md')).toEqual(['new.pdf']);
    });
});

describe('host-note lifecycle (C24)', () => {
    it('noteDeleted purges the host vectors + drops pending queue batches', async () => {
        const w = await makeWorld();
        addNoteWithPdf(w, 'a.md', 'deck.pdf');
        await w.service.indexHostNote('a.md');
        const r = await w.service.noteDeleted('a.md');
        expect(r.ok).toBe(true);
        expect(w.repo.hostCount()).toBe(0);
        expect(w.removedKeys).toContain('a.md::vis::deck.pdf');
    });

    it('noteRenamed rekeys the host', async () => {
        const w = await makeWorld();
        addNoteWithPdf(w, 'a.md', 'deck.pdf');
        await w.service.indexHostNote('a.md');
        const r = await w.service.noteRenamed('a.md', 'moved/a.md');
        expect(r.ok).toBe(true);
        expect(w.repo.indexedPdfsOf('a.md')).toEqual([]);
        expect(w.repo.indexedPdfsOf('moved/a.md')).toEqual(['deck.pdf']);
    });

    it('noteModified RECONCILES: a de-linked embed loses its vectors, a new one indexes', async () => {
        const w = await makeWorld();
        addNoteWithPdf(w, 'a.md', 'x.pdf');
        await w.service.indexHostNote('a.md');
        expect(w.repo.indexedPdfsOf('a.md')).toEqual(['x.pdf']);

        // User edits the note: removes ![[x.pdf]], adds ![[y.pdf]].
        w.links['a.md'] = { 'y.pdf': 1 };
        w.files.set('y.pdf', createTFile('y.pdf'));
        const r = await w.service.noteModified('a.md');
        expect(r.ok).toBe(true);
        expect(w.repo.indexedPdfsOf('a.md')).toEqual(['y.pdf']);
    });
});
