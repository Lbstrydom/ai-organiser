/**
 * Azure AI Speech Fast Transcription diarization adapter (azure-audio plan D2).
 *
 * Transcribes AND separates speakers in ONE synchronous REST call — exactly the
 * seam Deepgram fills, so this is a second `DiarizationProvider` impl behind
 * the existing injectable coordinator seam (no new abstraction). This is the
 * in-region (Wärtsilä-compliant) diarizer: Speech endpoints are regional,
 * unlike Deepgram / Azure OpenAI audio (Global-Standard).
 *
 * HTTP + multipart + retry/pacing live in `fastTranscribeRequest`
 * (audioTranscriptionService) — shared with the plain-STT path. This module
 * owns credential resolution (plan D9: dedicated Speech secret → shared
 * Foundry key, NEVER a personal cloud key), per-op readiness (explicit
 * custom-domain endpoint, plan D10), preflight size cap (G3 — reject BEFORE
 * buffering more), and the response → `LabelledTimedTranscript` mapping.
 *
 * Long audio (G4/§8): v1 is single-call only, capped at the shared 200 MB app
 * limit (the service itself accepts ~2 h / ~2 GB). Over-cap → typed
 * `file-too-large` error with a "split large recordings" message — chunked
 * Azure diarization (with chunk-local speaker disclosure) is deferred.
 */

import type { App } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import { err, ok, type Result } from '../../core/result';
import {
    fastTranscribeRequest,
    normalizeSpeechLocale,
    type FastTranscriptionResponse,
} from '../audioTranscriptionService';
import { resolveAzureSpeechCredential } from '../azure/azureSpeechCredential';
import { getSpeechFastTranscriptionEndpoint } from '../azure/endpointResolver';
import type {
    LabelledTimedSegment,
    LabelledTimedTranscript,
} from '../transcriptTypes';
import {
    DEEPGRAM_MAX_FILE_BYTES,
    type DiarizationOptions,
    type DiarizationProvider,
    type DiarizationResult,
} from './types';

/** Clamp helper mirroring the settings migration bound (1–10). */
function clampMaxSpeakers(v: unknown): number {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) ? Math.min(10, Math.max(1, n)) : 4;
}

export class AzureSpeechDiarizationAdapter implements DiarizationProvider {
    public readonly name = 'azure-speech' as const;

    constructor(private readonly plugin: AIOrganiserPlugin) {}

    async transcribeWithDiarization(
        _app: App,
        audioBytes: ArrayBuffer,
        options: DiarizationOptions = {},
    ): Promise<Result<DiarizationResult>> {
        if (audioBytes.byteLength === 0) return err('empty-audio');
        // Preflight size cap BEFORE any further buffering (G3). Shared app cap
        // with the Deepgram path; the v1 single-call decision (G4) means no
        // chunking fallback — the message tells the user what to do instead.
        if (audioBytes.byteLength > DEEPGRAM_MAX_FILE_BYTES) {
            return err(`file-too-large:${audioBytes.byteLength}:${DEEPGRAM_MAX_FILE_BYTES}`);
        }

        const endpoint = getSpeechFastTranscriptionEndpoint(this.plugin.settings);
        if (!endpoint.ok) return err(endpoint.error);
        const cred = await resolveAzureSpeechCredential(this.plugin);
        if (!cred.ok) return err(cred.error);

        const locale = normalizeSpeechLocale(options.languageHint);
        const r = await fastTranscribeRequest({
            endpoint: endpoint.value,
            key: cred.value.key,
            audioBytes,
            filename: options.filename,
            mimeType: options.mimeType,
            locales: locale ? [locale] : undefined,
            diarization: {
                enabled: true,
                maxSpeakers: clampMaxSpeakers(this.plugin.settings.azureSpeechMaxSpeakers),
            },
            signal: options.signal,
            timeoutMs: options.timeoutMs,
        });
        if (!r.ok) return err(r.error);
        return parseFastTranscription(r.value);
    }
}

/**
 * Map a verified Fast Transcription response (plan §A) to the canonical
 * `DiarizationResult`. Azure speaker ids are 1-based already → `Speaker N`
 * matches the UX convention shared with the Deepgram/Whisper paths.
 */
export function parseFastTranscription(body: FastTranscriptionResponse): Result<DiarizationResult> {
    const rawPhrases = body.phrases;
    if (!rawPhrases || !Array.isArray(rawPhrases) || rawPhrases.length === 0) {
        return err('no-phrases');
    }

    // Provider payload is untrusted (M4): keep only well-formed phrases —
    // finite non-negative timestamps + non-empty text. All malformed → error.
    const phrases = rawPhrases.filter((p) =>
        p && typeof p.text === 'string' && p.text.length > 0
        && Number.isFinite(p.offsetMilliseconds) && p.offsetMilliseconds >= 0
        && Number.isFinite(p.durationMilliseconds) && p.durationMilliseconds >= 0,
    );
    if (phrases.length === 0) return err('no-phrases');

    const segments: LabelledTimedSegment[] = phrases.map((p, idx) => ({
        startMs: Math.round(p.offsetMilliseconds),
        endMs: Math.round(p.offsetMilliseconds + p.durationMilliseconds),
        text: p.text,
        id: idx,
        speaker: typeof p.speaker === 'number' && Number.isFinite(p.speaker)
            ? `Speaker ${p.speaker}`
            : undefined,
    }));

    const seen = new Set<string>();
    const speakers: string[] = [];
    for (const s of segments) {
        if (s.speaker && !seen.has(s.speaker)) { seen.add(s.speaker); speakers.push(s.speaker); }
    }

    const detectedLanguage = phrases.find((p) => p.locale)?.locale ?? 'und';
    const durationMs = body.durationMilliseconds
        ?? (segments.length > 0 ? segments[segments.length - 1].endMs : 0);
    const text = body.combinedPhrases?.[0]?.text ?? phrases.map((p) => p.text).join(' ');

    const labelled: LabelledTimedTranscript = {
        text,
        segments,
        // Real provider timestamps — same preview-eligibility semantics as the
        // Whisper/Deepgram value (the union member means "real timestamps").
        timestampSource: 'whisper-verbose-json',
        durationMs,
        languageCode: detectedLanguage,
        speakers,
    };

    return ok({
        labelled,
        transcriptText: text,
        durationSec: durationMs / 1000,
        detectedLanguage,
        provider: 'azure-speech',
        // Azure Speech billing is account-level; no per-request price is
        // computed (plan M6 — typed 'unknown', frontmatter omits usd).
        cost: { kind: 'unknown' },
    });
}

/** Production factory (parity with `createDeepgramProvider`). */
export function createAzureSpeechDiarizationProvider(plugin: AIOrganiserPlugin): AzureSpeechDiarizationAdapter {
    return new AzureSpeechDiarizationAdapter(plugin);
}
