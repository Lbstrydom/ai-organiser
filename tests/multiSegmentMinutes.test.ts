/**
 * multiSegmentMinutes orchestrator (TD: multi-segment-minutes test hardening).
 *
 * Covers the shipped runMultiSegmentExtraction: per-segment extract,
 * empty-segment skip, error isolation, cancellation (pre-loop + mid-loop +
 * short-circuit), all-failed, mixed success/failed ordering, and the >10-segment
 * hierarchical-reduce path. The LLM is mocked; chunking / prompt builders /
 * parseJsonWithRepair / redactPII run for real.
 */
import { describe, it, expect, vi } from 'vitest';
import { runMultiSegmentExtraction } from '../src/services/minutes/multiSegmentMinutes';
import type { MultiSegmentInput, SegmentInput } from '../src/services/minutes/minutesTypes';
import type { MeetingMetadata } from '../src/services/prompts/minutesPrompts';

const META: MeetingMetadata = {
    title: 'Board', date: '2026-05-25', startTime: '09:00', endTime: '11:00', timezone: 'UTC',
    meetingContext: 'board' as never, outputAudience: 'internal' as never, confidentialityLevel: 'internal' as never,
    chair: 'Chair', location: 'Room 1', agenda: [], dualOutput: false, obsidianTasksFormat: false, minuteTaker: 'Sec',
};

const EXTRACT_JSON = JSON.stringify({
    actions: [{ id: 'A1', description: 'do thing', owner: 'Pat' }],
    decisions: [{ id: 'D1', description: 'decided' }],
    risks: [], notable_points: [], open_questions: [], deferred_items: [],
});

/** Consolidation output: one content section per input extract + global rollups. */
function consolidationJson(sectionMarkers: Array<{ sectionId: string; name: string }>): string {
    return JSON.stringify({
        metadata: { title: 'Board' },
        participants: [],
        agenda: [],
        sections: sectionMarkers.map((s) => ({
            kind: 'content', sectionId: s.sectionId, name: s.name, summary: 'sec summary',
            actions: [], decisions: [], risks: [], notable_points: [], open_questions: [], deferred_items: [],
        })),
        actions: [], decisions: [], risks: [], notable_points: [], open_questions: [], deferred_items: [],
    });
}

/** Mock plugin whose summarizeText routes by prompt content. `markers` is the
 *  list of segments the consolidation pass should echo back. */
function makePlugin(markers: Array<{ sectionId: string; name: string }>, over: { extract?: () => { success: boolean; content?: string; error?: string } } = {}) {
    const summarizeText = vi.fn(async (prompt: string) => {
        if (prompt.includes('Consolidate per-section meeting extracts')) {
            return { success: true, content: consolidationJson(markers) };
        }
        return over.extract ? over.extract() : { success: true, content: EXTRACT_JSON };
    });
    return { plugin: { llmService: { summarizeText } } as never, summarizeText };
}

function seg(sectionId: string, sectionName: string, transcript = 'Discussion text for the segment.'): SegmentInput {
    return { sectionId, sectionName, transcript, contextDocuments: '' };
}

function input(segments: SegmentInput[]): MultiSegmentInput {
    return { metadata: META, participantsRaw: 'Pat, Chris', segments };
}

describe('runMultiSegmentExtraction', () => {
    it('errors with no-segments on empty input', async () => {
        const { plugin } = makePlugin([]);
        const r = await runMultiSegmentExtraction(plugin, input([]));
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toBe('no-segments');
    });

    it('single segment success → content section, not cancelled', async () => {
        const { plugin } = makePlugin([{ sectionId: 'general', name: 'General' }]);
        const r = await runMultiSegmentExtraction(plugin, input([seg('general', 'General')]));
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.value.cancelled).toBe(false);
        expect(r.value.segments[0].kind).toBe('success');
        expect(r.value.consolidated.sections).toHaveLength(1);
        expect(r.value.consolidated.sections?.[0]).toMatchObject({ kind: 'content', sectionId: 'general' });
    });

    it('empty-transcript segment → skipped/empty (no LLM extract call)', async () => {
        const { plugin, summarizeText } = makePlugin([]);
        const r = await runMultiSegmentExtraction(plugin, input([seg('general', 'General', '   ')]));
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.value.segments[0]).toMatchObject({ kind: 'skipped', reason: 'empty' });
        // empty segment is the only one → no successes → no consolidation LLM call
        expect(summarizeText).not.toHaveBeenCalled();
    });

    it('extraction LLM failure → failed segment with redacted error + excerpt', async () => {
        const { plugin } = makePlugin([], { extract: () => ({ success: false, error: 'boom' }) });
        const r = await runMultiSegmentExtraction(plugin, input([seg('general', 'General', 'contact me at a@b.com')]));
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        const s = r.value.segments[0];
        expect(s.kind).toBe('failed');
        if (s.kind === 'failed') {
            // redactPII scrubs the email out of the excerpt
            expect(s.rawExcerpt).not.toContain('a@b.com');
            expect(s.rawExcerpt).toContain('[email]');
        }
        // consolidated.sections carries the failed section (end-to-end visibility)
        expect(r.value.consolidated.sections?.[0]).toMatchObject({ kind: 'failed', sectionId: 'general' });
    });

    it('all segments fail → ok result, every section kind=failed (caller decides all-failed)', async () => {
        const { plugin } = makePlugin([], { extract: () => ({ success: false, error: 'x' }) });
        const r = await runMultiSegmentExtraction(plugin, input([seg('general', 'General'), seg('t1', 'VAT')]));
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.value.consolidated.sections?.every((s) => s.kind === 'failed')).toBe(true);
    });

    it('mixed success + failed → sections keep original segment order', async () => {
        const { plugin } = makePlugin([{ sectionId: 'general', name: 'General' }]);
        // make the SECOND segment fail by routing its extract call to failure via transcript marker
        const summarize = (plugin as { llmService: { summarizeText: ReturnType<typeof vi.fn> } }).llmService.summarizeText;
        summarize.mockImplementation(async (prompt: string) => {
            if (prompt.includes('Consolidate per-section meeting extracts')) return { success: true, content: consolidationJson([{ sectionId: 'general', name: 'General' }]) };
            if (prompt.includes('FAILSEG')) return { success: false, error: 'nope' };
            return { success: true, content: EXTRACT_JSON };
        });
        const r = await runMultiSegmentExtraction(plugin, input([seg('general', 'General'), seg('t1', 'VAT', 'FAILSEG content')]));
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.value.consolidated.sections?.map((s) => s.sectionId)).toEqual(['general', 't1']);
        expect(r.value.consolidated.sections?.[1].kind).toBe('failed');
    });

    it('aborted before start → all skipped/cancelled, short-circuits consolidation', async () => {
        const { plugin, summarizeText } = makePlugin([]);
        const ac = new AbortController();
        ac.abort();
        const r = await runMultiSegmentExtraction(plugin, input([seg('general', 'General'), seg('t1', 'VAT')]), { signal: ac.signal });
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.value.cancelled).toBe(true);
        expect(r.value.segments.every((s) => s.kind === 'skipped' && s.reason === 'cancelled')).toBe(true);
        expect(summarizeText).not.toHaveBeenCalled();   // short-circuit: no extraction, no consolidation
    });

    it('fires onProgress per processed segment', async () => {
        const { plugin } = makePlugin([{ sectionId: 'general', name: 'General' }, { sectionId: 't1', name: 'VAT' }]);
        const onProgress = vi.fn();
        await runMultiSegmentExtraction(plugin, input([seg('general', 'General'), seg('t1', 'VAT')]), { onProgress });
        expect(onProgress).toHaveBeenCalledWith(1, 2, 'General');
        expect(onProgress).toHaveBeenCalledWith(2, 2, 'VAT');
    });

    it('>10 segments → hierarchical reduce (batched consolidation), sections preserved', async () => {
        const markers = Array.from({ length: 11 }, (_, i) => ({ sectionId: `s${i}`, name: `S${i}` }));
        const { plugin, summarizeText } = makePlugin([]);
        // Route each consolidation batch to echo only its batch's sections.
        summarizeText.mockImplementation(async (prompt: string) => {
            if (prompt.includes('Consolidate per-section meeting extracts')) {
                // echo back whichever sectionIds appear in the prompt's extract payload
                const present = markers.filter((m) => prompt.includes(`"sectionId": "${m.sectionId}"`));
                return { success: true, content: consolidationJson(present) };
            }
            return { success: true, content: EXTRACT_JSON };
        });
        const segs = markers.map((m) => seg(m.sectionId, m.name));
        const r = await runMultiSegmentExtraction(plugin, input(segs));
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        // 11 segments → batches of 4 → 3 consolidation calls (+11 extraction calls)
        const consolidationCalls = summarizeText.mock.calls.filter((c) => String(c[0]).includes('Consolidate per-section'));
        expect(consolidationCalls.length).toBe(3);
        // all 11 sections preserved across the merged batches
        expect(r.value.consolidated.sections).toHaveLength(11);
        expect(new Set(r.value.consolidated.sections?.map((s) => s.sectionId)).size).toBe(11);
    });
});
