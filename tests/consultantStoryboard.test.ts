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

    it('RECONCILES suggested_visual to visual_data.type (was a rejecting refine — now follows the data)', () => {
        const mismatched = { ...barSlide, suggested_visual: 'line' as const }; // bar data, line label
        const r = storyboardSlideSchema.safeParse(mismatched);
        expect(r.success).toBe(true);
        if (r.success) expect(r.data.suggested_visual).toBe('bar'); // reconciled to the actual data
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
    it('returns a typed err on STRUCTURALLY-invalid JSON (a slide missing required fields)', () => {
        // A visual mismatch now reconciles + a malformed visual degrades, so the err
        // path needs a STRUCTURAL break the .catch()/coerce can't save: a slide with no id/role.
        const r = parseStoryboardFromResponse(JSON.stringify({ thesis: 'x', slides: [{ core_message: 'orphan' }] }));
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

describe('over-long prose truncates instead of hard-failing (live 2026-06-08 core_message fix)', () => {
    it('a >800-char core_message no longer fails generation (was the storyboard blocker)', () => {
        const longMsg = 'EMEA cloud revenue compounding. '.repeat(40); // ~1280 chars, > old 800 cap
        const r = parseStoryboardFromResponse(JSON.stringify({ thesis: 'x', slides: [{ ...barSlide, core_message: longMsg }] }));
        expect(r.ok).toBe(true);
    });
    it('an extreme core_message (>1500) truncates with an ellipsis (graceful, not rejected)', () => {
        const huge = 'word '.repeat(500); // 2500 chars
        const r = parseStoryboardFromResponse(JSON.stringify({ thesis: 'x', slides: [{ ...barSlide, core_message: huge }] }));
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.value.slides[0].core_message.length).toBeLessThanOrEqual(1501);
            expect(r.value.slides[0].core_message.endsWith('…')).toBe(true);
        }
    });
    it('a long visual label truncates rather than failing the deck', () => {
        const slide = { ...barSlide, visual_data: { type: 'bar' as const, items: [{ label: 'x'.repeat(1000), value: 1, evidence_span_id: 'e1' }] } };
        const r = parseStoryboardFromResponse(JSON.stringify({ thesis: 'x', slides: [slide] }));
        expect(r.ok).toBe(true);
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

describe('malformed visual DEGRADES to bullets (systematic .catch() finisher — no more whack-a-mole)', () => {
    it('a line with <2 points falls back to a prose visual instead of failing the deck', () => {
        const slide = { ...barSlide, suggested_visual: 'line', visual_data: { type: 'line', series: [{ label: 'X', points: [{ x: 'a', y: 1, evidence_span_id: 'e1' }] }] } };
        const r = parseStoryboardFromResponse(JSON.stringify({ thesis: 'x', slides: [slide] }));
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.value.slides[0].visual_data.type).toBe('bullets'); // degraded
            expect(r.value.slides[0].suggested_visual).toBe('bullets'); // reconciled
        }
    });
    it('a harvey with >8 columns degrades to bullets rather than hard-failing', () => {
        const cols = Array.from({ length: 9 }, (_, i) => `c${i}`);
        const slide = { ...barSlide, suggested_visual: 'harvey', visual_data: { type: 'harvey', columns: cols, rows: [{ label: 'A', ratings: [1] }] } };
        const r = parseStoryboardFromResponse(JSON.stringify({ thesis: 'x', slides: [slide] }));
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value.slides[0].visual_data.type).toBe('bullets');
    });
    it('a suggested_visual ≠ visual_data.type mismatch reconciles (no longer rejected)', () => {
        const slide = { ...barSlide, suggested_visual: 'pyramid' }; // bar data, pyramid label
        const r = parseStoryboardFromResponse(JSON.stringify({ thesis: 'x', slides: [slide] }));
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value.slides[0].suggested_visual).toBe('bar'); // follows the data
    });
});

describe('ragged table/harvey rows COERCE to the column count (live 2026-06-08 — was a hard reject)', () => {
    it('pads a short harvey row with 0-ratings instead of failing the whole storyboard', () => {
        const slide = { ...barSlide, suggested_visual: 'harvey', visual_data: { type: 'harvey', columns: ['Cost', 'Speed'], rows: [{ label: 'A', ratings: [4] }] } };
        const r = parseStoryboardFromResponse(JSON.stringify({ thesis: 'x', slides: [slide] }));
        expect(r.ok).toBe(true);
        if (r.ok) {
            const v = r.value.slides[0].visual_data as { type: 'harvey'; rows: { ratings: number[] }[] };
            expect(v.rows[0].ratings).toEqual([4, 0]); // padded to 2 columns
        }
    });
    it('truncates a long harvey row to the column count', () => {
        const slide = { ...barSlide, suggested_visual: 'harvey', visual_data: { type: 'harvey', columns: ['Cost'], rows: [{ label: 'A', ratings: [4, 2, 1] }] } };
        const r = parseStoryboardFromResponse(JSON.stringify({ thesis: 'x', slides: [slide] }));
        expect(r.ok).toBe(true);
        if (r.ok) {
            const v = r.value.slides[0].visual_data as { type: 'harvey'; rows: { ratings: number[] }[] };
            expect(v.rows[0].ratings).toEqual([4]); // truncated to 1 column
        }
    });
    it('pads a short table row with an em-dash cell instead of failing', () => {
        const slide = { ...barSlide, suggested_visual: 'table', visual_data: { type: 'table', columns: ['A', 'B'], rows: [{ cells: [{ text: 'x' }] }] } };
        const r = parseStoryboardFromResponse(JSON.stringify({ thesis: 'x', slides: [slide] }));
        expect(r.ok).toBe(true);
        if (r.ok) {
            const v = r.value.slides[0].visual_data as { type: 'table'; rows: { cells: { text: string }[] }[] };
            expect(v.rows[0].cells).toHaveLength(2);
            expect(v.rows[0].cells[1].text).toBe('—');
        }
    });
});
