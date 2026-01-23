/**
 * Audio Compression Service
 * Uses native FFmpeg via Node.js child_process for reliable compression
 *
 * Flow:
 * 1. Write audio file to temp location
 * 2. Run FFmpeg to compress to mono 16kHz MP3
 * 3. Read compressed file back
 * 4. Clean up temp files
 */

import { App, TFile, Platform } from 'obsidian';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { MAX_FILE_SIZE_BYTES, formatFileSize } from './audioTranscriptionService';

// Target size after compression (20MB to have margin under 25MB limit)
const TARGET_SIZE_BYTES = 20 * 1024 * 1024;

export interface CompressionProgress {
    stage: 'loading' | 'decoding' | 'compressing' | 'done' | 'error';
    progress: number; // 0-100
    message: string;
}

export interface CompressionResult {
    success: boolean;
    data?: Uint8Array;
    outputSize?: number;
    error?: string;
}

export type ProgressCallback = (progress: CompressionProgress) => void;

/**
 * Find FFmpeg binary path
 * Checks common installation locations
 */
function findFFmpegPath(): string | null {
    // Check if ffmpeg is in PATH
    const ffmpegCmd = Platform.isWin ? 'ffmpeg.exe' : 'ffmpeg';

    // Common installation paths
    const commonPaths = Platform.isWin ? [
        String.raw`C:\ffmpeg\bin\ffmpeg.exe`,
        String.raw`C:\Program Files\ffmpeg\bin\ffmpeg.exe`,
        String.raw`C:\Program Files (x86)\ffmpeg\bin\ffmpeg.exe`,
        path.join(os.homedir(), 'ffmpeg', 'bin', 'ffmpeg.exe'),
        path.join(os.homedir(), 'scoop', 'shims', 'ffmpeg.exe'),
    ] : [
        '/usr/bin/ffmpeg',
        '/usr/local/bin/ffmpeg',
        '/opt/homebrew/bin/ffmpeg',
        path.join(os.homedir(), '.local', 'bin', 'ffmpeg'),
    ];

    // Check common paths first
    for (const ffmpegPath of commonPaths) {
        try {
            if (fs.existsSync(ffmpegPath)) {
                return ffmpegPath;
            }
        } catch {
            // Ignore access errors
        }
    }

    // Return just the command name - will rely on PATH
    return ffmpegCmd;
}

/**
 * Check if FFmpeg is available
 */
export async function isFFmpegAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
        const ffmpegPath = findFFmpegPath();
        if (!ffmpegPath) {
            resolve(false);
            return;
        }

        try {
            const proc = spawn(ffmpegPath, ['-version'], {
                windowsHide: true,
                stdio: ['ignore', 'pipe', 'pipe']
            });

            proc.on('error', () => resolve(false));
            proc.on('close', (code) => resolve(code === 0));

            // Timeout after 5 seconds
            setTimeout(() => {
                proc.kill();
                resolve(false);
            }, 5000);
        } catch {
            resolve(false);
        }
    });
}

/**
 * Calculate target bitrate based on duration and target size
 */
function calculateBitrate(durationSeconds: number, targetSizeBytes: number): number {
    // bitrate (kbps) = (fileSize in bytes * 8) / (duration in seconds * 1000)
    const calculatedBitrate = Math.floor((targetSizeBytes * 8) / (durationSeconds * 1000));
    // Clamp between 24 and 96 kbps for speech
    return Math.max(24, Math.min(96, calculatedBitrate));
}

/**
 * Get audio duration using FFprobe
 */
async function getAudioDuration(inputPath: string): Promise<number> {
    return new Promise((resolve, reject) => {
        const ffprobePath = findFFmpegPath()?.replace('ffmpeg', 'ffprobe') || 'ffprobe';

        const proc = spawn(ffprobePath, [
            '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            inputPath
        ], {
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe']
        });

        let stdout = '';
        proc.stdout.on('data', (data) => { stdout += data.toString(); });

        proc.on('error', (err) => reject(err));
        proc.on('close', (code) => {
            if (code === 0) {
                const duration = Number.parseFloat(stdout.trim());
                if (Number.isNaN(duration)) {
                    // Default estimate: 1 minute per 1MB (rough estimate for audio)
                    reject(new Error('Could not parse duration'));
                } else {
                    resolve(duration);
                }
            } else {
                reject(new Error(`FFprobe exited with code ${code}`));
            }
        });

        setTimeout(() => {
            proc.kill();
            reject(new Error('FFprobe timeout'));
        }, 30000);
    });
}

/**
 * Compress audio using native FFmpeg
 */
async function compressWithFFmpeg(
    inputPath: string,
    outputPath: string,
    bitrate: number,
    onProgress?: (percent: number) => void
): Promise<void> {
    return new Promise((resolve, reject) => {
        const ffmpegPath = findFFmpegPath();
        if (!ffmpegPath) {
            reject(new Error('FFmpeg not found'));
            return;
        }

        const args = [
            '-i', inputPath,
            '-ac', '1',                    // Mono
            '-ar', '16000',                // 16kHz sample rate (optimal for speech/Whisper)
            '-b:a', `${bitrate}k`,         // Target bitrate
            '-codec:a', 'libmp3lame',      // Use MP3 encoder
            '-q:a', '9',                   // Quality setting (9 = smallest)
            '-progress', 'pipe:1',         // Output progress to stdout
            '-y',                          // Overwrite output
            outputPath
        ];

        const proc = spawn(ffmpegPath, args, {
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe']
        });

        let duration = 0;

        // Parse progress from stdout
        proc.stdout.on('data', (data) => {
            const lines = data.toString().split('\n');
            for (const line of lines) {
                if (line.startsWith('out_time_ms=')) {
                    const timeMs = Number.parseInt(line.split('=')[1], 10);
                    if (!Number.isNaN(timeMs) && duration > 0 && onProgress) {
                        const percent = Math.min(100, (timeMs / 1000000) / duration * 100);
                        onProgress(percent);
                    }
                }
                if (line.startsWith('duration=')) {
                    const parsed = Number.parseFloat(line.split('=')[1]);
                    if (!Number.isNaN(parsed)) duration = parsed;
                }
            }
        });

        proc.on('error', (err) => {
            reject(new Error(`FFmpeg failed to start: ${err.message}`));
        });

        proc.on('close', (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`FFmpeg exited with code ${code}`));
            }
        });

        // Timeout after 60 minutes (supports 6+ hour audio files)
        setTimeout(() => {
            proc.kill();
            reject(new Error('FFmpeg timeout (60 minutes)'));
        }, 3600000);
    });
}

/**
 * Compress an audio file to fit within the Whisper API size limit
 * Uses native FFmpeg for reliable compression
 */
export async function compressAudio(
    app: App,
    file: TFile,
    onProgress?: ProgressCallback
): Promise<CompressionResult> {
    // Check if FFmpeg is available
    const ffmpegAvailable = await isFFmpegAvailable();
    if (!ffmpegAvailable) {
        return {
            success: false,
            error: 'FFmpeg is not installed. Please install FFmpeg to compress large audio files. Visit https://ffmpeg.org/download.html'
        };
    }

    const tempDir = os.tmpdir();
    const tempId = `obsidian-audio-${Date.now()}`;
    const inputPath = path.join(tempDir, `${tempId}-input${path.extname(file.name)}`);
    const outputPath = path.join(tempDir, `${tempId}-output.mp3`);

    try {
        onProgress?.({
            stage: 'loading',
            progress: 0,
            message: 'Reading audio file...'
        });

        // Read the file as binary
        const arrayBuffer = await app.vault.readBinary(file);
        const inputSize = arrayBuffer.byteLength;

        // Write to temp file
        fs.writeFileSync(inputPath, Buffer.from(arrayBuffer));

        onProgress?.({
            stage: 'decoding',
            progress: 10,
            message: 'Analyzing audio duration...'
        });

        // Get audio duration for bitrate calculation
        let durationSeconds: number;
        try {
            durationSeconds = await getAudioDuration(inputPath);
        } catch {
            // Estimate duration from file size (rough: ~1MB per minute for typical audio)
            durationSeconds = (inputSize / (1024 * 1024)) * 60;
        }

        // Calculate target bitrate
        const targetBitrate = calculateBitrate(durationSeconds, TARGET_SIZE_BYTES);

        onProgress?.({
            stage: 'compressing',
            progress: 20,
            message: `Compressing to ${targetBitrate}kbps MP3...`
        });

        // Compress with FFmpeg
        await compressWithFFmpeg(inputPath, outputPath, targetBitrate, (percent) => {
            onProgress?.({
                stage: 'compressing',
                progress: 20 + Math.round(percent * 0.7),
                message: `Compressing: ${Math.round(percent)}%`
            });
        });

        onProgress?.({
            stage: 'compressing',
            progress: 95,
            message: 'Reading compressed file...'
        });

        // Read the compressed file
        const compressedBuffer = fs.readFileSync(outputPath);
        const outputSize = compressedBuffer.byteLength;

        // Check if output is still too large
        if (outputSize > MAX_FILE_SIZE_BYTES) {
            // Try again with lower bitrate
            const lowerBitrate = Math.max(16, Math.floor(targetBitrate * 0.5));

            onProgress?.({
                stage: 'compressing',
                progress: 50,
                message: `Re-compressing at ${lowerBitrate}kbps...`
            });

            await compressWithFFmpeg(inputPath, outputPath, lowerBitrate, (percent) => {
                onProgress?.({
                    stage: 'compressing',
                    progress: 50 + Math.round(percent * 0.4),
                    message: `Re-compressing: ${Math.round(percent)}%`
                });
            });

            const retryBuffer = fs.readFileSync(outputPath);
            const retrySize = retryBuffer.byteLength;

            if (retrySize > MAX_FILE_SIZE_BYTES) {
                return {
                    success: false,
                    error: `Could not compress below ${formatFileSize(MAX_FILE_SIZE_BYTES)}. Output size: ${formatFileSize(retrySize)}. The audio may be too long.`
                };
            }

            onProgress?.({
                stage: 'done',
                progress: 100,
                message: `Compressed: ${formatFileSize(inputSize)} → ${formatFileSize(retrySize)}`
            });

            return {
                success: true,
                data: new Uint8Array(retryBuffer),
                outputSize: retrySize
            };
        }

        onProgress?.({
            stage: 'done',
            progress: 100,
            message: `Compressed: ${formatFileSize(inputSize)} → ${formatFileSize(outputSize)}`
        });

        return {
            success: true,
            data: new Uint8Array(compressedBuffer),
            outputSize
        };

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';

        onProgress?.({
            stage: 'error',
            progress: 0,
            message: `Compression failed: ${errorMessage}`
        });

        return {
            success: false,
            error: errorMessage
        };

    } finally {
        // Clean up temp files
        try {
            if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
            if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
        } catch {
            // Ignore cleanup errors
        }
    }
}

/**
 * Check if a file needs compression
 */
export function needsCompression(fileSizeBytes: number): boolean {
    return fileSizeBytes > MAX_FILE_SIZE_BYTES;
}

/**
 * Get estimated compression ratio message
 */
export function getCompressionEstimate(fileSizeBytes: number): string {
    const estimatedOutput = Math.min(fileSizeBytes * 0.3, TARGET_SIZE_BYTES);
    return `File will be compressed from ${formatFileSize(fileSizeBytes)} to approximately ${formatFileSize(estimatedOutput)}`;
}

/**
 * Clean up resources (no-op, kept for API compatibility)
 */
export function disposeFFmpeg(): void {
    // No cleanup needed for native FFmpeg
}

// ============================================================================
// CHUNKED AUDIO PROCESSING FOR VERY LONG FILES
// ============================================================================

// Segment duration in seconds (5 minutes = safe margin under 25MB even at higher bitrates)
const SEGMENT_DURATION_SECONDS = 300;

// Maximum characters for Whisper prompt (stay under ~224 token limit)
const MAX_PROMPT_CHARS = 250;

export interface ChunkInfo {
    path: string;
    index: number;
    duration?: number;
}

export interface ChunkedCompressionResult {
    success: boolean;
    chunks?: ChunkInfo[];
    totalDuration?: number;
    outputDir?: string;
    error?: string;
}

export interface ChunkProgress {
    stage: 'preparing' | 'compressing' | 'splitting' | 'done' | 'error';
    progress: number;
    message: string;
    currentChunk?: number;
    totalChunks?: number;
}

export type ChunkProgressCallback = (progress: ChunkProgress) => void;

/**
 * Check if audio needs to be split into chunks
 * Rule: If duration > 20 minutes OR estimated compressed size > 20MB, use chunking
 */
export async function needsChunking(
    app: App,
    file: TFile
): Promise<{ needsChunking: boolean; estimatedDuration?: number; reason?: string }> {
    const ffmpegAvailable = await isFFmpegAvailable();
    if (!ffmpegAvailable) {
        return { needsChunking: false, reason: 'FFmpeg not available' };
    }

    const tempDir = os.tmpdir();
    const tempId = `obsidian-audio-check-${Date.now()}`;
    const inputPath = path.join(tempDir, `${tempId}${path.extname(file.name)}`);

    try {
        // Write temp file to check duration
        const arrayBuffer = await app.vault.readBinary(file);
        fs.writeFileSync(inputPath, Buffer.from(arrayBuffer));

        const duration = await getAudioDuration(inputPath);

        // If duration > 20 minutes, recommend chunking
        if (duration > 1200) {
            return {
                needsChunking: true,
                estimatedDuration: duration,
                reason: `Audio is ${Math.round(duration / 60)} minutes long`
            };
        }

        // Estimate compressed size: 32kbps mono = ~240KB per minute
        const estimatedCompressedSize = (duration / 60) * 240 * 1024;
        if (estimatedCompressedSize > TARGET_SIZE_BYTES) {
            return {
                needsChunking: true,
                estimatedDuration: duration,
                reason: `Estimated compressed size exceeds ${formatFileSize(TARGET_SIZE_BYTES)}`
            };
        }

        return { needsChunking: false, estimatedDuration: duration };

    } catch (error) {
        // If we can't determine duration, fall back to file size heuristic
        const fileSize = file.stat.size;
        // If file is > 100MB, likely needs chunking
        if (fileSize > 100 * 1024 * 1024) {
            return {
                needsChunking: true,
                reason: `File size (${formatFileSize(fileSize)}) suggests long duration`
            };
        }
        return { needsChunking: false };
    } finally {
        try {
            if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
        } catch {
            // Cleanup errors are non-critical, ignore them
        }
    }
}

/**
 * Compress and split audio into chunks for transcription
 * Uses a SINGLE FFmpeg pass to compress AND segment simultaneously
 * This eliminates the intermediate file and cuts disk I/O in half
 */
export async function compressAndChunkAudio(
    app: App,
    file: TFile,
    onProgress?: ChunkProgressCallback
): Promise<ChunkedCompressionResult> {
    const ffmpegAvailable = await isFFmpegAvailable();
    if (!ffmpegAvailable) {
        return {
            success: false,
            error: 'FFmpeg is not installed. Please install FFmpeg to process large audio files.'
        };
    }

    const tempDir = os.tmpdir();
    const tempId = `obsidian-audio-chunk-${Date.now()}`;
    const workDir = path.join(tempDir, tempId);
    const inputPath = path.join(workDir, `input${path.extname(file.name)}`);
    const chunkPattern = path.join(workDir, 'chunk_%03d.mp3');

    try {
        // Create work directory
        fs.mkdirSync(workDir, { recursive: true });

        onProgress?.({
            stage: 'preparing',
            progress: 0,
            message: 'Reading audio file...'
        });

        // Read and write input file
        const arrayBuffer = await app.vault.readBinary(file);
        fs.writeFileSync(inputPath, Buffer.from(arrayBuffer));

        onProgress?.({
            stage: 'preparing',
            progress: 10,
            message: 'Analyzing audio...'
        });

        // Get duration for progress calculation
        let duration: number;
        try {
            duration = await getAudioDuration(inputPath);
        } catch {
            duration = (arrayBuffer.byteLength / (1024 * 1024)) * 60; // Estimate
        }

        const estimatedChunks = Math.ceil(duration / SEGMENT_DURATION_SECONDS);

        onProgress?.({
            stage: 'compressing',
            progress: 15,
            message: `Processing ${Math.round(duration / 60)} minutes into ~${estimatedChunks} chunks...`
        });

        // ONE-PASS: Compress AND segment simultaneously
        // This is much faster than compress-then-split as it avoids intermediate file I/O
        await compressAndSplitOnePass(inputPath, chunkPattern, duration, (percent) => {
            onProgress?.({
                stage: 'compressing',
                progress: 15 + Math.round(percent * 0.8),
                message: `Processing: ${Math.round(percent)}%`
            });
        });

        // Collect chunk files
        const chunkFiles = fs.readdirSync(workDir)
            .filter(f => f.startsWith('chunk_') && f.endsWith('.mp3'))
            .sort((a, b) => a.localeCompare(b))
            .map((f, index) => ({
                path: path.join(workDir, f),
                index
            }));

        if (chunkFiles.length === 0) {
            throw new Error('No audio chunks were created');
        }

        // Clean up input file (chunks are the only files we need)
        try {
            if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
        } catch {
            // Non-critical cleanup error
        }

        onProgress?.({
            stage: 'done',
            progress: 100,
            message: `Created ${chunkFiles.length} chunks`,
            totalChunks: chunkFiles.length
        });

        return {
            success: true,
            chunks: chunkFiles,
            totalDuration: duration,
            outputDir: workDir
        };

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';

        onProgress?.({
            stage: 'error',
            progress: 0,
            message: `Chunking failed: ${errorMessage}`
        });

        // Clean up on error
        try {
            if (fs.existsSync(workDir)) {
                fs.rmSync(workDir, { recursive: true, force: true });
            }
        } catch {
            // Non-critical cleanup error
        }

        return {
            success: false,
            error: errorMessage
        };
    }
}

/**
 * ONE-PASS compress and split: compress AND segment audio in a single FFmpeg invocation
 * This eliminates intermediate file I/O and significantly speeds up processing
 *
 * Command equivalent:
 * ffmpeg -i input.wav -ac 1 -ar 16000 -b:a 32k -f segment -segment_time 300 output_%03d.mp3
 */
async function compressAndSplitOnePass(
    inputPath: string,
    outputPattern: string,
    estimatedDuration: number,
    onProgress?: (percent: number) => void
): Promise<void> {
    return new Promise((resolve, reject) => {
        const ffmpegPath = findFFmpegPath();
        if (!ffmpegPath) {
            reject(new Error('FFmpeg not found'));
            return;
        }

        const args = [
            '-i', inputPath,
            '-map', '0:a',                 // Only audio stream
            '-ac', '1',                    // Mono
            '-ar', '16000',                // 16kHz (optimal for Whisper)
            '-b:a', '32k',                 // 32kbps (good for speech)
            '-codec:a', 'libmp3lame',      // MP3 encoder
            '-f', 'segment',               // Segment muxer
            '-segment_time', String(SEGMENT_DURATION_SECONDS),
            '-reset_timestamps', '1',      // Reset timestamps for each chunk
            '-progress', 'pipe:1',         // Output progress to stdout
            '-y',                          // Overwrite output
            outputPattern
        ];

        const proc = spawn(ffmpegPath, args, {
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe']
        });

        // Track progress based on output time
        proc.stdout.on('data', (data) => {
            const lines = data.toString().split('\n');
            for (const line of lines) {
                if (line.startsWith('out_time_ms=')) {
                    const timeMs = Number.parseInt(line.split('=')[1], 10);
                    if (!Number.isNaN(timeMs) && estimatedDuration > 0 && onProgress) {
                        const percent = Math.min(100, (timeMs / 1000000) / estimatedDuration * 100);
                        onProgress(percent);
                    }
                }
            }
        });

        proc.on('error', (err) => reject(new Error(`FFmpeg error: ${err.message}`)));
        proc.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`FFmpeg exited with code ${code}`));
        });

        // 2 hour timeout for very long files (supports 6+ hour recordings)
        setTimeout(() => {
            proc.kill();
            reject(new Error('FFmpeg compress+split timeout'));
        }, 7200000);
    });
}

/**
 * Clean up chunk files after transcription
 */
export function cleanupChunks(outputDir: string): void {
    try {
        if (fs.existsSync(outputDir)) {
            fs.rmSync(outputDir, { recursive: true, force: true });
        }
    } catch {
        // Ignore cleanup errors
    }
}

/**
 * Clean up orphaned chunk directories from previous sessions
 * Call this on plugin startup to remove any temp files left behind
 * from crashes or interrupted transcriptions
 */
export function cleanupOrphanedChunks(): { cleaned: number; errors: number } {
    const tempDir = os.tmpdir();
    let cleaned = 0;
    let errors = 0;

    try {
        const entries = fs.readdirSync(tempDir, { withFileTypes: true });

        for (const entry of entries) {
            // Look for our temp directories
            if (entry.isDirectory() && entry.name.startsWith('obsidian-audio-chunk-')) {
                const dirPath = path.join(tempDir, entry.name);

                try {
                    // Check if directory is old (more than 1 hour)
                    // This avoids cleaning up an active transcription
                    const stats = fs.statSync(dirPath);
                    const ageMs = Date.now() - stats.mtimeMs;
                    const oneHourMs = 60 * 60 * 1000;

                    if (ageMs > oneHourMs) {
                        fs.rmSync(dirPath, { recursive: true, force: true });
                        cleaned++;
                    }
                } catch {
                    errors++;
                }
            }
        }
    } catch {
        // Failed to read temp directory - non-critical
    }

    return { cleaned, errors };
}

/**
 * Get the prompt context for the next chunk (last ~250 chars of previous transcript)
 * This helps Whisper maintain context across chunk boundaries
 *
 * IMPORTANT: Keep trailing fragments! Whisper's prompt parameter guides acoustic
 * pronunciation and style, not semantic completion. An incomplete sentence like
 * "and then the" helps Whisper correctly recognize words that might span chunk
 * boundaries. Stripping to sentence boundaries loses this benefit.
 */
export function getChunkPromptContext(previousTranscript: string): string {
    if (!previousTranscript || previousTranscript.length === 0) {
        return '';
    }

    // Simply take the last ~250 chars - keep trailing fragments for word continuity
    const context = previousTranscript.slice(-MAX_PROMPT_CHARS);

    // Try to start at a word boundary (avoid mid-word cuts)
    const firstSpace = context.indexOf(' ');
    if (firstSpace > 0 && firstSpace < 30) {
        // If we're cutting mid-word at the start, trim to the first word boundary
        return context.slice(firstSpace + 1).trim();
    }

    return context.trim();
}
