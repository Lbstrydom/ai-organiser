/**
 * renderMinutesFromJson — multi-segment section rendering (TD: multi-segment
 * test hardening). Covers the injectSegmentSections discriminated-union output
 * (content / failed / skipped-cancelled / skipped-empty) + the legacy
 * (no-sections) passthrough, via the public renderer seam.
 */
import { describe, it, expect } from 'vitest';
import { renderMinutesFromJson } from '../src/utils/minutesUtils';
import type { MinutesJSON } from '../src/services/prompts/minutesPrompts';
import type { SegmentSection } from '../src/services/minutes/minutesTypes';

function baseJson(sections?: SegmentSection[]): MinutesJSON {
    return {
        metadata: {
            title: 'Board', date: '2026-05-25', start_time: '09:00', end_time: '11:00', timezone: 'UTC',
            meeting_context: 'board', output_audience: 'internal', confidentiality_level: 'internal',
            chair: 'Chair', minute_taker: 'Sec', location: 'Room 1', quorum_present: null,
        },
        participants: [], agenda: [],
        decisions: [{ id: 'D1', description: 'A decision was taken' } as never],
        actions: [], risks: [], notable_points: [], open_questions: [], deferred_items: [],
        ...(sections ? { sections } : {}),
    } as MinutesJSON;
}

describe('renderMinutesFromJson — segment sections', () => {
    it('legacy (no sections field) renders no section blocks / warning callouts', () => {
        const md = renderMinutesFromJson(baseJson(), 'standard');
        expect(md).not.toContain('could not be processed');
        expect(md).not.toContain('[!info]');
    });

    it('content section renders a "## <name>" header + summary', () => {
        const md = renderMinutesFromJson(baseJson([
            { kind: 'content', sectionId: 'topic-vat', name: 'VAT review', summary: 'Discussed reclaim.',
              decisions: [], actions: [], risks: [], notable_points: [], open_questions: [], deferred_items: [] },
        ]), 'standard');
        expect(md).toContain('## VAT review');
        expect(md).toContain('Discussed reclaim.');
    });

    it('failed section renders a warning callout with error + redacted excerpt', () => {
        const md = renderMinutesFromJson(baseJson([
            { kind: 'failed', sectionId: 't1', name: 'VAT', sanitizedError: 'parse error', redactedExcerpt: 'some [email]' },
        ]), 'standard');
        expect(md).toContain('> [!warning] Section "VAT" could not be processed.');
        expect(md).toContain('> Error: parse error');
        expect(md).toContain('> Excerpt: some [email]');
    });

    it('cancelled section renders an info callout', () => {
        const md = renderMinutesFromJson(baseJson([
            { kind: 'skipped', sectionId: 't1', name: 'Breakout', reason: 'cancelled' },
        ]), 'standard');
        expect(md).toContain('> [!info] Section "Breakout" was not processed (cancelled).');
    });

    it('empty-skipped section is silently omitted', () => {
        const md = renderMinutesFromJson(baseJson([
            { kind: 'skipped', sectionId: 't1', name: 'EmptyTopic', reason: 'empty' },
        ]), 'standard');
        expect(md).not.toContain('EmptyTopic');
    });

    it('sections are inserted before the first global rollup header', () => {
        const md = renderMinutesFromJson(baseJson([
            { kind: 'content', sectionId: 'general', name: 'General', summary: 'main',
              decisions: [], actions: [], risks: [], notable_points: [], open_questions: [], deferred_items: [] },
        ]), 'standard');
        const sectionIdx = md.indexOf('## General');
        const rollupIdx = md.search(/^## (Decisions|Actions|Risks|Notable points|Open questions|Deferred items|Discussion|Agenda items)/m);
        expect(sectionIdx).toBeGreaterThanOrEqual(0);
        if (rollupIdx >= 0) expect(sectionIdx).toBeLessThan(rollupIdx);
    });
});
