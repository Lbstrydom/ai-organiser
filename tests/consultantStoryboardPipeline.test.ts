import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ok, err } from '../src/core/result';
import type { LLMFacadeContext } from '../src/services/llmFacade';
import { consultantStoryboardSchema } from '../src/services/presentationIr/consultantStoryboard';
import type { ConsultantStoryboard, EvidenceSpan } from '../src/services/presentationIr/consultantStoryboard';
import { storyboardToMarkdown } from '../src/services/presentationIr/dotDashSerializer';

// Mock only the LLM-calling generateStoryboard; keep the real deterministic translate.
vi.mock('../src/services/presentationIr/storyboardService', async (importActual) => {
    const actual = await importActual<typeof import('../src/services/presentationIr/storyboardService')>();
    return { ...actual, generateStoryboard: vi.fn() };
});
import { generateStoryboard } from '../src/services/presentationIr/storyboardService';
import { runStoryboardStage, buildDeckFromStoryline, buildDeckFromStoryboard } from '../src/services/chat/consultantStoryboardPipeline';

function sb(obj: unknown): ConsultantStoryboard {
    const r = consultantStoryboardSchema.safeParse(obj);
    if (!r.success) throw new Error('fixture invalid: ' + JSON.stringify(r.error.issues));
    return r.data as ConsultantStoryboard;
}

const catalog: EvidenceSpan[] = [{ id: 'e1', source_ref: 'q3.md', text: 'EMEA was 60% and APAC 30% of growth in Q3.' }];
const storyboard = sb({
    schemaVersion: 1,
    thesis: 'Growth was regionally concentrated',
    slides: [{
        id: 's1', role: 'insight', action_title: 'EMEA drove 60% of Q3 growth',
        core_message: 'EMEA led every region', evidence_span_ids: ['e1'],
        suggested_visual: 'bar',
        visual_data: { type: 'bar', unit: '%', items: [{ label: 'EMEA', value: 60, evidence_span_id: 'e1' }, { label: 'APAC', value: 30, evidence_span_id: 'e1' }] },
    }],
});
const ctx = {} as unknown as LLMFacadeContext;

describe('runStoryboardStage', () => {
    beforeEach(() => vi.mocked(generateStoryboard).mockReset());

    it('generates → grounds → audits → renders the storyline markdown', async () => {
        vi.mocked(generateStoryboard).mockResolvedValue(ok(storyboard));
        const r = await runStoryboardStage(ctx, 'Summarise Q3', catalog, { deckName: 'Q3' });
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.value.storyboard).toEqual(storyboard);
            expect(r.value.storylineMarkdown).toContain('## EMEA drove 60% of Q3 growth');
            expect(r.value.grounding.danglingSpanIds).toHaveLength(0);
        }
    });

    it('threads the injected judge into the audit', async () => {
        vi.mocked(generateStoryboard).mockResolvedValue(ok(storyboard));
        const judge = vi.fn().mockResolvedValue({ findings: [{ dimension: 'mece', severity: 'major', message: 'overlap' }] });
        const r = await runStoryboardStage(ctx, 'Summarise Q3', catalog, { judge });
        expect(judge).toHaveBeenCalledOnce();
        if (r.ok) expect(r.value.audit.findings.some((f) => f.dimension === 'mece')).toBe(true);
    });

    it('propagates a generation failure as err', async () => {
        vi.mocked(generateStoryboard).mockResolvedValue(err('LLM offline'));
        const r = await runStoryboardStage(ctx, 'x', catalog);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toBe('LLM offline');
    });
});

describe('buildDeckFromStoryboard (auto-build path)', () => {
    it('translates a storyboard straight to a valid SlideDeckIr', () => {
        const r = buildDeckFromStoryboard(storyboard);
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value.slides[0].type).toBe('title');
    });
});

describe('buildDeckFromStoryline (review path)', () => {
    it('parses the edited storyline → re-grounds → re-audits → translates', () => {
        const md = storyboardToMarkdown(storyboard, { deckName: 'Q3' });
        const r = buildDeckFromStoryline(md, catalog);
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.value.deck.slides.some((s) => s.title === 'EMEA drove 60% of Q3 growth')).toBe(true);
            expect(r.value.comments).toHaveLength(0);
            expect(r.value.grounding.danglingSpanIds).toHaveLength(0);
        }
    });

    it('surfaces a parse error from a corrupt storyline', () => {
        const r = buildDeckFromStoryline('garbage with no thesis', catalog);
        expect(r.ok).toBe(false);
    });

    it('carries user comments through for targeted revision', () => {
        let md = storyboardToMarkdown(storyboard);
        md = md.replace('- EMEA led every region', '- EMEA led every region\n<!-- comment: add YoY -->');
        const r = buildDeckFromStoryline(md, catalog);
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value.comments[0]).toEqual({ slideId: 's1', comment: 'add YoY' });
    });
});
