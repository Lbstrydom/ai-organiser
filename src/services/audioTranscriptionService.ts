/**
 * Audio Transcription Service
 * Handles transcription of audio files using Whisper API (OpenAI or Groq)
 */

import { App, TFile, requestUrl } from 'obsidian';

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

export interface TranscriptionResult {
    success: boolean;
    transcript?: string;
    error?: string;
    duration?: number;
}

export interface TranscriptionOptions {
    provider: TranscriptionProvider;
    apiKey: string;
    language?: string;
    prompt?: string;
}

// Supported audio formats for Whisper API
export const SUPPORTED_AUDIO_FORMATS = [
    'mp3', 'mp4', 'm4a', 'wav', 'webm', 'mpeg', 'mpga', 'oga', 'ogg'
];

// Maximum file size (25MB for both OpenAI and Groq)
export const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024;
export const MAX_FILE_SIZE_MB = 25;

/**
 * Check if a file is a supported audio format
 */
export function isAudioFile(file: TFile): boolean {
    const ext = file.extension.toLowerCase();
    return SUPPORTED_AUDIO_FORMATS.includes(ext);
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
            duration: result.duration
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
        const formData = buildMultipartFormData(
            audioData.buffer as ArrayBuffer,
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
            duration: result.duration
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

    // Response format
    parts.push(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="response_format"\r\n\r\n` +
        `json\r\n`
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
            encodedParts.push(encoded.buffer);
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
        // Use Node.js fs to read external file
        const { promises: fs } = require('fs');
        const path = require('path');

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
        const { requestUrl } = require('obsidian');
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
            duration: result.duration
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

// ============================================================================
// CHUNKED TRANSCRIPTION FOR VERY LONG FILES
// ============================================================================

import * as fs from 'fs';
import {
    ChunkInfo,
    getChunkPromptContext,
    cleanupChunks
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
    let previousContext = '';
    let totalDuration = 0;
    const totalChunks = chunks.length;

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
            // Read chunk file
            const audioBuffer = fs.readFileSync(chunk.path);
            const audioData = new Uint8Array(audioBuffer);

            // Report uploading (chunkProgress = 0.5)
            const uploadPercent = ((i + 0.5) / totalChunks) * 100;
            onProgress?.({
                currentChunk: i + 1,
                totalChunks,
                globalPercent: Math.round(uploadPercent),
                message: `Uploading chunk ${i + 1}/${totalChunks}...`
            });

            // Create options with context from previous chunk
            const chunkOptions: TranscriptionOptions = {
                ...options,
                // Use previous transcript context as prompt for continuity
                prompt: previousContext || options.prompt
            };

            // Transcribe this chunk
            const result = await transcribeAudioFromData(
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

            // Add to transcripts
            transcripts.push(result.transcript.trim());

            // Update context for next chunk (last ~250 chars)
            previousContext = getChunkPromptContext(result.transcript);

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

    // Combine all transcripts with proper spacing
    const fullTranscript = transcripts.join(' ');

    return {
        success: true,
        transcript: fullTranscript,
        duration: totalDuration > 0 ? totalDuration : undefined
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
