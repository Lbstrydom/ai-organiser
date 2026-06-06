// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { SlideIrSchema, validateDeckIr, IR_SCHEMA_VERSION } from '../src/services/presentationIr/slideIr';
import type { Block, SlideDeckIr } from '../src/services/presentationIr/slideIr';
import { consultantStoryboardSchema } from '../src/services/presentationIr/consultantStoryboard';
import type { ConsultantStoryboard } from '../src/services/presentationIr/consultantStoryboard';
import { translateStoryboardToIr } from '../src/services/presentationIr/storyboardService';
import { renderDeckToHtml } from '../src/services/presentationIr/irToHtml';
import { sanitizePresentation } from '../src/services/chat/presentationSanitizer';
import { resolveTheme } from '../src/services/export/exportTheme';

const theme = resolveTheme('navy-gold', '', '', 'Inter', 14);
function deckWith(block: Block): SlideDeckIr {
    return { schemaVersion: IR_SCHEMA_VERSION, slides: [{ id: 's1', type: 'content', title: 'T', blocks: [block] }] };
}
function renderHtml(block: Block): string {
    const r = renderDeckToHtml(deckWith(block), theme);
    if (!r.ok) throw new Error('render failed: ' + r.error);
    return r.value.html;
}

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

describe('Cluster C — HTML renders + sanitizer survival', () => {
    it('2×2 styled table renders an axis-labelled grid of quadrant cells', () => {
        const html = renderHtml({ kind: 'table', style: 'matrix-2x2', headers: ['Impact / Effort', 'Low', 'High'], rows: [['High', '—', 'Quick win'], ['Low', 'Avoid', '—']] });
        expect(html).toContain('display:grid');
        expect(html).toContain('Quick win'); // a quadrant cell
        expect(html).toContain('High');       // axis label
        // survives sanitization (grid CSS + text are allowlisted; the sanitizer
        // re-serializes CSS via CSSOM as `display: grid` with a space).
        const clean = sanitizePresentation(html).html;
        expect(clean).toContain('Quick win');
        expect(clean).toMatch(/display:\s*grid/);
    });

    it('rating table renders harvey glyphs + a visually-hidden "N of M" text node (a11y, no aria)', () => {
        const html = renderHtml({ kind: 'table', style: 'rating', headers: ['Option', 'Cost'], rows: [['Vendor A', '●●●○']] });
        expect(html).toContain('●●●○');
        expect(html).toContain('3 of 4'); // visually-hidden text alternative
        const clean = sanitizePresentation(html).html;
        expect(clean).toContain('3 of 4'); // the clip-free hidden span survives (aria would be stripped)
        expect(clean).toContain('●●●○');
    });

    it('waterfall renders signed step values + connected bars', () => {
        const html = renderHtml({ kind: 'waterfall', unit: '€m', base: { label: 'Start', value: 100 }, deltas: [{ label: 'EMEA', value: 20 }, { label: 'APAC', value: -10 }], total: { label: 'End' } });
        expect(html).toContain('Start');
        expect(html).toContain('+20 €m');  // signed delta value
        expect(html).toContain('-10 €m');
        expect(sanitizePresentation(html).html).toContain('Start');
    });

    it('line-chart renders an SVG polyline that survives sanitization', () => {
        const html = renderHtml({ kind: 'line-chart', unit: '%', series: [{ label: 'Rev', points: [{ x: '22', y: 1 }, { x: '23', y: 2 }, { x: '24', y: 4 }] }] });
        expect(html).toContain('<polyline');
        const clean = sanitizePresentation(html).html;
        expect(clean).toContain('<polyline'); // SVG polyline is allowlisted
        expect(clean).toContain('22');         // x-axis tick text
    });

    it('pyramid renders ≥3 stacked levels', () => {
        const html = renderHtml({ kind: 'pyramid', levels: [{ label: 'Vision' }, { label: 'Strategy' }, { label: 'Tactics', detail: 'the how' }] });
        expect(html).toContain('Vision');
        expect(html).toContain('Strategy');
        expect(html).toContain('Tactics');
        expect(html).toContain('the how');
        expect(sanitizePresentation(html).html).toContain('Tactics');
    });

    it('a full storyboard with all 5 visuals translates + renders without error', () => {
        const storyboard = sb({
            schemaVersion: 1, thesis: 'x',
            slides: [
                { id: 'a', role: 'insight', action_title: 'Trend up', core_message: 'm', evidence_span_ids: [], suggested_visual: 'line', visual_data: { type: 'line', series: [{ label: 'R', points: [{ x: '1', y: 1, evidence_span_id: 'e1' }, { x: '2', y: 3, evidence_span_id: 'e2' }] }] } },
                { id: 'b', role: 'proof', action_title: 'Bridge', core_message: 'm', evidence_span_ids: [], suggested_visual: 'waterfall', visual_data: { type: 'waterfall', base: { label: 'S', value: 100, evidence_span_id: 'e1' }, deltas: [{ label: 'D', value: 20, evidence_span_id: 'e2' }] } },
                { id: 'c', role: 'recommendation', action_title: 'Prioritise', core_message: 'm', evidence_span_ids: [], suggested_visual: '2x2', visual_data: { type: '2x2', x_axis: { label: 'Eff', low_label: 'L', high_label: 'H' }, y_axis: { label: 'Imp', low_label: 'L', high_label: 'H' }, items: [{ label: 'A', quadrant: 'tr' }] } },
                { id: 'd', role: 'context', action_title: 'Hierarchy', core_message: 'm', evidence_span_ids: [], suggested_visual: 'pyramid', visual_data: { type: 'pyramid', levels: [{ label: 'V' }, { label: 'S' }] } },
            ],
        });
        const ir = translateStoryboardToIr(storyboard);
        expect(ir.ok).toBe(true);
        if (!ir.ok) return;
        const r = renderDeckToHtml(ir.value, theme);
        expect(r.ok).toBe(true);
    });
});
