/**
 * RelatedNotesDeduper tests (azure-capability-completion-v2 — C20, Cluster A / Phase 1).
 * The display-path deduper groups hits by host filePath (best score per note), excludes the
 * query note, and takes the top N — so attachment chunks (which share their host's filePath)
 * never crowd a unique note out of the related-notes list.
 */

import { describe, it, expect } from 'vitest';
import { dedupeRelatedByFile } from '../src/services/ragService';
import type { SearchResult } from '../src/services/vector/types';

const hit = (filePath: string, score: number, id = `${filePath}#${score}`): SearchResult => ({
    document: {
        id, filePath, chunkIndex: 0, content: 'c',
        metadata: { title: filePath, createdTime: 0, modifiedTime: 0, contentHash: 'h', wordCount: 1, tokens: 1 },
    },
    score,
} as SearchResult);

describe('dedupeRelatedByFile (C20)', () => {
    it('keeps the best-scoring chunk per file and sorts by score', () => {
        const out = dedupeRelatedByFile([hit('a.md', 0.5), hit('a.md', 0.9), hit('b.md', 0.7)], 'self.md', 5);
        expect(out.map(r => r.document.filePath)).toEqual(['a.md', 'b.md']);
        expect(out[0].score).toBe(0.9);
    });

    it('excludes the query note', () => {
        const out = dedupeRelatedByFile([hit('self.md', 0.99), hit('a.md', 0.4)], 'self.md', 5);
        expect(out.map(r => r.document.filePath)).toEqual(['a.md']);
    });

    it('returns up to `limit` UNIQUE files even when one file dominates the chunk list', () => {
        // 5 chunks of a.md + one each of b/c/d — must still yield 3 unique files at limit 3.
        const results = [
            hit('a.md', 0.95), hit('a.md', 0.94), hit('a.md', 0.93), hit('a.md', 0.92), hit('a.md', 0.91),
            hit('b.md', 0.6), hit('c.md', 0.5), hit('d.md', 0.4),
        ];
        const out = dedupeRelatedByFile(results, 'self.md', 3);
        expect(out).toHaveLength(3);
        expect(new Set(out.map(r => r.document.filePath)).size).toBe(3);
        expect(out.map(r => r.document.filePath)).toEqual(['a.md', 'b.md', 'c.md']);
    });

    it('respects the limit', () => {
        const out = dedupeRelatedByFile([hit('a.md', 0.9), hit('b.md', 0.8), hit('c.md', 0.7)], 'self.md', 2);
        expect(out).toHaveLength(2);
    });

    it('attachment chunks (same host filePath) collapse to one related-note entry', () => {
        // A note body chunk + two of its attachment chunks all share filePath host.md.
        const results = [
            hit('host.md', 0.8, 'host.md-0'),
            hit('host.md', 0.85, 'host.md::att::abcd1234#0'),
            hit('host.md', 0.7, 'host.md::att::abcd1234#1'),
            hit('other.md', 0.6),
        ];
        const out = dedupeRelatedByFile(results, 'self.md', 5);
        expect(out.map(r => r.document.filePath)).toEqual(['host.md', 'other.md']);
        expect(out[0].score).toBe(0.85); // best chunk (the attachment one) represents the note
    });
});
