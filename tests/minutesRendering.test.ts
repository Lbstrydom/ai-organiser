/**
 * Tests for minutes rendering — Phase 3 TRA style-specific renderers.
 *
 * Coverage:
 * - Smart Brevity: 5-section structure, no tables, numbered lists
 * - Standard: header, summary, agenda-grouped, opportunities (max 6), no Status
 * - Detailed: governance prose, compact D/A tables, appendix, no confidence
 * - Guided: LLM markdown passthrough, standard fallback
 * - stripConfidenceAnnotations: stripping all levels, preserving other text
 * - Shared: GTD rendering, empty agenda warnings, flat fallback
 * - Prompt schema: agenda_item_ref in extraction/merge/consolidation
 */

import { renderMinutesFromJson, stripConfidenceAnnotations, isUsableMarkdown } from '../src/utils/minutesUtils';
import type { MinutesJSON } from '../src/services/prompts/minutesPrompts';

function makeMinimalJson(overrides: Partial<MinutesJSON> = {}): MinutesJSON {
    return {
        metadata: {
            title: 'Test Meeting',
            date: '2026-02-24',
            start_time: '09:00',
            end_time: '10:00',
            timezone: 'UTC',
            meeting_context: 'internal',
            output_audience: 'internal',
            confidentiality_level: 'internal',
            chair: 'Alice',
            minute_taker: 'Bob',
            location: 'Room A',
            quorum_present: true
        },
        participants: [
            { name: 'Alice', role: 'Chair', attendance: 'present' },
            { name: 'Bob', attendance: 'present' },
        ],
        agenda: [],
        decisions: [],
        actions: [],
        risks: [],
        notable_points: [],
        open_questions: [],
        deferred_items: [],
        ...overrides
    };
}

// -------------------------------------------------------------------
// stripConfidenceAnnotations
// -------------------------------------------------------------------
describe('stripConfidenceAnnotations', () => {
    it('should strip *(low confidence)*', () => {
        expect(stripConfidenceAnnotations('Point A *(low confidence)*')).toBe('Point A');
    });

    it('should strip *(medium confidence)* and *(high confidence)*', () => {
        const text = 'Decision *(medium confidence)* and another *(high confidence)*';
        const result = stripConfidenceAnnotations(text);
        expect(result).not.toContain('confidence');
        expect(result).toContain('Decision');
        expect(result).toContain('another');
    });

    it('should strip shorthand *(low)*, *(medium)*, *(high)*', () => {
        expect(stripConfidenceAnnotations('Item *(low)* text *(high)*')).toBe('Item text');
    });

    it('should preserve non-confidence parenthetical text', () => {
        expect(stripConfidenceAnnotations('Alice (Chair) noted the issue')).toBe('Alice (Chair) noted the issue');
    });

    it('should be case-insensitive', () => {
        expect(stripConfidenceAnnotations('X *(LOW CONFIDENCE)*')).toBe('X');
    });

    it('should be no-op on clean text', () => {
        expect(stripConfidenceAnnotations('Clean text with no annotations')).toBe('Clean text with no annotations');
    });

    it('renderMinutesFromJson strips confidence from JSON text fields', () => {
        const json = makeMinimalJson({
            notable_points: [
                { id: 'NP1', text: 'Point A *(medium confidence)*', confidence: 'medium' },
            ],
            decisions: [
                { id: 'D1', text: 'Decision B *(low confidence)*', owner: 'Alice', due_date: '', confidence: 'low' },
            ],
        });
        const output = renderMinutesFromJson(json, 'standard');
        expect(output).not.toContain('*(medium confidence)*');
        expect(output).not.toContain('*(low confidence)*');
        expect(output).toContain('Point A');
        expect(output).toContain('Decision B');
    });
});

// -------------------------------------------------------------------
// isUsableMarkdown
// -------------------------------------------------------------------
describe('isUsableMarkdown', () => {
    it('should accept text with heading and >200 chars', () => {
        const text = '# Heading\n\n' + 'a'.repeat(200);
        expect(isUsableMarkdown(text)).toBe(true);
    });

    it('should reject short text', () => {
        expect(isUsableMarkdown('# Short')).toBe(false);
    });

    it('should reject JSON-like text', () => {
        expect(isUsableMarkdown('{ "key": "value" }' + 'x'.repeat(200))).toBe(false);
    });

    it('should reject text without headings', () => {
        expect(isUsableMarkdown('No heading here ' + 'x'.repeat(200))).toBe(false);
    });
});

// -------------------------------------------------------------------
// Smart Brevity renderer
// -------------------------------------------------------------------
describe('Smart Brevity renderer', () => {
    it('should have 5 required sections', () => {
        const json = makeMinimalJson({
            notable_points: [{ id: 'N1', text: 'Key point about revenue', confidence: 'high' }],
            decisions: [{ id: 'D1', text: 'Approved budget', owner: 'CFO', confidence: 'high' }],
            actions: [{ id: 'A1', text: 'Send report', owner: 'Bob', due_date: '2026-03-01', confidence: 'high' }],
        });
        const result = renderMinutesFromJson(json, 'smart-brevity');

        expect(result).toContain('## The big thing');
        expect(result).toContain('## Why it matters');
        expect(result).toContain('## Decisions');
        expect(result).toContain('## Actions');
        expect(result).toContain('## Go deeper');
    });

    it('should use numbered lists for decisions, not tables', () => {
        const json = makeMinimalJson({
            decisions: [
                { id: 'D1', text: 'Approved budget', owner: 'CFO', confidence: 'high' },
                { id: 'D2', text: 'Approved timeline', owner: 'PM', confidence: 'high' },
            ],
        });
        const result = renderMinutesFromJson(json, 'smart-brevity');

        expect(result).toContain('1. Approved budget');
        expect(result).toContain('2. Approved timeline');
        expect(result).not.toContain('| ID |');
    });

    it('should use numbered action format: Action — Owner — Due', () => {
        const json = makeMinimalJson({
            actions: [{ id: 'A1', text: 'Send report', owner: 'Bob', due_date: '2026-03-01', confidence: 'high' }],
        });
        const result = renderMinutesFromJson(json, 'smart-brevity');
        expect(result).toContain('1. Send report — Bob — 2026-03-01');
    });

    it('should not have tables or risks section', () => {
        const json = makeMinimalJson({
            risks: [{ id: 'R1', text: 'Supply risk', confidence: 'high' }],
            decisions: [{ id: 'D1', text: 'Dec', owner: '', confidence: 'high' }],
        });
        const result = renderMinutesFromJson(json, 'smart-brevity');
        expect(result).not.toContain('| ID |');
        expect(result).not.toContain('## Risks');
        expect(result).not.toContain('## Opportunities');
    });

    it('should not render header block', () => {
        const result = renderMinutesFromJson(makeMinimalJson(), 'smart-brevity');
        expect(result).not.toContain('**Chair:**');
        expect(result).not.toContain('**Attendees:**');
    });

    it('should append GTD when present', () => {
        const json = makeMinimalJson({
            notable_points: [{ id: 'N1', text: 'Point', confidence: 'high' }],
            gtd_processing: {
                next_actions: [{ text: 'Call client', context: '@call' }],
                waiting_for: [],
                projects: [],
                someday_maybe: []
            }
        });
        const result = renderMinutesFromJson(json, 'smart-brevity');
        expect(result).toContain('## GTD: Next Actions');
    });
});

// -------------------------------------------------------------------
// Standard renderer
// -------------------------------------------------------------------
describe('Standard renderer', () => {
    it('should render header with metadata', () => {
        const result = renderMinutesFromJson(makeMinimalJson(), 'standard');
        expect(result.startsWith('# Test Meeting')).toBe(true);
        expect(result).toContain('**Date:** 2026-02-24');
        expect(result).toContain('**Chair:** Alice');
    });

    it('should include attendees and apologies', () => {
        const result = renderMinutesFromJson(makeMinimalJson({
            participants: [
                { name: 'Alice', role: 'Chair', attendance: 'present' },
                { name: 'Carol', attendance: 'apologies' },
            ],
        }), 'standard');
        expect(result).toContain('**Attendees:** Alice (Chair)');
        expect(result).toContain('**Apologies:** Carol');
    });

    it('should render Summary from notable points', () => {
        const result = renderMinutesFromJson(makeMinimalJson({
            notable_points: [{ id: 'N1', text: 'Revenue up 15%', confidence: 'high' }],
        }), 'standard');
        expect(result).toContain('## Summary');
        expect(result).toContain('Revenue up 15%');
    });

    it('should render Decisions as flat table when no agenda', () => {
        const result = renderMinutesFromJson(makeMinimalJson({
            decisions: [{ id: 'D1', text: 'Approve budget', owner: 'CFO', confidence: 'high' }],
        }), 'standard');
        expect(result).toContain('## Decisions');
        expect(result).toContain('| D1 |');
    });

    it('should render Actions as flat table without Status column', () => {
        const result = renderMinutesFromJson(makeMinimalJson({
            actions: [{ id: 'A1', text: 'Send report', owner: 'Bob', due_date: '2026-03-01', status: 'new', confidence: 'high' }],
        }), 'standard');
        expect(result).toContain('## Actions');
        expect(result).toContain('| A1 |');
        expect(result).not.toContain('| Status |');
        expect(result).not.toContain('| new |');
    });

    it('should render Opportunities and obstacles (max 6) instead of Risks', () => {
        const risks = Array.from({ length: 8 }, (_, i) => ({
            id: `R${i + 1}`, text: `Risk ${i + 1}`, confidence: 'high' as const
        }));
        const result = renderMinutesFromJson(makeMinimalJson({ risks }), 'standard');
        expect(result).toContain('## Opportunities and obstacles');
        expect(result).not.toContain('## Risks & Issues');
        // Max 6 items
        expect(result).toContain('Risk 6');
        expect(result).not.toContain('Risk 7');
    });

    it('should NOT render Open Questions or Deferred Items as standalone sections', () => {
        const result = renderMinutesFromJson(makeMinimalJson({
            open_questions: [{ id: 'Q1', text: 'Timeline?', confidence: 'medium' }],
            deferred_items: [{ id: 'P1', text: 'Relocation', reason: 'Waiting on lease' }],
        }), 'standard');
        expect(result).not.toContain('## Open Questions');
        expect(result).not.toContain('## Deferred Items');
    });

    it('should NOT show confidence annotations', () => {
        const result = renderMinutesFromJson(makeMinimalJson({
            notable_points: [{ id: 'N1', text: 'Low conf point', confidence: 'low' }],
        }), 'standard');
        expect(result).not.toContain('confidence');
    });

    it('should use em-dash for missing values in tables', () => {
        const result = renderMinutesFromJson(makeMinimalJson({
            decisions: [{ id: 'D1', text: 'Some decision', confidence: 'high' }],
        }), 'standard');
        expect(result).toContain('| — |');
    });

    it('should use agenda-grouped layout when items have refs', () => {
        const json = makeMinimalJson({
            agenda: ['Budget Review', 'Team Updates'],
            notable_points: [{ id: 'N1', agenda_item_ref: 1, text: 'Revenue met target', confidence: 'high' }],
            decisions: [{ id: 'D1', agenda_item_ref: 1, text: 'Approve budget', owner: 'CFO', confidence: 'high' }],
        });
        const result = renderMinutesFromJson(json, 'standard');
        expect(result).toContain('## 1. Budget Review');
    });

    it('should fall back to flat layout when no agenda refs', () => {
        const result = renderMinutesFromJson(makeMinimalJson({
            agenda: ['Budget Review'],
            notable_points: [{ id: 'N1', text: 'Revenue up', confidence: 'high' }],
            decisions: [{ id: 'D1', text: 'Approve budget', owner: 'CFO', confidence: 'high' }],
        }), 'standard');
        expect(result).toContain('## Agenda');
        expect(result).toContain('1. Budget Review');
        expect(result).not.toContain('## 1. Budget Review');
    });
});

// -------------------------------------------------------------------
// Standard renderer — agenda-grouped details
// -------------------------------------------------------------------
describe('Standard agenda-grouped layout', () => {
    const agendaJson = makeMinimalJson({
        agenda: ['Budget Review', 'Team Updates', 'AOB'],
        notable_points: [
            { id: 'N1', agenda_item_ref: 1, text: 'Q4 revenue met target', confidence: 'high' },
            { id: 'N2', agenda_item_ref: 2, text: 'Hiring pipeline is strong', confidence: 'medium' },
            { id: 'N3', text: 'Car park changes next month', confidence: 'high' },
        ],
        decisions: [
            { id: 'D1', agenda_item_ref: 1, text: 'Approve Q1 budget', owner: 'CFO', confidence: 'high' },
        ],
        actions: [
            { id: 'A1', agenda_item_ref: 1, text: 'Distribute budget packs', owner: 'Bob', due_date: '2026-03-01', confidence: 'high' },
            { id: 'A2', agenda_item_ref: 2, text: 'Schedule interviews', owner: 'Alice', due_date: '2026-03-15', confidence: 'high' },
        ],
    });

    it('should render agenda items as H2 section headings', () => {
        const result = renderMinutesFromJson(agendaJson, 'standard');
        expect(result).toContain('## 1. Budget Review');
        expect(result).toContain('## 2. Team Updates');
    });

    it('should group items under their agenda item', () => {
        const result = renderMinutesFromJson(agendaJson, 'standard');
        const budgetSection = result.split('## 2.')[0];
        expect(budgetSection).toContain('Q4 revenue met target');
        expect(budgetSection).toContain('Approve Q1 budget');
        expect(budgetSection).toContain('Distribute budget packs');
    });

    it('should put unlinked items in General Items section', () => {
        const result = renderMinutesFromJson(agendaJson, 'standard');
        expect(result).toContain('## General Items');
        expect(result).toContain('Car park changes next month');
    });

    it('should show transcript incomplete for empty agenda items', () => {
        const result = renderMinutesFromJson(agendaJson, 'standard');
        expect(result).toContain('## 3. AOB');
        expect(result).toContain('**[Transcript incomplete]**');
    });

    it('should NOT show flat Agenda list in grouped mode', () => {
        const result = renderMinutesFromJson(agendaJson, 'standard');
        expect(result).not.toMatch(/^## Agenda$/m);
    });

    it('grouped sections should flow: heading → points → decisions → actions', () => {
        const json = makeMinimalJson({
            agenda: ['Budget Review'],
            notable_points: [{ id: 'N1', agenda_item_ref: 1, text: 'Revenue met target', confidence: 'high' }],
            decisions: [{ id: 'D1', agenda_item_ref: 1, text: 'Approve budget', owner: 'CFO', confidence: 'high' }],
            actions: [{ id: 'A1', agenda_item_ref: 1, text: 'Send packs', owner: 'Bob', due_date: '2026-03', confidence: 'high' }],
        });
        const result = renderMinutesFromJson(json, 'standard');

        const headingIdx = result.indexOf('## 1. Budget Review');
        // Search for the point AFTER the heading (it also appears in the Summary section earlier)
        const pointIdx = result.indexOf('Revenue met target', headingIdx);
        const decisionIdx = result.indexOf('**Decisions**', headingIdx);
        const actionIdx = result.indexOf('**Actions**', headingIdx);

        expect(headingIdx).toBeGreaterThan(-1);
        expect(headingIdx).toBeLessThan(pointIdx);
        expect(pointIdx).toBeLessThan(decisionIdx);
        expect(decisionIdx).toBeLessThan(actionIdx);
    });

    it('should separate sections with blank lines (no triple newlines)', () => {
        const result = renderMinutesFromJson(agendaJson, 'standard');
        expect(result).not.toMatch(/\n\n\n/);
    });

    it('GTD should render after grouped content', () => {
        const json = makeMinimalJson({
            agenda: ['Topic A'],
            notable_points: [{ id: 'N1', agenda_item_ref: 1, text: 'Point', confidence: 'high' }],
            gtd_processing: {
                next_actions: [{ text: 'Task', context: '@office' }],
                waiting_for: [],
                projects: [],
                someday_maybe: []
            }
        });
        const result = renderMinutesFromJson(json, 'standard');
        const agendaIdx = result.indexOf('## 1. Topic A');
        const gtdIdx = result.indexOf('## GTD: Next Actions');
        expect(agendaIdx).toBeLessThan(gtdIdx);
    });
});

// -------------------------------------------------------------------
// Detailed renderer (governance)
// -------------------------------------------------------------------
describe('Detailed renderer', () => {
    it('should include quorum in header', () => {
        const result = renderMinutesFromJson(makeMinimalJson(), 'detailed');
        expect(result).toContain('**Quorum:** Yes');
    });

    it('should NOT show confidence annotations in output', () => {
        const json = makeMinimalJson({
            agenda: ['Topic A'],
            notable_points: [{ id: 'N1', agenda_item_ref: 1, text: 'Low conf point', confidence: 'low' }],
        });
        const result = renderMinutesFromJson(json, 'detailed');
        expect(result).not.toContain('*(low confidence)*');
        expect(result).not.toContain('*(low)*');
    });

    it('should NOT have Status column in actions', () => {
        const json = makeMinimalJson({
            agenda: ['Topic A'],
            actions: [{ id: 'A1', agenda_item_ref: 1, text: 'Do thing', owner: 'X', due_date: 'TBC', status: 'new', confidence: 'high' }],
        });
        const result = renderMinutesFromJson(json, 'detailed');
        expect(result).not.toContain('| Status |');
        expect(result).not.toContain('| new |');
    });

    it('should render prose paragraphs (no bullets) for notable points in agenda-grouped', () => {
        const json = makeMinimalJson({
            agenda: ['Topic A'],
            notable_points: [
                { id: 'N1', agenda_item_ref: 1, text: 'The Board noted that revenue was strong.', confidence: 'high' },
                { id: 'N2', agenda_item_ref: 1, text: 'Expenses remained within budget.', confidence: 'high' },
            ],
        });
        const result = renderMinutesFromJson(json, 'detailed');
        // Should be prose (no leading bullet)
        expect(result).toContain('The Board noted that revenue was strong.');
        expect(result).not.toMatch(/^- The Board/m);
    });

    it('should have compact Decisions table (ID | Decision | Owner)', () => {
        const json = makeMinimalJson({
            agenda: ['Topic A'],
            decisions: [{ id: 'D1', agenda_item_ref: 1, text: 'Approved budget', owner: 'CFO', confidence: 'high' }],
        });
        const result = renderMinutesFromJson(json, 'detailed');
        expect(result).toContain('| ID | Decision | Owner |');
        // Should NOT have Due column in detailed decisions
        expect(result).not.toMatch(/\| ID \| Decision \| Owner \| Due \|/);
    });

    it('should have compact Actions table (ID | Action | Owner | Due, no Status)', () => {
        const json = makeMinimalJson({
            agenda: ['Topic A'],
            actions: [{ id: 'A1', agenda_item_ref: 1, text: 'Send report', owner: 'Bob', due_date: '2026-03-01', confidence: 'high' }],
        });
        const result = renderMinutesFromJson(json, 'detailed');
        expect(result).toContain('| ID | Action | Owner | Due |');
        expect(result).not.toContain('| Status |');
    });

    it('should render Appendix with risks, deferred, and open questions', () => {
        const json = makeMinimalJson({
            risks: [{ id: 'R1', text: 'Exchange risk', confidence: 'high' }],
            deferred_items: [{ id: 'P1', text: 'Office relocation', reason: 'Lease pending' }],
            open_questions: [{ id: 'Q1', text: 'Phase 2 timing?', confidence: 'medium' }],
        });
        const result = renderMinutesFromJson(json, 'detailed');
        expect(result).toContain('## Appendix');
        expect(result).toContain('### Risks & Issues');
        expect(result).toContain('### Deferred Items');
        expect(result).toContain('### Follow-up Items');
    });

    it('should NOT render Appendix when no risks/deferred/questions', () => {
        const result = renderMinutesFromJson(makeMinimalJson(), 'detailed');
        expect(result).not.toContain('## Appendix');
    });

    it('should show transcript incomplete for empty agenda items', () => {
        const json = makeMinimalJson({
            agenda: ['Topic A', 'Topic B'],
            notable_points: [{ id: 'N1', agenda_item_ref: 1, text: 'Some content', confidence: 'high' }],
        });
        const result = renderMinutesFromJson(json, 'detailed');
        expect(result).toContain('**[Transcript incomplete]**');
    });
});

// -------------------------------------------------------------------
// Guided renderer (LLM passthrough)
// -------------------------------------------------------------------
describe('Guided renderer', () => {
    it('should pass through valid LLM markdown', () => {
        const llmMarkdown = '# Meeting Minutes\n\n## Discussion\n\n' + 'The committee discussed various items. '.repeat(10);
        const json = makeMinimalJson();
        const result = renderMinutesFromJson(json, 'guided', false, llmMarkdown);
        expect(result).toContain('# Meeting Minutes');
        expect(result).toContain('## Discussion');
    });

    it('should strip confidence from passthrough markdown', () => {
        const llmMarkdown = '# Meeting Minutes\n\n## Items\n\nPoint A *(low confidence)* discussed. ' + 'x'.repeat(200);
        const result = renderMinutesFromJson(makeMinimalJson(), 'guided', false, llmMarkdown);
        expect(result).not.toContain('confidence');
    });

    it('should fall back to standard when LLM markdown is unusable', () => {
        const result = renderMinutesFromJson(makeMinimalJson({
            notable_points: [{ id: 'N1', text: 'Point', confidence: 'high' }],
        }), 'guided', false, 'too short');
        // Should get standard renderer output
        expect(result).toContain('# Test Meeting');
        expect(result).toContain('## Summary');
    });

    it('should fall back to standard when no LLM markdown provided', () => {
        const result = renderMinutesFromJson(makeMinimalJson(), 'guided');
        expect(result).toContain('# Test Meeting');
    });
});

// -------------------------------------------------------------------
// Prompt schema tests — agenda_item_ref in extraction
// -------------------------------------------------------------------
describe('Prompt schema changes', () => {
    let buildChunkExtractionPrompt: typeof import('../src/services/prompts/minutesPrompts').buildChunkExtractionPrompt;
    let buildIntermediateMergePrompt: typeof import('../src/services/prompts/minutesPrompts').buildIntermediateMergePrompt;
    let buildStyleConsolidationPrompt: typeof import('../src/services/prompts/minutesPrompts').buildStyleConsolidationPrompt;

    beforeAll(async () => {
        const mod = await import('../src/services/prompts/minutesPrompts');
        buildChunkExtractionPrompt = mod.buildChunkExtractionPrompt;
        buildIntermediateMergePrompt = mod.buildIntermediateMergePrompt;
        buildStyleConsolidationPrompt = mod.buildStyleConsolidationPrompt;
    });

    it('chunk extraction should include agenda_item_ref in actions and decisions schema', () => {
        const prompt = buildChunkExtractionPrompt({
            agenda: ['Budget Review', 'Hiring'],
        });
        expect(prompt).toMatch(/"actions".*agenda_item_ref/s);
        expect(prompt).toMatch(/"decisions".*agenda_item_ref/s);
    });

    it('chunk extraction should instruct to set agenda_item_ref when agenda provided', () => {
        const prompt = buildChunkExtractionPrompt({
            agenda: ['Budget Review'],
        });
        expect(prompt).toContain('agenda_item_ref');
        expect(prompt.toLowerCase()).toContain('matching item number');
    });

    it('intermediate merge should include agenda_item_ref in schema', () => {
        const prompt = buildIntermediateMergePrompt();
        expect(prompt).toContain('agenda_item_ref');
    });

    it('intermediate merge should instruct to preserve agenda_item_ref', () => {
        const prompt = buildIntermediateMergePrompt();
        expect(prompt.toLowerCase()).toContain('preserve agenda_item_ref');
    });

    it('consolidation should instruct to copy agenda array from input', () => {
        const prompt = buildStyleConsolidationPrompt({
            minutesStyle: 'standard',
            outputLanguage: 'English',
        });
        expect(prompt.toLowerCase()).toContain('copy the agenda array');
    });

    it('consolidation should include agenda_item_ref in notable_points schema', () => {
        const prompt = buildStyleConsolidationPrompt({
            minutesStyle: 'standard',
            outputLanguage: 'English',
        });
        expect(prompt).toMatch(/"notable_points".*agenda_item_ref/s);
    });
});
