import { describe, it, expect } from 'vitest';
import { computeLineDiff, getDiffStats, hasMeaningfulChanges, DiffLine } from '../src/utils/mermaidDiff';

// ── computeLineDiff ──────────────────────────────────────────────────────────

describe('computeLineDiff', () => {
    it('identical code produces all unchanged lines', () => {
        const code = 'flowchart TD\n  A --> B\n  B --> C';
        const diff = computeLineDiff(code, code);
        expect(diff.every(l => l.type === 'unchanged')).toBe(true);
        expect(diff).toHaveLength(3);
    });

    it('detects added line at end', () => {
        const old = 'flowchart TD\n  A --> B';
        const next = 'flowchart TD\n  A --> B\n  B --> C';
        const diff = computeLineDiff(old, next);
        const added = diff.filter(l => l.type === 'added');
        expect(added).toHaveLength(1);
        expect(added[0].content).toBe('  B --> C');
    });

    it('detects removed line at end', () => {
        const old = 'flowchart TD\n  A --> B\n  B --> C';
        const next = 'flowchart TD\n  A --> B';
        const diff = computeLineDiff(old, next);
        const removed = diff.filter(l => l.type === 'removed');
        expect(removed).toHaveLength(1);
        expect(removed[0].content).toBe('  B --> C');
    });

    it('detects line changed in middle', () => {
        const old = 'flowchart TD\n  A --> B\n  B --> C';
        const next = 'flowchart TD\n  A --> X\n  B --> C';
        const diff = computeLineDiff(old, next);
        const added = diff.filter(l => l.type === 'added');
        const removed = diff.filter(l => l.type === 'removed');
        expect(removed.some(l => l.content === '  A --> B')).toBe(true);
        expect(added.some(l => l.content === '  A --> X')).toBe(true);
    });

    it('handles empty old string — all lines added', () => {
        const diff = computeLineDiff('', 'flowchart TD\n  A --> B');
        expect(diff.every(l => l.type === 'added')).toBe(true);
        expect(diff).toHaveLength(2);
    });

    it('handles empty new string — all lines removed', () => {
        const diff = computeLineDiff('flowchart TD\n  A --> B', '');
        expect(diff.every(l => l.type === 'removed')).toBe(true);
        expect(diff).toHaveLength(2);
    });

    it('both empty strings produce empty diff', () => {
        expect(computeLineDiff('', '')).toHaveLength(0);
    });

    it('preserves shared lines as unchanged when surrounding lines change', () => {
        const old = 'flowchart TD\n  A --> B\n  B --> C';
        const next = 'flowchart TD\n  A --> B\n  B --> D';
        const diff = computeLineDiff(old, next);
        const unchanged = diff.filter(l => l.type === 'unchanged');
        expect(unchanged.some(l => l.content === 'flowchart TD')).toBe(true);
        expect(unchanged.some(l => l.content === '  A --> B')).toBe(true);
    });

    it('diagram type switch produces meaningful changes', () => {
        const old = 'flowchart TD\n  A --> B';
        const next = 'sequenceDiagram\n  Alice->>Bob: Hello';
        const diff = computeLineDiff(old, next);
        expect(hasMeaningfulChanges(diff)).toBe(true);
    });

    it('result ordering matches new file order for added lines', () => {
        const old = 'A';
        const next = 'A\nB\nC';
        const diff = computeLineDiff(old, next);
        const addedContents = diff.filter(l => l.type === 'added').map(l => l.content);
        expect(addedContents).toEqual(['B', 'C']);
    });

    it('single-line change: one removed + one added', () => {
        const diff = computeLineDiff('old', 'new');
        expect(diff.filter(l => l.type === 'removed')).toHaveLength(1);
        expect(diff.filter(l => l.type === 'added')).toHaveLength(1);
    });
});

// ── getDiffStats ─────────────────────────────────────────────────────────────

describe('getDiffStats', () => {
    it('counts each type correctly on a mixed diff', () => {
        const diff: DiffLine[] = [
            { type: 'unchanged', content: 'flowchart TD' },
            { type: 'removed',   content: '  A --> B' },
            { type: 'added',     content: '  A --> C' },
            { type: 'added',     content: '  C --> D' },
        ];
        const stats = getDiffStats(diff);
        expect(stats.unchanged).toBe(1);
        expect(stats.removed).toBe(1);
        expect(stats.added).toBe(2);
    });

    it('returns all zeros for empty diff', () => {
        const stats = getDiffStats([]);
        expect(stats).toEqual({ added: 0, removed: 0, unchanged: 0 });
    });

    it('returns zero changes for identical code diff', () => {
        const code = 'flowchart TD';
        const stats = getDiffStats(computeLineDiff(code, code));
        expect(stats.added).toBe(0);
        expect(stats.removed).toBe(0);
        expect(stats.unchanged).toBe(1);
    });
});

// ── hasMeaningfulChanges ─────────────────────────────────────────────────────

describe('hasMeaningfulChanges', () => {
    it('returns false for identical code', () => {
        const code = 'flowchart TD\n  A --> B';
        expect(hasMeaningfulChanges(computeLineDiff(code, code))).toBe(false);
    });

    it('returns true when a line is added', () => {
        const diff = computeLineDiff('A', 'A\nB');
        expect(hasMeaningfulChanges(diff)).toBe(true);
    });

    it('returns true when a line is removed', () => {
        const diff = computeLineDiff('A\nB', 'A');
        expect(hasMeaningfulChanges(diff)).toBe(true);
    });

    it('returns true when a line is changed', () => {
        const diff = computeLineDiff('A', 'B');
        expect(hasMeaningfulChanges(diff)).toBe(true);
    });

    it('returns false for empty-to-empty diff', () => {
        expect(hasMeaningfulChanges(computeLineDiff('', ''))).toBe(false);
    });
});
