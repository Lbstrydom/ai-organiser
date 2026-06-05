import { describe, it, expect } from 'vitest';
import { consultantStoryboardSchema } from '../src/services/presentationIr/consultantStoryboard';
import type { ConsultantStoryboard } from '../src/services/presentationIr/consultantStoryboard';
import { selfCheckStoryboard } from '../src/services/presentationIr/evidenceGrounding';
import type { EvidenceSpan } from '../src/services/presentationIr/consultantStoryboard';
import { auditStoryboard, auditStoryboardWithJudge } from '../src/services/chat/consultantAuditService';

function sb(obj: unknown): ConsultantStoryboard {
    const r = consultantStoryboardSchema.safeParse(obj);
    if (!r.success) throw new Error('fixture invalid: ' + JSON.stringify(r.error.issues));
    return r.data as ConsultantStoryboard;
}

const catalog: EvidenceSpan[] = [{ id: 'e1', source_ref: 'q3.md', text: 'EMEA was 60% and APAC 30% of growth in Q3.' }];

function slide(over: Record<string, unknown> = {}) {
    return {
        id: 's1', role: 'insight', action_title: 'EMEA drove 60% of Q3 growth',
        core_message: 'EMEA led every region', evidence_span_ids: ['e1'],
        suggested_visual: 'bar',
        visual_data: { type: 'bar', unit: '%', items: [{ label: 'EMEA', value: 60, evidence_span_id: 'e1' }, { label: 'APAC', value: 30, evidence_span_id: 'e1' }] },
        ...over,
    };
}

describe('auditStoryboard (deterministic core)', () => {
    it('a clean grounded slide with an action title yields no findings', () => {
        const storyboard = sb({ schemaVersion: 1, thesis: 'x', slides: [slide()] });
        const grounding = selfCheckStoryboard(storyboard, catalog);
        const res = auditStoryboard(storyboard, grounding);
        expect(res.findings).toHaveLength(0);
    });

    it('a label-like title is a minor action-title flag', () => {
        const storyboard = sb({ schemaVersion: 1, thesis: 'x', slides: [slide({ action_title: 'Revenue by region', evidence_span_ids: [], visual_data: { type: 'none' }, suggested_visual: 'none' })] });
        const grounding = selfCheckStoryboard(storyboard, catalog);
        const res = auditStoryboard(storyboard, grounding);
        const f = res.findings.find((x) => x.dimension === 'action-title');
        expect(f?.severity).toBe('minor');
    });

    it('a number with NO cited evidence becomes a blocker (ungrounded); a number with a non-matching citation is inferential, not a blocker', () => {
        // 99% in the title, but the slide cites NO spans → ungrounded → blocker.
        const storyboard = sb({ schemaVersion: 1, thesis: 'x', slides: [slide({ action_title: 'EMEA hit 99% adoption', evidence_span_ids: [], suggested_visual: 'none', visual_data: { type: 'none' } })] });
        const grounding = selfCheckStoryboard(storyboard, catalog);
        const res = auditStoryboard(storyboard, grounding);
        expect(res.findings.some((f) => f.dimension === 'grounding' && f.severity === 'blocker')).toBe(true);

        // A number cited against a real (but non-matching) span is inferential → routed to the LLM judge, NOT a hard blocker.
        const inferential = sb({ schemaVersion: 1, thesis: 'x', slides: [slide({ action_title: 'EMEA hit 99% adoption', evidence_span_ids: ['e1'], suggested_visual: 'none', visual_data: { type: 'none' } })] });
        const g2 = selfCheckStoryboard(inferential, catalog);
        const r2 = auditStoryboard(inferential, g2);
        expect(r2.findings.some((f) => f.dimension === 'grounding' && f.severity === 'blocker')).toBe(false);
    });

    it('a dangling evidence id is a deck-level blocker', () => {
        const storyboard = sb({ schemaVersion: 1, thesis: 'x', slides: [slide({ evidence_span_ids: ['nope'], action_title: 'EMEA led growth this quarter' })] });
        const grounding = selfCheckStoryboard(storyboard, catalog);
        const res = auditStoryboard(storyboard, grounding);
        const f = res.findings.find((x) => x.dimension === 'grounding' && /Dangling/.test(x.message));
        expect(f).toBeTruthy();
        expect(f?.slideId).toBeUndefined(); // deck-level
    });

    it('a chart with <2 data points is a minor chart-appropriateness flag', () => {
        const storyboard = sb({ schemaVersion: 1, thesis: 'x', slides: [slide({ action_title: 'EMEA drove growth', visual_data: { type: 'bar', items: [{ label: 'EMEA', value: 60, evidence_span_id: 'e1' }] } })] });
        const grounding = selfCheckStoryboard(storyboard, catalog);
        const res = auditStoryboard(storyboard, grounding);
        expect(res.findings.some((f) => f.dimension === 'chart-appropriateness')).toBe(true);
    });

    it('groups findings by slide id (deck-level under the empty key)', () => {
        const storyboard = sb({ schemaVersion: 1, thesis: 'x', slides: [slide({ evidence_span_ids: ['nope'], action_title: 'EMEA led growth this quarter' })] });
        const grounding = selfCheckStoryboard(storyboard, catalog);
        const res = auditStoryboard(storyboard, grounding);
        expect(res.bySlide.get('')?.length).toBeGreaterThan(0); // dangling → deck-level
    });
});

describe('auditStoryboardWithJudge', () => {
    const storyboard = sb({ schemaVersion: 1, thesis: 'x', slides: [slide()] });

    it('appends judge findings to the deterministic core', async () => {
        const grounding = selfCheckStoryboard(storyboard, catalog);
        const res = await auditStoryboardWithJudge(storyboard, grounding, async () => ({ findings: [{ dimension: 'mece', severity: 'major', message: 'overlap between s1 and s2' }] }));
        expect(res.findings.some((f) => f.dimension === 'mece')).toBe(true);
    });

    it('degrades gracefully when the judge throws (deterministic result only)', async () => {
        const grounding = selfCheckStoryboard(storyboard, catalog);
        const res = await auditStoryboardWithJudge(storyboard, grounding, async () => { throw new Error('judge offline'); });
        expect(res.findings.every((f) => f.dimension !== 'mece')).toBe(true);
    });

    it('returns the deterministic result unchanged when no judge is supplied', async () => {
        const grounding = selfCheckStoryboard(storyboard, catalog);
        const withJudge = await auditStoryboardWithJudge(storyboard, grounding);
        const direct = auditStoryboard(storyboard, grounding);
        expect(withJudge.findings).toEqual(direct.findings);
    });
});
