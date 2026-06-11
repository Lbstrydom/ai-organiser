/**
 * Audio Transcription Service
 * Handles transcription of audio files using Whisper API (OpenAI or Groq)
 */

import { App, TFile, Platform, requestUrl } from 'obsidian';
import { getFs, getPath } from '../utils/desktopRequire';
import { withAzureLease, buildAzureOpenAIDeploymentKey, buildAzureSpeechKey, isAzureHost } from './azure/azureRequestPacer';
import { parseAzureRateLimitHeaders, computeAzureBackoffMs, logAzureRateLimitHeaders } from './azure/azureRateLimitHeaders';
import { abortableSleep } from '../utils/abortableSleep';
import { abortableRequestUrl } from '../utils/abortableRequestUrl';
import { err, ok, type Result } from '../core/result';
import { validateChunkQuality, stitchOverlappingTranscripts } from './transcriptQualityService';
import { SEGMENT_OVERLAP_SECONDS } from './audioCompressionService';

/**
 * `azure` = Azure OpenAI Whisper (legacy, Global-Standard).
 * `azure-speech` = Azure AI Speech Fast Transcription (in-region, azure-audio plan).
 * `openai-gpt-audio` = bounded short-clip STT via gpt-audio-1.5 (plan Phase 4).
 */
export type TranscriptionProvider = 'openai' | 'groq' | 'azure' | 'azure-speech';

/**
 * Audio Transcription Provider Registry
 * Single source of truth for Whisper API endpoints and models.
 *
 * Azure Whisper (plan §5): the endpoint is resolved dynamically by the caller via
 * `azure/endpointResolver.getWhisperEndpoint(settings)` (carries the
 * `deployments/<dep>/audio/transcriptions?api-version=2024-10-21` pattern) and
 * passed in as `options.azureEndpoint`. Azure auth uses the `api-key` header
 * (not `Authorization: Bearer`); the model name is the deployment ('whisper').
 */
// Direct-provider endpoints (Azure is resolved dynamically, so excluded here).
const WHISPER_ENDPOINT: Record<Exclude<TranscriptionProvider, 'azure' | 'azure-speech'>, string> = {
    openai: 'https://api.openai.com/v1/audio/transcriptions',
    groq: 'https://api.groq.com/openai/v1/audio/transcriptions'
};

const WHISPER_MODEL: Record<TranscriptionProvider, string> = {
    openai: 'whisper-1',
    groq: 'whisper-large-v3',
    azure: 'whisper',
    'azure-speech': 'fast-transcription', // informational — Speech has no model field
};

/** Whisper verbose_json segment with timestamps and quality signals (Phase 4b TRA) */
export interface WhisperSegment {
    id: number;
    start: number;
    end: number;
    text: string;
    /** Probability that the segment contains no speech (0-1). High values indicate silence/noise. */
    no_speech_prob: number;
    /** Compression ratio — high values (>2.4) indicate repetitive/corrupt text. */
    compression_ratio: number;
    avg_logprob?: number;
    temperature?: number;
}

export interface TranscriptionResult {
    success: boolean;
    transcript?: string;
    error?: string;
    duration?: number;
    /** Whisper verbose_json segments with timestamps and quality signals (Phase 4b TRA) */
    segments?: WhisperSegment[];
    /** Compressed audio data, available when compression was performed (Phase 5) */
    compressedData?: Uint8Array;
    /** Original file size in bytes before compression */
    originalSizeBytes?: number;
    /** Quality warnings from chunk validation (e.g., skipped chunks, low word rate) */
    warnings?: string[];
    /**
     * BCP-47 language detected by Whisper (from `verbose_json.language`).
     * Used by F2c/F5 to route speaker attribution to the right language
     * strategy. Falls back to 'und' when not present. Hamina persona test
     * showed `language: und` in saved frontmatter because we'd hardcoded
     * the fallback instead of using Whisper's detection.
     */
    language?: string;
}

export interface TranscriptionOptions {
    provider: TranscriptionProvider;
    apiKey: string;
    language?: string;
    prompt?: string;
    /**
     * Azure Whisper only: pre-resolved endpoint URL (includes deployment name +
     * api-version). Required when `provider === 'azure'`; ignored otherwise.
     */
    azureEndpoint?: string;
}

/**
 * Resolved transcription credentials returned by `getAudioTranscriptionApiKey`.
 * For Azure (`provider === 'azure'`), `azureEndpoint` carries the pre-resolved
 * Whisper URL and callers MUST forward it into `TranscriptionOptions`.
 */
export interface ResolvedTranscriptionConfig {
    key: string;
    provider: TranscriptionProvider;
    azureEndpoint?: string;
}

// Supported audio formats for Whisper API
export const SUPPORTED_AUDIO_FORMATS = new Set([
    'mp3', 'mp4', 'm4a', 'wav', 'webm', 'mpeg', 'mpga', 'oga', 'ogg'
]);

// Maximum file size (25MB for both OpenAI and Groq)
export const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024;
export const MAX_FILE_SIZE_MB = 25;

/**
 * Check if a file is a supported audio format
 */
export function isAudioFile(file: TFile): boolean {
    const ext = file.extension.toLowerCase();
    return SUPPORTED_AUDIO_FORMATS.has(ext);
}

/**
 * Get audio files from a folder
 */
export function getAudioFilesFromFolder(app: App, folderPath: string): TFile[] {
    const files = app.vault.getFiles();
    return files.filter(file =>
        file.path.startsWith(folderPath) && isAudioFile(file)
    );
}

/**
 * Get all audio files from vault
 */
export function getAllAudioFiles(app: App): TFile[] {
    const files = app.vault.getFiles();
    return files.filter(file => isAudioFile(file));
}

/**
 * Check if file size is within limits
 */
export function isFileSizeValid(sizeBytes: number): boolean {
    return sizeBytes <= MAX_FILE_SIZE_BYTES;
}

/**
 * Format file size for display
 */
export function formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Get MIME type for audio file. Exported for reuse by the Deepgram
 * adapter (plan §1.5 G4 — single MIME table for Whisper + Deepgram).
 */
export function getAudioMimeType(extension: string): string {
    const mimeTypes: Record<string, string> = {
        'mp3': 'audio/mpeg',
        'mp4': 'audio/mp4',
        'm4a': 'audio/mp4',
        'wav': 'audio/wav',
        'webm': 'audio/webm',
        'mpeg': 'audio/mpeg',
        'mpga': 'audio/mpeg',
        'oga': 'audio/ogg',
        'ogg': 'audio/ogg'
    };
    return mimeTypes[extension.toLowerCase()] || 'audio/mpeg';
}

/**
 * Transcribe audio file using Whisper API
 */
export async function transcribeAudio(
    app: App,
    file: TFile,
    options: TranscriptionOptions
): Promise<TranscriptionResult> {
    try {
        // Stat-based preflight BEFORE buffering (azure-audio G3) — reject an
        // over-cap file without reading it into memory.
        const statSize = file.stat?.size ?? 0;
        if (options.provider === 'azure-speech' && statSize > AZURE_SPEECH_MAX_FILE_BYTES) {
            return {
                success: false,
                error: `File size (${formatFileSize(statSize)}) exceeds the ${formatFileSize(AZURE_SPEECH_MAX_FILE_BYTES)} limit — split large recordings first.`,
            };
        }

        // Read the file as binary
        const arrayBuffer = await app.vault.readBinary(file);
        const fileSize = arrayBuffer.byteLength;

        // Azure AI Speech Fast Transcription path (in-region; own size cap —
        // the service accepts ~2 GB, app-capped well below the Whisper 25 MB).
        if (options.provider === 'azure-speech') {
            return transcribeWithAzureSpeech(arrayBuffer, file.name, options);
        }

        // Check file size
        if (!isFileSizeValid(fileSize)) {
            return {
                success: false,
                error: `File size (${formatFileSize(fileSize)}) exceeds ${MAX_FILE_SIZE_MB}MB limit. Please compress the audio file first.`
            };
        }

        // Get the appropriate endpoint and prepare the request
        const endpoint = getWhisperEndpoint(options);

        // Create form data manually for Obsidian's requestUrl
        const boundary = '----FormBoundary' + Math.random().toString(36).substring(2);
        const formData = buildMultipartFormData(
            arrayBuffer,
            file.name,
            file.extension,
            options,
            boundary
        );

        // Make the API request with a 10-minute timeout (Whisper typically returns
        // in 1-2 min for 25MB). The timeout + abort + lease cleanup live INSIDE
        // pacedWhisperRequest — no leaked timer, no zombie retry loop on timeout.
        const timeoutMs = 600000; // 10 minutes

        const response = await pacedWhisperRequest(endpoint, {
            url: endpoint,
            method: 'POST',
            headers: {
                ...getTranscriptionAuthHeaders(options),
                'Content-Type': `multipart/form-data; boundary=${boundary}`
            },
            body: formData,
            throw: false
        }, timeoutMs);

        if (response.status !== 200) {
            const errorText = typeof response.json === 'object'
                ? JSON.stringify(response.json)
                : response.text;
            return {
                success: false,
                error: `API error (${response.status}): ${errorText}`
            };
        }

        const result = response.json;

        return {
            success: true,
            transcript: result.text,
            duration: result.duration,
            segments: parseWhisperSegments(result.segments),
            language: typeof result.language === 'string' ? result.language : undefined,
        };

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return {
            success: false,
            error: `Transcription failed: ${errorMessage}`
        };
    }
}

/**
 * Transcribe audio from raw data (used for compressed audio)
 */
export async function transcribeAudioFromData(
    audioData: Uint8Array,
    fileName: string,
    options: TranscriptionOptions
): Promise<TranscriptionResult> {
    try {
        if (options.provider === 'azure-speech') {
            const exact = audioData.buffer.slice(
                audioData.byteOffset,
                audioData.byteOffset + audioData.byteLength
            ) as ArrayBuffer;
            return transcribeWithAzureSpeech(exact, fileName, options);
        }

        // Check file size
        if (!isFileSizeValid(audioData.byteLength)) {
            return {
                success: false,
                error: `File size (${formatFileSize(audioData.byteLength)}) exceeds ${MAX_FILE_SIZE_MB}MB limit.`
            };
        }

        // Get the appropriate endpoint and prepare the request
        const endpoint = getWhisperEndpoint(options);

        // Create form data manually for Obsidian's requestUrl
        const boundary = '----FormBoundary' + Math.random().toString(36).substring(2);
        // Exact-slice to avoid subarray corruption when audioData is a view over a larger buffer
        const exactBuffer = audioData.buffer.slice(
            audioData.byteOffset,
            audioData.byteOffset + audioData.byteLength
        ) as ArrayBuffer;
        const formData = buildMultipartFormData(
            exactBuffer,
            fileName,
            'mp3', // Compressed files are always MP3
            options,
            boundary
        );

        // Make the API request with 10 minute timeout
        const timeoutMs = 600000; // 10 minutes

        const timeoutPromise = new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error('Transcription request timeout (10 minutes)')), timeoutMs);
        });

        const requestPromise = pacedWhisperRequest(endpoint, {
            url: endpoint,
            method: 'POST',
            headers: {
                ...getTranscriptionAuthHeaders(options),
                'Content-Type': `multipart/form-data; boundary=${boundary}`
            },
            body: formData,
            throw: false
        });

        const response = await Promise.race([requestPromise, timeoutPromise]);

        if (response.status !== 200) {
            const errorText = typeof response.json === 'object'
                ? JSON.stringify(response.json)
                : response.text;
            return {
                success: false,
                error: `API error (${response.status}): ${errorText}`
            };
        }

        const result = response.json;

        return {
            success: true,
            transcript: result.text,
            duration: result.duration,
            segments: parseWhisperSegments(result.segments),
            language: typeof result.language === 'string' ? result.language : undefined,
        };

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return {
            success: false,
            error: `Transcription failed: ${errorMessage}`
        };
    }
}

/** App-level size cap for the Fast Transcription path (mirrors the diarized
 *  path's 200 MB cap; the service itself accepts ~2 GB / ~2 h). */
const AZURE_SPEECH_MAX_FILE_BYTES = 200 * 1024 * 1024;

/**
 * Plain (non-diarized) STT via Azure AI Speech Fast Transcription.
 * `options.azureEndpoint` carries the pre-resolved `:transcribe` URL and
 * `options.apiKey` the Ocp-Apim-Subscription-Key (both from
 * `getAudioTranscriptionApiKey` → `resolveAzureCapability('transcription')`).
 */
async function transcribeWithAzureSpeech(
    audioBytes: ArrayBuffer,
    fileName: string,
    options: TranscriptionOptions,
): Promise<TranscriptionResult> {
    if (!options.azureEndpoint) {
        return { success: false, error: 'Azure Speech transcription requires a resolved endpoint' };
    }
    if (audioBytes.byteLength > AZURE_SPEECH_MAX_FILE_BYTES) {
        return {
            success: false,
            error: `File size (${formatFileSize(audioBytes.byteLength)}) exceeds the ${formatFileSize(AZURE_SPEECH_MAX_FILE_BYTES)} limit — split large recordings first.`,
        };
    }
    const locale = normalizeSpeechLocale(options.language);
    const r = await fastTranscribeRequest({
        endpoint: options.azureEndpoint,
        key: options.apiKey,
        audioBytes,
        filename: fileName,
        locales: locale ? [locale] : undefined,
        // diarization off — the diarized path goes through the adapter
    });
    if (!r.ok) {
        return { success: false, error: `Azure Speech transcription failed: ${r.error}` };
    }
    const body = r.value;
    const transcript = body.combinedPhrases?.[0]?.text
        ?? (body.phrases ?? []).map((p) => p.text).join(' ');
    if (!transcript) {
        return { success: false, error: 'Azure Speech returned no transcript' };
    }
    const segments: WhisperSegment[] = (body.phrases ?? []).map((p, idx) => ({
        id: idx,
        start: p.offsetMilliseconds / 1000,
        end: (p.offsetMilliseconds + p.durationMilliseconds) / 1000,
        text: p.text,
        // Fast Transcription has no Whisper quality signals — neutral values.
        no_speech_prob: 0,
        compression_ratio: 1,
    }));
    return {
        success: true,
        transcript,
        duration: body.durationMilliseconds != null ? body.durationMilliseconds / 1000 : undefined,
        segments,
        language: body.phrases?.[0]?.locale ?? locale ?? undefined,
    };
}

/**
 * Get the Whisper API endpoint for the provider.
 * Azure callers must supply the pre-resolved endpoint in `options.azureEndpoint`.
 */
function getWhisperEndpoint(options: TranscriptionOptions): string {
    // azure-speech never reaches the Whisper path — routed earlier in
    // transcribeAudio*/transcribeWithAzureSpeech (plan D1: different surface).
    if (options.provider === 'azure' || options.provider === 'azure-speech') {
        if (!options.azureEndpoint) {
            throw new Error('Azure transcription requires a resolved endpoint');
        }
        return options.azureEndpoint;
    }
    return WHISPER_ENDPOINT[options.provider] || WHISPER_ENDPOINT.openai;
}

const WHISPER_MAX_RETRIES = 3;

/** Extract the deployment id from an Azure Whisper URL, else the literal 'whisper'
 *  (the bucket id only needs to be stable per deployment). */
function extractWhisperDeployment(endpoint: string): string {
    const m = /\/openai\/deployments\/([^/]+)\//i.exec(endpoint);
    return m ? m[1] : 'whisper';
}

/** SELF-DETECT the Azure Whisper pacer key from the resolved endpoint (azure-throttle-
 *  coverage) — `null` (un-paced) for any non-Azure Whisper host. No settings/options
 *  needed: the endpoint already carries everything. Exported for behavioral tests. */
export function resolveWhisperPacingKey(endpoint: string): string | null {
    return isAzureHost(endpoint)
        ? buildAzureOpenAIDeploymentKey(endpoint, extractWhisperDeployment(endpoint))
        : null;
}

/**
 * Run a Whisper `requestUrl` through the Azure pacer when the endpoint is an Azure
 * host (chunked audio = many calls = RPM burst). Per-attempt lease + Azure backoff
 * on 429/5xx; the lease releases (withAzureLease `finally`) BEFORE the backoff sleep
 * (deadlock-safe). Non-Azure: a plain `requestUrl` (byte-identical). The request
 * param MUST set `throw:false` so a 429 status is readable here.
 *
 * Owns the request timeout (when `timeoutMs` is given) via an internal
 * AbortController so a timeout (a) clears its own timer — no leak, and (b) aborts
 * the retry loop + frees any queued pacer lease, rather than leaving a zombie
 * retry/backoff loop running in the background (audit consolidated-R1 H1). Obsidian's
 * `requestUrl` itself can't be cancelled, so at most ONE in-flight request dangles
 * (its lease releases on completion); no FURTHER attempts or leases occur.
 */
export async function pacedWhisperRequest(
    endpoint: string,
    param: Parameters<typeof requestUrl>[0],
    timeoutMs?: number,
    signal?: AbortSignal,
): Promise<import('obsidian').RequestUrlResponse> {
    const key = resolveWhisperPacingKey(endpoint);
    const controller = new AbortController();
    const onParentAbort = (): void => controller.abort();
    if (signal) {
        if (signal.aborted) controller.abort();
        else signal.addEventListener('abort', onParentAbort, { once: true });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = timeoutMs != null
        ? new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
                controller.abort();
                reject(new Error(`Transcription request timeout (${Math.round(timeoutMs / 60000)} minutes)`));
            }, timeoutMs);
        })
        : null;
    const race = <T>(p: Promise<T>): Promise<T> => (timeout ? Promise.race([p, timeout]) : p);

    try {
        if (!key) return await race(requestUrl(param)); // non-Azure: single call + timeout (byte-identical)
        let last!: import('obsidian').RequestUrlResponse;
        for (let attempt = 0; attempt < WHISPER_MAX_RETRIES; attempt++) {
            if (controller.signal.aborted) throw new Error('Aborted');
            last = await race(withAzureLease(key, controller.signal, () => requestUrl(param)));
            const info = parseAzureRateLimitHeaders(last.headers);
            logAzureRateLimitHeaders(info, 'azure-whisper');
            const retriable = last.status === 429 || (last.status >= 500 && last.status < 600);
            if (!retriable || attempt >= WHISPER_MAX_RETRIES - 1) return last;
            await abortableSleep(computeAzureBackoffMs(info, attempt), controller.signal);
        }
        return last;
    } finally {
        if (timer) clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onParentAbort);
    }
}

// ── Azure AI Speech — Fast Transcription client (azure-audio plan Phase 2) ──
//
// Shared by the plain-STT path here AND the diarization adapter
// (`azureSpeechDiarizationAdapter` imports it — same import direction as
// `getAudioMimeType`, no module cycle). Multipart gotchas (plan §A, verified
// live 2026-06-08): the `definition` part MUST be inline `application/json`
// (a file-shaped part is SILENTLY ignored → no diarization), and the host is
// the `<resource>.cognitiveservices.azure.com` custom domain.

/** Verified response shape (§A) — only the fields we read. */
export interface FastTranscriptionPhrase {
    speaker?: number;
    offsetMilliseconds: number;
    durationMilliseconds: number;
    text: string;
    locale?: string;
    confidence?: number;
}

export interface FastTranscriptionResponse {
    durationMilliseconds?: number;
    combinedPhrases?: Array<{ text: string }>;
    phrases?: FastTranscriptionPhrase[];
}

export interface FastTranscribeArgs {
    /** Pre-resolved `:transcribe` endpoint (from getSpeechFastTranscriptionEndpoint). */
    endpoint: string;
    /** Ocp-Apim-Subscription-Key value. */
    key: string;
    audioBytes: ArrayBuffer;
    filename?: string;
    mimeType?: string;
    /** Full BCP-47 locales (e.g. ['en-US']); omit for auto language identification. */
    locales?: string[];
    /** Enable inline diarization with a max-speakers hint. */
    diarization?: { enabled: boolean; maxSpeakers: number };
    signal?: AbortSignal;
    timeoutMs?: number;
}

/**
 * Map a short language hint to a full BCP-47 locale Azure accepts (plan §2e).
 * Already-regioned tags pass through; unknown short codes get a sensible
 * region default; unmappable input returns null (caller omits `locales`).
 */
export function normalizeSpeechLocale(hint: string | undefined): string | null {
    if (!hint) return null;
    const t = hint.trim();
    if (!t) return null;
    if (/^[A-Za-z]{2,3}-[A-Za-z]{2,4}(-[A-Za-z0-9]+)?$/.test(t)) return t; // already BCP-47 with region
    const SHORT_TO_LOCALE: Record<string, string> = {
        en: 'en-US', fi: 'fi-FI', sv: 'sv-SE', de: 'de-DE', fr: 'fr-FR',
        es: 'es-ES', it: 'it-IT', pt: 'pt-PT', nl: 'nl-NL', da: 'da-DK',
        no: 'nb-NO', nb: 'nb-NO', pl: 'pl-PL', ru: 'ru-RU', ja: 'ja-JP',
        ko: 'ko-KR', zh: 'zh-CN', ar: 'ar-SA', hi: 'hi-IN', tr: 'tr-TR',
        cs: 'cs-CZ', uk: 'uk-UA', et: 'et-EE',
    };
    return SHORT_TO_LOCALE[t.toLowerCase()] ?? null;
}

const SPEECH_MAX_RETRIES = 3;
const SPEECH_DEFAULT_TIMEOUT_MS = 300_000; // synchronous endpoint; large files take minutes

/**
 * POST one Fast Transcription request. Paced through the resource-level
 * azure-speech lease (R2-H2); 429/5xx retried with Azure-aware backoff; owns
 * its timeout via an internal AbortController (no leaked timer, no zombie
 * retry loop). Multipart is built WITHOUT duplicating the audio buffer
 * beyond the single combined body (G3).
 */
export async function fastTranscribeRequest(
    args: FastTranscribeArgs,
): Promise<Result<FastTranscriptionResponse>> {
    const { endpoint, key, audioBytes } = args;
    if (audioBytes.byteLength === 0) return err('empty-audio');

    const definition: Record<string, unknown> = {};
    if (args.locales && args.locales.length > 0) definition.locales = args.locales;
    if (args.diarization?.enabled) {
        definition.diarization = { enabled: true, maxSpeakers: args.diarization.maxSpeakers };
    }

    const boundary = '----FormBoundary' + Math.random().toString(36).substring(2);
    const mimeType = args.mimeType
        ?? getAudioMimeType((args.filename ?? '').split('.').pop() ?? '');
    const parts: (string | ArrayBuffer)[] = [];
    parts.push(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="audio"; filename="${args.filename ?? 'audio'}"\r\n` +
        `Content-Type: ${mimeType}\r\n\r\n`
    );
    parts.push(audioBytes);
    parts.push('\r\n');
    // ⚠ Inline JSON with an explicit per-part Content-Type (plan §A/§2e) —
    // a file-attachment-shaped part is silently ignored by the service.
    parts.push(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="definition"\r\n` +
        `Content-Type: application/json\r\n\r\n` +
        `${JSON.stringify(definition)}\r\n`
    );
    parts.push(`--${boundary}--\r\n`);
    const body = combineArrayBuffers(parts);

    let paceKey: string;
    try {
        paceKey = buildAzureSpeechKey(endpoint, 'fast-transcription');
    } catch {
        return err('bad-endpoint');
    }

    const controller = new AbortController();
    const onParentAbort = (): void => controller.abort();
    if (args.signal) {
        if (args.signal.aborted) return err('aborted');
        args.signal.addEventListener('abort', onParentAbort, { once: true });
    }
    const timeoutMs = args.timeoutMs ?? SPEECH_DEFAULT_TIMEOUT_MS;
    let didTimeout = false;
    const timer = setTimeout(() => { didTimeout = true; controller.abort(); }, timeoutMs);

    try {
        let last: import('obsidian').RequestUrlResponse | null = null;
        for (let attempt = 0; attempt < SPEECH_MAX_RETRIES; attempt++) {
            if (controller.signal.aborted) return err(didTimeout ? 'timeout' : 'aborted');
            try {
                last = await withAzureLease(paceKey, controller.signal, () => abortableRequestUrl({
                    url: endpoint,
                    method: 'POST',
                    headers: {
                        'Ocp-Apim-Subscription-Key': key,
                        'Content-Type': `multipart/form-data; boundary=${boundary}`,
                    },
                    body,
                    throw: false,
                }, { signal: controller.signal }));
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                if (didTimeout) return err('timeout');
                if (/abort|cancell/i.test(msg)) return err('aborted');
                return err(`network: ${msg.slice(0, 120)}`);
            }
            if (last.status === 200) {
                const json = last.json as FastTranscriptionResponse | null;
                if (!json || typeof json !== 'object') return err('malformed-response');
                return ok(json);
            }
            const info = parseAzureRateLimitHeaders(last.headers);
            logAzureRateLimitHeaders(info, 'azure-speech-stt');
            const retriable = last.status === 429 || (last.status >= 500 && last.status < 600);
            if (!retriable || attempt >= SPEECH_MAX_RETRIES - 1) {
                return err(`http-${last.status}: ${(last.text ?? '').slice(0, 200)}`);
            }
            await abortableSleep(computeAzureBackoffMs(info, attempt), controller.signal);
        }
        return err(`http-${last?.status ?? 0}`);
    } finally {
        clearTimeout(timer);
        if (args.signal) args.signal.removeEventListener('abort', onParentAbort);
    }
}

/**
 * Build auth headers for the transcription provider.
 * Azure OpenAI uses the `api-key` header; OpenAI/Groq use a Bearer token.
 */
function getTranscriptionAuthHeaders(options: TranscriptionOptions): Record<string, string> {
    if (options.provider === 'azure') {
        return { 'api-key': options.apiKey };
    }
    return { 'Authorization': `Bearer ${options.apiKey}` };
}

/**
 * Get the model name for the provider
 */
function getWhisperModel(provider: TranscriptionProvider): string {
    return WHISPER_MODEL[provider] || WHISPER_MODEL.openai;
}

/**
 * Build multipart form data for the API request
 */
function buildMultipartFormData(
    fileData: ArrayBuffer,
    fileName: string,
    extension: string,
    options: TranscriptionOptions,
    boundary: string
): ArrayBuffer {
    const mimeType = getAudioMimeType(extension);

    // Build the form data parts
    const parts: (string | ArrayBuffer)[] = [];

    // File part
    parts.push(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
        `Content-Type: ${mimeType}\r\n\r\n`
    );
    parts.push(fileData);
    parts.push('\r\n');

    // Model part — OMITTED for Azure: the deployment encoded in the URL is the
    // authoritative model selector, and a static `model` field conflicts with
    // deployment-scoped semantics. openai/groq still require it.
    if (options.provider !== 'azure') {
        const model = getWhisperModel(options.provider);
        parts.push(
            `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="model"\r\n\r\n` +
            `${model}\r\n`
        );
    }

    // Response format — verbose_json provides timestamps + quality signals (Phase 4b TRA)
    parts.push(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="response_format"\r\n\r\n` +
        `verbose_json\r\n`
    );

    // Language (optional)
    if (options.language) {
        parts.push(
            `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="language"\r\n\r\n` +
            `${options.language}\r\n`
        );
    }

    // Prompt (optional) - helps with accuracy
    if (options.prompt) {
        parts.push(
            `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="prompt"\r\n\r\n` +
            `${options.prompt}\r\n`
        );
    }

    // End boundary
    parts.push(`--${boundary}--\r\n`);

    // Combine all parts into a single ArrayBuffer
    return combineArrayBuffers(parts);
}


/**
 * Combine strings and ArrayBuffers into a single ArrayBuffer
 */
function combineArrayBuffers(parts: (string | ArrayBuffer)[]): ArrayBuffer {
    const encoder = new TextEncoder();

    // Calculate total size
    let totalSize = 0;
    const encodedParts: ArrayBuffer[] = [];

    for (const part of parts) {
        if (typeof part === 'string') {
            const encoded = encoder.encode(part);
            // Exact-slice for safety (TextEncoder usually returns exact-sized buffers, but spec doesn't guarantee it)
            encodedParts.push(encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength));
            totalSize += encoded.byteLength;
        } else {
            encodedParts.push(part);
            totalSize += part.byteLength;
        }
    }

    // Combine into single buffer
    const result = new Uint8Array(totalSize);
    let offset = 0;

    for (const buffer of encodedParts) {
        result.set(new Uint8Array(buffer), offset);
        offset += buffer.byteLength;
    }

    return result.buffer;
}

/**
 * Transcribe external audio file (outside vault)
 */
export async function transcribeExternalAudio(
    filePath: string,
    options: TranscriptionOptions
): Promise<TranscriptionResult> {
    try {
        // Use Node.js fs to read external file (desktop-only)
        const fsMod = getFs();
        const pathMod = getPath();
        if (!fsMod || !pathMod) {
            return {
                success: false,
                error: 'External audio transcription requires desktop Obsidian'
            };
        }
        const fs = fsMod.promises;
        const path = pathMod;

        // Normalize the file path
        let normalizedPath = filePath;
        if (filePath.startsWith('file://')) {
            try {
                const url = new URL(filePath);
                normalizedPath = decodeURIComponent(url.pathname);
                if (process.platform === 'win32' && normalizedPath.startsWith('/')) {
                    normalizedPath = normalizedPath.slice(1);
                }
            } catch {
                // Keep original path
            }
        }
        normalizedPath = path.normalize(normalizedPath);

        // Read the file
        const data = await fs.readFile(normalizedPath);
        const arrayBuffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
        const fileSize = arrayBuffer.byteLength;

        // Check file size
        if (!isFileSizeValid(fileSize)) {
            return {
                success: false,
                error: `File size (${formatFileSize(fileSize)}) exceeds ${MAX_FILE_SIZE_MB}MB limit. Please compress the audio file first.`
            };
        }

        // Get the file extension and name
        const fileName = path.basename(normalizedPath);
        const extension = path.extname(normalizedPath).slice(1).toLowerCase();

        // Get the appropriate endpoint and prepare the request
        const endpoint = getWhisperEndpoint(options);

        // Create form data manually for Obsidian's requestUrl
        const boundary = '----FormBoundary' + Math.random().toString(36).substring(2);
        const formData = buildMultipartFormData(
            arrayBuffer,
            fileName,
            extension,
            options,
            boundary
        );

        // Make the API request (Azure-paced when the endpoint is an Azure host;
        // `throw:false` so the pacer can read a 429 status and retry).
        const response = await pacedWhisperRequest(endpoint, {
            url: endpoint,
            method: 'POST',
            headers: {
                ...getTranscriptionAuthHeaders(options),
                'Content-Type': `multipart/form-data; boundary=${boundary}`
            },
            body: formData,
            throw: false
        });

        if (response.status !== 200) {
            const errorText = typeof response.json === 'object'
                ? JSON.stringify(response.json)
                : response.text;
            return {
                success: false,
                error: `API error (${response.status}): ${errorText}`
            };
        }

        const result = response.json;

        return {
            success: true,
            transcript: result.text,
            duration: result.duration,
            segments: parseWhisperSegments(result.segments),
            language: typeof result.language === 'string' ? result.language : undefined,
        };

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        if (errorMessage.includes('ENOENT')) {
            return {
                success: false,
                error: 'File not found. Please ensure the file exists and is accessible.'
            };
        }
        return {
            success: false,
            error: `Transcription failed: ${errorMessage}`
        };
    }
}

/**
 * Check if a provider is available based on settings
 */
export function getAvailableTranscriptionProvider(
    cloudServiceType: string,
    apiKey: string
): TranscriptionProvider | null {
    // Check if current cloud provider supports Whisper
    if (cloudServiceType === 'openai' && apiKey) {
        return 'openai';
    }
    if (cloudServiceType === 'groq' && apiKey) {
        return 'groq';
    }

    // No compatible provider available
    return null;
}

/**
 * Parse Whisper verbose_json segments into typed WhisperSegment array.
 * Gracefully handles missing/malformed segment data (returns undefined).
 */
export function parseWhisperSegments(rawSegments: unknown): WhisperSegment[] | undefined {
    if (!Array.isArray(rawSegments) || rawSegments.length === 0) return undefined;

    const parsed: WhisperSegment[] = [];
    for (const seg of rawSegments) {
        if (typeof seg !== 'object' || seg === null) continue;
        const s = seg as Record<string, unknown>;
        parsed.push({
            id: typeof s.id === 'number' ? s.id : parsed.length,
            start: typeof s.start === 'number' ? s.start : 0,
            end: typeof s.end === 'number' ? s.end : 0,
            text: typeof s.text === 'string' ? s.text : '',
            no_speech_prob: typeof s.no_speech_prob === 'number' ? s.no_speech_prob : 0,
            compression_ratio: typeof s.compression_ratio === 'number' ? s.compression_ratio : 1,
            avg_logprob: typeof s.avg_logprob === 'number' ? s.avg_logprob : undefined,
            temperature: typeof s.temperature === 'number' ? s.temperature : undefined,
        });
    }

    return parsed.length > 0 ? parsed : undefined;
}

// ============================================================================
// CHUNKED TRANSCRIPTION FOR VERY LONG FILES
// ============================================================================

import {
    ChunkInfo,
    cleanupChunks,
    needsChunking,
    compressAudio,
    compressAndChunkAudio,
    CompressionProgress,
    ChunkProgress
} from './audioCompressionService';

export interface ChunkedTranscriptionProgress {
    currentChunk: number;
    totalChunks: number;
    globalPercent: number;  // Overall progress across all chunks (0-100)
    message: string;
}

export type ChunkedTranscriptionCallback = (progress: ChunkedTranscriptionProgress) => void;

/**
 * Transcribe multiple audio chunks sequentially with context chaining
 * Uses the "prompt" parameter to maintain context across chunk boundaries
 *
 * Progress formula: globalPercent = ((currentChunkIndex + chunkProgress) / totalChunks) * 100
 * Where chunkProgress is 0 at start of chunk, 0.5 while uploading, 1 when complete
 */
export async function transcribeChunkedAudio(
    chunks: ChunkInfo[],
    options: TranscriptionOptions,
    onProgress?: ChunkedTranscriptionCallback
): Promise<TranscriptionResult> {
    if (chunks.length === 0) {
        return { success: false, error: 'No audio chunks provided' };
    }

    const transcripts: string[] = [];
    const warnings: string[] = [];
    let totalDuration = 0;
    const totalChunks = chunks.length;

    // When overlap stitching is active, disable Whisper context chaining.
    // Overlap handles boundary continuity; context prompting is redundant
    // and risks duplication (Design Decision #7 in tra-plan.md).
    const useOverlapStitching = SEGMENT_OVERLAP_SECONDS > 0;

    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];

        // Report starting this chunk (chunkProgress = 0)
        const startPercent = (i / totalChunks) * 100;
        onProgress?.({
            currentChunk: i + 1,
            totalChunks,
            globalPercent: Math.round(startPercent),
            message: `Transcribing chunk ${i + 1}/${totalChunks}...`
        });

        try {
            // Read chunk file (desktop-only: fs available in Electron)
            const fsMod = getFs();
            if (!fsMod) {
                return { success: false, error: 'Chunked transcription requires desktop Obsidian' };
            }
            const audioBuffer = fsMod.readFileSync(chunk.path);
            const audioData = new Uint8Array(audioBuffer);

            // Report uploading (chunkProgress = 0.5)
            const uploadPercent = ((i + 0.5) / totalChunks) * 100;
            onProgress?.({
                currentChunk: i + 1,
                totalChunks,
                globalPercent: Math.round(uploadPercent),
                message: `Uploading chunk ${i + 1}/${totalChunks}...`
            });

            // When overlap is active, use base prompt only (no context chaining).
            // When overlap is NOT active, chain context from previous transcript.
            let chunkPrompt = options.prompt || '';
            if (!useOverlapStitching && transcripts.length > 0) {
                // Use tail of previous transcript as context for Whisper
                const prev = transcripts[transcripts.length - 1];
                const tail = prev.length > 250 ? prev.substring(prev.length - 250) : prev;
                chunkPrompt = tail.trim();
            }
            const chunkOptions: TranscriptionOptions = {
                ...options,
                prompt: chunkPrompt
            };

            // Transcribe this chunk
            let result = await transcribeAudioFromData(
                audioData,
                `chunk_${String(i).padStart(3, '0')}.mp3`,
                chunkOptions
            );

            if (!result.success || !result.transcript) {
                return {
                    success: false,
                    error: `Failed to transcribe chunk ${i + 1}: ${result.error || 'Unknown error'}`
                };
            }

            // Quality gate: validate chunk for repetition loops
            let quality = validateChunkQuality(
                result.transcript,
                i,
                chunk.duration
            );

            if (quality.hasRepetitionLoop) {
                // Deterministic retry: re-transcribe once with shifted context.
                // Use context from previously transcribed chunks (if any) to give
                // Whisper a different prompt, which often breaks repetition loops.
                onProgress?.({
                    currentChunk: i + 1,
                    totalChunks,
                    globalPercent: Math.round(uploadPercent),
                    message: `Retrying chunk ${i + 1}/${totalChunks} (corruption detected)...`
                });

                // Build shifted prompt: use tail of already-transcribed text
                let shiftedPrompt = options.prompt || '';
                if (transcripts.length > 0) {
                    const lastTranscript = transcripts[transcripts.length - 1];
                    // Use chars from -500 to -250 (not the very end) for variety
                    const end = lastTranscript.length;
                    if (end > 500) {
                        shiftedPrompt = lastTranscript.substring(end - 500, end - 250).trim();
                    } else if (end > 250) {
                        shiftedPrompt = lastTranscript.substring(0, end - 250).trim();
                    } else {
                        shiftedPrompt = lastTranscript.trim();
                    }
                    // Whisper prompt has a ~224 token / ~250 char practical limit
                    if (shiftedPrompt.length > 250) {
                        shiftedPrompt = shiftedPrompt.substring(shiftedPrompt.length - 250);
                    }
                }

                const retryOptions: TranscriptionOptions = {
                    ...options,
                    prompt: shiftedPrompt
                };

                const retryResult = await transcribeAudioFromData(
                    audioData,
                    `chunk_${String(i).padStart(3, '0')}.mp3`,
                    retryOptions
                );

                if (retryResult.success && retryResult.transcript) {
                    const retryQuality = validateChunkQuality(retryResult.transcript, i, chunk.duration);
                    if (!retryQuality.hasRepetitionLoop) {
                        // Retry succeeded — use the clean transcript and its quality
                        result = retryResult;
                        quality = retryQuality;
                    } else {
                        // Still corrupt after retry — skip this chunk
                        warnings.push(`Chunk ${i + 1}: Skipped due to persistent repetition loop after retry.`);
                        if (result.duration) totalDuration += result.duration;
                        continue;
                    }
                } else {
                    // Retry failed entirely — skip chunk
                    warnings.push(`Chunk ${i + 1}: Skipped — retry failed (${retryResult.error || 'unknown error'}).`);
                    if (result.duration) totalDuration += result.duration;
                    continue;
                }
            }

            // Skip effectively empty chunks (< 5 words)
            if (quality.wordCount < 5) {
                warnings.push(`Chunk ${i + 1}: Skipped — effectively empty (${quality.wordCount} words).`);
                if (result.duration) totalDuration += result.duration;
                continue;
            }

            // Warn on low words-per-minute (but don't skip — may be legitimate pauses)
            if (quality.wordsPerMinute != null && quality.wordsPerMinute < 40) {
                warnings.push(`Chunk ${i + 1}: Low word rate (${quality.wordsPerMinute} wpm) — some content may be missing.`);
            }

            // Add to transcripts (transcript guaranteed non-null after success check above)
            transcripts.push(result.transcript!.trim());

            // Track duration
            if (result.duration) {
                totalDuration += result.duration;
            }

            // Report chunk complete (chunkProgress = 1)
            const completePercent = ((i + 1) / totalChunks) * 100;
            onProgress?.({
                currentChunk: i + 1,
                totalChunks,
                globalPercent: Math.round(completePercent),
                message: `Completed chunk ${i + 1}/${totalChunks}`
            });

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            return {
                success: false,
                error: `Error reading chunk ${i + 1}: ${errorMessage}`
            };
        }
    }

    // Combine transcripts: use overlap stitching if overlap is active, else space join
    const fullTranscript = useOverlapStitching
        ? stitchOverlappingTranscripts(transcripts, SEGMENT_OVERLAP_SECONDS)
        : transcripts.join(' ');

    return {
        success: true,
        transcript: fullTranscript,
        duration: totalDuration > 0 ? totalDuration : undefined,
        warnings: warnings.length > 0 ? warnings : undefined
    };
}

/**
 * Higher-level function to handle the complete chunked transcription workflow
 * Includes cleanup of temporary files
 */
export async function transcribeChunkedAudioWithCleanup(
    chunks: ChunkInfo[],
    outputDir: string,
    options: TranscriptionOptions,
    onProgress?: ChunkedTranscriptionCallback
): Promise<TranscriptionResult> {
    try {
        const result = await transcribeChunkedAudio(chunks, options, onProgress);
        return result;
    } finally {
        // Always clean up temp files
        cleanupChunks(outputDir);
    }
}

// ============================================================================
// UNIFIED AUDIO TRANSCRIPTION WORKFLOW
// ============================================================================

/**
 * Progress callback for the full workflow
 */
export interface AudioWorkflowProgress {
    stage: 'checking' | 'compressing' | 'chunking' | 'transcribing' | 'done' | 'error';
    progress: number;  // 0-100
    message: string;
    currentChunk?: number;
    totalChunks?: number;
}

export type AudioWorkflowProgressCallback = (progress: AudioWorkflowProgress) => void;

/**
 * Unified audio transcription workflow that handles all file sizes and durations.
 *
 * This function encapsulates the complete audio transcription workflow:
 * 1. CHUNKED PATH: For long audio (>20 minutes) - compresses and splits into chunks
 * 2. COMPRESSION PATH: For large files (>25MB but <20 minutes) - compresses first
 * 3. DIRECT PATH: For small files (<25MB and <20 minutes) - transcribes directly
 *
 * Use this function for any audio transcription to ensure consistent handling
 * across all file sizes and durations.
 *
 * @param app Obsidian App instance
 * @param file Audio file to transcribe
 * @param options Transcription options (provider, API key, language, prompt)
 * @param onProgress Optional progress callback for UI updates
 * @returns Transcription result with transcript text
 */
export async function transcribeAudioWithFullWorkflow(
    app: App,
    file: TFile,
    options: TranscriptionOptions,
    onProgress?: AudioWorkflowProgressCallback
): Promise<TranscriptionResult> {
    const fileSizeBytes = file.stat.size;
    const fileSizeMB = fileSizeBytes / (1024 * 1024);

    onProgress?.({
        stage: 'checking',
        progress: 0,
        message: 'Checking audio file...'
    });

    // Check if file needs chunking (long audio > 20 minutes)
    const chunkingCheck = await needsChunking(app, file);

    if (chunkingCheck.needsChunking) {
        // CHUNKED PATH: For long audio files (20+ minutes)
        const durationMinutes = chunkingCheck.estimatedDuration
            ? Math.round(chunkingCheck.estimatedDuration / 60)
            : 'unknown';

        onProgress?.({
            stage: 'chunking',
            progress: 5,
            message: `Processing ${durationMinutes} minute audio file...`
        });

        // Step 1: Compress and split into chunks
        const chunkResult = await compressAndChunkAudio(
            app,
            file,
            (progress: ChunkProgress) => {
                if (progress.stage === 'compressing') {
                    onProgress?.({
                        stage: 'compressing',
                        progress: Math.round(5 + progress.progress * 0.3),
                        message: progress.message
                    });
                } else if (progress.stage === 'done') {
                    onProgress?.({
                        stage: 'chunking',
                        progress: 35,
                        message: progress.message
                    });
                }
            }
        );

        if (!chunkResult.success || !chunkResult.chunks || !chunkResult.outputDir) {
            return {
                success: false,
                error: `Audio processing failed: ${chunkResult.error || 'Unknown error'}`
            };
        }

        onProgress?.({
            stage: 'transcribing',
            progress: 40,
            message: `Transcribing ${chunkResult.chunks.length} chunks...`,
            totalChunks: chunkResult.chunks.length
        });

        // Step 2: Transcribe all chunks with context chaining
        const transcriptionResult = await transcribeChunkedAudioWithCleanup(
            chunkResult.chunks,
            chunkResult.outputDir,
            options,
            (progress: ChunkedTranscriptionProgress) => {
                onProgress?.({
                    stage: 'transcribing',
                    progress: Math.round(40 + progress.globalPercent * 0.55),
                    message: progress.message,
                    currentChunk: progress.currentChunk,
                    totalChunks: progress.totalChunks
                });
            }
        );

        // Set duration from chunk result
        if (chunkResult.totalDuration && transcriptionResult.success) {
            transcriptionResult.duration = chunkResult.totalDuration;
        }

        if (transcriptionResult.success) {
            onProgress?.({
                stage: 'done',
                progress: 100,
                message: 'Transcription complete'
            });
        }

        return transcriptionResult;

    } else if (fileSizeBytes > MAX_FILE_SIZE_BYTES) {
        // COMPRESSION PATH: For files > 25MB but < 20 minutes
        // Compression uses FFmpeg via child_process — desktop-only. Mobile
        // users see a clear file-too-large error instead of a crash
        // (persona round 10 mobile audit — surfaced via Minutes audio-detect
        // path now being reachable on mobile).
        if (Platform.isMobile) {
            return {
                success: false,
                error: `Audio file is ${fileSizeMB.toFixed(1)}MB — exceeds 25MB Whisper limit. Mobile can't compress; use a shorter recording or transcribe on desktop.`,
            };
        }
        onProgress?.({
            stage: 'compressing',
            progress: 5,
            message: `Compressing ${fileSizeMB.toFixed(1)}MB audio file...`
        });

        const compressionResult = await compressAudio(
            app,
            file,
            (progress: CompressionProgress) => {
                if (progress.stage === 'compressing') {
                    onProgress?.({
                        stage: 'compressing',
                        progress: Math.round(5 + progress.progress * 0.4),
                        message: progress.message
                    });
                }
            }
        );

        if (!compressionResult.success || !compressionResult.data) {
            return {
                success: false,
                error: `Compression failed: ${compressionResult.error || 'Unknown error'}`
            };
        }

        onProgress?.({
            stage: 'transcribing',
            progress: 50,
            message: 'Transcribing compressed audio...'
        });

        // Transcribe the compressed audio
        const transcriptionResult = await transcribeAudioFromData(
            compressionResult.data,
            file.basename + '_compressed.mp3',
            options
        );

        // Attach compressed data for potential vault replacement (Phase 5)
        if (transcriptionResult.success && compressionResult.data) {
            transcriptionResult.compressedData = compressionResult.data;
            transcriptionResult.originalSizeBytes = fileSizeBytes;
        }

        if (transcriptionResult.success) {
            onProgress?.({
                stage: 'done',
                progress: 100,
                message: 'Transcription complete'
            });
        }

        return transcriptionResult;

    } else {
        // DIRECT PATH: For small files (< 25MB and < 20 minutes)
        onProgress?.({
            stage: 'transcribing',
            progress: 10,
            message: 'Transcribing audio...'
        });

        const transcriptionResult = await transcribeAudio(app, file, options);

        if (transcriptionResult.success) {
            onProgress?.({
                stage: 'done',
                progress: 100,
                message: 'Transcription complete'
            });
        }

        return transcriptionResult;
    }
}
