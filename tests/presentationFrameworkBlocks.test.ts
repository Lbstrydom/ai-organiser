import { describe, it, expect } from 'vitest';
import { SlideIrSchema, validateDeckIr, IR_SCHEMA_VERSION } from '../src/services/presentationIr/slideIr';
import { consultantStoryboardSchema } from '../src/services/presentationIr/consultantStoryboard';
import type { ConsultantStoryboard } from '../src/services/presentationIr/consultantStoryboard';
import { translateStoryboardToIr } from '../src/services/presentationIr/storyboardService';

function sb(obj: unknown): ConsultantStoryboard {
    const r = consultantStoryboardSchema.safeParse(obj);
    if (!r.success) throw new Error('fixture invalid: ' + JSON.stringify(r.error.issues));
    return r.data as ConsultantStoryboard;
}

// Cluster C — Phase 5 foundation: table `style` + slide provenance (the dual-renderer
// native rendering of the 3 new block kinds is a separate phase).
describe('Cluster C foundation — table style + provenance (schema)', () => {
    it('SlideIrSchema accepts a matrix-2x2 styled table', () => {
        const r = SlideIrSchema.safeParse({
            id: 's1', type: 'content', blocks: [{ kind: 'table', style: 'matrix-2x2', headers: ['A', 'B'], rows: [['x', 'y']] }],
        });
        expect(r.success).toBe(true);
    });

    it('SlideIrSchema accepts a rating styled table', () => {
        const r = SlideIrSchema.safeParse({
            id: 's1', type: 'content', blocks: [{ kind: 'table', style: 'rating', headers: ['Option', 'Cost'], rows: [['A', '●●●○']] }],
        });
        expect(r.success).toBe(true);
    });

    it('rejects an unknown table style (strict union)', () => {
        const r = SlideIrSchema.safeParse({
            id: 's1', type: 'content', blocks: [{ kind: 'table', style: 'pie', headers: ['A'], rows: [['x']] }],
        });
        expect(r.success).toBe(false);
    });

    it('SlideIrSchema accepts optional provenance (action_title + storyboard_slide_id)', () => {
        const r = SlideIrSchema.safeParse({
            id: 's1', type: 'content', blocks: [], action_title: 'EMEA drove growth', storyboard_slide_id: 'sb-1',
        });
        expect(r.success).toBe(true);
    });

    it('a legacy slide WITHOUT provenance/style still strict-parses (additive, optional)', () => {
        const r = SlideIrSchema.safeParse({ id: 's1', type: 'content', blocks: [{ kind: 'table', headers: ['A'], rows: [['x']] }] });
        expect(r.success).toBe(true);
    });

    it('validateDeckIr accepts a deck using the new fields', () => {
        const deck = {
            schemaVersion: IR_SCHEMA_VERSION,
            slides: [{ id: 's1', type: 'content', action_title: 'T', storyboard_slide_id: 'sb1', blocks: [{ kind: 'table', style: 'matrix-2x2', headers: ['A', 'B'], rows: [['x', 'y']] }] }],
        };
        expect(validateDeckIr(deck).ok).toBe(true);
    });
});

describe('Cluster C foundation — translator tags styled tables + provenance', () => {
    it('a 2×2 storyboard visual translates to a matrix-2x2 styled table + slide provenance', () => {
        const storyboard = sb({
            schemaVersion: 1, thesis: 'x',
            slides: [{
                id: 'sb1', role: 'recommendation', action_title: 'Prioritise quick wins', core_message: 'effort vs impact',
                evidence_span_ids: [], suggested_visual: '2x2',
                visual_data: { type: '2x2', x_axis: { label: 'Effort', low_label: 'Low', high_label: 'High' }, y_axis: { label: 'Impact', low_label: 'Low', high_label: 'High' }, items: [{ label: 'A', quadrant: 'tr' }] },
            }],
        });
        const r = translateStoryboardToIr(storyboard);
        expect(r.ok).toBe(true);
        if (r.ok) {
            const slide = r.value.slides[1];
            expect(slide.action_title).toBe('Prioritise quick wins');
            expect(slide.storyboard_slide_id).toBe('sb1');
            const table = slide.blocks.find((b) => b.kind === 'table');
            expect(table && table.kind === 'table' && table.style).toBe('matrix-2x2');
        }
    });

    it('a harvey storyboard visual translates to a rating styled table', () => {
        const storyboard = sb({
            schemaVersion: 1, thesis: 'x',
            slides: [{
                id: 'sb1', role: 'proof', action_title: 'Vendor A leads on cost', core_message: 'compare',
                evidence_span_ids: [], suggested_visual: 'harvey',
                visual_data: { type: 'harvey', columns: ['Cost', 'Speed'], rows: [{ label: 'A', ratings: [4, 2] }] },
            }],
        });
        const r = translateStoryboardToIr(storyboard);
        expect(r.ok).toBe(true);
        if (r.ok) {
            const table = r.value.slides[1].blocks.find((b) => b.kind === 'table');
            expect(table && table.kind === 'table' && table.style).toBe('rating');
        }
    });
});
