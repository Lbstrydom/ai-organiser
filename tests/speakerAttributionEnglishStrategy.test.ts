/**
 * Unit tests for src/services/speakerAttribution/englishStrategy (plan F5, R1 H3).
 *
 * Coverage:
 *   - Rule 1: provenance + first-person → owner = mapped speaker
 *   - Rule 2: third-person "Bob will do X" → owner = Bob
 *   - Rule 3: non-participant LLM owner → TBC + non-participant-owner flag
 *   - Case-insensitive participant matching with first-name lookup
 *   - First-person without provenance → falls through to other rules
 *   - First-person with provenance but speaker not in mapping → ambiguous flag
 *   - LLM owner already in participants → preserved (case-normalised)
 *   - "Bob said he'll do X" → owner = Bob (third-person captures Bob, not "he'll")
 */

import { EnglishAttributionStrategy } from '../src/services/speakerAttribution/englishStrategy';
import type { Action } from '../src/services/prompts/minutesPrompts';
import type { LabelledTimedTranscript } from '../src/services/transcriptTypes';

function action(overrides: Partial<Action> = {}): Action {
    return {
        id: 'A1',
        text: '',
        owner: '',
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

const strategy = new EnglishAttributionStrategy();

describe('EnglishAttributionStrategy — Rule 1 (provenance + first-person)', () => {
    it('rewrites owner to mapped speaker for "I will" + provenance', () => {
        const result = strategy.apply({
            actions: [action({
                text: "I will follow up with finance",
                owner: 'TBC',
                source_timecodes: ['10'],
            })],
            labelledTranscript: labelled([{ text: "I will follow up with finance", speaker: 'Speaker B', id: 10 }]),
            speakerMapping: { 'Speaker B': 'Pat' },
            participants: ['Pat', 'Sarah', 'Marco'],
        });
        expect(result.actions[0].owner).toBe('Pat');
        expect(result.flags.length).toBe(0);
    });

    it("rewrites owner for I'll first-person form", () => {
        const result = strategy.apply({
            actions: [action({ text: "I'll check the budget", source_timecodes: ['5'], owner: 'TBC' })],
            labelledTranscript: labelled([{ text: "I'll check the budget", speaker: 'Speaker A', id: 5 }]),
            speakerMapping: { 'Speaker A': 'Sarah' },
            participants: ['Sarah', 'Pat'],
        });
        expect(result.actions[0].owner).toBe('Sarah');
    });

    it('emits ambiguous-attribution flag when speaker is not in the mapping', () => {
        const result = strategy.apply({
            actions: [action({ text: "I'll do this", source_timecodes: ['1'], owner: 'TBC' })],
            labelledTranscript: labelled([{ text: "I'll do this", speaker: 'Speaker X', id: 1 }]),
            speakerMapping: {}, // empty mapping — user skipped review
            participants: ['Sarah'],
        });
        expect(result.actions[0].owner).toBe('TBC');
        expect(result.flags.some((f) => f.kind === 'ambiguous-attribution')).toBe(true);
    });
});

describe('EnglishAttributionStrategy — Rule 2 (third-person)', () => {
    it('captures proper-noun + verb and sets owner if participant', () => {
        const result = strategy.apply({
            actions: [action({ text: 'Bob will check the budget', owner: 'TBC' })],
            labelledTranscript: labelled([]),
            speakerMapping: {},
            participants: ['Bob', 'Sarah'],
        });
        expect(result.actions[0].owner).toBe('Bob');
    });

    it('captures first-name only when participant uses full name', () => {
        const result = strategy.apply({
            actions: [action({ text: 'Sarah will follow up', owner: 'TBC' })],
            labelledTranscript: labelled([]),
            speakerMapping: {},
            participants: ['Sarah Lee', 'Pat'],
        });
        // First-name-only match → normalised to participant's canonical spelling.
        expect(result.actions[0].owner).toBe('Sarah Lee');
    });

    it('"Bob said he\'ll do X" → owner = Bob (third-person captures Bob, not subordinate clause)', () => {
        const result = strategy.apply({
            actions: [action({ text: "Bob said he'll do the writeup", owner: 'TBC' })],
            labelledTranscript: labelled([]),
            speakerMapping: {},
            participants: ['Bob'],
        });
        expect(result.actions[0].owner).toBe('Bob');
    });

    it('leaves owner unchanged when third-person name is NOT in participants', () => {
        const result = strategy.apply({
            actions: [action({ text: 'Bob will write the report', owner: 'TBC' })],
            labelledTranscript: labelled([]),
            speakerMapping: {},
            participants: ['Sarah', 'Pat'],
        });
        // Rule 2 didn't fire (Bob not a participant), Rule 3 fires on owner
        // = 'TBC' which is the sentinel and is preserved.
        expect(result.actions[0].owner).toBe('TBC');
    });
});

describe('EnglishAttributionStrategy — Rule 3 (non-participant owner sanity)', () => {
    it('rewrites LLM-assigned non-participant owner to TBC + flags', () => {
        const result = strategy.apply({
            actions: [action({ text: 'do the report', owner: 'Mystery Person' })],
            labelledTranscript: labelled([]),
            speakerMapping: {},
            participants: ['Sarah', 'Pat'],
        });
        expect(result.actions[0].owner).toBe('TBC');
        expect(result.flags.some((f) => f.kind === 'non-participant-owner')).toBe(true);
    });

    it('preserves LLM owner when it matches a participant (case-insensitive)', () => {
        const result = strategy.apply({
            actions: [action({ text: 'do the report', owner: 'sarah' })],
            labelledTranscript: labelled([]),
            speakerMapping: {},
            participants: ['Sarah Lee'],
        });
        // Match found → normalise to canonical spelling.
        expect(result.actions[0].owner).toBe('Sarah Lee');
    });

    it('passes through "TBC" owner unchanged', () => {
        const result = strategy.apply({
            actions: [action({ text: 'do something', owner: 'TBC' })],
            labelledTranscript: labelled([]),
            speakerMapping: {},
            participants: ['Sarah'],
        });
        expect(result.actions[0].owner).toBe('TBC');
        expect(result.flags.length).toBe(0);
    });

    it('passes through empty owner unchanged', () => {
        const result = strategy.apply({
            actions: [action({ text: 'do something', owner: '' })],
            labelledTranscript: labelled([]),
            speakerMapping: {},
            participants: ['Sarah'],
        });
        expect(result.actions[0].owner).toBe('');
        expect(result.flags.length).toBe(0);
    });
});

describe('EnglishAttributionStrategy — multi-action runs', () => {
    it('applies rules independently per action and accumulates flags', () => {
        const result = strategy.apply({
            actions: [
                action({ id: 'A1', text: "I'll do alpha", source_timecodes: ['1'], owner: 'TBC' }),
                action({ id: 'A2', text: 'Bob will do beta', owner: 'TBC' }),
                action({ id: 'A3', text: 'do gamma', owner: 'Unknown' }),
            ],
            labelledTranscript: labelled([{ text: "I'll do alpha", speaker: 'Speaker A', id: 1 }]),
            speakerMapping: { 'Speaker A': 'Sarah' },
            participants: ['Sarah', 'Bob'],
        });
        expect(result.actions[0].owner).toBe('Sarah');
        expect(result.actions[1].owner).toBe('Bob');
        expect(result.actions[2].owner).toBe('TBC');
        expect(result.flags.length).toBe(1);
        expect(result.flags[0].kind).toBe('non-participant-owner');
        expect(result.flags[0].actionId).toBe('A3');
    });
});
