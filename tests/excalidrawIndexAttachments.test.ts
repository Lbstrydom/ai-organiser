/**
 * Excalidraw drawings in the vector indexer: attachment identity survives the cleaned-text
 * hash, the collector sees exactly what the hash covers (never the blob), and a failed
 * collection never wipes what is already indexed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('obsidian', async () => await import('./mocks/obsidian'));
vi.mock('../src/services/vector/voyVectorStore', () => ({ VoyVectorStore: class {} }));

const collectSpy = vi.hoisted(() => vi.fn());
vi.mock('../src/services/vector/attachmentTextIndexer', async () => {
    const actual = await vi.importActual<typeof import('../src/services/vector/attachmentTextIndexer')>('../src/services/vector/attachmentTextIndexer');
    return { ...actual, collectAttachmentChunks: (...args: unknown[]) => collectSpy(...args) };
});

import { createContentHash } from '../src/services/vector/hashUtils';
import { drawingNote, BLOB_PROBE } from './helpers/excalidrawFixture';
import { makeHarness } from './helpers/excalidrawIndexHarness';

const ATTACHMENT_ONLY = { elements: [], embeds: ['f1: [[Report.docx]]'] };

beforeEach(() => {
    collectSpy.mockReset();
    collectSpy.mockResolvedValue({ ok: true, value: { chunks: [], skipped: [] } });
});

describe('indexer: Excalidraw attachment identity', () => {
    it('re-indexes when an embedded file is added although the words did not change', async () => {
        const h = makeHarness({ indexAttachmentText: true });
        const file = h.setNote('Drawings/Att.excalidraw.md', drawingNote());
        await h.service.indexNote(file as never);
        expect(h.embedded).toHaveLength(1);

        h.setNote(file.path, drawingNote({ embeds: ['f1: [[Report.docx]]'] }));
        await h.service.indexNote(file as never);
        expect(h.embedded).toHaveLength(2);
    });

    it('hands attachment collection the words and the embedded-files list, never the blob', async () => {
        const h = makeHarness({ indexAttachmentText: true });
        const file = h.setNote('Drawings/Att.excalidraw.md', drawingNote({ embeds: ['f1: [[Report.docx]]'], blobChars: 50_000 }));
        await h.service.indexNote(file as never);
        expect(collectSpy).toHaveBeenCalledTimes(1);
        const seen = collectSpy.mock.calls[0][1] as string;
        expect(seen).toContain('f1: [[Report.docx]]');
        expect(seen).toContain('Intake');
        expect(seen).not.toContain(BLOB_PROBE);
    });

    it('hands attachment collection a plain note unchanged', async () => {
        const h = makeHarness({ indexAttachmentText: true });
        const file = h.setNote('Notes/Plain.md', 'see ![[Report.docx]]');
        await h.service.indexNote(file as never);
        expect(collectSpy.mock.calls[0][1]).toBe('see ![[Report.docx]]');
    });

    it('keeps the attachment documents of a drawing that has no words', async () => {
        const h = makeHarness({ indexAttachmentText: true });
        collectSpy.mockResolvedValue({
            ok: true,
            value: {
                chunks: [{ id: 'att-1', content: 'attachment text', attachment: { path: 'Report.docx', name: 'Report', contentHash: 'h1', kind: 'office' } }],
                skipped: [],
            },
        });
        const file = h.setNote('Drawings/OnlyAtt.excalidraw.md', drawingNote(ATTACHMENT_ONLY));
        await h.service.indexNote(file as never);

        expect(h.embedded).toHaveLength(1);
        expect(h.embedded[0].join('\n')).toContain('attachment text');
        expect(h.embedded[0].join('\n')).not.toContain(BLOB_PROBE);
    });

    it('keeps the indexed attachment documents and retries when collection fails for an attachment-only drawing', async () => {
        const h = makeHarness({ indexAttachmentText: true });
        collectSpy.mockResolvedValue({ ok: false, error: 'attachment-collect-failed: boom' });
        const file = h.setNote('Drawings/OnlyAtt.excalidraw.md', drawingNote(ATTACHMENT_ONLY));
        h.docs.set(file.path, [{ id: 'att-old', content: 'earlier attachment text' }]);

        const ok = await h.service.indexNote(file as never);

        expect(ok).toBe(false);
        expect(h.store.remove).not.toHaveBeenCalled();
        expect(h.docs.get(file.path)).toEqual([{ id: 'att-old', content: 'earlier attachment text' }]);
        expect(h.hashes.has(file.path)).toBe(false); // identity unrecorded: the next pass retries
        expect(h.embedded).toHaveLength(0);
    });

    it('treats an embeds-only drawing as empty when attachment indexing is off', async () => {
        const h = makeHarness({ indexAttachmentText: false });
        const file = h.setNote('Drawings/OnlyAtt.excalidraw.md', drawingNote(ATTACHMENT_ONLY));
        await h.service.indexNote(file as never);
        expect(h.embedded).toHaveLength(0);
        expect(collectSpy).not.toHaveBeenCalled();
    });

    it('leaves the stored hash of a plain note unaffected by the setting', async () => {
        for (const on of [true, false]) {
            const h = makeHarness({ indexAttachmentText: on });
            const file = h.setNote('Notes/Plain.md', 'just words');
            await h.service.indexNote(file as never);
            expect(h.hashes.get(file.path)).toBe(await createContentHash('just words'));
        }
    });
});
