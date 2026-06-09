/**
 * Storyboard non-JSON retry hardening (2026-06-08).
 *
 * Azure Claude intermittently returns a 200 with non-JSON / empty content for the
 * structured-JSON storyboard prompt (live: 1 of 2 cold runs failed through both the
 * generator AND the single repair). `runStoryboardLLM` now retries up to 3 attempts,
 * distinguishing an EMPTY response (retry the base prompt fresh) from a non-empty
 * UNPARSEABLE one (feed it to a repair prompt). These tests pin that behaviour.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/services/llmFacade', () => ({ summarizeText: vi.fn() }));
import { summarizeText } from '../src/services/llmFacade';
import type { LLMFacadeContext } from '../src/services/llmFacade';
import { generateStoryboard, maxStoryboardSlides } from '../src/services/presentationIr/storyboardService';

const st = vi.mocked(summarizeText);
const ctx = {} as unknown as LLMFacadeContext;

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

beforeEach(() => st.mockReset());

describe('storyboard non-JSON retry', () => {
    it('succeeds after one unparseable response (single repair)', async () => {
        st.mockResolvedValueOnce({ success: true, content: 'Sorry, here is a plan in prose, no JSON.' })
          .mockResolvedValueOnce({ success: true, content: VALID });
        const r = await generateStoryboard(ctx, 'brief', []);
        expect(r.ok).toBe(true);
        expect(st).toHaveBeenCalledTimes(2);
    });

    it('succeeds after TWO unparseable responses (uses the 3rd attempt)', async () => {
        st.mockResolvedValueOnce({ success: true, content: 'no json 1' })
          .mockResolvedValueOnce({ success: true, content: 'no json 2' })
          .mockResolvedValueOnce({ success: true, content: VALID });
        const r = await generateStoryboard(ctx, 'brief', []);
        expect(r.ok).toBe(true);
        expect(st).toHaveBeenCalledTimes(3);
    });

    it('fails (Result.err) only after all 3 attempts are unparseable', async () => {
        st.mockResolvedValue({ success: true, content: 'never json' });
        const r = await generateStoryboard(ctx, 'brief', []);
        expect(r.ok).toBe(false);
        expect(st).toHaveBeenCalledTimes(3);
    });

    it('retries the BASE prompt fresh (no repair envelope) after an empty 200 response', async () => {
        st.mockResolvedValueOnce({ success: true, content: '' })   // 200 with empty content
          .mockResolvedValueOnce({ success: true, content: VALID });
        const r = await generateStoryboard(ctx, 'brief', []);
        expect(r.ok).toBe(true);
        expect(st).toHaveBeenCalledTimes(2);
        // The 2nd call must NOT carry the repair envelope (nothing to repair from an
        // empty response) — it's a fresh retry of the base prompt.
        expect(st.mock.calls[1][1]).not.toContain('was invalid');
    });

    it('does NOT re-fire on a FAILED call (cloudService already did 429/5xx backoff) — terminal', async () => {
        st.mockResolvedValue({ success: false, error: 'HTTP 429' });
        const r = await generateStoryboard(ctx, 'brief', []);
        expect(r.ok).toBe(false);
        expect(st).toHaveBeenCalledTimes(1); // no hammering
    });

    it('scales the output-token budget with the target slide count (large-deck fix)', async () => {
        st.mockResolvedValue({ success: true, content: VALID });
        await generateStoryboard(ctx, 'brief', [], { targetLength: 30 });
        // 3000 + 30*1400 = 45000 — a 30-slide deck no longer overflows the fixed 8192.
        expect((st.mock.calls[0][2] as { maxTokens?: number }).maxTokens).toBeGreaterThan(40000);
        st.mockClear();
        await generateStoryboard(ctx, 'brief', [], { targetLength: 6 });
        // A small deck stays modest (3000 + 6*1400 = 11400).
        expect((st.mock.calls[0][2] as { maxTokens?: number }).maxTokens).toBeLessThan(15000);
    });

    it('maxStoryboardSlides is provider-aware — all cloud flagships clear ≥35; local stays honest', () => {
        // 2026 cloud flagships (64k+ output) all reach the schema cap (40) — clears 35.
        for (const p of ['azure-claude', 'claude', 'openai', 'azure-openai', 'gemini', 'groq', 'deepseek', 'openrouter']) {
            expect(maxStoryboardSlides(p)).toBeGreaterThanOrEqual(35);
        }
        // local is honestly capped (an arbitrary local model's output ceiling is unknowable).
        expect(maxStoryboardSlides('local')).toBeGreaterThanOrEqual(3);
        expect(maxStoryboardSlides('local')).toBeLessThan(35);
    });

    it('stops early on abort', async () => {
        const ac = new AbortController();
        ac.abort();
        st.mockResolvedValue({ success: true, content: 'no json' });
        const r = await generateStoryboard(ctx, 'brief', [], { signal: ac.signal });
        expect(r.ok).toBe(false);
        expect(st).not.toHaveBeenCalled();
    });
});
