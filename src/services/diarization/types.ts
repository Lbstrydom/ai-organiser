import type { App } from 'obsidian';
import type { Result } from '../../core/result';
import type { LabelledTimedTranscript } from '../transcriptTypes';

/**
 * Acoustic-diarization adapter contract — see plan §1.5
 * (docs/plans/deepgram-diarization-v2.md) + the azure-audio-adapters plan
 * (D2/D9/H3). Two implementations: Deepgram (private/BYO) and Azure AI
 * Speech Fast Transcription (in-region, Wärtsilä path).
 *
 * Seam change (azure-audio H3): the positional `apiKey` parameter was
 * REMOVED — each provider resolves its own credentials through an injected
 * resolver (Deepgram → `getDeepgramApiKey`; Azure Speech →
 * `resolveAzureSpeechCredential`), so a Deepgram-shaped key can never be
 * handed to a non-Deepgram provider.
 */
export interface DiarizationProvider {
    readonly name: DiarizationProviderName;
    transcribeWithDiarization(
        app: App,
        audioBytes: ArrayBuffer,
        options?: DiarizationOptions,
    ): Promise<Result<DiarizationResult>>;
}

export type DiarizationProviderName = 'deepgram' | 'azure-speech';

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
 * Typed cost model (azure-audio M6). Replaces the old nullable
 * `actualCostUsd`: Deepgram computes an authoritative per-request cost
 * (`kind:'actual'`); Azure Speech billing is account-level, so the adapter
 * reports `kind:'unknown'` (or `'estimated'` with a `basis` when a public
 * rate is applied). Consumers write `usd` to frontmatter only when present.
 */
export interface DiarizationCost {
    kind: 'actual' | 'estimated' | 'unknown';
    usd?: number;
    /** Human-readable basis for an estimate (e.g. '$0.0043/min nova-3'). */
    basis?: string;
}

/**
 * Wrapper around `LabelledTimedTranscript` carrying provider metadata the
 * modal needs for transcript-note frontmatter (R1 H4 + G2).
 */
export interface DiarizationResult {
    labelled: LabelledTimedTranscript;
    /** Plain transcript text (joined utterances) — legacy string-shape consumers */
    transcriptText: string;
    /** Total audio duration in seconds (provider metadata) */
    durationSec: number;
    /** BCP-47 language tag from provider (e.g. 'en'); same as `labelled.languageCode` */
    detectedLanguage: string;
    /** Provider identifier */
    provider: DiarizationProviderName;
    /** Typed cost (azure-audio M6) — Deepgram `actual`, Azure Speech `unknown`. */
    cost: DiarizationCost;
}

/** Cost rate — single source of truth for cost preview math */
export const DEEPGRAM_COST_PER_MIN_USD = 0.0043;

/**
 * Application-level file-size cap for the diarized path. Lowered from the
 * original 500 MB to 200 MB after Gemini G3 flagged Obsidian Sync per-file
 * limits and Electron IPC memory doubling. 200 MB covers ≈3.5 hours of
 * 128 kbps mp3 — longer than 95% of meetings.
 *
 * Shared by BOTH providers: the Azure Speech Fast Transcription service cap
 * (~2 GB / ~2 h) is far above this, so the app cap is the effective preflight
 * for both (azure-audio G3 — reject BEFORE buffering).
 */
export const DEEPGRAM_MAX_FILE_BYTES = 200 * 1024 * 1024; // 200 MB

/**
 * Advisory threshold for the "this will inflate your vault sync" warning.
 * Shown as a Notice the first time a user attaches a file above this size
 * with diarization enabled. Does NOT block transcription.
 */
export const DEEPGRAM_LARGE_FILE_WARN_BYTES = 100 * 1024 * 1024; // 100 MB
