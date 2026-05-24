/**
 * Cross-cutting types for the audio narration feature.
 * Single declaration site — prevents type drift between command, service, modal, tests.
 */

import type { TFile } from 'obsidian';
import type { NarrationProviderConfig, NarrationProviderId } from '../tts/ttsProviderRegistry';
import type { Result } from '../../core/result';
import { ok, err } from '../../core/result';

// ── Error contract ──────────────────────────────────────────────────────────

export type NarrationErrorCode =
    | 'EMPTY_CONTENT'
    | 'NO_API_KEY'
    | 'CONSENT_DECLINED'
    | 'IN_FLIGHT'
    | 'ABORTED'
    | 'TRANSFORM_FAILED'
    | 'ESTIMATE_FAILED'
    | 'TTS_FAILED'
    | 'ENCODE_FAILED'
    | 'WRITE_FAILED'
    | 'EMBED_FAILED'
    | 'UNSUPPORTED_PLATFORM'
    | 'STALE_PREPARED';

export interface NarrationError {
    readonly code: NarrationErrorCode;
    readonly message: string;
    readonly cause?: unknown;
}

export function makeError(code: NarrationErrorCode, message: string, cause?: unknown): NarrationError {
    return { code, message, cause };
}

/** Serialise a NarrationError for the string-typed Result error field. */
export function encodeError(e: NarrationError): string {
    return `${e.code}:${e.message}`;
}

/** Parse a serialised error back into a NarrationError. Falls back to ENCODE_FAILED for unknown codes. */
export function decodeError(s: string): NarrationError {
    const idx = s.indexOf(':');
    if (idx === -1) return { code: 'ENCODE_FAILED', message: s };
    const code = s.slice(0, idx);
    const message = s.slice(idx + 1);
    if (isNarrationErrorCode(code)) return { code, message };
    return { code: 'ENCODE_FAILED', message: s };
}

const ALL_CODES: ReadonlySet<NarrationErrorCode> = new Set<NarrationErrorCode>([
    'EMPTY_CONTENT', 'NO_API_KEY', 'CONSENT_DECLINED', 'IN_FLIGHT', 'ABORTED',
    'TRANSFORM_FAILED', 'ESTIMATE_FAILED', 'TTS_FAILED', 'ENCODE_FAILED',
    'WRITE_FAILED', 'EMBED_FAILED', 'UNSUPPORTED_PLATFORM', 'STALE_PREPARED',
]);

function isNarrationErrorCode(s: string): s is NarrationErrorCode {
    return ALL_CODES.has(s as NarrationErrorCode);
}

/** Convenience: produce an err-shaped Result<T> from a NarrationError. */
export function errFrom<T>(e: NarrationError): Result<T> {
    return err<T>(encodeError(e));
}

export { ok };

// ── Phase enum ──────────────────────────────────────────────────────────────

export type NarrationPhase = 'enhancing' | 'narrating' | 'encoding' | 'writing';

// ── Transformer options + result ────────────────────────────────────────────

export type CodeBlockMode = 'placeholder' | 'omit' | 'read-inline';
export type TableMode = 'row-prose' | 'header-summary' | 'omit';
export type ImageMode = 'alt-text' | 'omit';

export interface MarkdownToProseOptions {
    codeBlockMode: CodeBlockMode;
    tableMode: TableMode;
    imageMode: ImageMode;
}

export const DEFAULT_PROSE_OPTIONS: MarkdownToProseOptions = {
    codeBlockMode: 'placeholder',
    tableMode: 'row-prose',
    imageMode: 'alt-text',
};

export interface ProseStats {
    charCount: number;
    wordCount: number;
    estReadSeconds: number;
    sectionCount: number;
}

export interface TransformResult {
    spokenText: string;
    stats: ProseStats;
    /** Unsupported constructs encountered during transform — logged for debug visibility. */
    warnings: string[];
}

// ── Cost estimate ───────────────────────────────────────────────────────────

export interface CostEstimate {
    charCount: number;
    chunkCount: number;
    estDurationSec: number;
    estUsd: number;
    estEur: number;
    providerId: NarrationProviderId;
    voice: string;
    /** Estimated USD cost of the LLM enhancement pre-pass, when mode='on' AND key resolves.
     *  Undefined / 0 in literal-mode flows. Computed deterministically in prepareNarration
     *  (no LLM call) so the cost-confirmation modal displays it before billing. */
    llmEnhancementUsd?: number;
}

// ── Two-stage service contract ──────────────────────────────────────────────

export interface PreparedNarration {
    readonly file: TFile;
    readonly spokenText: string;
    readonly stats: ProseStats;
    readonly cost: CostEstimate;
    readonly fingerprint: string;
    readonly outputPath: string;
    readonly existingFile: TFile | null;
    readonly provider: NarrationProviderConfig;
    readonly voice: string;
    readonly embedInNote: boolean;
    /** LLM enhancement intent — provider identity only, NEVER the apiKey.
     *  Null when mode='off' OR mode='on' but no key resolved (graceful fallback). */
    readonly llmIntent: LlmEnhancementIntent | null;
    /** `file.stat.mtime` at prepare-time. Execute re-reads and asserts equality;
     *  mismatch → STALE_PREPARED error so the user re-narrates against current content. */
    readonly fingerprintMtime: number;
}

export interface LlmEnhancementIntent {
    readonly providerId: 'gemini' | 'haiku';
    readonly modelSentinel: string;
}

export interface NarrateOutcome {
    readonly filePath: string;
    readonly bytes: number;
    readonly durationSec: number;
    readonly skippedExisting: boolean;
    readonly embedUpdated: boolean;
    /** Typed warning surface — caller maps code → i18n + Notice.
     *  Empty array means everything succeeded cleanly. */
    readonly warnings: NarrationWarning[];
}

// ── LLM enhancement warning surface ─────────────────────────────────────────

export type NarrationWarningCode =
    | 'llm-enhancement-disabled-no-key'
    | 'llm-enhancement-partial'
    | 'llm-enhancement-failed'
    | 'llm-enhancement-rate-limited'
    | 'llm-enhancement-aborted';

export interface NarrationWarning {
    code: NarrationWarningCode;
    /** Per-chunk titles when code === 'llm-enhancement-partial' */
    failedChunkTitles?: string[];
    /** Underlying error string when code === 'llm-enhancement-failed' (debug only; not shown to user) */
    detail?: string;
}
