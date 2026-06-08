/**
 * Attachment text indexer tests (azure-capability-completion-v2 — Cluster A / Phase 1).
 * collectAttachmentChunks: PDF deferral, extraction, per-note WORK cap, per-attachment
 * isolation (failure/timeout/empty), single-flight cache dedup, collision-safe ids.
 */

import { describe, it, expect, vi } from 'vitest';
import { collectAttachmentChunks, type AttachmentExtractionDeps, type AttachmentRef } from '../src/services/vector/attachmentTextIndexer';
import { SingleFlightCache } from '../src/services/vector/attachmentFingerprint';

function makeDeps(over: Partial<AttachmentExtractionDeps> & { refs: AttachmentRef[] }): AttachmentExtractionDeps {
    return {
        detect: () => over.refs,
        extractText: over.extractText ?? (async (r) => ({ ok: true, text: `text-of-${r.name}` })),
        contentHash: over.contentHash ?? (async (r) => `hash-${r.path}`),
        chunk: over.chunk ?? (async (t) => [t]),
        cache: over.cache ?? new SingleFlightCache(),
        timeoutMs: over.timeoutMs,
        concurrency: over.concurrency,
    };
}

const ref = (name: string, isPdf = false): AttachmentRef => ({ name, path: `att/${name}`, isPdf });

describe('collectAttachmentChunks', () => {
    it('defers PDFs (not extracted) with reason pdf-deferred-to-phase4', async () => {
        const extractText = vi.fn(async () => ({ ok: true, text: 'should not be called' }));
        const r = await collectAttachmentChunks('n.md', '', 50_000, makeDeps({ refs: [ref('doc.pdf', true)], extractText }));
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.value.chunks).toHaveLength(0);
        expect(r.value.skipped).toEqual([{ path: 'att/doc.pdf', reason: 'pdf-deferred-to-phase4' }]);
        expect(extractText).not.toHaveBeenCalled();
    });

    it('extracts an Office doc → chunk with sourceAttachment + collision-safe id', async () => {
        const r = await collectAttachmentChunks('notes/n.md', '', 50_000, makeDeps({
            refs: [ref('report.docx')],
            chunk: async () => ['chunk a', 'chunk b'],
        }));
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.value.chunks).toHaveLength(2);
        expect(r.value.chunks[0].attachment).toEqual({ name: 'report.docx', path: 'att/report.docx', contentHash: 'hash-att/report.docx' });
        expect(r.value.chunks[0].id).toMatch(/^notes\/n\.md::att::[0-9a-f]{8}#0$/);
        expect(r.value.chunks[1].id).toMatch(/#1$/);
        // ids are unique
        expect(new Set(r.value.chunks.map(c => c.id)).size).toBe(2);
    });

    it('isolates an extraction failure as skipped extract-failed (note unaffected)', async () => {
        const r = await collectAttachmentChunks('n.md', '', 50_000, makeDeps({
            refs: [ref('good.docx'), ref('bad.docx')],
            extractText: async (a) => (a.name === 'bad.docx' ? { ok: false, error: 'boom' } : { ok: true, text: 'ok' }),
        }));
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.value.chunks).toHaveLength(1);
        expect(r.value.skipped).toContainEqual(expect.objectContaining({ path: 'att/bad.docx', reason: 'extract-failed' }));
    });

    it('reports timeout when extraction exceeds timeoutMs', async () => {
        const r = await collectAttachmentChunks('n.md', '', 50_000, makeDeps({
            refs: [ref('slow.docx')],
            timeoutMs: 10,
            extractText: () => new Promise(resolve => setTimeout(() => resolve({ ok: true, text: 'late' }), 200)),
        }));
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.value.chunks).toHaveLength(0);
        expect(r.value.skipped).toContainEqual(expect.objectContaining({ path: 'att/slow.docx', reason: 'timeout' }));
    });

    it('skips an attachment whose extracted text is empty', async () => {
        const r = await collectAttachmentChunks('n.md', '', 50_000, makeDeps({
            refs: [ref('blank.txt')],
            extractText: async () => ({ ok: true, text: '   ' }),
        }));
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.value.skipped).toContainEqual(expect.objectContaining({ path: 'att/blank.txt', reason: 'empty' }));
    });

    it('enforces the per-note WORK cap and reports cap-reached for the remainder', async () => {
        const r = await collectAttachmentChunks('n.md', '', 10, makeDeps({
            refs: [ref('a.docx'), ref('b.docx')],
            chunk: async () => ['12345', '67890', 'OVERFLOW'],  // 5+5 fits the 10-char budget, 3rd overflows
        }));
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        // First attachment emits 2 chunks (10 chars), then the budget is exhausted.
        expect(r.value.chunks).toHaveLength(2);
        expect(r.value.skipped).toContainEqual(expect.objectContaining({ path: 'att/b.docx', reason: 'cap-reached' }));
    });

    it('single-flight cache: a duplicate-path ref extracts once', async () => {
        const extractText = vi.fn(async (a: AttachmentRef) => ({ ok: true, text: `t-${a.name}` }));
        // Two refs with the SAME path → the cache key collapses them to one extraction.
        const dup: AttachmentRef = { name: 'shared.docx', path: 'att/shared.docx', isPdf: false };
        const r = await collectAttachmentChunks('n.md', '', 50_000, makeDeps({ refs: [dup, { ...dup }], extractText, concurrency: 2 }));
        expect(r.ok).toBe(true);
        expect(extractText).toHaveBeenCalledTimes(1);
    });
});

describe('SingleFlightCache', () => {
    it('shares one in-flight promise for concurrent same-key gets (parse-once)', async () => {
        const cache = new SingleFlightCache<number>();
        const factory = vi.fn(() => new Promise<number>(res => setTimeout(() => res(42), 20)));
        const [a, b] = await Promise.all([cache.get('k', factory), cache.get('k', factory)]);
        expect(a).toBe(42);
        expect(b).toBe(42);
        expect(factory).toHaveBeenCalledTimes(1);
    });

    it('evicts a rejected promise so a later call retries', async () => {
        const cache = new SingleFlightCache<number>();
        await expect(cache.get('k', () => Promise.reject(new Error('x')))).rejects.toThrow('x');
        const ok = await cache.get('k', () => Promise.resolve(7));
        expect(ok).toBe(7);
    });
});
