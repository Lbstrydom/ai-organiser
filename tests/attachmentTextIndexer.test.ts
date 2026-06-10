/**
 * Attachment text indexer tests (azure-capability-completion-v2 — Cluster A / Phase 1).
 * collectAttachmentChunks: PDF deferral, extraction, per-note WORK cap, per-attachment
 * isolation (failure/timeout/empty), single-flight cache dedup, collision-safe ids.
 */

import { describe, it, expect, vi } from 'vitest';
import { collectAttachmentChunks, MAX_ATTACHMENT_FILE_BYTES, type AttachmentExtractionDeps, type AttachmentRef } from '../src/services/vector/attachmentTextIndexer';
import { SingleFlightCache } from '../src/services/vector/attachmentFingerprint';

function makeDeps(over: Partial<AttachmentExtractionDeps> & { refs: AttachmentRef[] }): AttachmentExtractionDeps {
    return {
        detect: () => over.refs,
        extractText: over.extractText ?? (async (r) => ({ ok: true, text: `text-of-${r.name}` })),
        extractPdfText: over.extractPdfText,
        contentHash: over.contentHash ?? (async (r) => `hash-${r.path}`),
        chunk: over.chunk ?? (async (t) => [t]),
        cache: over.cache ?? new SingleFlightCache(),
        timeoutMs: over.timeoutMs,
    };
}

const ref = (name: string, isPdf = false, size = 1000): AttachmentRef => ({ name, path: `att/${name}`, isPdf, size });

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

    it('Phase 4: extracts a PDF via the extractPdfText seam (no longer deferred)', async () => {
        const extractPdfText = vi.fn(async () => ({ ok: true, text: 'figure 1 shows revenue growth' }));
        const r = await collectAttachmentChunks('n.md', '', 50_000, makeDeps({ refs: [ref('deck.pdf', true)], extractPdfText }));
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.value.chunks.length).toBeGreaterThan(0);
        expect(r.value.chunks[0].attachment.name).toBe('deck.pdf');
        expect(extractPdfText).toHaveBeenCalledTimes(1);
        expect(r.value.skipped).toHaveLength(0);
    });

    it('Phase 4 G1: a pdfjs-unavailable PDF is skipped as needs-retry (NOT cached)', async () => {
        const extractPdfText = vi.fn(async () => ({ ok: false, error: 'pdfjs-unavailable' }));
        const r = await collectAttachmentChunks('n.md', '', 50_000, makeDeps({ refs: [ref('deck.pdf', true)], extractPdfText }));
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.value.chunks).toHaveLength(0);
        expect(r.value.skipped[0]).toMatchObject({ path: 'att/deck.pdf', reason: 'needs-retry' });
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
        // Collision-free path-stable id: the encoded vault path is the identity (no hash).
        expect(r.value.chunks[0].id).toBe('notes/n.md::att::att%2Freport.docx#0');
        expect(r.value.chunks[1].id).toBe('notes/n.md::att::att%2Freport.docx#1');
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

    it('size-admission guard: a file over MAX_ATTACHMENT_FILE_BYTES is skipped without extraction (H7/H11)', async () => {
        const extractText = vi.fn(async () => ({ ok: true, text: 'huge' }));
        const huge = ref('huge.docx', false, MAX_ATTACHMENT_FILE_BYTES + 1);
        const r = await collectAttachmentChunks('n.md', '', 50_000, makeDeps({ refs: [huge], extractText }));
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(extractText).not.toHaveBeenCalled();
        expect(r.value.skipped).toEqual([{ path: 'att/huge.docx', reason: 'too-large' }]);
    });

    it('admission work-cap: does NOT extract attachments once the budget is exhausted (H6)', async () => {
        const extractText = vi.fn(async (a: AttachmentRef) => ({ ok: true, text: a.name === 'a.docx' ? '1234567890' : 'never' }));
        const r = await collectAttachmentChunks('n.md', '', 10, makeDeps({
            refs: [ref('a.docx'), ref('b.docx')],
            extractText,
            chunk: async (t) => [t],
        }));
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        // a.docx fills the 10-char budget; b.docx is cap-reached WITHOUT being extracted.
        expect(extractText).toHaveBeenCalledTimes(1);
        expect(extractText).toHaveBeenCalledWith(expect.objectContaining({ name: 'a.docx' }));
        expect(r.value.skipped).toContainEqual({ path: 'att/b.docx', reason: 'cap-reached' });
    });

    it('single-flight cache: a duplicate-path ref extracts once', async () => {
        const extractText = vi.fn(async (a: AttachmentRef) => ({ ok: true, text: `t-${a.name}` }));
        // Two refs with the SAME path → the cache key collapses them to one extraction.
        const dup: AttachmentRef = { name: 'shared.docx', path: 'att/shared.docx', isPdf: false, size: 1000 };
        const r = await collectAttachmentChunks('n.md', '', 50_000, makeDeps({ refs: [dup, { ...dup }], extractText }));
        expect(r.ok).toBe(true);
        expect(extractText).toHaveBeenCalledTimes(1);
    });
});

describe('H6(i) — budget-bounded PDF cache must not poison larger-budget callers', () => {
    it('a low-budget TRUNCATED extraction is re-extracted for a later higher-budget host', async () => {
        const cache = new SingleFlightCache<{ text: string; contentHash: string; extractedWithBudget?: number }>();
        const fullText = 'x'.repeat(500);
        const extractPdfText = vi.fn(async (_r: AttachmentRef, budget: number) => ({
            ok: true,
            text: fullText.slice(0, budget), // bounded extractor: returns exactly up to budget
        }));
        // Host A: tiny remaining budget (50) → truncated entry cached.
        const a = await collectAttachmentChunks('a.md', '', 50, makeDeps({ refs: [ref('shared.pdf', true)], extractPdfText, cache }));
        expect(a.ok).toBe(true);
        // Host B: full budget — must NOT inherit the 50-char truncation.
        const b = await collectAttachmentChunks('b.md', '', 50_000, makeDeps({ refs: [ref('shared.pdf', true)], extractPdfText, cache }));
        expect(b.ok).toBe(true);
        if (!b.ok) return;
        expect(extractPdfText).toHaveBeenCalledTimes(2); // re-extracted at the larger budget
        expect(b.value.chunks[0].content.length).toBe(500);
    });

    it('a COMPLETE small extraction (budget not binding) is shared without re-extraction', async () => {
        const cache = new SingleFlightCache<{ text: string; contentHash: string; extractedWithBudget?: number }>();
        const extractPdfText = vi.fn(async () => ({ ok: true, text: 'short pdf text' })); // 14 chars ≪ any budget
        const a = await collectAttachmentChunks('a.md', '', 1000, makeDeps({ refs: [ref('shared.pdf', true)], extractPdfText, cache }));
        const b = await collectAttachmentChunks('b.md', '', 50_000, makeDeps({ refs: [ref('shared.pdf', true)], extractPdfText, cache }));
        expect(a.ok && b.ok).toBe(true);
        expect(extractPdfText).toHaveBeenCalledTimes(1); // entry is complete → safely shared
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
