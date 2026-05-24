import type { App } from 'obsidian';
import type { Result } from '../../core/result';
import type { LabelledTimedTranscript } from '../transcriptTypes';

/**
 * Acoustic-diarization adapter contract — see plan §1.5
 * (docs/plans/deepgram-diarization-v2.md). Single seam swappable per
 * R2 M3; v2 ships with the Deepgram impl only.
 */
export interface DiarizationProvider {
    readonly name: string;
    transcribeWithDiarization(
        app: App,
        audioBytes: ArrayBuffer,
        apiKey: string,
        options?: DiarizationOptions,
    ): Promise<Result<DiarizationResult>>;
}

export interface DiarizationOptions {
    signal?: AbortSignal;
    /** Hint for language; passed to provider but does NOT disable detection */
    languageHint?: string;
    /** Per-call timeout (ms). Default 120_000 (2 min) for typical-length audio */
    timeoutMs?: number;
    /**
     * Original filename (with extension) so the adapter can sniff Content-Type.
     * Adapter falls back to `application/octet-stream` when absent.
     */
    filename?: string;
    /**
     * Explicit MIME override. Supersedes filename-based sniff when set.
     * Use for sources where the extension lies (e.g. recorder blob named
     * `recording.webm` but actually `audio/ogg;codecs=opus`).
     */
    mimeType?: string;
}

/**
 * Wrapper around `LabelledTimedTranscript` carrying provider metadata the
 * modal needs for transcript-note frontmatter (R1 H4 + G2).
 */
export interface DiarizationResult {
    labelled: LabelledTimedTranscript;
    /** Plain transcript text (joined utterances) — legacy string-shape consumers */
    transcriptText: string;
    /** Total audio duration in seconds (Deepgram metadata.duration) */
    durationSec: number;
    /** BCP-47 language tag from provider (e.g. 'en'); same as `labelled.languageCode` */
    detectedLanguage: string;
    /** Provider identifier — `'deepgram'` for v2; future adapters set their own */
    provider: 'deepgram';
    /**
     * Authoritative cost in USD for this transcription.
     *
     * Deepgram's response body does NOT include a per-request cost field, so
     * we compute it from the authoritative `durationSec`:
     *   actualCostUsd = (durationSec / 60) * DEEPGRAM_COST_PER_MIN_USD
     *
     * Null only when duration is missing from the response (rare edge); the
     * transcript-note frontmatter omits the field when null.
     */
    actualCostUsd: number | null;
}

/** Cost rate — single source of truth for cost preview math */
export const DEEPGRAM_COST_PER_MIN_USD = 0.0043;

/**
 * Application-level file-size cap for the diarized path. Lowered from the
 * original 500 MB to 200 MB after Gemini G3 flagged Obsidian Sync per-file
 * limits and Electron IPC memory doubling. 200 MB covers ≈3.5 hours of
 * 128 kbps mp3 — longer than 95% of meetings.
 */
export const DEEPGRAM_MAX_FILE_BYTES = 200 * 1024 * 1024; // 200 MB

/**
 * Advisory threshold for the "this will inflate your vault sync" warning.
 * Shown as a Notice the first time a user attaches a file above this size
 * with diarization enabled. Does NOT block transcription.
 */
export const DEEPGRAM_LARGE_FILE_WARN_BYTES = 100 * 1024 * 1024; // 100 MB
