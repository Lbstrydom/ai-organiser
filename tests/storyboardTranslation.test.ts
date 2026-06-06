import { describe, it, expect } from 'vitest';
import { consultantStoryboardSchema } from '../src/services/presentationIr/consultantStoryboard';
import type { ConsultantStoryboard, VisualData } from '../src/services/presentationIr/consultantStoryboard';
import { translateStoryboardToIr, visualDataToBlock } from '../src/services/presentationIr/storyboardService';

/** Parse via the real schema so a malformed test fixture fails loudly. */
function sb(obj: unknown): ConsultantStoryboard {
    const r = consultantStoryboardSchema.safeParse(obj);
    if (!r.success) throw new Error('fixture invalid: ' + JSON.stringify(r.error.issues));
    return r.data as ConsultantStoryboard;
}

const barSlide = {
    id: 's1', role: 'insight', action_title: 'EMEA drove 60% of Q3 growth',
    core_message: 'EMEA led every region this quarter', evidence_span_ids: ['e1'],
    suggested_visual: 'bar',
    visual_data: { type: 'bar', unit: '%', items: [{ label: 'EMEA', value: 60, evidence_span_id: 'e1' }, { label: 'APAC', value: 30, evidence_span_id: 'e1' }] },
};

describe('visualDataToBlock', () => {
    it('bar → bar-chart with pct relative to the max value', () => {
        const block = visualDataToBlock(barSlide.visual_data as VisualData);
        expect(block?.kind).toBe('bar-chart');
        if (block?.kind === 'bar-chart') {
            // Labels keep the raw value (+ unit) so the number isn't dropped (H8).
            expect(block.bars).toEqual([{ label: 'EMEA (60%)', pct: 100 }, { label: 'APAC (30%)', pct: 50 }]);
            expect(block.axisLabel).toBe('%');
        }
    });

    it('table → table block (value preferred over text per cell)', () => {
        const v: VisualData = { type: 'table', columns: ['Metric', 'Q3'], rows: [{ cells: [{ text: 'Revenue' }, { text: '1.2', value: '1.2M', evidence_span_id: 'e1' }] }] };
        const block = visualDataToBlock(v);
        expect(block).toEqual({ kind: 'table', headers: ['Metric', 'Q3'], rows: [['Revenue', '1.2M']] });
    });

    it('line → native line-chart block (Cluster C)', () => {
        const v: VisualData = { type: 'line', series: [{ label: 'Rev', unit: '%', points: [{ x: '22', y: 1, evidence_span_id: 'e1' }, { x: '23', y: 2, evidence_span_id: 'e2' }] }] };
        const block = visualDataToBlock(v);
        expect(block?.kind).toBe('line-chart');
        if (block?.kind === 'line-chart') {
            expect(block.series[0].points).toEqual([{ x: '22', y: 1 }, { x: '23', y: 2 }]);
            expect(block.unit).toBe('%');
        }
    });

    it('waterfall → native waterfall block over base + deltas (Cluster C)', () => {
        const v: VisualData = { type: 'waterfall', unit: '€m', base: { label: 'Start', value: 100, evidence_span_id: 'e1' }, deltas: [{ label: 'EMEA', value: 20, evidence_span_id: 'e2' }], total: { label: 'End' } };
        const block = visualDataToBlock(v);
        expect(block?.kind).toBe('waterfall');
        if (block?.kind === 'waterfall') {
            expect(block.base).toEqual({ label: 'Start', value: 100 });
            expect(block.deltas[0]).toEqual({ label: 'EMEA', value: 20 });
            expect(block.total).toEqual({ label: 'End' });
            expect(block.unit).toBe('€m');
        }
    });

    it('2x2 → matrix-2x2 styled 3×3 table (axis labels + quadrant cells) (Cluster C)', () => {
        const v: VisualData = { type: '2x2', x_axis: { label: 'Effort', low_label: 'Low', high_label: 'High' }, y_axis: { label: 'Impact', low_label: 'Low', high_label: 'High' }, items: [{ label: 'A', quadrant: 'tr' }] };
        const block = visualDataToBlock(v);
        expect(block?.kind).toBe('table');
        if (block?.kind === 'table') {
            expect(block.style).toBe('matrix-2x2');
            expect(block.headers).toEqual(['Impact / Effort', 'Low', 'High']);
            // row 0 = y-high; 'A' is top-right (y high, x high) → tr cell.
            expect(block.rows[0]).toEqual(['High', '—', 'A']);
            expect(block.rows[1]).toEqual(['Low', '—', '—']);
        }
    });

    it('pyramid → native pyramid block (Cluster C)', () => {
        const v: VisualData = { type: 'pyramid', levels: [{ label: 'Vision' }, { label: 'Strategy', detail: 'the how' }] };
        const block = visualDataToBlock(v);
        expect(block).toEqual({ kind: 'pyramid', levels: [{ label: 'Vision' }, { label: 'Strategy', detail: 'the how' }] });
    });

    it('harvey → table fallback with filled/empty glyphs', () => {
        const v: VisualData = { type: 'harvey', columns: ['Cost', 'Speed'], rows: [{ label: 'Option A', ratings: [4, 1] }] };
        const block = visualDataToBlock(v);
        expect(block?.kind).toBe('table');
        if (block?.kind === 'table') expect(block.rows[0]).toEqual(['Option A', '●●●●', '●○○○']);
    });

    it('harvey with >7 columns keeps headers and rating cells the same width (audit M5)', () => {
        const cols = Array.from({ length: 10 }, (_, i) => `C${i}`);
        const v: VisualData = { type: 'harvey', columns: cols, rows: [{ label: 'A', ratings: cols.map(() => 3) }] };
        const block = visualDataToBlock(v);
        expect(block?.kind).toBe('table');
        if (block?.kind === 'table') {
            expect(block.headers).toHaveLength(8); // '' + 7 capped columns
            expect(block.rows[0]).toHaveLength(block.headers.length); // aligned — no overflow cells
        }
    });

    it('prose visuals → null (carried by the core_message paragraph)', () => {
        expect(visualDataToBlock({ type: 'bullets' })).toBeNull();
        expect(visualDataToBlock({ type: 'none' })).toBeNull();
        expect(visualDataToBlock({ type: 'stat-grid' })).toBeNull();
    });
});

describe('translateStoryboardToIr', () => {
    it('produces a valid SlideDeckIr: title slide (thesis) + content slides', () => {
        const storyboard = sb({ schemaVersion: 1, thesis: 'Growth was regionally concentrated', slides: [barSlide] });
        const r = translateStoryboardToIr(storyboard);
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.value.slides[0]).toMatchObject({ type: 'title', title: 'Growth was regionally concentrated' });
            expect(r.value.slides[1]).toMatchObject({ type: 'content', title: 'EMEA drove 60% of Q3 growth' });
            const blocks = r.value.slides[1].blocks;
            expect(blocks[0]).toEqual({ kind: 'paragraph', text: 'EMEA led every region this quarter' });
            expect(blocks[1].kind).toBe('bar-chart');
        }
    });

    it('introduces no new numbers — bars come only from cited values', () => {
        const storyboard = sb({ schemaVersion: 1, thesis: 'x', slides: [barSlide] });
        const r = translateStoryboardToIr(storyboard);
        expect(r.ok).toBe(true);
        if (r.ok && r.value.slides[1].blocks[1].kind === 'bar-chart') {
            expect(r.value.slides[1].blocks[1].bars.map((b) => b.pct)).toEqual([100, 50]);
        }
    });

    it('omits the supporting paragraph when core_message duplicates the title', () => {
        const dup = { ...barSlide, core_message: barSlide.action_title };
        const storyboard = sb({ schemaVersion: 1, thesis: 'x', slides: [dup] });
        const r = translateStoryboardToIr(storyboard);
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value.slides[1].blocks[0].kind).toBe('bar-chart'); // no leading paragraph
    });
});
