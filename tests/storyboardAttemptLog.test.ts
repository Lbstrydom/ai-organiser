/**
 * One content-free log line per storyboard run: attempts used and outcome.
 * The denominator (first-attempt successes included) is what makes the retry
 * rate — and so the case for caching the storyboard prefix — measurable.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/services/llmFacade', () => ({ summarizeText: vi.fn() }));
import { summarizeText } from '../src/services/llmFacade';
import type { LLMFacadeContext } from '../src/services/llmFacade';
import { generateStoryboard, generateRevisedStoryboard } from '../src/services/presentationIr/storyboardService';
import { logger } from '../src/utils/logger';

const st = vi.mocked(summarizeText);
const ctx = {} as unknown as LLMFacadeContext;
const SENTINEL = 'ZQX-BRIEF-SENTINEL';

const VALID = JSON.stringify({
    schemaVersion: 1,
    thesis: 'Growth was regionally concentrated',
    slides: [{
        id: 's1', role: 'insight', action_title: 'EMEA drove 60% of Q3 growth',
        core_message: 'Regional revenue concentration', evidence_span_ids: ['e1'],
        suggested_visual: 'bar',
        visual_data: { type: 'bar', unit: '%', items: [{ label: 'EMEA', value: 60, evidence_span_id: 'e1' }] },
    }],
});

let spy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
    st.mockReset();
    logger.setDebugMode(true);
    spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
});
afterEach(() => { spy.mockRestore(); logger.setDebugMode(false); });

const runLines = (): string[] =>
    (spy.mock.calls as unknown[][]).map((c) => String(c[0])).filter((l) => l.includes('storyboard run'));

describe('storyboard run log', () => {
    it('first-attempt success: attempts=1/3 outcome=ok', async () => {
        st.mockResolvedValueOnce({ success: true, content: VALID });
        await generateStoryboard(ctx, SENTINEL, []);
        expect(runLines()).toEqual(['[AI Organiser][Presentation] storyboard run presentation-storyboard: attempts=1/3 outcome=ok']);
    });

    it('repaired success: attempts=2/3 outcome=ok', async () => {
        st.mockResolvedValueOnce({ success: true, content: 'no json' }).mockResolvedValueOnce({ success: true, content: VALID });
        await generateStoryboard(ctx, SENTINEL, []);
        expect(runLines()[0]).toContain('attempts=2/3 outcome=ok');
    });

    it('exhausted: attempts=3/3 outcome=exhausted', async () => {
        st.mockResolvedValue({ success: true, content: 'never json' });
        await generateStoryboard(ctx, SENTINEL, []);
        expect(runLines()[0]).toContain('attempts=3/3 outcome=exhausted');
    });

    it('provider failure on the first call: attempts=1/3 outcome=llm-error', async () => {
        st.mockResolvedValueOnce({ success: false, error: 'HTTP 500' });
        await generateStoryboard(ctx, SENTINEL, []);
        expect(runLines()[0]).toContain('attempts=1/3 outcome=llm-error');
    });

    it('the revise path carries its own label', async () => {
        st.mockResolvedValueOnce({ success: true, content: VALID });
        const current = JSON.parse(VALID);
        await generateRevisedStoryboard(ctx, current, 'change it', [], []);
        expect(runLines()[0]).toContain('storyboard run presentation-storyboard-revise: attempts=1/3 outcome=ok');
    });

    it('never contains the brief, the prompt or the reply', async () => {
        st.mockResolvedValueOnce({ success: true, content: `reply with ${SENTINEL}` }).mockResolvedValueOnce({ success: true, content: VALID });
        await generateStoryboard(ctx, SENTINEL, []);
        for (const line of runLines()) expect(line).not.toContain(SENTINEL);
    });
});
