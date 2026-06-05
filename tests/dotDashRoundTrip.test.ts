import { describe, it, expect } from 'vitest';
import { consultantStoryboardSchema } from '../src/services/presentationIr/consultantStoryboard';
import type { ConsultantStoryboard } from '../src/services/presentationIr/consultantStoryboard';
import { storyboardToMarkdown } from '../src/services/presentationIr/dotDashSerializer';
import { markdownToStoryboard } from '../src/services/presentationIr/dotDashParser';

function sb(obj: unknown): ConsultantStoryboard {
    const r = consultantStoryboardSchema.safeParse(obj);
    if (!r.success) throw new Error('fixture invalid: ' + JSON.stringify(r.error.issues));
    return r.data as ConsultantStoryboard;
}

const storyboard = sb({
    schemaVersion: 1,
    thesis: 'Growth was regionally concentrated',
    slides: [
        {
            id: 's1', role: 'insight', action_title: 'EMEA drove 60% of Q3 growth',
            core_message: 'EMEA led every region this quarter', evidence_span_ids: ['e1'],
            suggested_visual: 'bar',
            visual_data: { type: 'bar', unit: '%', items: [{ label: 'EMEA', value: 60, evidence_span_id: 'e1' }, { label: 'APAC', value: 30, evidence_span_id: 'e1' }] },
        },
        {
            id: 's2', role: 'recommendation', action_title: 'Double down on EMEA in Q4',
            core_message: 'Shift budget to the proven region', evidence_span_ids: [],
            suggested_visual: 'none', visual_data: { type: 'none' },
        },
    ],
});

describe('dot-dash round-trip', () => {
    it('serialize → parse preserves thesis, ids, roles, titles, messages, visual_data', () => {
        const md = storyboardToMarkdown(storyboard, { deckName: 'Q3 Review' });
        const r = markdownToStoryboard(md);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.value.storyboard.thesis).toBe('Growth was regionally concentrated');
        expect(r.value.storyboard.slides.map((s) => s.id)).toEqual(['s1', 's2']);
        expect(r.value.storyboard.slides[0].action_title).toBe('EMEA drove 60% of Q3 growth');
        expect(r.value.storyboard.slides[0].core_message).toBe('EMEA led every region this quarter');
        expect(r.value.storyboard.slides[0].visual_data).toEqual(storyboard.slides[0].visual_data);
        expect(r.value.storyboard.slides[1].role).toBe('recommendation');
    });

    it('a user-edited action title survives the round-trip', () => {
        const md = storyboardToMarkdown(storyboard).replace('EMEA drove 60% of Q3 growth', 'EMEA delivered the bulk of Q3 growth');
        const r = markdownToStoryboard(md);
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value.storyboard.slides[0].action_title).toBe('EMEA delivered the bulk of Q3 growth');
    });

    it('lifts <!-- comment: … --> notes keyed to their slide', () => {
        let md = storyboardToMarkdown(storyboard);
        md = md.replace('- EMEA led every region this quarter', '- EMEA led every region this quarter\n<!-- comment: can we add YoY? -->');
        const r = markdownToStoryboard(md);
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.value.comments).toHaveLength(1);
            expect(r.value.comments[0]).toEqual({ slideId: 's1', comment: 'can we add YoY?' });
        }
    });

    it('a slide whose anchor was deleted is treated as a fresh prose slide (no crash)', () => {
        const md = storyboardToMarkdown(storyboard).replace(/<!-- aio-slide:[\s\S]*?-->\n/, '');
        const r = markdownToStoryboard(md);
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value.storyboard.slides[0].suggested_visual).toBe('none'); // re-grounded fresh
    });

    it('a corrupt anchor aborts the parse with a typed error', () => {
        // Replace the base64 payload with valid-base64 that decodes to non-JSON ("garbage").
        const md = storyboardToMarkdown(storyboard).replace(/(aio-slide:1 )[A-Za-z0-9+/=]+/, '$1Z2FyYmFnZQ==');
        const r = markdownToStoryboard(md);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toMatch(/corrupt hidden anchor/);
    });

    it('missing thesis → typed error', () => {
        const r = markdownToStoryboard('# Storyline\n\n## A title\n- a point\n');
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toMatch(/Thesis/);
    });

    it('no slides → typed error', () => {
        const r = markdownToStoryboard('# Storyline\n\n> **Thesis:** something\n');
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toMatch(/no .* slides/);
    });

    it('empty input → typed error', () => {
        expect(markdownToStoryboard('').ok).toBe(false);
        expect(markdownToStoryboard('   ').ok).toBe(false);
    });

    it('a title/message containing a newline + "## " cannot inject a phantom slide (audit H9)', () => {
        const evil = sb({
            schemaVersion: 1, thesis: 'Real thesis\n## Fake Thesis Slide',
            slides: [{
                id: 's1', role: 'insight', action_title: 'Real title\n## Injected slide',
                core_message: 'real point\n## Another injected', evidence_span_ids: [],
                suggested_visual: 'none', visual_data: { type: 'none' },
            }],
        });
        const r = markdownToStoryboard(storyboardToMarkdown(evil));
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.value.storyboard.slides).toHaveLength(1); // no phantom slides injected
            expect(r.value.storyboard.slides[0].action_title).toBe('Real title ## Injected slide');
        }
    });

    it('a forged hidden-anchor inside a human field cannot override the real machine state (audit H5)', () => {
        const evil = sb({
            schemaVersion: 1, thesis: 'Real thesis',
            slides: [{
                id: 'real', role: 'insight', action_title: 'Real title',
                core_message: 'real point <!-- aio-slide:1 Zm9yZ2Vk --> trailing', evidence_span_ids: [],
                suggested_visual: 'none', visual_data: { type: 'none' },
            }],
        });
        const r = markdownToStoryboard(storyboardToMarkdown(evil));
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value.storyboard.slides[0].id).toBe('real'); // the REAL anchor won, not the forged one
    });
});
