/**
 * C23 — on-enable backfill: enabling visual-search yields RETRIEVABLE results for a
 * pre-existing linked PDF with NO edit event. End-to-end through the REAL generic queue
 * (fake embed backend) → repository → scoped search.
 */
import { describe, it, expect } from 'vitest';
import { VisualIndexService } from '../src/services/visualEmbedding/visualIndexService';
import { VisualIndexRepository, VISUAL_INDEX_PATH } from '../src/services/visualEmbedding/visualIndexRepository';
import { GenericEmbeddingQueue, type EmbeddingBackend } from '../src/services/vector/embeddingQueue';
import type { VisualPageTask } from '../src/services/visualEmbedding/types';
import type { PdfHandlePool } from '../src/services/pdf/pdfHandlePool';
import { ForegroundGate } from '../src/services/foregroundGate';
import { EmbeddingCooldown } from '../src/services/embeddings/embeddingCooldown';
import { ok } from '../src/core/result';
import { createTFile } from './mocks/obsidian';
import { fakeAdapter, fakeStore } from './helpers/visualFakes';

const IDENTITY = { modelId: 'embed-v-4-0', backend: 'azure-cohere-v4' as const, dim: 4 };
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('C23 — enable backfill', () => {
    it('a pre-existing linked PDF becomes retrievable with no edit event', async () => {
        const adapter = fakeAdapter();
        const note = createTFile('research/paper-notes.md');
        const pdf = createTFile('research/figures.pdf');
        const plainNote = createTFile('journal/today.md'); // no PDFs — must be skipped
        const app = {
            vault: {
                adapter,
                getAbstractFileByPath: (p: string) => ({ [note.path]: note, [pdf.path]: pdf, [plainNote.path]: plainNote } as Record<string, unknown>)[p] ?? null,
                readBinary: async () => new Uint8Array([9, 9, 9]).buffer,
                getMarkdownFiles: () => [note, plainNote],
            },
            metadataCache: {
                resolvedLinks: {
                    'research/paper-notes.md': { 'research/figures.pdf': 1 },
                    'journal/today.md': {},
                },
            },
        } as never;

        const repo = new VisualIndexRepository(app, IDENTITY, VISUAL_INDEX_PATH, () => fakeStore());
        await repo.load();

        // The REAL generic queue with a fake embed backend (deterministic unit vectors).
        const backend: EmbeddingBackend<VisualPageTask> = {
            maxBatchSize: 8,
            embedBatch: async (tasks) => ({ success: true, embeddings: tasks.map(() => [0, 0, 1, 0]) }),
        };
        const queue = new GenericEmbeddingQueue<VisualPageTask>({
            getBackend: () => backend,
            foregroundGate: new ForegroundGate(),
            cooldown: new EmbeddingCooldown(() => 0),
            schedule: (fn) => { fn(); return 0 as never; },
            cancel: () => {},
        });

        const pool = {
            lease: async () => ok({
                handle: {
                    numPages: 3,
                    getPageText: async (p: number) => `figure caption ${p}`,
                    detectFigurePages: async () => ({
                        pages: [{ page: 2, signals: { image: true, vectorOps: 0, textDensityLow: true } }],
                        capped: false,
                    }),
                    renderPageImage: async () => ok('data:image/jpeg;base64,x'),
                    dispose: () => {},
                },
                release: () => {},
            }),
        } as unknown as PdfHandlePool;

        const service = new VisualIndexService({
            app,
            repository: repo,
            queue,
            pool,
            isEnabled: () => true,
            getIdentity: () => IDENTITY,
            getMaxPagesPerAttachment: () => 20,
        });

        const r = await service.backfillVault();
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value.notes).toBe(1); // only the PDF-bearing note processed
        await flush();

        // The pre-existing PDF is now retrievable — page 2 with its text payload.
        const s = await repo.searchByVector([0, 0, 1, 0], {}, 5);
        expect(s.ok).toBe(true);
        if (s.ok) {
            expect(s.value).toHaveLength(1);
            expect(s.value[0]).toMatchObject({
                hostNotePath: 'research/paper-notes.md',
                pdfPath: 'research/figures.pdf',
                page: 2,
                pageText: 'figure caption 2',
                renderRef: { pdfPath: 'research/figures.pdf', page: 2 },
            });
        }
    });

    it('a second backfill run is a cheap no-op (C9 cache — resume semantics)', async () => {
        const adapter = fakeAdapter();
        const note = createTFile('a.md');
        const pdf = createTFile('deck.pdf');
        let embedCalls = 0;
        const app = {
            vault: {
                adapter,
                getAbstractFileByPath: (p: string) => (p === 'a.md' ? note : p === 'deck.pdf' ? pdf : null),
                readBinary: async () => new Uint8Array([1]).buffer,
                getMarkdownFiles: () => [note],
            },
            metadataCache: { resolvedLinks: { 'a.md': { 'deck.pdf': 1 } } },
        } as never;
        const repo = new VisualIndexRepository(app, IDENTITY, VISUAL_INDEX_PATH, () => fakeStore());
        await repo.load();
        const queue = new GenericEmbeddingQueue<VisualPageTask>({
            getBackend: () => ({
                maxBatchSize: 8,
                embedBatch: async (tasks: VisualPageTask[]) => { embedCalls++; return { success: true, embeddings: tasks.map(() => [1, 0, 0, 0]) }; },
            }),
            foregroundGate: new ForegroundGate(),
            cooldown: new EmbeddingCooldown(() => 0),
            schedule: (fn) => { fn(); return 0 as never; },
            cancel: () => {},
        });
        const pool = {
            lease: async () => ok({
                handle: {
                    numPages: 1,
                    getPageText: async () => 'chart',
                    detectFigurePages: async () => ({ pages: [{ page: 1, signals: { image: true, vectorOps: 0, textDensityLow: false } }], capped: false }),
                    renderPageImage: async () => ok('data:image/jpeg;base64,x'),
                    dispose: () => {},
                },
                release: () => {},
            }),
        } as unknown as PdfHandlePool;
        const service = new VisualIndexService({
            app, repository: repo, queue, pool,
            isEnabled: () => true,
            getIdentity: () => IDENTITY,
            getMaxPagesPerAttachment: () => 20,
        });

        await service.backfillVault();
        await flush();
        expect(embedCalls).toBe(1);
        await service.backfillVault();
        await flush();
        expect(embedCalls).toBe(1); // unchanged PDF skipped by the fingerprint cache
    });
});
