import { describe, it, expect } from 'vitest';
import {
    CONTENT_WIDTH, gridColumns, splitColumns, estimateTextHeight,
    tableColumnWidths,
} from '../src/services/presentationIr/irLayout';

describe('tableColumnWidths', () => {
    it('sums exactly to the content width (overflow regression)', () => {
        const w = tableColumnWidths(['Country', 'Import value'], [['USA', '$7.6B'], ['Germany', '$3.5B']], CONTENT_WIDTH);
        const sum = w.reduce((a, b) => a + b, 0);
        expect(sum).toBeCloseTo(CONTENT_WIDTH, 6);
    });

    it('never exceeds content width even with many wide columns', () => {
        const headers = Array.from({ length: 8 }, (_, i) => `Column header number ${i} with long text`);
        const rows = [headers.map(() => 'x'.repeat(40))];
        const w = tableColumnWidths(headers, rows, CONTENT_WIDTH);
        expect(w.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(CONTENT_WIDTH + 1e-9);
    });

    it('returns [] for no headers', () => {
        expect(tableColumnWidths([], [], CONTENT_WIDTH)).toEqual([]);
    });
});

describe('gridColumns / splitColumns', () => {
    it('grid columns sum (with gaps) to content width', () => {
        const cols = gridColumns(4);
        expect(cols).toHaveLength(4);
        const span = cols[3].x + cols[3].w - cols[0].x;
        expect(span).toBeCloseTo(CONTENT_WIDTH, 6);
    });

    it('two columns are non-overlapping with distinct x offsets', () => {
        const { left, right } = splitColumns();
        expect(right.x).toBeGreaterThan(left.x + left.w);
    });

    it('handles the max stat-card count (6) with non-negative widths (M2)', () => {
        const cols = gridColumns(6);
        expect(cols).toHaveLength(6);
        for (const c of cols) expect(c.w).toBeGreaterThanOrEqual(0);
    });
});

describe('estimateTextHeight', () => {
    it('grows with text length', () => {
        const short = estimateTextHeight('hi', 5, 14);
        const long = estimateTextHeight('x'.repeat(400), 5, 14);
        expect(long).toBeGreaterThan(short);
    });
});

