/**
 * Discriminated-union state types for the audio-attach + speaker-review flow
 * (plan §4 State management, R1 M1 + R2 G3 + Gemini-r2 G2 + G3 + G4).
 *
 * Rationale: the v0 plan used a soup of `speakerMapping | speakersVerified |
 * speakersTouched | lastTranscribedAudioUrl` flags that produced invalid
 * combinations and brittle CTA logic. These discriminated unions make every
 * legal state representable exactly once; `canGenerateMinutes(state)` is a
 * pure derivation rather than a stored boolean.
 *
 * NOTE: `AudioPreviewHandle` is INTENTIONALLY not part of `SpeakerReviewState`
 * (Gemini-r1 M1 + R3 M1). Live resource handles are not serializable UI state;
 * the host coordinator owns the handle and passes it to the panel at render
 * time only.
 */

import type { TFile } from 'obsidian';
import type { TimedTranscript, LabelledTimedTranscript } from '../../services/transcriptTypes';

// ============================================================================
// AudioSource — unified shape across desktop / mobile / vault / recorder
// ============================================================================

/**
 * Canonical AudioSource model (plan §1.5 R1 H1 + R2 H1). Every input path
 * (desktop file dialog, mobile webview file input, vault picker, in-modal
 * recorder) normalises to one of these four kinds. `AudioImportService`
 * (F1 next step) consumes any kind and writes it to the vault, returning
 * a vault `TFile` for downstream services that expect one.
 */
export type AudioSource =
    | { kind: 'vault'; file: TFile }
    | { kind: 'desktop-path'; absolutePath: string; displayName: string }
    | { kind: 'webview-blob'; blob: Blob; displayName: string; mimeType: string }
    | { kind: 'recorder'; blob: Blob; displayName: string; mimeType: string; durationMs: number };

// ============================================================================
// AudioAttachItem + AudioAttachViewState — multi-source attach state
// ============================================================================

/**
 * One queued audio item inside the multi-source attach flow.
 * (Gemini-r2 G4 — existing `AudioController.transcribeAll()` supports
 * multiple sequential audio files; the state model must NOT regress that.)
 */
export interface AudioAttachItem {
    source: AudioSource;
    displayName: string;
    itemState: 'pending' | 'transcribing' | 'transcribed' | 'error';
    /** Populated when itemState === 'transcribed' */
    transcript?: TimedTranscript;
    /** Populated when itemState === 'error' */
    errorMessage?: string;
    /** Section assignment for multi-segment minutes. Defaults to 'general'. */
    sectionId?: string;
}

/**
 * View state for the audio-attach section. The non-`empty`/`picking` kinds
 * carry an ordered list of `AudioAttachItem` so multi-file transcription
 * (part 1 + part 2 of a meeting) is a first-class case, not a regression.
 *
 * `labelledTranscript` lives on the `transcribed` state (Gemini-r2 G2) so
 * the modal can pass it to `MinutesService.generateMinutes()` without
 * threading a separate field through state.
 */
export type AudioAttachViewState =
    | { kind: 'empty' }
    | { kind: 'picking' }
    | { kind: 'attached'; items: AudioAttachItem[] }
    | { kind: 'transcribing'; items: AudioAttachItem[]; activeIndex: number }
    | {
          kind: 'transcribed';
          items: AudioAttachItem[];
          /** Concatenated transcript across all items, with segment offsets adjusted. */
          combinedTranscript: TimedTranscript;
          /** Populated AFTER labelSpeakers() runs; undefined while labelling pending. */
          labelledTranscript?: LabelledTimedTranscript;
      }
    | { kind: 'error'; items: AudioAttachItem[]; message: string };

// ============================================================================
// DetectedSpeaker + SpeakerReviewState — speaker review panel state
// ============================================================================

/**
 * One row in the speaker review panel. `firstUtteranceStartMs` is OPTIONAL
 * because some transcription paths (`timestampSource === 'none'`) produce no
 * usable offsets — the panel suppresses audio preview entirely in that case
 * (R1 H2). When timestamps ARE available, `startMs` is sourced from a real
 * Whisper segment, never from a line-index estimate.
 */
export interface DetectedSpeaker {
    /** Label from the labelling LLM, e.g. "Speaker A" */
    label: string;
    /** Start of this speaker's first utterance, in milliseconds — UNDEFINED when timestampSource is 'none' */
    firstUtteranceStartMs?: number;
    /** First labelled line's text — shown as a snippet in the row */
    firstUtteranceText: string;
    /** How many segments this speaker accounts for */
    occurrenceCount: number;
    /** Optional labelling confidence (when the LLM emits it) */
    confidence?: 'low' | 'medium' | 'high';
}

/**
 * Mapping label → resolved human name, e.g. `{ "Speaker A": "Sarah" }`.
 * `null` mapping ≡ user chose "Skip"; downstream attribution stays in
 * NoOp mode + frontmatter records `speakers_verified: false`.
 */
export type SpeakerMapping = Record<string, string>;

/**
 * Speaker-review state machine. `detected` is preserved across `confirmed`,
 * `skipped`, and `failed` (R2 G3 + Gemini-r2 G3) so the panel can re-render
 * post-decision (e.g. to show "you mapped Speaker A → Sarah" for review).
 *
 * `not-required` ≡ <2 distinct speakers OR transcript empty — panel hidden.
 * `pending` ≡ ≥2 speakers detected, awaiting user decision.
 * `confirmed` ≡ user named the speakers; mapping carries the rename data.
 * `skipped` ≡ either user-skip or auto-skip on detection failure/unavailable.
 * `failed` ≡ `labelSpeakers()` threw (rare; LLM unreachable).
 */
export type SpeakerReviewState =
    | { kind: 'not-required' }
    | { kind: 'pending'; detected: DetectedSpeaker[] }
    | { kind: 'confirmed'; detected: DetectedSpeaker[]; mapping: SpeakerMapping }
    | {
          kind: 'skipped';
          detected: DetectedSpeaker[];
          reason: 'user-skip' | 'detection-failed' | 'detection-unavailable';
      }
    | { kind: 'failed'; detected: DetectedSpeaker[]; error: string };

// ============================================================================
// Pure derivations — no boolean soup, no stored flags
// ============================================================================

/**
 * Can the "Generate minutes" CTA be enabled? Pure function over the modal's
 * derived state — no flags read or written. The CTA blocks only while
 * speaker review is `pending` or `failed`; every other state means the user
 * has either confirmed, explicitly skipped, or doesn't need to review.
 *
 * Transcript content can come from either source:
 *  - `transcript`  — pasted/typed text in the textarea
 *  - `loadedTranscriptCount` — files loaded via the multi-picker into
 *    `transcriptItems[]` (assigned to General or topic sections)
 * Either alone is sufficient; the modal joins them at generation time.
 */
export function canGenerateMinutes(args: {
    transcript: string;
    loadedTranscriptCount?: number;
    speakerReview: SpeakerReviewState;
}): boolean {
    const hasPasted = args.transcript.trim().length > 0;
    const hasLoaded = (args.loadedTranscriptCount ?? 0) > 0;
    if (!hasPasted && !hasLoaded) return false;
    const k = args.speakerReview.kind;
    return k === 'confirmed' || k === 'skipped' || k === 'not-required';
}

/**
 * What status to write to `TranscriptNoteFrontmatter.speaker_detection_status`
 * (and propagate to minutes frontmatter via the single-source rule).
 */
export function deriveSpeakerDetectionStatus(
    state: SpeakerReviewState
): 'detected' | 'failed' | 'skipped' | 'unavailable' | 'not-required' {
    switch (state.kind) {
        case 'not-required':
            return 'not-required';
        case 'pending':
            // Caller shouldn't persist while pending; fall back to skipped for safety.
            return 'skipped';
        case 'confirmed':
            return 'detected';
        case 'skipped':
            if (state.reason === 'detection-failed') return 'failed';
            if (state.reason === 'detection-unavailable') return 'unavailable';
            return 'skipped';
        case 'failed':
            return 'failed';
    }
}

/**
 * Did the user confirm speakers, or did they skip / hit a detection failure?
 * Drives `TranscriptNoteFrontmatter.speakers_verified`.
 */
export function areSpeakersVerified(state: SpeakerReviewState): boolean {
    return state.kind === 'confirmed';
}
