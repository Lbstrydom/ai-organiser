import { describe, it, expect } from 'vitest';
import { normaliseNumeric, checkClaim, selfCheckStoryboard } from '../src/services/presentationIr/evidenceGrounding';
import type { EvidenceSpan, ConsultantStoryboard } from '../src/services/presentationIr/consultantStoryboard';

const spans: EvidenceSpan[] = [
    { id: 'e1', source_ref: 'notes.md', text: 'EMEA revenue grew 60% in Q3, leading all regions.' },
    { id: 'e2', source_ref: 'notes.md', text: 'Revenue rose from 40 to 64 over the year.' },
];

describe('normaliseNumeric', () => {
    it('normalises % / percent / decimal / thousands', () => {
        expect(normaliseNumeric('60%')).toBeCloseTo(0.6);
        expect(normaliseNumeric('60 percent')).toBeCloseTo(0.6);
        expect(normaliseNumeric('0.60')).toBeCloseTo(0.6);
        expect(normaliseNumeric('1,234')).toBe(1234);
        expect(normaliseNumeric('nope')).toBeNull();
    });
});

describe('checkClaim tiers', () => {
    it('exact-matches a verbatim figure', () => {
        const c = checkClaim('EMEA drove 60% of growth', [spans[0]], { slideId: 's1', field: 'action_title' });
        expect(c.tier).toBe('exact');
        expect(c.needsLlm).toBe(false);
    });
    it('passes a non-numeric claim as grounded-text', () => {
        const c = checkClaim('EMEA led all regions', [spans[0]], { slideId: 's1', field: 'action_title' });
        expect(c.tier).toBe('grounded-text');
    });
    it('flags an inferential number (not a direct match) for the LLM', () => {
        const c = checkClaim('Revenue grew 60% year on year', [spans[1]], { slideId: 's1', field: 'action_title' });
        expect(c.tier).toBe('inferential'); // 60% not verbatim in "40 to 64"
        expect(c.needsLlm).toBe(true);
    });
    it('marks a number with NO cited spans as ungrounded (blocker)', () => {
        const c = checkClaim('Revenue grew 99%', [], { slideId: 's1', field: 'action_title' });
        expect(c.tier).toBe('ungrounded');
    });
});

describe('selfCheckStoryboard', () => {
    const deck: ConsultantStoryboard = {
        schemaVersion: 1,
        thesis: 'Growth was regionally concentrated',
        slides: [{
            id: 's1', role: 'insight', action_title: 'EMEA drove 60% of Q3 growth', core_message: 'Concentration',
            evidence_span_ids: ['e1'], suggested_visual: 'bar',
            visual_data: { type: 'bar', unit: '%', items: [{ label: 'EMEA', value: 60, evidence_span_id: 'e1' }] },
        }],
    };
    it('grounds a deck whose numbers trace to cited spans (no blockers, no dangling)', () => {
        const r = selfCheckStoryboard(deck, spans);
        expect(r.blockers.length).toBe(0);
        expect(r.danglingSpanIds.length).toBe(0);
    });
    it('reports a dangling evidence_span_id', () => {
        const bad = { ...deck, slides: [{ ...deck.slides[0], evidence_span_ids: ['nope'] }] };
        const r = selfCheckStoryboard(bad, spans);
        expect(r.danglingSpanIds).toContain('nope');
    });
});

describe('numeric matching is token-bounded (audit H10)', () => {
    const span: EvidenceSpan[] = [{ id: 'e1', source_ref: 's', text: 'We shipped 160 widgets.' }];
    it('a claim of "6" does NOT match the "160" in a cited span', () => {
        const c = checkClaim('we saw 6 issues', span, { slideId: 's1', field: 'core_message' });
        expect(c.tier).not.toBe('exact');
        expect(c.tier).not.toBe('numeric');
    });
    it('a verbatim numeric token still matches', () => {
        const c = checkClaim('we shipped 160 units', span, { slideId: 's1', field: 'core_message' });
        expect(c.tier).toBe('exact');
    });
    it('a magnitude claim does NOT match a bare number of the same digits (consolidated gate H1)', () => {
        const src: EvidenceSpan[] = [{ id: 'e1', source_ref: 's', text: 'We counted 50 apples.' }];
        const c = checkClaim('revenue hit $50 billion', src, { slideId: 's1', field: 'action_title' });
        expect(c.tier).not.toBe('exact');
        expect(c.tier).not.toBe('numeric'); // "50 billion" (mag b) ≠ "50" (no mag) → routed to the judge
    });
    it('a magnitude claim matches the SAME magnitude in a span', () => {
        const src: EvidenceSpan[] = [{ id: 'e1', source_ref: 's', text: 'Revenue was 50 billion last year.' }];
        const c = checkClaim('revenue hit 50 billion', src, { slideId: 's1', field: 'action_title' });
        expect(c.tier === 'exact' || c.tier === 'numeric').toBe(true);
    });
    it('"60 percent" in a span matches a "60%" claim (audit M6/M12)', () => {
        const pctSpan: EvidenceSpan[] = [{ id: 'e1', source_ref: 's', text: 'EMEA was 60 percent of growth.' }];
        const c = checkClaim('EMEA drove 60% of growth', pctSpan, { slideId: 's1', field: 'action_title' });
        expect(c.tier === 'exact' || c.tier === 'numeric').toBe(true);
    });
});

describe('numeric table cells are grounded (audit H4/H8)', () => {
    const cat: EvidenceSpan[] = [{ id: 'e1', source_ref: 's', text: 'Q3 revenue was 1.2 and Q2 was 0.9.' }];
    function tableDeck(cellEvidence: string | undefined): ConsultantStoryboard {
        return {
            schemaVersion: 1, thesis: 't',
            slides: [{
                id: 's1', role: 'proof', action_title: 'Revenue climbed quarter over quarter', core_message: 'growth',
                evidence_span_ids: [], suggested_visual: 'table',
                visual_data: { type: 'table', columns: ['Q', 'Rev'], rows: [{ cells: [{ text: 'Q3' }, { text: '1.2', value: '1.2', ...(cellEvidence ? { evidence_span_id: cellEvidence } : {}) }] }] },
            }],
        } as ConsultantStoryboard;
    }
    it('a cited table-cell number that matches its span is grounded (no blocker, not inferential)', () => {
        const r = selfCheckStoryboard(tableDeck('e1'), cat);
        expect(r.blockers.length).toBe(0);
        expect(r.inferential.length).toBe(0);
    });
    it('a cited table-cell number that does NOT match its span is inferential', () => {
        const wrong: EvidenceSpan[] = [{ id: 'e1', source_ref: 's', text: 'Revenue was 9.9 last year.' }];
        const r = selfCheckStoryboard(tableDeck('e1'), wrong);
        expect(r.inferential.some((c) => c.field === 'visual_data')).toBe(true);
    });
    it('an UNCITED wholly-numeric cell is a blocker; a label cell with a digit ("Q3") is not (audit H10)', () => {
        const r = selfCheckStoryboard(tableDeck(undefined), cat);
        // The "1.2" value cell has no citation → ungrounded blocker.
        expect(r.blockers.some((b) => b.field === 'visual_data')).toBe(true);
        // The "Q3" label cell must NOT be treated as a number (exactly one visual blocker).
        expect(r.blockers.filter((b) => b.field === 'visual_data').length).toBe(1);
    });
});

describe('2×2 / harvey numeric labels are grounded (consolidated gate H3)', () => {
    const cat: EvidenceSpan[] = [{ id: 'e1', source_ref: 's', text: 'EMEA delivered 99 wins.' }];
    function deck2x2(itemLabel: string, evidence?: string): ConsultantStoryboard {
        return {
            schemaVersion: 1, thesis: 't',
            slides: [{
                id: 's1', role: 'recommendation', action_title: 'Prioritise', core_message: 'm', evidence_span_ids: [], suggested_visual: '2x2',
                visual_data: { type: '2x2', x_axis: { label: 'Eff', low_label: 'L', high_label: 'H' }, y_axis: { label: 'Imp', low_label: 'L', high_label: 'H' }, items: [{ label: itemLabel, quadrant: 'tr', ...(evidence ? { evidence_span_id: evidence } : {}) }] },
            }],
        } as ConsultantStoryboard;
    }
    it('an UNCITED numeric 2×2 item label is an ungrounded blocker', () => {
        const r = selfCheckStoryboard(deck2x2('EMEA hit 250 wins'), cat);
        expect(r.blockers.some((b) => b.field === 'visual_data')).toBe(true);
    });
    it('a purely categorical 2×2 label (no number) is not flagged', () => {
        const r = selfCheckStoryboard(deck2x2('EMEA expansion'), cat);
        expect(r.blockers.some((b) => b.field === 'visual_data')).toBe(false);
    });
});
