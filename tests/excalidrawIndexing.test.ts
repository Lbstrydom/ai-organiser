/**
 * Excalidraw drawings in the vector indexer: the compressed blob never reaches an embedding
 * request, non-drawing notes are indexed byte-identically, and existing (raw-hash) drawing
 * chunks self-heal. Attachment identity lives in excalidrawIndexAttachments.test.ts.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('obsidian', async () => await import('./mocks/obsidian'));
vi.mock('../src/services/vector/voyVectorStore', () => ({ VoyVectorStore: class {} }));

import { createContentHash } from '../src/services/vector/hashUtils';
import { drawingNote, BLOB_PROBE } from './helpers/excalidrawFixture';
import { makeHarness } from './helpers/excalidrawIndexHarness';

describe('indexer: Excalidraw drawings', () => {
    it('never sends the blob to an embedding request; the words go through', async () => {
        const h = makeHarness();
        const file = h.setNote('Drawings/Map.excalidraw.md', drawingNote({ blobChars: 20_000 }));
        await h.service.indexNote(file as never);

        expect(h.embedded).toHaveLength(1);
        const sent = h.embedded[0].join('\n');
        expect(sent).toContain('Intake');
        expect(sent).toContain('Decision');
        expect(sent).not.toContain(BLOB_PROBE);
        expect(sent).not.toContain('compressed-json');
        const stored = (h.docs.get(file.path) ?? []).map((d) => d.content).join('\n');
        expect(stored).not.toContain(BLOB_PROBE);
    });

    it('indexes a normal note exactly as before (embedding input and stored hash unchanged)', async () => {
        const h = makeHarness();
        const body = '# Notes\n\nI used Excalidraw to sketch the plan.\n' + 'x'.repeat(2500);
        const file = h.setNote('Notes/Plain.md', body);
        await h.service.indexNote(file as never);

        const expectedChunks = [body.slice(0, 2000), body.slice(2000)];
        // Each request is the metadata prefix (title line + separator) followed by the raw chunk.
        expect(h.embedded[0]).toEqual(expectedChunks.map((c) => `Title: Plain\n---\n${c}`));
        expect(h.hashes.get(file.path)).toBe(await createContentHash(body));
    });

    it('re-chunks a drawing whose old index was built from the raw text (self-heal)', async () => {
        const h = makeHarness();
        const raw = drawingNote();
        const file = h.setNote('Drawings/Old.excalidraw.md', raw);
        h.hashes.set(file.path, await createContentHash(raw)); // what the old build stored
        h.docs.set(file.path, [{ id: `${file.path}-0`, content: raw }]);

        await h.service.indexNote(file as never);

        expect(h.embedded).toHaveLength(1);
        expect(h.store.remove).toHaveBeenCalledWith([`${file.path}-0`]);
        expect((h.docs.get(file.path) ?? []).some((d) => d.content.includes(BLOB_PROBE))).toBe(false);
    });

    it('does not re-embed when only the drawing data changes and the words stay the same', async () => {
        const h = makeHarness();
        const file = h.setNote('Drawings/Same.excalidraw.md', drawingNote({ blobChars: 3000 }));
        await h.service.indexNote(file as never);
        expect(h.embedded).toHaveLength(1);

        h.setNote(file.path, drawingNote({ blobChars: 9000 }));
        await h.service.indexNote(file as never);
        expect(h.embedded).toHaveLength(1);
    });

    it('re-embeds when a word changes', async () => {
        const h = makeHarness();
        const file = h.setNote('Drawings/Edit.excalidraw.md', drawingNote());
        await h.service.indexNote(file as never);
        h.setNote(file.path, drawingNote({ elements: ['Intake ^64GA6tr1', 'Escalate ^KUuV7DH0'] }));
        await h.service.indexNote(file as never);
        expect(h.embedded).toHaveLength(2);
        expect(h.embedded[1].join('\n')).toContain('Escalate');
    });

    it('drops the stale documents of a drawing with no words and makes no embedding request', async () => {
        const h = makeHarness();
        const file = h.setNote('Drawings/Blank.excalidraw.md', drawingNote({ elements: [] }));
        h.docs.set(file.path, [{ id: `${file.path}-0`, content: 'old blob chunk' }]);

        await h.service.indexNote(file as never);

        expect(h.embedded).toHaveLength(0);
        expect(h.store.remove).toHaveBeenCalledWith([`${file.path}-0`]);
        expect(h.hashes.has(file.path)).toBe(true);
    });
});

describe('indexer: Excalidraw metadata identity', () => {
    it('re-embeds a drawing when only its tags change (they feed the metadata prefix)', async () => {
        const h = makeHarness();
        const file = h.setNote('Drawings/Tagged.excalidraw.md', drawingNote());
        h.setTags(file.path, ['alpha']);
        await h.service.indexNote(file as never);
        expect(h.embedded).toHaveLength(1);

        h.setTags(file.path, ['alpha', 'beta']);
        await h.service.indexNote(file as never);
        expect(h.embedded).toHaveLength(2);
        expect(h.embedded[1].join(' | ')).toContain('Tags: alpha, beta');
    });

    it('forgets cached search results when it drops the documents of an emptied note', async () => {
        const h = makeHarness();
        const file = h.setNote('Notes/Gone.md', '   ');
        h.docs.set(file.path, [{ id: `${file.path}-0`, content: 'old' }]);
        const spy = vi.spyOn((h.service as unknown as { searchCache: { invalidateForFile: (p: string) => void } }).searchCache, 'invalidateForFile');
        await h.service.indexNote(file as never);
        expect(h.store.remove).toHaveBeenCalled();
        expect(spy).toHaveBeenCalledWith(file.path);
    });
});
