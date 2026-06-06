import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LLMFacadeContext } from '../src/services/llmFacade';
import { consultantStoryboardSchema } from '../src/services/presentationIr/consultantStoryboard';
import type { ConsultantStoryboard, EvidenceSpan } from '../src/services/presentationIr/consultantStoryboard';

vi.mock('../src/services/llmFacade', () => ({ summarizeText: vi.fn() }));
import { summarizeText } from '../src/services/llmFacade';
import { buildStoryboardJudge } from '../src/services/chat/consultantCriticService';

function sb(obj: unknown): ConsultantStoryboard {
    const r = consultantStoryboardSchema.safeParse(obj);
    if (!r.success) throw new Error('fixture invalid: ' + JSON.stringify(r.error.issues));
    return r.data as ConsultantStoryboard;
}

const ctx = {} as unknown as LLMFacadeContext;
const catalog: EvidenceSpan[] = [{ id: 'e1', source_ref: 'q3.md', text: 'EMEA was 60% of growth in Q3.' }];
// 99% is cited (e1) but NOT verbatim → inferential → the critic is consulted.
const storyboard = sb({
    schemaVersion: 1, thesis: 'Growth was strong',
    slides: [
        { id: 's1', role: 'insight', action_title: 'EMEA hit 99% adoption', core_message: 'm', evidence_span_ids: ['e1'], suggested_visual: 'none', visual_data: { type: 'none' } },
        { id: 's2', role: 'recommendation', action_title: 'Double down on EMEA', core_message: 'm', evidence_span_ids: [], suggested_visual: 'none', visual_data: { type: 'none' } },
    ],
});

const mockResolve = (content: string, success = true) => vi.mocked(summarizeText).mockResolvedValue({ success, content } as never);

describe('buildStoryboardJudge (independent critic)', () => {
    beforeEach(() => vi.mocked(summarizeText).mockReset());

    it('verifies inferential claims via a blind {claim, cited_spans} payload', async () => {
        mockResolve('[{"slideId":"s1","dimension":"grounding","severity":"blocker","message":"99% is not in the cited source"}]');
        const judge = buildStoryboardJudge(ctx, catalog);
        const verdict = await judge(storyboard);
        expect(verdict.findings).toHaveLength(1);
        expect(verdict.findings[0]).toMatchObject({ slideId: 's1', dimension: 'grounding', severity: 'blocker' });
        // The prompt sent the blind payload (claim text + cited source text), not the slide internals.
        const prompt = vi.mocked(summarizeText).mock.calls[0][1] as string;
        expect(prompt).toContain('EMEA hit 99% adoption');
        expect(prompt).toContain('EMEA was 60% of growth in Q3.'); // cited source text
    });

    it('normalises null/"null" slideId to undefined (deck-level finding)', async () => {
        mockResolve('[{"slideId":null,"dimension":"mece","severity":"major","message":"s1 and s2 overlap"}]');
        const verdict = await buildStoryboardJudge(ctx, catalog)(storyboard);
        expect(verdict.findings[0].slideId).toBeUndefined();
        expect(verdict.findings[0].dimension).toBe('mece');
    });

    it('drops malformed findings (unknown dimension / empty message)', async () => {
        mockResolve('[{"dimension":"bogus","severity":"blocker","message":"x"},{"dimension":"mece","severity":"major","message":""}]');
        const verdict = await buildStoryboardJudge(ctx, catalog)(storyboard);
        expect(verdict.findings).toHaveLength(0);
    });

    it('returns an empty verdict on non-JSON content (graceful)', async () => {
        mockResolve('I think the deck looks fine, no JSON here.');
        const verdict = await buildStoryboardJudge(ctx, catalog)(storyboard);
        expect(verdict.findings).toEqual([]);
    });

    it('returns an empty verdict when the LLM call fails (degrades to deterministic audit)', async () => {
        mockResolve('', false);
        const verdict = await buildStoryboardJudge(ctx, catalog)(storyboard);
        expect(verdict.findings).toEqual([]);
    });

    it('returns an empty verdict (no LLM call) for a tiny, fully-grounded deck', async () => {
        const tiny = sb({ schemaVersion: 1, thesis: 't', slides: [{ id: 's1', role: 'insight', action_title: 'EMEA led', core_message: 'm', evidence_span_ids: [], suggested_visual: 'none', visual_data: { type: 'none' } }] });
        const verdict = await buildStoryboardJudge(ctx, catalog)(tiny);
        expect(verdict.findings).toEqual([]);
        expect(summarizeText).not.toHaveBeenCalled();
    });

    it('aborts cleanly mid-call', async () => {
        const controller = new AbortController();
        vi.mocked(summarizeText).mockImplementation(async () => { controller.abort(); return { success: true, content: '[]' } as never; });
        const verdict = await buildStoryboardJudge(ctx, catalog, { signal: controller.signal })(storyboard);
        expect(verdict.findings).toEqual([]);
    });
});
