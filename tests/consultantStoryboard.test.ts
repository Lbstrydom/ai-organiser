import { describe, it, expect } from 'vitest';
import {
    consultantStoryboardSchema,
    storyboardSlideSchema,
    visualDataSchema,
    parseStoryboardFromResponse,
    validateStoryboard,
    STORYBOARD_SCHEMA_VERSION,
} from '../src/services/presentationIr/consultantStoryboard';

const barSlide = {
    id: 's1',
    role: 'insight' as const,
    action_title: 'EMEA drove 60% of Q3 growth',
    core_message: 'Regional revenue concentration',
    evidence_span_ids: ['e1'],
    suggested_visual: 'bar' as const,
    visual_data: { type: 'bar' as const, unit: '%', items: [{ label: 'EMEA', value: 60, evidence_span_id: 'e1' }] },
};

const deck = { thesis: 'Growth was regionally concentrated', slides: [barSlide] };

describe('ConsultantStoryboard schema', () => {
    it('accepts a well-formed deck + defaults schemaVersion', () => {
        const r = consultantStoryboardSchema.safeParse(deck);
        expect(r.success).toBe(true);
        if (r.success) expect(r.data.schemaVersion).toBe(STORYBOARD_SCHEMA_VERSION);
    });

    it('REQUIRES suggested_visual === visual_data.type (the refine)', () => {
        const bad = { ...barSlide, suggested_visual: 'line' as const };
        const r = storyboardSlideSchema.safeParse(bad);
        expect(r.success).toBe(false);
        if (!r.success) expect(r.error.issues[0].message).toMatch(/suggested_visual must equal visual_data.type/);
    });

    it('strict-rejects a hallucinated/unknown field (not silently stripped)', () => {
        const bad = { ...barSlide, made_up_field: 'x' };
        expect(storyboardSlideSchema.safeParse(bad).success).toBe(false);
    });

    it('every numeric visual value requires an evidence_span_id', () => {
        const noEvidence = { type: 'bar', unit: '%', items: [{ label: 'EMEA', value: 60 }] };
        expect(visualDataSchema.safeParse(noEvidence).success).toBe(false);
    });

    it('validates each visual_data variant (line/waterfall/2x2/pyramid/harvey/table)', () => {
        expect(visualDataSchema.safeParse({ type: 'line', series: [{ label: 'Rev', points: [{ x: '22', y: 1, evidence_span_id: 'e1' }, { x: '23', y: 2, evidence_span_id: 'e2' }] }] }).success).toBe(true);
        expect(visualDataSchema.safeParse({ type: 'waterfall', base: { label: 'Start', value: 100, evidence_span_id: 'e1' }, deltas: [{ label: 'EMEA', value: 20, evidence_span_id: 'e2' }] }).success).toBe(true);
        expect(visualDataSchema.safeParse({ type: '2x2', x_axis: { label: 'Effort', low_label: 'Low', high_label: 'High' }, y_axis: { label: 'Impact', low_label: 'Low', high_label: 'High' }, items: [{ label: 'A', quadrant: 'tr' }] }).success).toBe(true);
        expect(visualDataSchema.safeParse({ type: 'pyramid', levels: [{ label: 'Top' }, { label: 'Base' }] }).success).toBe(true);
        expect(visualDataSchema.safeParse({ type: 'harvey', columns: ['Cost'], rows: [{ label: 'Opt A', ratings: [3] }] }).success).toBe(true);
        expect(visualDataSchema.safeParse({ type: 'table', columns: ['A'], rows: [{ cells: [{ text: 'x' }] }] }).success).toBe(true);
    });

    it('rejects a bad quadrant + an out-of-range harvey rating', () => {
        expect(visualDataSchema.safeParse({ type: '2x2', x_axis: { label: 'x', low_label: 'l', high_label: 'h' }, y_axis: { label: 'y', low_label: 'l', high_label: 'h' }, items: [{ label: 'A', quadrant: 'middle' }] }).success).toBe(false);
        expect(visualDataSchema.safeParse({ type: 'harvey', columns: ['c'], rows: [{ label: 'r', ratings: [5] }] }).success).toBe(false);
    });
});

describe('parseStoryboardFromResponse', () => {
    it('parses a fenced JSON response', () => {
        const raw = 'Here is the storyboard:\n```json\n' + JSON.stringify(deck) + '\n```';
        const r = parseStoryboardFromResponse(raw);
        expect(r.ok).toBe(true);
    });
    it('returns a typed err on no JSON', () => {
        const r = parseStoryboardFromResponse('no json here');
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toMatch(/no JSON object found/);
    });
    it('returns a typed err on schema-invalid JSON', () => {
        const r = parseStoryboardFromResponse(JSON.stringify({ thesis: 'x', slides: [{ ...barSlide, suggested_visual: 'line' }] }));
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toMatch(/schema validation failed/);
    });
    it('strips zero-width chars at the parse boundary (Gemini-gate: no revision-cycle accumulation)', () => {
        const zwsp = '​';
        const dirty = { thesis: `Growth ${zwsp}<${zwsp}strong>`, slides: [{ ...barSlide, action_title: `EMEA ${zwsp}drove 60%` }] };
        const r = parseStoryboardFromResponse(JSON.stringify(dirty));
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.value.thesis).not.toContain(zwsp);
            expect(r.value.slides[0].action_title).not.toContain(zwsp);
        }
    });
});

describe('validateStoryboard (snapshot restore)', () => {
    it('strips zero-width chars from a restored snapshot too', () => {
        const zwsp = '​';
        const r = validateStoryboard({ ...deck, thesis: `Growth${zwsp}${zwsp} concentrated` });
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value.thesis).not.toContain(zwsp);
    });
});

describe('column-length invariant (consolidated gate MEDIUM)', () => {
    it('rejects a harvey row whose ratings count != columns count', () => {
        const slide = { ...barSlide, suggested_visual: 'harvey', visual_data: { type: 'harvey', columns: ['Cost', 'Speed'], rows: [{ label: 'A', ratings: [4] }] } };
        const r = parseStoryboardFromResponse(JSON.stringify({ thesis: 'x', slides: [slide] }));
        expect(r.ok).toBe(false);
    });
    it('rejects a table row whose cells count != columns count', () => {
        const slide = { ...barSlide, suggested_visual: 'table', visual_data: { type: 'table', columns: ['A', 'B'], rows: [{ cells: [{ text: 'x' }] }] } };
        const r = parseStoryboardFromResponse(JSON.stringify({ thesis: 'x', slides: [slide] }));
        expect(r.ok).toBe(false);
    });
});
