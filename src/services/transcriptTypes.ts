/**
 * Canonical transcript contract (plan §1.5, R1 H2 + R2 H5).
 *
 * Single source of truth for transcript shape across the audio-attach,
 * speaker-labelling, attribution, and minutes generation pipelines.
 *
 * Producer: `audioTranscriptionService.transcribeAudio*()` returns this shape.
 * Consumer: `labelSpeakers()` maps it to `LabelledTimedTranscript`; the speaker
 * review panel + attribution service both consume the labelled form.
 *
 * Why a structured type instead of a bare string: speaker preview audio MUST
 * use real Whisper timestamps (R1 H2 — line-index estimates produce wrong-speaker
 * preview clips, undermining trust). When `timestampSource === 'none'` callers
 * suppress preview entirely; no estimate fallback.
 */

/** Inclusive-start, exclusive-end millisecond range tagging a single Whisper segment. */
export interface TimedSegment {
    /** Inclusive start in milliseconds */
    startMs: number;
    /** Exclusive end in milliseconds */
    endMs: number;
    /** Raw text for this segment (NOT speaker-labelled yet) */
    text: string;
    /** Whisper segment id when available — useful for source_timecodes provenance */
    id?: number;
}

/**
 * Plain timed transcript produced by transcription. Speaker labels are NOT
 * applied yet — see `LabelledTimedTranscript` for the labelled form.
 */
export interface TimedTranscript {
    /** Plain transcript text (joined from segments) */
    text: string;
    /** Per-segment timestamps from Whisper `verbose_json` — empty array if unavailable */
    segments: TimedSegment[];
    /** Provider/model that produced these timestamps */
    timestampSource: TimestampSource;
    /** Total duration in milliseconds (best-effort from segments or audio probe) */
    durationMs?: number;
    /**
     * BCP-47 language tag (e.g. 'en', 'en-US', 'zh-CN'). Sourced from Whisper's
     * `detected_language` field, falling back to the user-specified
     * `transcriptionLanguage` setting, finally to `'und'` (undetermined).
     * Propagated end-to-end so attribution dispatch (§4) and frontmatter writer
     * (§1.5 `TranscriptNoteSchema`) use a single language source.
     */
    languageCode: string;
}

/** Where timestamps came from — drives whether speaker preview is allowed. */
export type TimestampSource = 'whisper-verbose-json' | 'none';

/**
 * A segment that has been speaker-labelled. `speaker` is optional because some
 * segments (silence gaps, single-speaker stretches the labelling LLM declined
 * to attribute) may legitimately have no label.
 */
export interface LabelledTimedSegment extends TimedSegment {
    /** Resolved speaker label (e.g. "Speaker A", "Sarah") — undefined when unknown */
    speaker?: string;
}

/**
 * Speaker-labelled transcript — the canonical form passed to attribution
 * + minutes generation. The `segments` array preserves Whisper's structure;
 * the `text` getter joins them for legacy string-consuming callers.
 */
export interface LabelledTimedTranscript {
    /** Joined plain text (no labels — for legacy string consumers) */
    text: string;
    /** Per-segment timestamps + speaker labels */
    segments: LabelledTimedSegment[];
    /** Carried through from the source `TimedTranscript` */
    timestampSource: TimestampSource;
    /** Carried through from the source `TimedTranscript` */
    durationMs?: number;
    /** Carried through — drives attribution strategy dispatch */
    languageCode: string;
    /**
     * Unique speakers seen across all segments, in first-appearance order.
     * Convenient for the speaker review panel without re-walking segments.
     */
    speakers: string[];
}

/**
 * Mapping from labelling-LLM speaker label (e.g. `"Speaker A"`) to the
 * resolved human name the user confirmed (e.g. `"Sarah"`). When the user
 * chose "Skip — labels look fine" the mapping is `null` (no rewrite).
 */
export type SpeakerLabelling = Record<string, string>;

/**
 * Pure mapping from an unlabelled `TimedTranscript` + a speaker-labelling
 * result into the canonical `LabelledTimedTranscript`. Used by the labelling
 * service after the LLM pre-pass returns per-segment speakers.
 *
 * Side-effect-free; useful as a unit-testable seam between the labelling
 * service and downstream consumers.
 */
export function toLabelledTimedTranscript(
    timed: TimedTranscript,
    perSegmentSpeakers: ReadonlyMap<number, string>
): LabelledTimedTranscript {
    const segments: LabelledTimedSegment[] = timed.segments.map((s, idx) => {
        // Prefer Whisper segment id; fall back to array index for transcripts
        // where ids are absent (some Whisper providers don't emit them).
        const key = s.id ?? idx;
        const speaker = perSegmentSpeakers.get(key);
        return speaker === undefined ? { ...s } : { ...s, speaker };
    });

    const seen = new Set<string>();
    const speakers: string[] = [];
    for (const s of segments) {
        if (s.speaker && !seen.has(s.speaker)) {
            seen.add(s.speaker);
            speakers.push(s.speaker);
        }
    }

    return {
        text: timed.text,
        segments,
        timestampSource: timed.timestampSource,
        durationMs: timed.durationMs,
        languageCode: timed.languageCode,
        speakers,
    };
}
