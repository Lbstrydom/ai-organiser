/**
 * RagContextMerger (Phase 7 / C4 / C20) — EVIDENCE-identity dedup (never host-filePath),
 * rank ordering, and the per-host / per-attachment / global budgets.
 */
import { describe, it, expect } from 'vitest';
import { mergeRagContext, evidenceIdOf, textResultToItem, visualHitToItem, DEFAULT_MERGE_BUDGET } from '../src/services/ragContextMerger';
import type { SearchResult } from '../src/services/vector/types';
import type { VisualHit } from '../src/services/visualEmbedding/types';

function textResult(filePath: string, content: string, score: number, chunkIndex = 0): SearchResult {
    return {
        document: {
            id: `${filePath}-${chunkIndex}`,
            filePath,
            chunkIndex,
            content,
            metadata: { title: filePath, createdTime: 0, modifiedTime: 0, contentHash: 'h', wordCount: 1, tokens: 1 },
        },
        score,
        highlightedText: content,
    };
}

function visualHit(host: string, pdf: string, page: number, score: number, pageText = `page ${page} text`): VisualHit {
    return { hostNotePath: host, pdfPath: pdf, page, score, pageText, renderRef: { pdfPath: pdf, page } };
}

describe('evidence identity (C4)', () => {
    it('two pages of ONE PDF never collapse', () => {
        const a = visualHitToItem(visualHit('n.md', 'deck.pdf', 1, 0.9));
        const b = visualHitToItem(visualHit('n.md', 'deck.pdf', 2, 0.8));
        expect(evidenceIdOf(a, 'm')).not.toBe(evidenceIdOf(b, 'm'));
        const merged = mergeRagContext([], [visualHit('n.md', 'deck.pdf', 1, 0.9), visualHit('n.md', 'deck.pdf', 2, 0.8)], 'm');
        expect(merged).toHaveLength(2);
    });

    it('a note TEXT chunk and that note\'s ATTACHMENT page never collapse (no host-filePath dedup)', () => {
        const merged = mergeRagContext(
            [textResult('n.md', 'body text', 0.9)],
            [visualHit('n.md', 'deck.pdf', 1, 0.85)],
            'm',
        );
        expect(merged).toHaveLength(2);
        expect(merged.map((i) => i.kind).sort()).toEqual(['attachment-page', 'text']);
    });

    it('EXACT duplicates (same kind/path/page/chunk/model) dedupe', () => {
        const merged = mergeRagContext([], [visualHit('n.md', 'deck.pdf', 1, 0.9), visualHit('n.md', 'deck.pdf', 1, 0.7)], 'm');
        expect(merged).toHaveLength(1);
        expect(merged[0].score).toBe(0.9); // best-ranked wins
    });

    it('modelId participates in the identity', () => {
        const item = visualHitToItem(visualHit('n.md', 'deck.pdf', 1, 0.9));
        expect(evidenceIdOf(item, 'embed-v4')).not.toBe(evidenceIdOf(item, 'embed-v5'));
    });
});

describe('rank + budgets (C4)', () => {
    it('merged output is score-ordered across kinds', () => {
        const merged = mergeRagContext(
            [textResult('a.md', 't1', 0.7)],
            [visualHit('b.md', 'x.pdf', 1, 0.95), visualHit('c.md', 'y.pdf', 2, 0.5)],
            'm',
        );
        expect(merged.map((i) => i.score)).toEqual([0.95, 0.7, 0.5]);
    });

    it('maxPagesPerAttachment caps one dominant PDF', () => {
        const hits = [1, 2, 3, 4, 5].map((p) => visualHit('n.md', 'big.pdf', p, 1 - p * 0.01));
        const merged = mergeRagContext([], hits, 'm', { maxItems: 12, maxItemsPerHostNote: 12, maxPagesPerAttachment: 3 });
        expect(merged).toHaveLength(3);
        expect(merged.map((i) => i.kind === 'attachment-page' ? i.page : -1)).toEqual([1, 2, 3]); // best-ranked pages kept
    });

    it('maxItemsPerHostNote caps one dominant note across kinds', () => {
        const merged = mergeRagContext(
            [textResult('n.md', 'c0', 0.9, 0), textResult('n.md', 'c1', 0.89, 1), textResult('n.md', 'c2', 0.88, 2)],
            [visualHit('n.md', 'x.pdf', 1, 0.87), visualHit('other.md', 'y.pdf', 1, 0.5)],
            'm',
            { maxItems: 12, maxItemsPerHostNote: 3, maxPagesPerAttachment: 3 },
        );
        expect(merged.filter((i) => i.filePath === 'n.md')).toHaveLength(3);
        expect(merged.filter((i) => i.filePath === 'other.md')).toHaveLength(1);
    });

    it('global maxItems bounds the whole evidence list', () => {
        const texts = Array.from({ length: 20 }, (_, i) => textResult(`f${i}.md`, `c${i}`, 1 - i * 0.01));
        const merged = mergeRagContext(texts, [], 'm');
        expect(merged).toHaveLength(DEFAULT_MERGE_BUDGET.maxItems);
    });
});

describe('conversions', () => {
    it('textResultToItem carries sourceAttachment provenance when present', () => {
        const r = textResult('n.md', 'att text', 0.8);
        r.document.metadata.sourceAttachment = { name: 'doc.docx', path: 'att/doc.docx', contentHash: 'h' };
        const item = textResultToItem(r);
        expect(item.kind).toBe('text');
        expect(item.sourceAttachment?.path).toBe('att/doc.docx');
    });

    it('visualHitToItem carries the deferred renderRef (never an image)', () => {
        const item = visualHitToItem(visualHit('n.md', 'deck.pdf', 3, 0.9));
        expect(item.kind).toBe('attachment-page');
        if (item.kind === 'attachment-page') {
            expect(item.renderRef).toEqual({ pdfPath: 'deck.pdf', page: 3 });
            expect('dataUrl' in item).toBe(false);
        }
    });
});
