/**
 * Unit tests for src/services/speakerAttribution/provenanceBackfill (plan F5, R1 H4).
 */

import { attemptBackfill } from '../src/services/speakerAttribution/provenanceBackfill';
import type { Action } from '../src/services/prompts/minutesPrompts';
import type { LabelledTimedTranscript } from '../src/services/transcriptTypes';

function action(overrides: Partial<Action> = {}): Action {
    return {
        id: 'A1',
        text: '',
        owner: 'Sarah',
        due_date: '',
        confidence: 'high',
        ...overrides,
    };
}

function labelled(segments: Array<{ text: string; speaker?: string; id?: number }>): LabelledTimedTranscript {
    return {
        text: segments.map((s) => s.text).join(' '),
        segments: segments.map((s, i) => ({
            startMs: i * 1000,
            endMs: (i + 1) * 1000,
            text: s.text,
            id: s.id,
            speaker: s.speaker,
        })),
        timestampSource: 'whisper-verbose-json',
        languageCode: 'en',
        speakers: [],
    };
}

describe('attemptBackfill', () => {
    it('returns early when action already has source_timecodes', () => {
        const a = action({ source_timecodes: ['42'], text: 'no match in transcript' });
        const result = attemptBackfill(a, labelled([{ text: 'completely unrelated text', id: 0 }]));
        expect(result.matched).toBe(true);
        expect(result.action.source_timecodes).toEqual(['42']);
    });

    it('matches a high-overlap segment by token Jaccard similarity', () => {
        const a = action({
            text: 'check the budget projections next week',
            source_timecodes: undefined,
        });
        const transcript = labelled([
            { text: 'team status update from monday', id: 10 },
            { text: 'we should check the budget projections next week', id: 11 },
            { text: 'thanks everyone', id: 12 },
        ]);
        const result = attemptBackfill(a, transcript);
        expect(result.matched).toBe(true);
        // Window of 3 segments starting at idx 0 has higher overlap than the
        // others — but the second window (starting at 1) is the strongest
        // because it contains "check budget projections week".
        expect(result.action.source_timecodes).toBeDefined();
        expect(result.action.source_timecodes!.length).toBeGreaterThan(0);
    });

    it('drops confidence to "low" and flags missing when no segment is similar enough', () => {
        const a = action({
            text: 'authorise the offshore expansion next quarter',
            source_timecodes: undefined,
            confidence: 'high',
        });
        const transcript = labelled([
            { text: 'hello team how is everyone today', id: 0 },
            { text: 'just running through the standup agenda', id: 1 },
        ]);
        const result = attemptBackfill(a, transcript);
        expect(result.matched).toBe(false);
        expect(result.action.confidence).toBe('low');
        expect(result.action.source_timecodes).toBeUndefined();
    });

    it('uses array index when segments lack id', () => {
        const a = action({ text: 'follow up with finance', source_timecodes: undefined });
        const transcript = labelled([
            { text: 'follow up with finance team please' },
            { text: 'before next monday' },
        ]);
        const result = attemptBackfill(a, transcript);
        expect(result.matched).toBe(true);
        expect(result.action.source_timecodes![0]).toBe('0');
    });

    it('returns matched=false when labelled transcript has no segments', () => {
        const a = action({ text: 'do something', source_timecodes: undefined });
        const transcript = labelled([]);
        const result = attemptBackfill(a, transcript);
        expect(result.matched).toBe(false);
        expect(result.action.confidence).toBe('low');
    });

    it('returns matched=false when action text tokenises to empty (punctuation only)', () => {
        const a = action({ text: '...', source_timecodes: undefined });
        const transcript = labelled([{ text: 'real content here', id: 0 }]);
        const result = attemptBackfill(a, transcript);
        expect(result.matched).toBe(false);
    });
});
