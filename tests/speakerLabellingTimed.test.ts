/**
 * Unit tests for the F2a TimedTranscript-aware labelling pipeline:
 *  - mapLabelledTextToSegments: positional word-stream walker
 *  - labelSpeakersTimed: end-to-end TimedTranscript → LabelledTimedTranscript
 *
 * Coverage:
 *  - Single-speaker transcript: every segment gets the same speaker
 *  - Multi-speaker turn boundaries: segments map to the right speaker
 *  - LLM reformatting (whitespace, punctuation): walker still maps correctly
 *  - Empty labelled text: returns empty Map (no assignments)
 *  - Non-name prefixes ("Note:", "TODO:"): rejected by regex guard
 *  - Stream shorter than segments: remaining segments unassigned (graceful)
 *  - Stream longer than segments: extra words ignored (clamped)
 *  - timestampSource carried through unchanged in labelSpeakersTimed
 *  - speakers[] populated in first-appearance order
 */

vi.mock('obsidian', async () => {
    const mod = await import('./mocks/obsidian');
    return mod;
});

const summarizeStub = vi.hoisted(() => vi.fn());
vi.mock('../src/services/llmFacade', () => ({
    summarizeText: summarizeStub,
    pluginContext: vi.fn(() => ({})),
}));

// Bypass the withBusyIndicator overhead in tests — just invoke the worker.
vi.mock('../src/utils/busyIndicator', () => ({
    withBusyIndicator: <T,>(_plugin: unknown, fn: () => Promise<T>) => fn(),
}));

import {
    labelSpeakersTimed,
    mapLabelledTextToSegments,
} from '../src/services/speakerLabellingService';
import type { TimedTranscript, TimedSegment } from '../src/services/transcriptTypes';

function segment(startMs: number, endMs: number, text: string, id?: number): TimedSegment {
    return id === undefined ? { startMs, endMs, text } : { startMs, endMs, text, id };
}

function timed(segments: TimedSegment[], extras?: Partial<TimedTranscript>): TimedTranscript {
    return {
        text: segments.map((s) => s.text).join(' '),
        segments,
        timestampSource: 'whisper-verbose-json',
        durationMs: segments.at(-1)?.endMs,
        languageCode: 'en',
        ...extras,
    };
}

describe('mapLabelledTextToSegments', () => {
    it('returns empty map when labelled text has no Name: lines', () => {
        const t = timed([segment(0, 1000, 'hello there', 0)]);
        const map = mapLabelledTextToSegments(t, 'just some prose without any labels');
        expect(map.size).toBe(0);
    });

    it('assigns a single speaker across every segment of a one-voice transcript', () => {
        const t = timed([
            segment(0, 1000, 'hello team', 0),
            segment(1000, 2000, 'lets begin', 1),
            segment(2000, 3000, 'first agenda item', 2),
        ]);
        const labelled = 'Sarah: hello team lets begin first agenda item';

        const map = mapLabelledTextToSegments(t, labelled);

        expect(map.get(0)).toBe('Sarah');
        expect(map.get(1)).toBe('Sarah');
        expect(map.get(2)).toBe('Sarah');
    });

    it('assigns the right speaker at turn boundaries (two speakers)', () => {
        const t = timed([
            segment(0, 1000, 'I think we should move the launch', 0),
            segment(1000, 2000, 'can we check the budget first', 1),
            segment(2000, 3000, 'good point let me pull the numbers', 2),
        ]);
        const labelled = [
            'Sarah: I think we should move the launch',
            'Marco: can we check the budget first',
            'Sarah: good point let me pull the numbers',
        ].join('\n');

        const map = mapLabelledTextToSegments(t, labelled);

        expect(map.get(0)).toBe('Sarah');
        expect(map.get(1)).toBe('Marco');
        expect(map.get(2)).toBe('Sarah');
    });

    it('falls back to array index when segments lack ids', () => {
        const t = timed([
            segment(0, 1000, 'one'),
            segment(1000, 2000, 'two'),
        ]);
        const labelled = 'Pat: one\nMarco: two';

        const map = mapLabelledTextToSegments(t, labelled);

        expect(map.get(0)).toBe('Pat');
        expect(map.get(1)).toBe('Marco');
    });

    it('rejects non-name prefixes like NOTE:/TODO:/etc', () => {
        const t = timed([segment(0, 1000, 'meeting starts', 0)]);
        // The regex requires the name to start with a letter — "1Action:" should pass
        // the broad `[^:]{2,40}` check but be rejected by the leading-letter guard.
        const labelled = '1Action: meeting starts';
        const map = mapLabelledTextToSegments(t, labelled);
        expect(map.size).toBe(0);
    });

    it('survives LLM reformatting (extra whitespace, punctuation) by approximate word counts', () => {
        const t = timed([
            segment(0, 1000, 'one two three four', 0),
            segment(1000, 2000, 'five six seven eight', 1),
        ]);
        // LLM emitted with extra spaces but same word count → walker still maps.
        const labelled = 'Pat:    one two three four\nMarco:  five  six  seven  eight';

        const map = mapLabelledTextToSegments(t, labelled);

        expect(map.get(0)).toBe('Pat');
        expect(map.get(1)).toBe('Marco');
    });

    it('clamps gracefully when the labelled stream is shorter than the timed segments', () => {
        const t = timed([
            segment(0, 1000, 'one', 0),
            segment(1000, 2000, 'two', 1),
            segment(2000, 3000, 'three', 2),
        ]);
        // Only one labelled word — covers segment 0; segments 1 and 2 fall off the end.
        const labelled = 'Sarah: one';

        const map = mapLabelledTextToSegments(t, labelled);

        expect(map.get(0)).toBe('Sarah');
        // Segments past the labelled stream end have no assignment.
        expect(map.has(1)).toBe(false);
        expect(map.has(2)).toBe(false);
    });

    it('ignores trailing words when the labelled stream is longer than the timed segments', () => {
        const t = timed([segment(0, 1000, 'hello', 0)]);
        const labelled = 'Sarah: hello there team how is everyone';

        const map = mapLabelledTextToSegments(t, labelled);

        expect(map.get(0)).toBe('Sarah');
    });

    it('takes the modal speaker over a segment that spans a turn boundary', () => {
        // Segment with 5 words; labelled stream gives 4 of them to Marco and 1 to Sarah.
        const t = timed([segment(0, 1000, 'sure we can do that today', 0)]);
        const labelled = 'Marco: sure we can do\nSarah: that today';

        const map = mapLabelledTextToSegments(t, labelled);

        // Marco wins the modal vote (3 words: "sure we can"  → 3; "do" → 4th Marco;
        // "that today" → 2 Sarah). Within the slice of 5 words, Marco has 4 / 5.
        expect(map.get(0)).toBe('Marco');
    });

    it('handles segments with whitespace-only text by skipping without consuming stream', () => {
        const t = timed([
            segment(0, 500, ''),
            segment(500, 1500, 'hello team', 1),
        ]);
        const labelled = 'Sarah: hello team';

        const map = mapLabelledTextToSegments(t, labelled);

        expect(map.has(0)).toBe(false);
        expect(map.get(1)).toBe('Sarah');
    });
});

describe('labelSpeakersTimed', () => {
    afterEach(() => {
        summarizeStub.mockReset();
    });

    function mockSummarize(labelledText: string): void {
        summarizeStub.mockResolvedValue({ success: true, content: labelledText });
    }

    it('produces a LabelledTimedTranscript with per-segment speakers + speakers[] in first-appearance order', async () => {
        mockSummarize(['Sarah: hello team', 'Marco: ready when you are', 'Sarah: lets begin'].join('\n'));

        const t = timed([
            segment(0, 1000, 'hello team', 0),
            segment(1000, 2000, 'ready when you are', 1),
            segment(2000, 3000, 'lets begin', 2),
        ]);

        const result = await labelSpeakersTimed({} as never, t, ['Sarah', 'Marco']);

        expect(result.segments[0].speaker).toBe('Sarah');
        expect(result.segments[1].speaker).toBe('Marco');
        expect(result.segments[2].speaker).toBe('Sarah');
        expect(result.speakers).toEqual(['Sarah', 'Marco']);
    });

    it('carries timestampSource through unchanged', async () => {
        mockSummarize('Pat: solo monologue');
        const t = timed([segment(0, 1000, 'solo monologue', 0)], { timestampSource: 'none' });

        const result = await labelSpeakersTimed({} as never, t, ['Pat']);

        expect(result.timestampSource).toBe('none');
    });

    it('returns empty speakers[] when the LLM fails (fail-open: original transcript unchanged)', async () => {
        // Failure path: summarizeText returns success=false → labelSpeakers
        // fails open and returns the original (unlabelled) transcript.
        summarizeStub.mockResolvedValue({ success: false, content: '' });

        const t = timed([segment(0, 1000, 'hello team', 0)]);
        const result = await labelSpeakersTimed({} as never, t, ['Sarah']);

        expect(result.speakers).toEqual([]);
        expect(result.segments[0].speaker).toBeUndefined();
    });

    it('preserves languageCode through the pipeline', async () => {
        mockSummarize('Pat: 大家好');
        const t = timed([segment(0, 1000, '大家好', 0)], { languageCode: 'zh-CN' });

        const result = await labelSpeakersTimed({} as never, t, ['Pat']);

        expect(result.languageCode).toBe('zh-CN');
    });
});
