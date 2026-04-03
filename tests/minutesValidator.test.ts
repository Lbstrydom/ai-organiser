/**
 * Minutes JSON Schema Validator Tests
 * Comprehensive tests for validateMinutesJSON: metadata, participants,
 * actions, decisions, ID auto-fix, cross-references, GTD, confidence audit.
 */

import { validateMinutesJSON } from '../src/services/validators/minutesValidator';
import type { MinutesJSON } from '../src/services/prompts/minutesPrompts';
import type { ValidationIssue } from '../src/services/validators/types';

/** Build a minimal valid MinutesJSON for testing, with optional overrides. */
function makeMinimalJson(overrides: Partial<MinutesJSON> = {}): MinutesJSON {
    return {
        metadata: {
            title: 'Test Meeting',
            date: '2026-02-22',
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
        participants: [{ name: 'Alice', role: 'Chair' }, { name: 'Bob' }],
        agenda: ['Budget review', 'Roadmap update'],
        decisions: [{ id: 'D1', text: 'Approve budget', confidence: 'high' }],
        actions: [{ id: 'A1', text: 'Draft proposal', owner: 'Alice', due_date: '2026-03-01', confidence: 'high' }],
        risks: [{ id: 'R1', text: 'Budget overrun', confidence: 'medium' }],
        notable_points: [{ id: 'N1', text: 'Revenue up 10%', confidence: 'high' }],
        open_questions: [{ id: 'Q1', text: 'Hire timeline?', confidence: 'medium' }],
        deferred_items: [{ id: 'P1', text: 'Office move discussion' }],
        ...overrides
    };
}

/** Helper to find issues by field substring */
function issuesForField(issues: ValidationIssue[], field: string): ValidationIssue[] {
    return issues.filter(i => i.field.includes(field));
}

// ─── Metadata ────────────────────────────────────────────────────────────────

describe('Metadata validation', () => {
    it('should pass with valid metadata', () => {
        const result = validateMinutesJSON(makeMinimalJson());
        expect(result.valid).toBe(true);
        expect(issuesForField(result.issues, 'metadata.title')).toHaveLength(0);
        expect(issuesForField(result.issues, 'metadata.date')).toHaveLength(0);
    });

    it('should warn on empty title', () => {
        const json = makeMinimalJson();
        json.metadata.title = '';
        const result = validateMinutesJSON(json);
        const titleIssues = issuesForField(result.issues, 'metadata.title');
        expect(titleIssues).toHaveLength(1);
        expect(titleIssues[0].severity).toBe('warning');
        expect(titleIssues[0].message).toContain('empty');
    });

    it('should warn on whitespace-only title', () => {
        const json = makeMinimalJson();
        json.metadata.title = '   ';
        const result = validateMinutesJSON(json);
        expect(issuesForField(result.issues, 'metadata.title')).toHaveLength(1);
    });

    it('should warn on empty date', () => {
        const json = makeMinimalJson();
        json.metadata.date = '';
        const result = validateMinutesJSON(json);
        const dateIssues = issuesForField(result.issues, 'metadata.date');
        expect(dateIssues).toHaveLength(1);
        expect(dateIssues[0].severity).toBe('warning');
    });

    it('should warn on unparseable date', () => {
        const json = makeMinimalJson();
        json.metadata.date = 'not-a-date-xyz';
        const result = validateMinutesJSON(json);
        const dateIssues = issuesForField(result.issues, 'metadata.date');
        expect(dateIssues).toHaveLength(1);
        expect(dateIssues[0].message).toContain('not parseable');
    });

    it('should accept ISO date format', () => {
        const json = makeMinimalJson();
        json.metadata.date = '2026-02-22T10:00:00Z';
        const result = validateMinutesJSON(json);
        expect(issuesForField(result.issues, 'metadata.date')).toHaveLength(0);
    });

    it('should emit info for each missing time field individually', () => {
        const json = makeMinimalJson();
        json.metadata.start_time = '';
        json.metadata.end_time = '';
        const result = validateMinutesJSON(json);
        const startIssues = issuesForField(result.issues, 'metadata.start_time');
        const endIssues = issuesForField(result.issues, 'metadata.end_time');
        expect(startIssues).toHaveLength(1);
        expect(startIssues[0].severity).toBe('info');
        expect(endIssues).toHaveLength(1);
        expect(endIssues[0].severity).toBe('info');
    });

    it('should emit info for missing start_time only', () => {
        const json = makeMinimalJson();
        json.metadata.start_time = '';
        const result = validateMinutesJSON(json);
        expect(issuesForField(result.issues, 'metadata.start_time')).toHaveLength(1);
        expect(issuesForField(result.issues, 'metadata.end_time')).toHaveLength(0);
    });

    it('should error on missing metadata object', () => {
        const json = makeMinimalJson();
        (json as any).metadata = undefined;
        const result = validateMinutesJSON(json);
        expect(result.valid).toBe(false);
        const metaIssues = result.issues.filter(i => i.field === 'metadata');
        expect(metaIssues).toHaveLength(1);
        expect(metaIssues[0].severity).toBe('error');
    });
});

// ─── Participants ────────────────────────────────────────────────────────────

describe('Participants validation', () => {
    it('should pass with valid participants', () => {
        const result = validateMinutesJSON(makeMinimalJson());
        expect(issuesForField(result.issues, 'participants')).toHaveLength(0);
    });

    it('should warn when participants array is empty', () => {
        const json = makeMinimalJson({ participants: [] });
        const result = validateMinutesJSON(json);
        const pIssues = issuesForField(result.issues, 'participants');
        expect(pIssues).toHaveLength(1);
        expect(pIssues[0].severity).toBe('warning');
        expect(pIssues[0].message).toContain('No participants');
    });

    it('should warn when a participant has an empty name', () => {
        const json = makeMinimalJson({
            participants: [{ name: 'Alice' }, { name: '' }]
        });
        const result = validateMinutesJSON(json);
        const nameIssues = result.issues.filter(i => i.field.includes('participants[1].name'));
        expect(nameIssues).toHaveLength(1);
        expect(nameIssues[0].severity).toBe('warning');
    });
});

// ─── Actions ─────────────────────────────────────────────────────────────────

describe('Actions validation', () => {
    it('should pass with valid actions', () => {
        const result = validateMinutesJSON(makeMinimalJson());
        expect(result.valid).toBe(true);
        expect(result.issues.filter(i => i.field.startsWith('actions['))).toHaveLength(0);
    });

    it('should auto-fix missing action ID', () => {
        const json = makeMinimalJson({
            actions: [
                { id: '', text: 'Do something', owner: 'Alice', due_date: '2026-03-01', confidence: 'high' }
            ]
        });
        const result = validateMinutesJSON(json);
        expect(result.data.actions[0].id).toBe('A1');
        const idIssues = result.issues.filter(i => i.field === 'actions[0].id' && i.autoFixed);
        expect(idIssues).toHaveLength(1);
        expect(idIssues[0].severity).toBe('info');
    });

    it('should error on duplicate action IDs', () => {
        const json = makeMinimalJson({
            actions: [
                { id: 'A1', text: 'First', owner: 'Alice', due_date: '2026-03-01', confidence: 'high' },
                { id: 'A1', text: 'Second', owner: 'Bob', due_date: '2026-03-02', confidence: 'high' }
            ]
        });
        const result = validateMinutesJSON(json);
        expect(result.valid).toBe(false);
        const dupIssues = result.issues.filter(i => i.message.includes('Duplicate action ID'));
        expect(dupIssues).toHaveLength(1);
        expect(dupIssues[0].severity).toBe('error');
    });

    it('should auto-fix empty action owner to TBC', () => {
        const json = makeMinimalJson({
            actions: [
                { id: 'A1', text: 'Do something', owner: '', due_date: '2026-03-01', confidence: 'high' }
            ]
        });
        const result = validateMinutesJSON(json);
        expect(result.data.actions[0].owner).toBe('TBC');
        const ownerIssues = result.issues.filter(i => i.field === 'actions[0].owner' && i.autoFixed);
        expect(ownerIssues).toHaveLength(1);
    });

    it('should error on empty action text', () => {
        const json = makeMinimalJson({
            actions: [
                { id: 'A1', text: '', owner: 'Alice', due_date: '2026-03-01', confidence: 'high' }
            ]
        });
        const result = validateMinutesJSON(json);
        expect(result.valid).toBe(false);
        const textIssues = result.issues.filter(i => i.field === 'actions[0].text');
        expect(textIssues).toHaveLength(1);
        expect(textIssues[0].severity).toBe('error');
    });

    it('should warn when due_date is missing', () => {
        const json = makeMinimalJson({
            actions: [
                { id: 'A1', text: 'Do something', owner: 'Alice', due_date: '', confidence: 'high' }
            ]
        });
        const result = validateMinutesJSON(json);
        const dateIssues = result.issues.filter(i => i.field === 'actions[0].due_date');
        expect(dateIssues).toHaveLength(1);
        expect(dateIssues[0].severity).toBe('warning');
        expect(dateIssues[0].message).toContain('no due_date');
    });

    it('should warn on unparseable due_date', () => {
        const json = makeMinimalJson({
            actions: [
                { id: 'A1', text: 'Do something', owner: 'Alice', due_date: 'next-tuesday-maybe', confidence: 'high' }
            ]
        });
        const result = validateMinutesJSON(json);
        const dateIssues = result.issues.filter(i => i.field === 'actions[0].due_date');
        expect(dateIssues).toHaveLength(1);
        expect(dateIssues[0].severity).toBe('warning');
        expect(dateIssues[0].message).toContain('unparseable');
    });

    it('should accept TBC as a valid due_date', () => {
        const json = makeMinimalJson({
            actions: [
                { id: 'A1', text: 'Do something', owner: 'Alice', due_date: 'TBC', confidence: 'high' }
            ]
        });
        const result = validateMinutesJSON(json);
        expect(result.issues.filter(i => i.field === 'actions[0].due_date')).toHaveLength(0);
    });

    it('should warn and auto-fix out-of-bounds agenda_item_ref', () => {
        const json = makeMinimalJson({
            agenda: ['Item 1', 'Item 2'],
            actions: [
                { id: 'A1', text: 'Do something', owner: 'Alice', due_date: '2026-03-01', confidence: 'high', agenda_item_ref: 5 }
            ]
        });
        const result = validateMinutesJSON(json);
        expect(result.data.actions[0].agenda_item_ref).toBeNull();
        const refIssues = result.issues.filter(i => i.field === 'actions[0].agenda_item_ref');
        expect(refIssues).toHaveLength(1);
        expect(refIssues[0].autoFixed).toBe(true);
    });

    it('should accept valid agenda_item_ref within bounds', () => {
        const json = makeMinimalJson({
            agenda: ['Item 1', 'Item 2'],
            actions: [
                { id: 'A1', text: 'Do something', owner: 'Alice', due_date: '2026-03-01', confidence: 'high', agenda_item_ref: 2 }
            ]
        });
        const result = validateMinutesJSON(json);
        expect(result.data.actions[0].agenda_item_ref).toBe(2);
        expect(result.issues.filter(i => i.field === 'actions[0].agenda_item_ref')).toHaveLength(0);
    });

    it('should handle missing actions array by initializing to empty', () => {
        const json = makeMinimalJson();
        (json as any).actions = undefined;
        const result = validateMinutesJSON(json);
        expect(result.data.actions).toEqual([]);
    });
});

// ─── Decisions ───────────────────────────────────────────────────────────────

describe('Decisions validation', () => {
    it('should auto-fix missing decision ID', () => {
        const json = makeMinimalJson({
            decisions: [
                { id: '', text: 'Approve plan', confidence: 'high' }
            ]
        });
        const result = validateMinutesJSON(json);
        expect(result.data.decisions[0].id).toBe('D1');
        const idIssues = result.issues.filter(i => i.field === 'decisions[0].id' && i.autoFixed);
        expect(idIssues).toHaveLength(1);
    });

    it('should error on duplicate decision IDs', () => {
        const json = makeMinimalJson({
            decisions: [
                { id: 'D1', text: 'First', confidence: 'high' },
                { id: 'D1', text: 'Second', confidence: 'medium' }
            ]
        });
        const result = validateMinutesJSON(json);
        expect(result.valid).toBe(false);
        expect(result.issues.some(i => i.message.includes('Duplicate decision ID'))).toBe(true);
    });

    it('should error on empty decision text', () => {
        const json = makeMinimalJson({
            decisions: [
                { id: 'D1', text: '  ', confidence: 'high' }
            ]
        });
        const result = validateMinutesJSON(json);
        expect(result.valid).toBe(false);
        const textIssues = result.issues.filter(i => i.field === 'decisions[0].text');
        expect(textIssues).toHaveLength(1);
        expect(textIssues[0].severity).toBe('error');
    });

    it('should handle missing decisions array by initializing to empty', () => {
        const json = makeMinimalJson();
        (json as any).decisions = undefined;
        const result = validateMinutesJSON(json);
        expect(result.data.decisions).toEqual([]);
    });
});

// ─── Risks / Notable Points / Open Questions / Deferred Items ────────────────

describe('Optional array ID auto-fix', () => {
    it('should auto-fix missing risk IDs with R prefix', () => {
        const json = makeMinimalJson({
            risks: [
                { id: '', text: 'Risk 1', confidence: 'low' },
                { id: '', text: 'Risk 2', confidence: 'medium' }
            ]
        });
        const result = validateMinutesJSON(json);
        expect(result.data.risks![0].id).toBe('R1');
        expect(result.data.risks![1].id).toBe('R2');
        expect(result.issues.filter(i => i.field.includes('risks') && i.autoFixed)).toHaveLength(2);
    });

    it('should auto-fix missing notable_points IDs with N prefix', () => {
        const json = makeMinimalJson({
            notable_points: [{ id: '', text: 'Point 1', confidence: 'high' }]
        });
        const result = validateMinutesJSON(json);
        expect(result.data.notable_points![0].id).toBe('N1');
    });

    it('should auto-fix missing open_questions IDs with Q prefix', () => {
        const json = makeMinimalJson({
            open_questions: [{ id: '', text: 'Question?', confidence: 'medium' }]
        });
        const result = validateMinutesJSON(json);
        expect(result.data.open_questions![0].id).toBe('Q1');
    });

    it('should auto-fix missing deferred_items IDs with P prefix', () => {
        const json = makeMinimalJson({
            deferred_items: [{ id: '', text: 'Deferred thing' }]
        });
        const result = validateMinutesJSON(json);
        expect(result.data.deferred_items![0].id).toBe('P1');
    });

    it('should initialize missing optional arrays to empty', () => {
        const json = makeMinimalJson();
        (json as any).risks = undefined;
        (json as any).notable_points = undefined;
        (json as any).open_questions = undefined;
        (json as any).deferred_items = undefined;
        const result = validateMinutesJSON(json);
        expect(result.data.risks).toEqual([]);
        expect(result.data.notable_points).toEqual([]);
        expect(result.data.open_questions).toEqual([]);
        expect(result.data.deferred_items).toEqual([]);
    });
});

// ─── Cross-reference: owners vs participants ─────────────────────────────────

describe('Cross-reference validation', () => {
    it('should warn when action owner is not in participant list', () => {
        const json = makeMinimalJson({
            participants: [{ name: 'Alice' }],
            actions: [
                { id: 'A1', text: 'Task', owner: 'Charlie', due_date: '2026-03-01', confidence: 'high' }
            ]
        });
        const result = validateMinutesJSON(json, { participants: ['Alice'] });
        const ownerIssues = result.issues.filter(i => i.message.includes('not found in participant list'));
        expect(ownerIssues).toHaveLength(1);
        expect(ownerIssues[0].severity).toBe('warning');
    });

    it('should match owners case-insensitively', () => {
        const json = makeMinimalJson({
            actions: [
                { id: 'A1', text: 'Task', owner: 'alice', due_date: '2026-03-01', confidence: 'high' }
            ]
        });
        const result = validateMinutesJSON(json, { participants: ['Alice'] });
        const ownerIssues = result.issues.filter(i => i.message.includes('not found in participant list'));
        expect(ownerIssues).toHaveLength(0);
    });

    it('should skip cross-ref when no participants option provided', () => {
        const json = makeMinimalJson({
            actions: [
                { id: 'A1', text: 'Task', owner: 'Unknown Person', due_date: '2026-03-01', confidence: 'high' }
            ]
        });
        const result = validateMinutesJSON(json);
        // No cross-ref issues because participants option was not passed
        expect(result.issues.filter(i => i.message.includes('not found in participant list'))).toHaveLength(0);
    });

    it('should skip cross-ref for TBC owners', () => {
        const json = makeMinimalJson({
            actions: [
                { id: 'A1', text: 'Task', owner: 'TBC', due_date: '2026-03-01', confidence: 'high' }
            ]
        });
        const result = validateMinutesJSON(json, { participants: ['Alice'] });
        expect(result.issues.filter(i => i.message.includes('not found in participant list'))).toHaveLength(0);
    });

    it('should warn when GTD waiting_on person is not in participant list', () => {
        const json = makeMinimalJson();
        json.gtd_processing = {
            next_actions: [],
            waiting_for: [{ text: 'Report', waiting_on: 'External Vendor' }],
            projects: [],
            someday_maybe: []
        };
        const result = validateMinutesJSON(json, { participants: ['Alice', 'Bob'] });
        const waitIssues = result.issues.filter(i => i.message.includes('Waiting-on person'));
        expect(waitIssues).toHaveLength(1);
        expect(waitIssues[0].severity).toBe('warning');
    });
});

// ─── GTD Validation ──────────────────────────────────────────────────────────

describe('GTD validation', () => {
    it('should pass with valid GTD contexts', () => {
        const json = makeMinimalJson();
        json.gtd_processing = {
            next_actions: [
                { text: 'Call vendor', context: '@call' },
                { text: 'File report', context: '@office' }
            ],
            waiting_for: [{ text: 'Approval', waiting_on: 'Alice' }],
            projects: ['Q2 Roadmap'],
            someday_maybe: ['Team offsite']
        };
        const result = validateMinutesJSON(json, { useGTD: true });
        expect(result.issues.filter(i => i.field.includes('gtd_processing.next_actions'))).toHaveLength(0);
    });

    it('should strip invalid GTD context and auto-fix', () => {
        const json = makeMinimalJson();
        json.gtd_processing = {
            next_actions: [
                { text: 'Do laundry', context: '@laundry' }
            ],
            waiting_for: [],
            projects: [],
            someday_maybe: []
        };
        const result = validateMinutesJSON(json, { useGTD: true });
        expect(result.data.gtd_processing!.next_actions[0].context).toBe('');
        const ctxIssues = result.issues.filter(i => i.field.includes('next_actions[0].context'));
        expect(ctxIssues).toHaveLength(1);
        expect(ctxIssues[0].autoFixed).toBe(true);
        expect(ctxIssues[0].message).toContain('@laundry');
    });

    it('should warn when waiting_for item has empty waiting_on', () => {
        const json = makeMinimalJson();
        json.gtd_processing = {
            next_actions: [],
            waiting_for: [{ text: 'Something', waiting_on: '' }],
            projects: [],
            someday_maybe: []
        };
        const result = validateMinutesJSON(json, { useGTD: true });
        const waitIssues = result.issues.filter(i => i.field.includes('waiting_for[0].waiting_on'));
        expect(waitIssues).toHaveLength(1);
        expect(waitIssues[0].severity).toBe('warning');
    });

    it('should skip GTD validation when useGTD is false', () => {
        const json = makeMinimalJson();
        json.gtd_processing = {
            next_actions: [{ text: 'Bad', context: '@invalid' }],
            waiting_for: [],
            projects: [],
            someday_maybe: []
        };
        const result = validateMinutesJSON(json, { useGTD: false });
        expect(result.issues.filter(i => i.field.includes('gtd_processing'))).toHaveLength(0);
    });

    it('should skip GTD validation when gtd_processing is absent', () => {
        const json = makeMinimalJson();
        delete json.gtd_processing;
        const result = validateMinutesJSON(json, { useGTD: true });
        expect(result.issues.filter(i => i.field.includes('gtd_processing'))).toHaveLength(0);
    });

    it('should warn when next_actions is not an array', () => {
        const json = makeMinimalJson();
        json.gtd_processing = {
            next_actions: 'not-an-array' as any,
            waiting_for: [],
            projects: [],
            someday_maybe: []
        };
        const result = validateMinutesJSON(json, { useGTD: true });
        const naIssues = result.issues.filter(i => i.field === 'gtd_processing.next_actions');
        expect(naIssues).toHaveLength(1);
        expect(naIssues[0].severity).toBe('warning');
    });
});

// ─── Confidence Audit ────────────────────────────────────────────────────────

describe('Confidence audit', () => {
    it('should emit info when >50% items are low-confidence', () => {
        const json = makeMinimalJson({
            actions: [
                { id: 'A1', text: 'Task 1', owner: 'Alice', due_date: '2026-03-01', confidence: 'low' },
                { id: 'A2', text: 'Task 2', owner: 'Bob', due_date: '2026-03-02', confidence: 'low' },
                { id: 'A3', text: 'Task 3', owner: 'Alice', due_date: '2026-03-03', confidence: 'low' }
            ],
            decisions: [
                { id: 'D1', text: 'Decision', confidence: 'high' }
            ],
            risks: [],
            notable_points: [],
            open_questions: []
        });
        // 3/4 = 75% low-confidence → above 50% threshold
        const result = validateMinutesJSON(json);
        const confIssues = result.issues.filter(i => i.field === 'confidence');
        expect(confIssues).toHaveLength(1);
        expect(confIssues[0].severity).toBe('info');
        expect(confIssues[0].message).toContain('3/4');
    });

    it('should not emit confidence info when ratio is at or below threshold', () => {
        const json = makeMinimalJson({
            actions: [
                { id: 'A1', text: 'Task 1', owner: 'Alice', due_date: '2026-03-01', confidence: 'low' },
                { id: 'A2', text: 'Task 2', owner: 'Bob', due_date: '2026-03-02', confidence: 'high' }
            ],
            decisions: [
                { id: 'D1', text: 'Decision 1', confidence: 'high' },
                { id: 'D2', text: 'Decision 2', confidence: 'medium' }
            ],
            risks: [],
            notable_points: [],
            open_questions: []
        });
        // 1/4 = 25% → below 50% threshold
        const result = validateMinutesJSON(json);
        expect(result.issues.filter(i => i.field === 'confidence')).toHaveLength(0);
    });

    it('should not emit confidence info when there are no items at all', () => {
        const json = makeMinimalJson({
            actions: [],
            decisions: [],
            risks: [],
            notable_points: [],
            open_questions: []
        });
        const result = validateMinutesJSON(json);
        expect(result.issues.filter(i => i.field === 'confidence')).toHaveLength(0);
    });

    it('should include risks, notable_points, and open_questions in confidence count', () => {
        const json = makeMinimalJson({
            actions: [],
            decisions: [],
            risks: [{ id: 'R1', text: 'Risk', confidence: 'low' }],
            notable_points: [{ id: 'N1', text: 'Point', confidence: 'low' }],
            open_questions: [{ id: 'Q1', text: 'Question', confidence: 'low' }]
        });
        // 3/3 = 100% low → above threshold
        const result = validateMinutesJSON(json);
        const confIssues = result.issues.filter(i => i.field === 'confidence');
        expect(confIssues).toHaveLength(1);
        expect(confIssues[0].message).toContain('3/3');
    });
});

// ─── Overall validity ────────────────────────────────────────────────────────

describe('Overall result shape', () => {
    it('should return valid=true when there are only warnings and info issues', () => {
        const json = makeMinimalJson();
        json.metadata.title = ''; // warning, not error
        const result = validateMinutesJSON(json);
        expect(result.valid).toBe(true);
    });

    it('should return valid=false when there is at least one error', () => {
        const json = makeMinimalJson({
            actions: [
                { id: 'A1', text: '', owner: 'Alice', due_date: '2026-03-01', confidence: 'high' }
            ]
        });
        const result = validateMinutesJSON(json);
        expect(result.valid).toBe(false);
    });

    it('should not mutate the original input (deep clone)', () => {
        const json = makeMinimalJson({
            actions: [
                { id: '', text: 'Task', owner: '', due_date: '2026-03-01', confidence: 'high' }
            ]
        });
        const originalId = json.actions[0].id;
        const originalOwner = json.actions[0].owner;
        validateMinutesJSON(json);
        expect(json.actions[0].id).toBe(originalId);
        expect(json.actions[0].owner).toBe(originalOwner);
    });

    it('should return corrected data with auto-fixes applied', () => {
        const json = makeMinimalJson({
            actions: [
                { id: '', text: 'Task', owner: '', due_date: '2026-03-01', confidence: 'high' }
            ],
            risks: [{ id: '', text: 'Risk', confidence: 'medium' }],
            deferred_items: [{ id: '', text: 'Defer' }]
        });
        const result = validateMinutesJSON(json);
        expect(result.data.actions[0].id).toBe('A1');
        expect(result.data.actions[0].owner).toBe('TBC');
        expect(result.data.risks![0].id).toBe('R1');
        expect(result.data.deferred_items![0].id).toBe('P1');
    });
});
