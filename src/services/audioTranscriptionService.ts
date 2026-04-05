/**
 * Audio Transcription Service
 * Handles transcription of audio files using Whisper API (OpenAI or Groq)
 */

import { App, TFile, requestUrl } from 'obsidian';
import { getFs, getPath } from '../utils/desktopRequire';
import { validateChunkQuality, stitchOverlappingTranscripts } from './transcriptQualityService';
import { SEGMENT_OVERLAP_SECONDS } from './audioCompressionService';

export type TranscriptionProvider = 'openai' | 'groq';

/**
 * Audio Transcription Provider Registry
 * Single source of truth for Whisper API endpoints and models
 */
const WHISPER_ENDPOINT: Record<TranscriptionProvider, string> = {
    openai: 'https://api.openai.com/v1/audio/transcriptions',
    groq: 'https://api.groq.com/openai/v1/audio/transcriptions'
};

const WHISPER_MODEL: Record<TranscriptionProvider, string> = {
    openai: 'whisper-1',
    groq: 'whisper-large-v3'
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
}

export interface TranscriptionOptions {
    provider: TranscriptionProvider;
    apiKey: string;
    language?: string;
    prompt?: string;
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
 * Get MIME type for audio file
 */
function getAudioMimeType(extension: string): string {
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
        // Read the file as binary
        const arrayBuffer = await app.vault.readBinary(file);
        const fileSize = arrayBuffer.byteLength;

        // Check file size
        if (!isFileSizeValid(fileSize)) {
            return {
                success: false,
                error: `File size (${formatFileSize(fileSize)}) exceeds ${MAX_FILE_SIZE_MB}MB limit. Please compress the audio file first.`
            };
        }

        // Get the appropriate endpoint and prepare the request
        const endpoint = getWhisperEndpoint(options.provider);

        // Create form data manually for Obsidian's requestUrl
        const boundary = '----FormBoundary' + Math.random().toString(36).substring(2);
        const formData = buildMultipartFormData(
            arrayBuffer,
            file.name,
            file.extension,
            options,
            boundary
        );

        // Make the API request with 10 minute timeout
        // (Whisper API typically returns within 1-2 minutes for 25MB files)
        const timeoutMs = 600000; // 10 minutes

        const timeoutPromise = new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error('Transcription request timeout (10 minutes)')), timeoutMs);
        });

        const requestPromise = requestUrl({
            url: endpoint,
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${options.apiKey}`,
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
        // Check file size
        if (!isFileSizeValid(audioData.byteLength)) {
            return {
                success: false,
                error: `File size (${formatFileSize(audioData.byteLength)}) exceeds ${MAX_FILE_SIZE_MB}MB limit.`
            };
        }

        // Get the appropriate endpoint and prepare the request
        const endpoint = getWhisperEndpoint(options.provider);

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

        const requestPromise = requestUrl({
            url: endpoint,
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${options.apiKey}`,
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
 * Get the Whisper API endpoint for the provider
 */
function getWhisperEndpoint(provider: TranscriptionProvider): string {
    return WHISPER_ENDPOINT[provider] || WHISPER_ENDPOINT.openai;
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
    const model = getWhisperModel(options.provider);

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

    // Model part
    parts.push(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="model"\r\n\r\n` +
        `${model}\r\n`
    );

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
        const endpoint = getWhisperEndpoint(options.provider);

        // Create form data manually for Obsidian's requestUrl
        const boundary = '----FormBoundary' + Math.random().toString(36).substring(2);
        const formData = buildMultipartFormData(
            arrayBuffer,
            fileName,
            extension,
            options,
            boundary
        );

        // Make the API request
        const response = await requestUrl({
            url: endpoint,
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${options.apiKey}`,
                'Content-Type': `multipart/form-data; boundary=${boundary}`
            },
            body: formData
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
