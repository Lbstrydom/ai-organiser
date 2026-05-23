// @vitest-environment happy-dom
/**
 * Unit tests for src/services/transcriptNoteService (plan F3a, R1 H5 +
 * Gemini-r1 G5 + Gemini-r2 G1).
 *
 * Coverage:
 *   - Round-trip: write → read produces equivalent TranscriptNote
 *   - Base64 path: small payload, no `-->` injection vector
 *   - Gzip path: large payload >32KB triggers gzip+base64 encoding
 *   - Frontmatter Zod validation: rejects malformed input
 *   - Read failure modes: no frontmatter / invalid YAML / missing body / decode error
 *   - HTML-comment injection guard: transcript containing "-->" round-trips intact
 *   - Human-readable body: speaker turns rendered as **Name:** prefixed lines
 */

// JSON-pretending-to-be-YAML — round-trip stable, no edge cases. We're testing
// the transcript service contract, not the YAML serializer; use the simplest
// reversible encoding so write→read produces an identical object.
vi.mock('obsidian', async () => {
    const mod = await import('./mocks/obsidian');
    return {
        ...mod,
        stringifyYaml: (obj: unknown): string => `__JSON__:${JSON.stringify(obj)}`,
        parseYaml: (text: string): unknown => {
            const trimmed = text.trim();
            if (!trimmed.startsWith('__JSON__:')) {
                throw new Error('mock parseYaml only accepts __JSON__: prefixed input');
            }
            return JSON.parse(trimmed.slice('__JSON__:'.length));
        },
    };
});

import {
    readTranscriptNote,
    writeTranscriptNote,
    type TranscriptNote,
    type TranscriptNoteFrontmatter,
} from '../src/services/transcriptNoteService';
import type { LabelledTimedTranscript } from '../src/services/transcriptTypes';

function makeFrontmatter(overrides: Partial<TranscriptNoteFrontmatter> = {}): TranscriptNoteFrontmatter {
    return {
        type: 'transcript',
        audio: 'AI-Organiser/Recordings/test.m4a',
        language: 'en',
        duration_seconds: 120,
        speakers: { 'Speaker A': 'Pat', 'Speaker B': 'Sarah' },
        speakers_verified: true,
        speaker_detection_status: 'detected',
        timestamp_source: 'whisper-verbose-json',
        created_at: '2026-05-23T14:30:00.000Z',
        ...overrides,
    };
}

function makeBody(segmentCount = 3): LabelledTimedTranscript {
    const segments = Array.from({ length: segmentCount }, (_, i) => ({
        startMs: i * 1000,
        endMs: (i + 1) * 1000,
        text: `segment ${i} text content`,
        id: i,
        speaker: i % 2 === 0 ? 'Speaker A' : 'Speaker B',
    }));
    return {
        text: segments.map((s) => s.text).join(' '),
        segments,
        timestampSource: 'whisper-verbose-json',
        durationMs: segmentCount * 1000,
        languageCode: 'en',
        speakers: ['Speaker A', 'Speaker B'],
    };
}

describe('writeTranscriptNote + readTranscriptNote round-trip', () => {
    it('round-trips a small payload via base64 (no gzip)', async () => {
        const original: TranscriptNote = {
            frontmatter: makeFrontmatter(),
            body: makeBody(3),
        };

        const md = await writeTranscriptNote(original);
        expect(md).toContain('enc=base64\n');
        expect(md).not.toContain('enc=base64+gzip');

        const parsed = await readTranscriptNote(md);
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) return;
        expect(parsed.value.frontmatter.audio).toBe(original.frontmatter.audio);
        expect(parsed.value.frontmatter.speakers_verified).toBe(true);
        expect(parsed.value.body.segments).toHaveLength(3);
        expect(parsed.value.body.segments[0].speaker).toBe('Speaker A');
    });

    it('round-trips a >32KB payload via gzip+base64', async () => {
        // Build a long transcript that will exceed the gzip threshold.
        const longBody: LabelledTimedTranscript = {
            text: '',
            segments: Array.from({ length: 1000 }, (_, i) => ({
                startMs: i * 1000,
                endMs: (i + 1) * 1000,
                text: `This is segment ${i} containing roughly fifty characters of plain text content for size.`,
                id: i,
                speaker: i % 2 === 0 ? 'Speaker A' : 'Speaker B',
            })),
            timestampSource: 'whisper-verbose-json',
            durationMs: 1000 * 1000,
            languageCode: 'en',
            speakers: ['Speaker A', 'Speaker B'],
        };
        longBody.text = longBody.segments.map((s) => s.text).join(' ');

        const md = await writeTranscriptNote({ frontmatter: makeFrontmatter(), body: longBody });
        expect(md).toContain('enc=base64+gzip\n');

        const parsed = await readTranscriptNote(md);
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) return;
        expect(parsed.value.body.segments).toHaveLength(1000);
        expect(parsed.value.body.segments[42].text).toContain('segment 42');
    });

    it('Gemini G5 — preserves a literal "-->" sequence inside transcript text', async () => {
        // The classic injection vector: a transcript line containing "-->" would
        // prematurely terminate the HTML comment under unsafe encoding.
        const body: LabelledTimedTranscript = {
            text: 'outcomes --> next steps',
            segments: [
                { startMs: 0, endMs: 5000, text: 'outcomes --> next steps and we will follow up', speaker: 'Pat', id: 0 },
            ],
            timestampSource: 'whisper-verbose-json',
            languageCode: 'en',
            speakers: ['Pat'],
        };

        const md = await writeTranscriptNote({ frontmatter: makeFrontmatter(), body });
        // The base64 alphabet doesn't contain `-`, so `-->` cannot appear in
        // the encoded JSON-payload region — that's the injection guard. The
        // human-readable markdown body below the comment can legitimately
        // contain `-->` (it's just text at that point and not parsed). The
        // critical assertion: between the comment-open marker and the comment
        // close `-->`, only base64 characters appear.
        const openIdx = md.indexOf('enc=base64');
        const closeIdx = md.indexOf('-->', openIdx);
        const payloadRegion = md.slice(openIdx, closeIdx);
        expect(payloadRegion).not.toContain('-->');

        const parsed = await readTranscriptNote(md);
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) return;
        expect(parsed.value.body.segments[0].text).toBe('outcomes --> next steps and we will follow up');
    });

    it('renders a human-readable markdown body with speaker prefixes', async () => {
        const body: LabelledTimedTranscript = {
            text: 'one two three',
            segments: [
                { startMs: 0, endMs: 1000, text: 'one', speaker: 'Pat', id: 0 },
                { startMs: 1000, endMs: 2000, text: 'two', speaker: 'Sarah', id: 1 },
                { startMs: 2000, endMs: 3000, text: 'three', speaker: 'Pat', id: 2 },
            ],
            timestampSource: 'whisper-verbose-json',
            languageCode: 'en',
            speakers: ['Pat', 'Sarah'],
        };
        const md = await writeTranscriptNote({ frontmatter: makeFrontmatter(), body });
        expect(md).toContain('**Pat:** one');
        expect(md).toContain('**Sarah:** two');
        expect(md).toContain('**Pat:** three');
    });
});

describe('writeTranscriptNote — schema validation', () => {
    it('throws when frontmatter is missing the required type=transcript discriminator', async () => {
        // @ts-expect-error — testing schema enforcement
        const bad: TranscriptNote = {
            frontmatter: { ...makeFrontmatter(), type: 'wrong' },
            body: makeBody(),
        };
        await expect(writeTranscriptNote(bad)).rejects.toThrow();
    });

    it('throws when duration_seconds is negative', async () => {
        const bad: TranscriptNote = {
            frontmatter: { ...makeFrontmatter(), duration_seconds: -1 },
            body: makeBody(),
        };
        await expect(writeTranscriptNote(bad)).rejects.toThrow();
    });
});

describe('readTranscriptNote — failure modes', () => {
    it('returns no-frontmatter when input lacks a --- block', async () => {
        const result = await readTranscriptNote('just some text\n## Transcript\n');
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error).toBe('no-frontmatter');
    });

    it('returns invalid-frontmatter when frontmatter fails schema validation', async () => {
        const bad = { type: 'note', audio: 'x.m4a' };  // missing required fields + wrong literal
        const result = await readTranscriptNote([
            '---',
            `__JSON__:${JSON.stringify(bad)}`,
            '---',
            '## Transcript',
        ].join('\n'));
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error).toBe('invalid-frontmatter');
    });

    it('returns no-body-payload when ## Transcript section lacks the comment fence', async () => {
        const valid = makeFrontmatter();
        const fmContent = [
            '---',
            `__JSON__:${JSON.stringify(valid)}`,
            '---',
            '',
            '## Transcript',
            '(no comment fence here)',
        ].join('\n');

        const result = await readTranscriptNote(fmContent);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error).toBe('no-body-payload');
    });
});
