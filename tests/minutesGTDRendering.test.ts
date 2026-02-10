/**
 * GTD Rendering Tests
 * Tests for GTD overlay rendering in renderMinutesFromJson()
 */

import { renderMinutesFromJson } from '../src/utils/minutesUtils';
import type { MinutesJSON } from '../src/services/prompts/minutesPrompts';

function makeMinimalJson(overrides: Partial<MinutesJSON> = {}): MinutesJSON {
    return {
        metadata: {
            title: 'Test Meeting',
            date: '2024-01-15',
            start_time: '09:00',
            end_time: '10:00',
            timezone: 'UTC',
            meeting_context: 'internal',
            output_audience: 'internal',
            confidentiality_level: 'internal',
            chair: 'John',
            minute_taker: 'Jane',
            location: 'Room A',
            quorum_present: true
        },
        participants: [],
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

describe('GTD Rendering in renderMinutesFromJson', () => {
    it('should not render GTD sections when gtd_processing is absent', () => {
        const json = makeMinimalJson();
        const result = renderMinutesFromJson(json, 'standard');
        expect(result).not.toContain('GTD:');
    });

    it('should render next_actions grouped by context', () => {
        const json = makeMinimalJson({
            gtd_processing: {
                next_actions: [
                    { text: 'Send email', context: '@office', owner: 'Alice' },
                    { text: 'Buy groceries', context: '@errand' }
                ],
                waiting_for: [],
                projects: [],
                someday_maybe: []
            }
        });
        const result = renderMinutesFromJson(json, 'standard');
        expect(result).toContain('## GTD: Next Actions');
        expect(result).toContain('**@office**');
        expect(result).toContain('**@errand**');
        expect(result).toContain('Send email');
        expect(result).toContain('(Alice)');
        expect(result).toContain('Buy groceries');
    });

    it('should render waiting_for items', () => {
        const json = makeMinimalJson({
            gtd_processing: {
                next_actions: [],
                waiting_for: [
                    { text: 'Report from finance', waiting_on: 'Bob', chase_date: '2024-02-01' }
                ],
                projects: [],
                someday_maybe: []
            }
        });
        const result = renderMinutesFromJson(json, 'standard');
        expect(result).toContain('## GTD: Waiting For');
        expect(result).toContain('Report from finance');
        expect(result).toContain('waiting on: Bob');
        expect(result).toContain('(chase: 2024-02-01)');
    });

    it('should render projects list', () => {
        const json = makeMinimalJson({
            gtd_processing: {
                next_actions: [],
                waiting_for: [],
                projects: ['Website redesign', 'Q2 Planning'],
                someday_maybe: []
            }
        });
        const result = renderMinutesFromJson(json, 'standard');
        expect(result).toContain('## GTD: Projects');
        expect(result).toContain('- Website redesign');
        expect(result).toContain('- Q2 Planning');
    });

    it('should render someday/maybe list', () => {
        const json = makeMinimalJson({
            gtd_processing: {
                next_actions: [],
                waiting_for: [],
                projects: [],
                someday_maybe: ['Explore AI tools', 'Team offsite']
            }
        });
        const result = renderMinutesFromJson(json, 'standard');
        expect(result).toContain('## GTD: Someday / Maybe');
        expect(result).toContain('- Explore AI tools');
        expect(result).toContain('- Team offsite');
    });

    it('should render GTD regardless of detailLevel', () => {
        const gtdData = {
            gtd_processing: {
                next_actions: [{ text: 'Task', context: '@office' }],
                waiting_for: [],
                projects: [],
                someday_maybe: []
            }
        };

        const concise = renderMinutesFromJson(makeMinimalJson(gtdData), 'concise');
        const standard = renderMinutesFromJson(makeMinimalJson(gtdData), 'standard');
        const detailed = renderMinutesFromJson(makeMinimalJson(gtdData), 'detailed');

        expect(concise).toContain('## GTD: Next Actions');
        expect(standard).toContain('## GTD: Next Actions');
        expect(detailed).toContain('## GTD: Next Actions');
    });

    it('should not render GTD sections when all arrays are empty', () => {
        const json = makeMinimalJson({
            gtd_processing: {
                next_actions: [],
                waiting_for: [],
                projects: [],
                someday_maybe: []
            }
        });
        const result = renderMinutesFromJson(json, 'standard');
        expect(result).not.toContain('GTD:');
    });

    it('should render energy tag only for low and high (not medium)', () => {
        const json = makeMinimalJson({
            gtd_processing: {
                next_actions: [
                    { text: 'Easy task', context: '@office', energy: 'low' },
                    { text: 'Normal task', context: '@office', energy: 'medium' },
                    { text: 'Hard task', context: '@office', energy: 'high' }
                ],
                waiting_for: [],
                projects: [],
                someday_maybe: []
            }
        });
        const result = renderMinutesFromJson(json, 'standard');
        expect(result).toContain('[low]');
        expect(result).toContain('[high]');
        expect(result).not.toContain('[medium]');
    });

    it('should omit owner when not present', () => {
        const json = makeMinimalJson({
            gtd_processing: {
                next_actions: [
                    { text: 'No owner task', context: '@office' }
                ],
                waiting_for: [],
                projects: [],
                someday_maybe: []
            }
        });
        const result = renderMinutesFromJson(json, 'standard');
        expect(result).toContain('- No owner task');
        expect(result).not.toContain('()');
    });

    it('should sort context keys alphabetically', () => {
        const json = makeMinimalJson({
            gtd_processing: {
                next_actions: [
                    { text: 'Z task', context: '@office' },
                    { text: 'A task', context: '@call' },
                    { text: 'M task', context: '@home' }
                ],
                waiting_for: [],
                projects: [],
                someday_maybe: []
            }
        });
        const result = renderMinutesFromJson(json, 'standard');
        const callIdx = result.indexOf('**@call**');
        const homeIdx = result.indexOf('**@home**');
        const officeIdx = result.indexOf('**@office**');
        expect(callIdx).toBeLessThan(homeIdx);
        expect(homeIdx).toBeLessThan(officeIdx);
    });

    it('should render next_actions as checkboxes when obsidianTasksFormat is true', () => {
        const json = makeMinimalJson({
            gtd_processing: {
                next_actions: [
                    { text: 'Checkbox task', context: '@office' }
                ],
                waiting_for: [],
                projects: [],
                someday_maybe: []
            }
        });
        const withTasks = renderMinutesFromJson(json, 'standard', true);
        const withoutTasks = renderMinutesFromJson(json, 'standard', false);

        expect(withTasks).toContain('- [ ] Checkbox task');
        expect(withoutTasks).toContain('- Checkbox task');
        expect(withoutTasks).not.toContain('- [ ]');
    });
});
