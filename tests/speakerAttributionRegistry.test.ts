/**
 * Unit tests for src/services/speakerAttribution/registry + noOpStrategy +
 * top-level applyDeterministicAttribution orchestrator (plan F5).
 */

import {
    getStrategyForLanguage,
    applyDeterministicAttribution,
    EnglishAttributionStrategy,
    NoOpAttributionStrategy,
} from '../src/services/speakerAttribution';
import type { Action } from '../src/services/prompts/minutesPrompts';
import type { LabelledTimedTranscript } from '../src/services/transcriptTypes';

function action(overrides: Partial<Action> = {}): Action {
    return { id: 'A1', text: '', owner: '', due_date: '', confidence: 'high', ...overrides };
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

describe('getStrategyForLanguage', () => {
    it('returns EnglishAttributionStrategy for "en"', () => {
        expect(getStrategyForLanguage('en')).toBeInstanceOf(EnglishAttributionStrategy);
    });

    it('returns EnglishAttributionStrategy for "en-US" (region subtag)', () => {
        expect(getStrategyForLanguage('en-US')).toBeInstanceOf(EnglishAttributionStrategy);
    });

    it('returns EnglishAttributionStrategy for "EN" (case-insensitive)', () => {
        expect(getStrategyForLanguage('EN')).toBeInstanceOf(EnglishAttributionStrategy);
    });

    it('returns NoOp for unsupported language', () => {
        const strategy = getStrategyForLanguage('zh-CN');
        expect(strategy).toBeInstanceOf(NoOpAttributionStrategy);
        expect(strategy.name).toBe('noop-zh-CN');
    });

    it('returns NoOp for "und" (undetermined — Whisper fallback)', () => {
        expect(getStrategyForLanguage('und')).toBeInstanceOf(NoOpAttributionStrategy);
    });

    it('returns NoOp for empty string', () => {
        expect(getStrategyForLanguage('')).toBeInstanceOf(NoOpAttributionStrategy);
    });
});

describe('NoOpAttributionStrategy', () => {
    it('passes actions through unchanged + emits one unsupported-language flag', () => {
        const strategy = new NoOpAttributionStrategy('zh-CN');
        const actions = [action({ id: 'A1', text: 'do alpha', owner: 'Pat' })];
        const result = strategy.apply({
            actions,
            labelledTranscript: labelled([]),
            speakerMapping: {},
            participants: ['Pat'],
        });
        expect(result.actions).toBe(actions);
        expect(result.flags).toHaveLength(1);
        expect(result.flags[0].kind).toBe('unsupported-language');
        expect(result.flags[0].actionId).toBeUndefined();
    });
});

describe('applyDeterministicAttribution', () => {
    it('returns invalid-input error when actions array is not present', () => {
        const result = applyDeterministicAttribution(
            // @ts-expect-error — testing invalid input handling
            { actions: undefined, labelledTranscript: labelled([]), speakerMapping: {}, participants: [] },
            'en'
        );
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error).toBe('invalid-input');
    });

    it('runs provenance backfill BEFORE strategy', () => {
        // Action has no source_timecodes; backfill should find segment 0 and
        // populate them, then the English strategy uses them for first-person.
        const result = applyDeterministicAttribution(
            {
                actions: [action({
                    id: 'A1',
                    text: "I'll follow up with finance team",
                    owner: 'TBC',
                })],
                labelledTranscript: labelled([
                    { text: "I'll follow up with finance team next week", speaker: 'Speaker A', id: 1 },
                ]),
                speakerMapping: { 'Speaker A': 'Sarah' },
                participants: ['Sarah'],
            },
            'en'
        );
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        // Backfill matched segment id 1 → first-person rule rewrites owner.
        expect(result.value.actions[0].owner).toBe('Sarah');
    });

    it('emits missing-provenance flag when backfill cannot match', () => {
        const result = applyDeterministicAttribution(
            {
                actions: [action({ id: 'A1', text: "completely unrelated content here" })],
                labelledTranscript: labelled([{ text: 'something else entirely', id: 0 }]),
                speakerMapping: {},
                participants: ['Sarah'],
            },
            'en'
        );
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.flags.some((f) => f.kind === 'missing-provenance' && f.actionId === 'A1')).toBe(true);
    });

    it('routes non-English to NoOp + emits unsupported-language flag', () => {
        const result = applyDeterministicAttribution(
            {
                actions: [action({ id: 'A1', text: '我会跟进', owner: 'Pat' })],
                labelledTranscript: labelled([{ text: '我会跟进', id: 0 }]),
                speakerMapping: {},
                participants: ['Pat'],
            },
            'zh-CN'
        );
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        // Owner unchanged (NoOp) — even though "Pat" is a participant, NoOp
        // doesn't run the English Rule 3 normalisation.
        expect(result.value.actions[0].owner).toBe('Pat');
        expect(result.value.flags.some((f) => f.kind === 'unsupported-language')).toBe(true);
    });

    it('handles empty actions array without errors', () => {
        const result = applyDeterministicAttribution(
            {
                actions: [],
                labelledTranscript: labelled([]),
                speakerMapping: {},
                participants: [],
            },
            'en'
        );
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.actions).toEqual([]);
        expect(result.value.flags).toEqual([]);
    });
});
