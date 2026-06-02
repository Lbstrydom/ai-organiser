/**
 * buildSegmentConsolidationPrompt (TD: multi-segment-minutes test hardening).
 *
 * Invariant tests in the same style as minutesPrompts.test.ts: the project's
 * XML envelope (<task>/<requirements>/<output_format>) MUST be present (R3-M4),
 * section identity must be carried into the prompt, metadata must be snake_case
 * (H4/H15), and the conditional GTD / dictionary / custom-instructions /
 * style-reference fields must appear only when supplied.
 */
import { describe, it, expect } from 'vitest';
import { buildSegmentConsolidationPrompt, type ConsolidationPromptOptions } from '../src/services/prompts/segmentConsolidationPrompts';
import type { SegmentExtract } from '../src/services/minutes/minutesTypes';
import type { MeetingMetadata } from '../src/services/prompts/minutesPrompts';

const META: MeetingMetadata = {
    title: 'Board', date: '2026-05-25', startTime: '09:00', endTime: '11:00', timezone: 'UTC',
    meetingContext: 'board' as never, outputAudience: 'internal' as never, confidentialityLevel: 'internal' as never,
    chair: 'Chair', location: 'Room 1', agenda: [], dualOutput: false, obsidianTasksFormat: false, minuteTaker: 'Sec',
};

const EXTRACTS: SegmentExtract[] = [
    { sectionId: 'general', sectionName: 'General', actions: [], decisions: [], risks: [], notable_points: [], open_questions: [], deferred_items: [] },
    { sectionId: 'topic-vat', sectionName: 'VAT', actions: [], decisions: [], risks: [], notable_points: [], open_questions: [], deferred_items: [] },
];

function opts(over: Partial<ConsolidationPromptOptions> = {}): ConsolidationPromptOptions {
    return { minutesStyle: 'standard', outputLanguage: 'English', meetingMetadata: META, participantsRaw: 'Pat, Chris', ...over };
}

describe('buildSegmentConsolidationPrompt', () => {
    it('emits the XML envelope sections', () => {
        const p = buildSegmentConsolidationPrompt(EXTRACTS, opts());
        for (const tag of ['<task>', '</task>', '<requirements>', '</requirements>', '<output_format>', '</output_format>']) {
            expect(p).toContain(tag);
        }
    });

    it('carries each input section identity verbatim', () => {
        const p = buildSegmentConsolidationPrompt(EXTRACTS, opts());
        expect(p).toContain('"sectionId": "general"');
        expect(p).toContain('"sectionName": "General"');
        expect(p).toContain('"sectionId": "topic-vat"');
        expect(p).toContain('"sectionName": "VAT"');
    });

    it('instructs preservation of section identity + per-item segmentId provenance', () => {
        const p = buildSegmentConsolidationPrompt(EXTRACTS, opts());
        expect(p).toMatch(/preserve each.*section'?s identity/i);
        expect(p).toContain('segmentId');
    });

    it('emits metadata as snake_case keys, never camelCase (H4/H15)', () => {
        const p = buildSegmentConsolidationPrompt(EXTRACTS, opts());
        expect(p).toContain('"start_time"');
        expect(p).toContain('"meeting_context"');
        expect(p).not.toContain('"startTime"');
        expect(p).not.toContain('"meetingContext"');
    });

    it('reflects the output language + style', () => {
        const p = buildSegmentConsolidationPrompt(EXTRACTS, opts({ outputLanguage: 'Finnish', minutesStyle: 'detailed' }));
        expect(p).toContain('Output language: Finnish');
        expect(p).toContain('Style: detailed');
    });

    it('includes the GTD rollup instruction only when useGTD is true', () => {
        expect(buildSegmentConsolidationPrompt(EXTRACTS, opts({ useGTD: true }))).toContain('gtd_processing');
        expect(buildSegmentConsolidationPrompt(EXTRACTS, opts({ useGTD: false }))).toContain('Do NOT emit a "gtd_processing"');
    });

    it('includes dictionary / custom-instructions / style-reference only when supplied (H5)', () => {
        const bare = buildSegmentConsolidationPrompt(EXTRACTS, opts());
        expect(bare).not.toContain('<dictionary>');
        expect(bare).not.toContain('<custom_instructions>');
        expect(bare).not.toContain('<style_reference>');

        const full = buildSegmentConsolidationPrompt(EXTRACTS, opts({
            dictionaryContent: 'ACME = a company', customInstructions: 'be terse', styleReference: 'prior minutes',
        }));
        expect(full).toContain('<dictionary>');
        expect(full).toContain('ACME = a company');
        expect(full).toContain('<custom_instructions>');
        expect(full).toContain('be terse');
        expect(full).toContain('<style_reference>');
        expect(full).toContain('prior minutes');
    });
});
