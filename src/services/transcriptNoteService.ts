/**
 * Transcript note shared contract (plan §1.5 R1 H5 + Gemini-r1 G5 + Gemini-r2 G1).
 *
 * Single source of truth for the markdown representation of a labelled
 * timed transcript. Used by:
 *   - `TranscribeOnlyModal` write path (F3) — produces the note from
 *     an active transcription run.
 *   - `generate-minutes-from-transcript` command — reads the note and
 *     hydrates `MinutesCreationModal` state for follow-up minutes generation.
 *
 * Body format — `## Transcript` heading + HTML-comment-fenced payload:
 *   ## Transcript
 *   <!-- ai-organiser-transcript-json v=1 enc=base64
 *   <base64-encoded JSON, single line>
 *   -->
 *   <human-readable markdown rendering of LabelledTimedTranscript>
 *
 * Gemini round 1 G5 security fix: the JSON payload is ALWAYS base64-encoded
 * (with optional gzip when >32KB). Otherwise a transcript line containing
 * the literal sequence `-->` (legitimate text — "outcomes —> next steps")
 * would prematurely terminate the HTML comment and break the parser.
 * Base64's alphabet (A-Z, a-z, 0-9, +, /, =) cannot contain `--`.
 *
 * Gemini round 2 G1 async fix: read/writeTranscriptNote are async because
 * browser-native gzip (`CompressionStream`) is asynchronous. Signatures stay
 * async even below the gzip threshold for a uniform contract — callers
 * always `await`.
 *
 * Production note: `zod` is a transitive dep already in the bundle (~14KB
 * minified). The schema validation here protects the read path from
 * silently corrupted notes — the alternative is hand-rolled validators
 * that drift from the type definitions.
 */

import { z } from 'zod';
import { stringifyYaml, parseYaml } from 'obsidian';
import type { Result } from '../core/result';
import type { LabelledTimedTranscript } from './transcriptTypes';
import { logger } from '../utils/logger';

// ============================================================================
// Schema
// ============================================================================

export const TranscriptNoteFrontmatterSchema = z.object({
    type: z.literal('transcript'),
    /** Vault-relative path to the audio file backing this transcript */
    audio: z.string(),
    /** BCP-47 language tag carried through from TimedTranscript.languageCode */
    language: z.string(),
    duration_seconds: z.number().nonnegative(),
    /** label → resolved name mapping confirmed (or skipped) by the user */
    speakers: z.record(z.string(), z.string()),
    /** True only when user clicked Confirm in the SpeakerReviewPanel */
    speakers_verified: z.boolean(),
    speaker_detection_status: z.enum([
        'detected',
        'failed',
        'skipped',
        'unavailable',
        'not-required',
    ]),
    timestamp_source: z.enum(['whisper-verbose-json', 'none']),
    /** ISO 8601 timestamp — produced by `new Date().toISOString()` */
    created_at: z.iso.datetime(),
    /** Diarization provider when an acoustic-diarization path was used (plan §7 R2 H4;
     *  azure-audio adds the in-region azure-speech provider) */
    diarization_provider: z.enum(['deepgram', 'azure-speech']).optional(),
    /** Authoritative cost in USD from provider — computed from durationSec */
    diarization_cost_usd: z.number().nonnegative().optional(),
    /** Language reported by the diarization provider (parallel to `language`) */
    diarization_language: z.string().optional(),
});

export type TranscriptNoteFrontmatter = z.infer<typeof TranscriptNoteFrontmatterSchema>;

export interface TranscriptNote {
    frontmatter: TranscriptNoteFrontmatter;
    /** Labelled timed transcript — the canonical machine-readable payload */
    body: LabelledTimedTranscript;
}

// ============================================================================
// Constants
// ============================================================================

const TRANSCRIPT_BODY_HEADING = '## Transcript';
const COMMENT_OPEN_PREFIX = '<!-- ai-organiser-transcript-json v=1 enc=';
const COMMENT_OPEN_RE = /<!-- ai-organiser-transcript-json v=1 enc=(base64(?:\+gzip)?)\s*([\s\S]*?)-->/;
/** When raw JSON exceeds this length (bytes), we gzip before base64-encoding. */
const GZIP_THRESHOLD_BYTES = 32_000;

// ============================================================================
// Writer
// ============================================================================

/**
 * Serialise a `TranscriptNote` into a markdown string. Always returns a
 * Promise because gzip encoding (when payload exceeds the threshold) is
 * async-only in browser environments via `CompressionStream` (Gemini G1).
 */
export async function writeTranscriptNote(note: TranscriptNote): Promise<string> {
    const validated = TranscriptNoteFrontmatterSchema.parse(note.frontmatter);
    const frontmatterYaml = stringifyYaml(validated);
    const payloadJson = JSON.stringify(note.body);

    const payloadBytes = textEncoder.encode(payloadJson);
    const useGzip = payloadBytes.byteLength > GZIP_THRESHOLD_BYTES;
    const encoded = useGzip
        ? await encodeGzipBase64(payloadBytes)
        : encodeBase64(payloadBytes);
    const enc = useGzip ? 'base64+gzip' : 'base64';

    const humanBody = renderHumanReadableMarkdown(note.body);

    return [
        '---',
        frontmatterYaml.trimEnd(),
        '---',
        '',
        TRANSCRIPT_BODY_HEADING,
        '',
        `${COMMENT_OPEN_PREFIX}${enc}`,
        encoded,
        '-->',
        '',
        humanBody,
        '',
    ].join('\n');
}

// ============================================================================
// Reader
// ============================================================================

/**
 * Parse a markdown string back into a `TranscriptNote`. Returns
 * `Result<TranscriptNote>` so the caller can surface specific failure
 * modes without losing the markdown content (degraded UI states still
 * have something to show).
 *
 * Error codes:
 *   - `'no-frontmatter'`         — file has no `---` frontmatter block
 *   - `'invalid-frontmatter'`    — YAML parsed but schema validation failed
 *   - `'no-body-payload'`        — `## Transcript` + comment fence not found
 *   - `'decode-failed'`          — base64/gzip decoding threw
 *   - `'invalid-body-json'`      — payload base64-decoded but JSON.parse failed
 */
export async function readTranscriptNote(content: string): Promise<Result<TranscriptNote>> {
    const frontmatterResult = extractFrontmatter(content);
    if (!frontmatterResult.ok) return frontmatterResult;

    const validated = TranscriptNoteFrontmatterSchema.safeParse(frontmatterResult.value.parsed);
    if (!validated.success) {
        logger.warn('TranscriptNote', `frontmatter schema validation failed: ${validated.error.message}`);
        return { ok: false, error: 'invalid-frontmatter' };
    }

    const commentMatch = COMMENT_OPEN_RE.exec(frontmatterResult.value.rest);
    if (!commentMatch) return { ok: false, error: 'no-body-payload' };
    const enc = commentMatch[1];
    const payload = commentMatch[2].trim();

    let payloadBytes: Uint8Array;
    try {
        if (enc === 'base64+gzip') {
            payloadBytes = await decodeGzipBase64(payload);
        } else {
            payloadBytes = decodeBase64(payload);
        }
    } catch (err) {
        logger.warn('TranscriptNote', `decode failed (enc=${enc}): ${String(err)}`);
        return { ok: false, error: 'decode-failed' };
    }

    let body: LabelledTimedTranscript;
    try {
        body = JSON.parse(textDecoder.decode(payloadBytes)) as LabelledTimedTranscript;
    } catch (err) {
        logger.warn('TranscriptNote', `body JSON parse failed: ${String(err)}`);
        return { ok: false, error: 'invalid-body-json' };
    }

    return {
        ok: true,
        value: { frontmatter: validated.data, body },
    };
}

// ============================================================================
// Helpers
// ============================================================================

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Render the speaker-labelled transcript as flowing markdown for human
 * readers. Format: `**Speaker:** text` per segment, blank line between
 * speaker turns. Unlabelled segments fall back to plain text without prefix.
 */
function renderHumanReadableMarkdown(body: LabelledTimedTranscript): string {
    if (!body.segments?.length) return body.text ?? '';
    const lines: string[] = [];
    let lastSpeaker: string | undefined = undefined;
    for (const seg of body.segments) {
        const text = seg.text.trim();
        if (!text) continue;
        if (seg.speaker && seg.speaker !== lastSpeaker) {
            if (lines.length > 0) lines.push(''); // blank line between turns
            lines.push(`**${seg.speaker}:** ${text}`);
        } else if (seg.speaker === lastSpeaker) {
            // Continuation of the same speaker — append on a new line without prefix.
            lines.push(text);
        } else {
            lines.push(text);
        }
        lastSpeaker = seg.speaker;
    }
    return lines.join('\n');
}

interface FrontmatterExtract {
    parsed: unknown;
    rest: string;
}

function extractFrontmatter(content: string): Result<FrontmatterExtract> {
    if (!content.startsWith('---')) {
        return { ok: false, error: 'no-frontmatter' };
    }
    const endMarker = content.indexOf('\n---', 3);
    if (endMarker === -1) return { ok: false, error: 'no-frontmatter' };
    const yamlBlock = content.slice(3, endMarker).trim();
    const rest = content.slice(endMarker + 4);
    try {
        const parsed = parseYaml(yamlBlock) as unknown;
        return { ok: true, value: { parsed, rest } };
    } catch (err) {
        logger.warn('TranscriptNote', `YAML parse failed: ${String(err)}`);
        return { ok: false, error: 'invalid-frontmatter' };
    }
}

// ----- base64 -----

function encodeBase64(bytes: Uint8Array): string {
    // Browser-safe: build a binary string in chunks (avoid call-stack overflow
    // on large transcripts) then btoa.
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        const slice = bytes.subarray(i, i + CHUNK);
        // String.fromCharCode + spread is fine here because the chunk size
        // stays under the call-stack limit.
        binary += String.fromCharCode(...slice);
    }
    return btoa(binary);
}

function decodeBase64(base64: string): Uint8Array {
    const binary = atob(base64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        out[i] = binary.charCodeAt(i);
    }
    return out;
}

// ----- gzip via CompressionStream (Gemini G1) -----

async function encodeGzipBase64(bytes: Uint8Array): Promise<string> {
    const compressed = await streamThrough(bytes, new CompressionStream('gzip'));
    return encodeBase64(compressed);
}

async function decodeGzipBase64(base64: string): Promise<Uint8Array> {
    const compressed = decodeBase64(base64);
    return streamThrough(compressed, new DecompressionStream('gzip'));
}

async function streamThrough(
    input: Uint8Array,
    transform: GenericTransformStream
): Promise<Uint8Array> {
    // Response() accepts ArrayBuffer/Blob but not Uint8Array directly in
    // strict TS lib defs; wrap via Blob (zero copy in practice).
    const stream = new Response(new Blob([input as BlobPart])).body;
    if (!stream) throw new Error('streamThrough: input has no ReadableStream body');
    const piped = stream.pipeThrough(transform as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
    const ab = await new Response(piped).arrayBuffer();
    return new Uint8Array(ab);
}
