/**
 * Deepgram Nova-3 acoustic-diarization adapter
 * =============================================
 *
 * Implementation contract per plan §1.5
 * (docs/plans/deepgram-diarization-v2.md). Single-file home for HTTP +
 * parse logic; orchestration lives in `AudioAttachCoordinator`.
 *
 * - `mip_opt_out=true` enforced (no-training opt-out — see plan §1
 *   "Privacy claims" note for retention-vs-training distinction).
 * - Uses Obsidian `requestUrl` via the shared `abortableRequestUrl`
 *   wrapper (G5). Cooperative cancel only — see R2 M1 note.
 * - Speaker labels formatted 1-indexed as "Speaker 1", "Speaker 2"
 *   for parity with the v1 Whisper+LLM path (G2-L1).
 * - Timestamps converted from float seconds → integer milliseconds
 *   (G2-H2). Tests assert integer output.
 */

import type { App, RequestUrlResponse } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import { logger } from '../../utils/logger';
import { abortableRequestUrl } from '../../utils/abortableRequestUrl';
import { err, ok, type Result } from '../../core/result';
import { getAudioMimeType } from '../audioTranscriptionService';
import { getDeepgramApiKey } from '../apiKeyHelpers';
import type {
    LabelledTimedSegment,
    LabelledTimedTranscript,
} from '../transcriptTypes';
import {
    DEEPGRAM_COST_PER_MIN_USD,
    type DiarizationOptions,
    type DiarizationProvider,
    type DiarizationResult,
} from './types';

const DEEPGRAM_URL = 'https://api.deepgram.com/v1/listen';
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_RETRIES_ON_429 = 2; // 3 total attempts = original + 2 retries
const BASE_BACKOFFS_MS = [1000, 4000] as const;

/** Provider-owned credential resolution (azure-audio H3/D9). */
export type DiarizationKeyResolver = () => Promise<string | null>;

/** Injectable hooks used only by tests (underscore-prefixed). */
interface AdapterTestHooks {
    /** Inject a fake sleeper to skip real waits in retry tests */
    _sleeper?: (ms: number) => Promise<void>;
    /** Inject a deterministic jitter (default = ±25% random) */
    _jitter?: (base: number) => number;
}

const defaultSleeper = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

const defaultJitter = (base: number): number =>
    base * (1 + (Math.random() * 0.5 - 0.25));

// Deepgram response shapes (only the fields we read)
interface DeepgramWord {
    word: string;
    start: number;
    end: number;
    confidence: number;
    speaker?: number;
    speaker_confidence?: number;
    punctuated_word?: string;
}

interface DeepgramUtterance {
    start: number;
    end: number;
    confidence: number;
    channel: number;
    transcript: string;
    words: DeepgramWord[];
    speaker?: number;
}

interface DeepgramChannel {
    alternatives: Array<{
        transcript: string;
        confidence: number;
    }>;
    detected_language?: string;
    language_confidence?: number;
}

interface DeepgramResponse {
    metadata?: {
        duration?: number;
        request_id?: string;
    };
    results?: {
        utterances?: DeepgramUtterance[];
        channels?: DeepgramChannel[];
    };
}

export class DeepgramAdapter implements DiarizationProvider {
    public readonly name = 'deepgram' as const;

    constructor(
        private readonly keyResolver: DiarizationKeyResolver,
        private readonly hooks: AdapterTestHooks = {},
    ) {}

    async transcribeWithDiarization(
        _app: App,
        audioBytes: ArrayBuffer,
        options: DiarizationOptions = {},
    ): Promise<Result<DiarizationResult>> {
        let apiKey: string | null;
        try {
            apiKey = await this.keyResolver();
        } catch (e) {
            // Surface the underlying reason in logs (H21) — the typed error
            // stays 'no-api-key' (callers prompt for configuration either way).
            logger.warn('Diarization', `Deepgram key resolution failed: ${e instanceof Error ? e.message : String(e)}`);
            apiKey = null;
        }
        if (!apiKey) {
            return err('no-api-key');
        }
        if (audioBytes.byteLength === 0) {
            return err('empty-audio');
        }

        // Build URL with required params (plan §1.5)
        const url = new URL(DEEPGRAM_URL);
        url.searchParams.set('model', 'nova-3');
        url.searchParams.set('diarize', 'true');
        url.searchParams.set('utterances', 'true');
        url.searchParams.set('detect_language', 'true');
        url.searchParams.set('smart_format', 'true');
        url.searchParams.set('punctuate', 'true');
        url.searchParams.set('mip_opt_out', 'true');

        const contentType = options.mimeType
            ?? getAudioMimeType(extensionOf(options.filename ?? ''));

        const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const sleeper = this.hooks._sleeper ?? defaultSleeper;
        const jitter = this.hooks._jitter ?? defaultJitter;

        // Retry loop: 3 total attempts (original + 2 retries) on 429 only
        for (let attempt = 0; attempt <= MAX_RETRIES_ON_429; attempt++) {
            const result = await this.singleAttempt(
                url.toString(),
                apiKey,
                audioBytes,
                contentType,
                timeoutMs,
                options.signal,
            );

            if (result.ok) {
                return parseResponse(result.value);
            }

            // Only retry on 429; anything else surfaces immediately
            if (result.error === 'http-429' && attempt < MAX_RETRIES_ON_429) {
                const base = BASE_BACKOFFS_MS[attempt];
                await sleeper(jitter(base));
                continue;
            }

            return err(result.error);
        }

        return err('http-429'); // unreachable but satisfies type
    }

    private async singleAttempt(
        url: string,
        apiKey: string,
        audioBytes: ArrayBuffer,
        contentType: string,
        timeoutMs: number,
        callerSignal: AbortSignal | undefined,
    ): Promise<Result<RequestUrlResponse>> {
        // Compose caller signal with internal timeout
        const composedController = new AbortController();
        const timeoutHandle = setTimeout(() => {
            composedController.abort();
        }, timeoutMs);
        let didTimeout = false;
        const timeoutWatcher = setTimeout(() => {
            didTimeout = true;
        }, timeoutMs);

        if (callerSignal) {
            if (callerSignal.aborted) {
                clearTimeout(timeoutHandle);
                clearTimeout(timeoutWatcher);
                return err('aborted');
            }
            callerSignal.addEventListener(
                'abort',
                () => composedController.abort(),
                { once: true },
            );
        }

        try {
            const response = await abortableRequestUrl(
                {
                    url,
                    method: 'POST',
                    headers: {
                        Authorization: `Token ${apiKey}`,
                        'Content-Type': contentType,
                    },
                    body: audioBytes,
                    throw: false,
                },
                { signal: composedController.signal },
            );

            // HTTP-status branch
            const status = response.status;
            if (status === 200) {
                return ok(response);
            }
            if (status >= 500 && status < 600) {
                // R4 M3: sanitized truncated payload (200 chars, no headers)
                const safeSnippet = (response.text ?? '').slice(0, 200);
                logger.warn(
                    'Diarization',
                    `deepgram-5xx status=${status} snippet=${safeSnippet.replace(/request_id|x-/gi, '[redacted]')}`,
                );
            }
            return err(`http-${status}`);
        } catch (e) {
            // Distinguish abort/timeout vs transport
            const message = e instanceof Error ? e.message : String(e);
            if (didTimeout) return err('timeout');
            if (
                message.includes('cancelled')
                || message.includes('aborted')
                || message.includes('AbortError')
            ) {
                return err('aborted');
            }
            return err(classifyTransportError(message));
        } finally {
            clearTimeout(timeoutHandle);
            clearTimeout(timeoutWatcher);
        }
    }
}

/** Classify a transport-level requestUrl rejection (R4 H3). */
function classifyTransportError(message: string): string {
    const lower = message.toLowerCase();
    if (lower.includes('enotfound') || lower.includes('eai_again') || lower.includes('net::')) {
        return 'network-dns';
    }
    if (lower.includes('cert') || lower.includes('tls') || lower.includes('ssl')) {
        return 'network-tls';
    }
    if (lower.includes('csp')) return 'network-csp';
    if (lower.includes('enetunreach') || lower.includes('offline')) return 'network-offline';
    return `network-other:${message.slice(0, 120)}`;
}

/** Extract file extension (lowercase, no leading dot) from a filename. */
function extensionOf(filename: string): string {
    const idx = filename.lastIndexOf('.');
    if (idx < 0 || idx === filename.length - 1) return '';
    return filename.slice(idx + 1).toLowerCase();
}

/** Parse a successful Deepgram response into `DiarizationResult`. */
export function parseResponse(response: RequestUrlResponse): Result<DiarizationResult> {
    let body: DeepgramResponse;
    try {
        body = response.json as DeepgramResponse ?? JSON.parse(response.text);
    } catch (e) {
        return err(`malformed-response: ${e instanceof Error ? e.message : String(e)}`);
    }

    const utterances = body.results?.utterances;
    if (!utterances || !Array.isArray(utterances) || utterances.length === 0) {
        return err('no-utterances');
    }

    const channel0 = body.results?.channels?.[0];
    const detectedLanguage = channel0?.detected_language ?? 'und';
    const durationSec = body.metadata?.duration ?? 0;

    // Map utterances → LabelledTimedSegment[]; convert sec → ms; format speaker label
    const segments: LabelledTimedSegment[] = utterances.map((utt, idx) => ({
        startMs: Math.round(utt.start * 1000),
        endMs: Math.round(utt.end * 1000),
        text: utt.transcript,
        id: idx,
        speaker: utt.speaker !== undefined ? `Speaker ${utt.speaker + 1}` : undefined,
    }));

    // Speakers list in first-appearance order
    const speakersSet = new Set<string>();
    for (const seg of segments) {
        if (seg.speaker && !speakersSet.has(seg.speaker)) speakersSet.add(seg.speaker);
    }

    const labelled: LabelledTimedTranscript = {
        text: utterances.map((u) => u.transcript).join(' '),
        segments,
        timestampSource: 'whisper-verbose-json',
        durationMs: Math.round(durationSec * 1000),
        languageCode: detectedLanguage,
        speakers: Array.from(speakersSet),
    };

    // Typed cost (azure-audio M6): Deepgram cost is computed from authoritative
    // duration → kind 'actual'; missing duration → 'unknown' (frontmatter omits usd).
    const cost = durationSec > 0
        ? {
            kind: 'actual' as const,
            usd: Math.round((durationSec / 60) * DEEPGRAM_COST_PER_MIN_USD * 10000) / 10000,
            basis: `$${DEEPGRAM_COST_PER_MIN_USD}/min nova-3`,
        }
        : { kind: 'unknown' as const };

    return ok({
        labelled,
        transcriptText: labelled.text,
        durationSec,
        detectedLanguage,
        provider: 'deepgram',
        cost,
    });
}

/**
 * Production factory (azure-audio H3/D9): binds the canonical Deepgram key
 * chain so callers never pass a key positionally. Tests construct the class
 * directly with a stub resolver.
 */
export function createDeepgramProvider(plugin: AIOrganiserPlugin): DeepgramAdapter {
    return new DeepgramAdapter(() => getDeepgramApiKey(plugin));
}
