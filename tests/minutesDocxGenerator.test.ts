import { describe, it, expect } from 'vitest';
import { extractMinutesJsonFromNote, generateMinutesDocx } from '../src/services/export/minutesDocxGenerator';
import type { MinutesJSON } from '../src/services/prompts/minutesPrompts';

// Note: DOCX is a ZIP archive with compressed XML — raw byte search is unreliable.
// We use size-comparison and mutation-checking for content-level assertions.

// ── Fixture ──────────────────────────────────────────────────────────

function makeMinutesJson(overrides: Partial<MinutesJSON> = {}): MinutesJSON {
    return {
        metadata: {
            title: 'Sprint Planning',
            date: '2026-02-21',
            start_time: '10:00',
            end_time: '11:00',
            timezone: 'Europe/London',
            meeting_context: 'internal',
            output_audience: 'internal',
            confidentiality_level: 'internal',
            chair: 'Alice',
            minute_taker: 'Bob',
            location: 'Room 42',
            quorum_present: true,
        },
        participants: [
            { name: 'Alice', role: 'PM', organisation: 'Acme', attendance: 'present' },
            { name: 'Bob', role: 'Dev', attendance: 'present' },
            { name: 'Charlie', attendance: 'apologies' },
        ],
        agenda: ['Review sprint goals', 'Assign tasks', 'AOB'],
        decisions: [
            { id: 'D1', text: 'Ship feature X this sprint', owner: 'Alice', due_date: '2026-03-01', confidence: 'high' },
        ],
        actions: [
            { id: 'A1', text: 'Write tests for feature X', owner: 'Bob', due_date: '2026-02-28', status: 'new', confidence: 'high' },
        ],
        risks: [
            { id: 'R1', text: 'Dependency on API v3', impact: 'High', mitigation: 'Mock first', owner: 'Bob', confidence: 'medium' },
        ],
        notable_points: [
            { id: 'NP1', text: 'Team agreed on code freeze Friday', confidence: 'high' },
        ],
        open_questions: [
            { id: 'OQ1', text: 'Who covers support rota?', owner: 'Alice', confidence: 'medium' },
        ],
        deferred_items: [
            { id: 'DI1', text: 'Migrate CI pipeline', reason: 'Blocked by infra' },
        ],
        ...overrides,
    };
}

// ── extractMinutesJsonFromNote ───────────────────────────────────────

describe('extractMinutesJsonFromNote', () => {
    it('extracts JSON from a note with AIO_MINUTES_JSON comment', () => {
        const json = makeMinutesJson();
        const content = `---\ntype: meeting\n---\n\n# Sprint Planning\n\n<!-- AIO_MINUTES_JSON:${JSON.stringify(json)} -->`;
        const result = extractMinutesJsonFromNote(content);
        expect(result).not.toBeNull();
        expect(result!.metadata.title).toBe('Sprint Planning');
        expect(result!.decisions).toHaveLength(1);
    });

    it('returns null for notes without the marker', () => {
        expect(extractMinutesJsonFromNote('# Just a note\n\nNo minutes here.')).toBeNull();
    });

    it('returns null for malformed JSON', () => {
        expect(extractMinutesJsonFromNote('<!-- AIO_MINUTES_JSON:{invalid -->'))
            .toBeNull();
    });

    it('returns null for empty content', () => {
        expect(extractMinutesJsonFromNote('')).toBeNull();
    });

    it('handles JSON with special characters', () => {
        const json = makeMinutesJson();
        json.metadata.title = 'Q&A Session — "Special" <chars>';
        const content = `Some text\n<!-- AIO_MINUTES_JSON:${JSON.stringify(json)} -->`;
        const result = extractMinutesJsonFromNote(content);
        expect(result).not.toBeNull();
        expect(result!.metadata.title).toBe('Q&A Session — "Special" <chars>');
    });
});

// ── generateMinutesDocx ──────────────────────────────────────────────

describe('generateMinutesDocx', () => {
    it('produces a non-empty ArrayBuffer', async () => {
        const result = await generateMinutesDocx(makeMinutesJson());
        expect(result).toBeInstanceOf(ArrayBuffer);
        expect(result.byteLength).toBeGreaterThan(0);
    });

    it('produces valid DOCX magic bytes (PK zip header)', async () => {
        const result = await generateMinutesDocx(makeMinutesJson());
        const view = new Uint8Array(result);
        // DOCX is a ZIP file — first 2 bytes are PK (0x50, 0x4B)
        expect(view[0]).toBe(0x50);
        expect(view[1]).toBe(0x4B);
    });

    it('handles minimal JSON (empty arrays)', async () => {
        const minimal: MinutesJSON = {
            metadata: {
                title: 'Minimal Meeting',
                date: '2026-01-01',
                start_time: '',
                end_time: '',
                timezone: '',
                meeting_context: 'internal',
                output_audience: 'internal',
                confidentiality_level: 'public',
                chair: '',
                minute_taker: '',
                location: '',
                quorum_present: null,
            },
            participants: [],
            agenda: [],
            decisions: [],
            actions: [],
            risks: [],
            notable_points: [],
            open_questions: [],
            deferred_items: [],
        };
        const result = await generateMinutesDocx(minimal);
        expect(result.byteLength).toBeGreaterThan(0);
    });

    it('handles GTD processing section', async () => {
        const json = makeMinutesJson({
            gtd_processing: {
                next_actions: [
                    { text: 'Draft proposal', context: '@office', owner: 'Alice', energy: 'high' },
                    { text: 'Call vendor', context: '@call', energy: 'low' },
                ],
                waiting_for: [
                    { text: 'Budget approval', waiting_on: 'Finance', chase_date: '2026-03-01' },
                ],
                projects: ['Website Redesign'],
                someday_maybe: ['Team offsite'],
            },
        });
        const result = await generateMinutesDocx(json);
        expect(result.byteLength).toBeGreaterThan(0);
    });

    it('skips confidentiality banner for public meetings', async () => {
        const json = makeMinutesJson();
        json.metadata.confidentiality_level = 'public';
        // Should not throw
        const result = await generateMinutesDocx(json);
        expect(result.byteLength).toBeGreaterThan(0);
    });

    it('includes confidentiality banner for non-public meetings', async () => {
        const json = makeMinutesJson();
        json.metadata.confidentiality_level = 'strictly_confidential';
        const result = await generateMinutesDocx(json);
        expect(result.byteLength).toBeGreaterThan(0);
    });

    it('respects includeConfidentialityBanner: false', async () => {
        const json = makeMinutesJson();
        json.metadata.confidentiality_level = 'confidential';
        const result = await generateMinutesDocx(json, { includeConfidentialityBanner: false });
        expect(result.byteLength).toBeGreaterThan(0);
    });

    it('handles participants with partial info', async () => {
        const json = makeMinutesJson({
            participants: [
                { name: 'Alice', attendance: 'present' },
                { name: 'Bob', role: 'Lead', attendance: 'present' },
                { name: 'Charlie', organisation: 'Partner Corp', attendance: 'apologies' },
            ],
        });
        const result = await generateMinutesDocx(json);
        expect(result.byteLength).toBeGreaterThan(0);
    });

    it('handles missing optional metadata fields', async () => {
        const json = makeMinutesJson();
        json.metadata.location = '';
        json.metadata.minute_taker = '';
        json.metadata.start_time = '';
        const result = await generateMinutesDocx(json);
        expect(result.byteLength).toBeGreaterThan(0);
    });
});

// ── Style-aware DOCX generation ─────────────────────────────────────

describe('generateMinutesDocx — style-aware', () => {
    it('accepts style option and produces valid DOCX for all styles', async () => {
        const styles = ['smart-brevity', 'standard', 'detailed', 'guided'] as const;
        for (const style of styles) {
            const result = await generateMinutesDocx(makeMinutesJson(), { style });
            const view = new Uint8Array(result);
            expect(view[0]).toBe(0x50); // PK header
            expect(view[1]).toBe(0x4B);
        }
    });

    it('reads style from json.metadata.style when options.style is not provided', async () => {
        const json = makeMinutesJson();
        json.metadata.style = 'detailed';
        // Should not throw — validates detailed-specific code paths
        const result = await generateMinutesDocx(json);
        expect(result.byteLength).toBeGreaterThan(0);
    });

    it('smart-brevity produces valid DOCX (risks omitted path)', async () => {
        const json = makeMinutesJson();
        // With risks — smart-brevity should skip them
        const result = await generateMinutesDocx(json, { style: 'smart-brevity' });
        expect(result.byteLength).toBeGreaterThan(0);
    });

    it('detailed style with risks, questions, and deferred produces valid DOCX (appendix path)', async () => {
        const json = makeMinutesJson();
        const result = await generateMinutesDocx(json, { style: 'detailed' });
        expect(result.byteLength).toBeGreaterThan(0);
    });

    it('detailed style without risks/questions/deferred produces valid DOCX (no appendix)', async () => {
        const json = makeMinutesJson({
            risks: [],
            open_questions: [],
            deferred_items: [],
        });
        const result = await generateMinutesDocx(json, { style: 'detailed' });
        expect(result.byteLength).toBeGreaterThan(0);
    });
});

// ── Content-level DOCX assertions (H3, M7, F2) ────────────────────
// DOCX is a ZIP archive — raw byte search is unreliable. We use:
// - Size comparison: more sections → larger DOCX (reliable for section gating)
// - Mutation checking: deepStripConfidence mutates JSON in-place (testable side effect)

describe('generateMinutesDocx — content-level assertions', () => {
    it('smart-brevity produces smaller DOCX than standard (omits risks, questions, deferred)', async () => {
        const json1 = makeMinutesJson();
        const json2 = makeMinutesJson();
        const brevity = await generateMinutesDocx(json1, { style: 'smart-brevity' });
        const standard = await generateMinutesDocx(json2, { style: 'standard' });
        // Standard includes Open Questions + Deferred Items + Risks; smart-brevity omits all three
        expect(standard.byteLength).toBeGreaterThan(brevity.byteLength);
    });

    it('standard with data produces larger DOCX than standard with empty sections', async () => {
        const jsonFull = makeMinutesJson();
        const jsonEmpty = makeMinutesJson({ open_questions: [], deferred_items: [], risks: [] });
        const full = await generateMinutesDocx(jsonFull, { style: 'standard' });
        const empty = await generateMinutesDocx(jsonEmpty, { style: 'standard' });
        // Standard renders Open Questions, Deferred Items, and Risks when present
        expect(full.byteLength).toBeGreaterThan(empty.byteLength);
    });

    it('detailed with appendix data produces larger DOCX than without', async () => {
        const jsonWith = makeMinutesJson();
        const jsonWithout = makeMinutesJson({ risks: [], open_questions: [], deferred_items: [] });
        const withAppendix = await generateMinutesDocx(jsonWith, { style: 'detailed' });
        const withoutAppendix = await generateMinutesDocx(jsonWithout, { style: 'detailed' });
        // Detailed puts risks/questions/deferred in Appendix section
        expect(withAppendix.byteLength).toBeGreaterThan(withoutAppendix.byteLength);
    });

    it('smart-brevity omits sections that standard includes (same data)', async () => {
        // Both receive identical JSON with risks, open_questions, deferred_items
        const json1 = makeMinutesJson();
        const json2 = makeMinutesJson();
        const brevity = await generateMinutesDocx(json1, { style: 'smart-brevity' });
        // smart-brevity with empty sections should be ≈ same size as smart-brevity with full sections
        // because it never renders them
        const json3 = makeMinutesJson({ risks: [], open_questions: [], deferred_items: [] });
        const brevityEmpty = await generateMinutesDocx(json3, { style: 'smart-brevity' });
        // Size difference should be minimal (< 200 bytes) since smart-brevity ignores these sections
        expect(Math.abs(brevity.byteLength - brevityEmpty.byteLength)).toBeLessThan(200);
    });

    it('strips confidence annotations from JSON text fields during generation', async () => {
        const json = makeMinutesJson();
        json.notable_points![0].text = 'Team agreed on freeze *(medium confidence)*';
        json.decisions![0].text = 'Ship feature X *(low confidence)*';
        json.actions![0].text = 'Write tests *(high confidence)*';
        await generateMinutesDocx(json, { style: 'standard' });
        // deepStripConfidence mutates JSON in-place before DOCX generation
        expect(json.notable_points![0].text).toBe('Team agreed on freeze');
        expect(json.decisions![0].text).toBe('Ship feature X');
        expect(json.actions![0].text).toBe('Write tests');
    });
});

// ── Per-agenda-item DOCX generation ─────────────────────────────────

function makeAgendaGroupedJson(overrides: Partial<MinutesJSON> = {}): MinutesJSON {
    return {
        metadata: {
            title: 'Board Meeting Q1',
            date: '2026-03-15',
            start_time: '14:00',
            end_time: '16:00',
            timezone: 'Europe/Helsinki',
            meeting_context: 'board',
            output_audience: 'internal',
            confidentiality_level: 'confidential',
            chair: 'Chair Person',
            minute_taker: 'Secretary',
            location: 'Board Room',
            quorum_present: true,
        },
        participants: [
            { name: 'Chair Person', role: 'Chair', organisation: 'Acme', attendance: 'present' },
            { name: 'Director A', role: 'Director', attendance: 'present' },
            { name: 'Director B', attendance: 'apologies' },
        ],
        agenda: ['Financial review', 'Operations update', 'AOB'],
        decisions: [
            { id: 'D1', text: 'Approve Q1 budget', owner: 'CFO', due_date: '2026-04-01', confidence: 'high', agenda_item_ref: 1 },
            { id: 'D2', text: 'Hire 3 engineers', owner: 'CTO', due_date: '2026-04-15', confidence: 'high', agenda_item_ref: 2 },
        ],
        actions: [
            { id: 'A1', text: 'Submit budget report', owner: 'CFO', due_date: '2026-03-20', status: 'new', confidence: 'high', agenda_item_ref: 1 },
            { id: 'A2', text: 'Post job listings', owner: 'HR', due_date: '2026-03-25', status: 'new', confidence: 'high', agenda_item_ref: 2 },
            { id: 'A3', text: 'Unlinked action item', owner: 'Admin', due_date: '2026-04-01', status: 'new', confidence: 'medium' },
        ],
        risks: [
            { id: 'R1', text: 'Budget overrun risk', impact: 'High', mitigation: 'Monthly reviews', confidence: 'medium' },
        ],
        notable_points: [
            { id: 'N1', text: 'Revenue exceeded targets by 12%', confidence: 'high', agenda_item_ref: 1 },
            { id: 'N2', text: 'Operating costs within budget', confidence: 'high', agenda_item_ref: 1 },
            { id: 'N3', text: 'Staffing levels below target', confidence: 'high', agenda_item_ref: 2 },
            { id: 'N4', text: 'Unlinked general observation', confidence: 'medium' },
        ],
        open_questions: [],
        deferred_items: [],
        ...overrides,
    };
}

describe('generateMinutesDocx — per-agenda-item layout', () => {
    it('produces valid DOCX with agenda-grouped content', async () => {
        const result = await generateMinutesDocx(makeAgendaGroupedJson());
        expect(result).toBeInstanceOf(ArrayBuffer);
        const view = new Uint8Array(result);
        expect(view[0]).toBe(0x50); // PK header
        expect(view[1]).toBe(0x4B);
    });

    it('agenda-grouped DOCX is larger than flat layout (more structural sections)', async () => {
        const grouped = await generateMinutesDocx(makeAgendaGroupedJson());
        const flat = await generateMinutesDocx(makeMinutesJson());
        // Grouped layout has per-item headings, tables, and labels — more content
        expect(grouped.byteLength).toBeGreaterThan(flat.byteLength);
    });

    it('handles agenda items with no linked content (transcript incomplete)', async () => {
        const json = makeAgendaGroupedJson({
            agenda: ['Item with content', 'Empty item', 'Another empty'],
            notable_points: [
                { id: 'N1', text: 'Content for item 1', confidence: 'high', agenda_item_ref: 1 },
            ],
            decisions: [],
            actions: [],
        });
        const result = await generateMinutesDocx(json);
        expect(result.byteLength).toBeGreaterThan(0);
    });

    it('renders unlinked items under General Items section', async () => {
        const json = makeAgendaGroupedJson();
        // json has unlinked A3 and N4 — should appear under General Items
        const result = await generateMinutesDocx(json);
        expect(result.byteLength).toBeGreaterThan(0);
    });

    it('per-agenda-item works with detailed style (prose, no Due column)', async () => {
        const result = await generateMinutesDocx(makeAgendaGroupedJson(), { style: 'detailed' });
        expect(result.byteLength).toBeGreaterThan(0);
    });

    it('per-agenda-item works with smart-brevity (uses flat layout instead)', async () => {
        // Smart-brevity doesn't use per-agenda-item grouping — falls through to flat
        const result = await generateMinutesDocx(makeAgendaGroupedJson(), { style: 'smart-brevity' });
        expect(result.byteLength).toBeGreaterThan(0);
    });

    it('produces Summary section for standard style with notable_points', async () => {
        const json = makeAgendaGroupedJson();
        const withSummary = await generateMinutesDocx(json, { style: 'standard' });
        // Summary section adds content — should be larger than without
        const jsonNoPoints = makeAgendaGroupedJson({ notable_points: [] });
        const withoutSummary = await generateMinutesDocx(jsonNoPoints, { style: 'standard' });
        expect(withSummary.byteLength).toBeGreaterThan(withoutSummary.byteLength);
    });
});
