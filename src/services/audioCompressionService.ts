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
// eslint-disable-next-line import/no-nodejs-modules -- Electron desktop-only: FFmpeg subprocess for audio compression
import { spawn } from 'child_process';
// eslint-disable-next-line import/no-nodejs-modules -- Electron desktop-only: temp file I/O for FFmpeg pipeline
import * as fs from 'fs';
// eslint-disable-next-line import/no-nodejs-modules -- Electron desktop-only: temp file path construction
import * as path from 'path';
// eslint-disable-next-line import/no-nodejs-modules -- Electron desktop-only: temp directory resolution
import * as os from 'os';
import { MAX_FILE_SIZE_BYTES, formatFileSize } from './audioTranscriptionService';
import { getAvailableFilePath } from '../utils/minutesUtils';

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
// BACKLINK-SAFE VAULT REPLACEMENT (Phase 5)
// ============================================================================

export interface AudioReplaceResult {
    newFile: TFile;
    /** Number of files currently linking to the new path after rename (not a before/after diff). */
    backlinksMigrated: number;
    oldPath: string;
    newPath: string;
}

/**
 * Replace an audio file in the vault with compressed data, preserving backlinks.
 * Uses modifyBinary + fileManager.renameFile for backlink safety.
 */
export async function replaceAudioFile(
    app: App,
    originalFile: TFile,
    compressedData: Uint8Array,
    targetExtension: string
): Promise<AudioReplaceResult> {
    const oldPath = originalFile.path;

    // 1. Write compressed bytes to the original file (exact-slice to avoid subarray corruption)
    const exactBuffer = compressedData.buffer.slice(
        compressedData.byteOffset,
        compressedData.byteOffset + compressedData.byteLength
    ) as ArrayBuffer;
    await app.vault.modifyBinary(originalFile, exactBuffer);

    // 2. If extension changed, compute collision-safe path and rename
    const oldExt = originalFile.extension.toLowerCase();
    let newPath = oldPath;

    if (targetExtension !== oldExt) {
        const dir = originalFile.parent?.path || '';
        const baseName = originalFile.basename;
        newPath = await getAvailableFilePath(
            app.vault, dir, `${baseName}.${targetExtension}`
        );
        // renameFile auto-updates all backlinks across vault
        await app.fileManager.renameFile(originalFile, newPath);
    }

    // 3. Count backlinks pointing to the (possibly renamed) file
    let backlinksMigrated = 0;
    const resolved = app.metadataCache.resolvedLinks;
    for (const sourcePath in resolved) {
        if (resolved[sourcePath]?.[newPath]) backlinksMigrated++;
    }

    const abstract = app.vault.getAbstractFileByPath(newPath);
    if (!(abstract instanceof TFile)) {
        throw new Error(`Expected TFile at ${newPath} after rename`);
    }
    return { newFile: abstract, backlinksMigrated, oldPath, newPath };
}

// ============================================================================
// CHUNKED AUDIO PROCESSING FOR VERY LONG FILES
// ============================================================================

// Segment duration in seconds (5 minutes = safe margin under 25MB even at higher bitrates)
const SEGMENT_DURATION_SECONDS = 300;

/** Overlap between consecutive audio chunks in seconds (for overlap stitching) */
export const SEGMENT_OVERLAP_SECONDS = 10;

// Maximum characters for Whisper prompt (stay under ~224 token limit)

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

    } catch (_error) {
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
 * Compress and split audio into chunks for transcription.
 * Uses a TWO-PASS approach with overlap:
 *   Pass 1: Compress full audio to mono 16kHz MP3
 *   Pass 2: Extract overlapping segments with -ss/-t/-c copy
 *
 * Each chunk overlaps the next by SEGMENT_OVERLAP_SECONDS to prevent
 * content loss at boundaries. Chunk durations are probed via FFprobe
 * so downstream WPM quality checks have accurate timing data.
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

        // TWO-PASS with overlap: Compress then segment with SEGMENT_OVERLAP_SECONDS overlap
        // This ensures no content is lost at chunk boundaries during transcription
        await compressAndSplitWithOverlap(inputPath, workDir, duration, (percent) => {
            onProgress?.({
                stage: 'compressing',
                progress: 15 + Math.round(percent * 0.8),
                message: `Processing: ${Math.round(percent)}%`
            });
        });

        // Collect chunk files
        const chunkFileNames = fs.readdirSync(workDir)
            .filter(f => f.startsWith('chunk_') && f.endsWith('.mp3'))
            .sort((a, b) => a.localeCompare(b));

        if (chunkFileNames.length === 0) {
            throw new Error('No audio chunks were created');
        }

        // Probe each chunk's duration via FFprobe so WPM checks work downstream
        const durations = await getChunkDurations(workDir);

        const chunkFiles: ChunkInfo[] = chunkFileNames.map((f, index) => ({
            path: path.join(workDir, f),
            index,
            duration: durations.get(f)
        }));

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
 * Get duration of each chunk file using FFprobe.
 * Returns a map of filename → duration in seconds.
 */
export async function getChunkDurations(outputDir: string): Promise<Map<string, number>> {
    const durations = new Map<string, number>();
    const files = fs.readdirSync(outputDir)
        .filter(f => f.startsWith('chunk_') && f.endsWith('.mp3'))
        .sort();

    for (const file of files) {
        try {
            const filePath = path.join(outputDir, file);
            const duration = await getAudioDuration(filePath);
            durations.set(file, duration);
        } catch {
            // Skip files where duration can't be determined
        }
    }

    return durations;
}

/**
 * TWO-PASS compress and split with overlap: compresses audio first, then extracts
 * overlapping segments using seek-based extraction.
 *
 * FFmpeg's -f segment doesn't support overlap, so we:
 * 1. Compress full audio to a temporary mono 16kHz MP3
 * 2. Extract overlapping segments using -ss and -t flags with -c copy (no re-encode)
 *
 * Each segment is SEGMENT_DURATION_SECONDS + SEGMENT_OVERLAP_SECONDS long,
 * starting SEGMENT_DURATION_SECONDS apart (so the last SEGMENT_OVERLAP_SECONDS
 * of chunk N overlaps with the first SEGMENT_OVERLAP_SECONDS of chunk N+1).
 */
async function compressAndSplitWithOverlap(
    inputPath: string,
    outputDir: string,
    estimatedDuration: number,
    onProgress?: (percent: number) => void
): Promise<void> {
    const ffmpegPath = findFFmpegPath();
    if (!ffmpegPath) {
        throw new Error('FFmpeg not found');
    }

    // Pass 1: Compress full audio to temp MP3
    const tempCompressed = path.join(outputDir, '_temp_compressed.mp3');
    await new Promise<void>((resolve, reject) => {
        const args = [
            '-i', inputPath,
            '-map', '0:a',
            '-ac', '1',
            '-ar', '16000',
            '-b:a', '32k',
            '-codec:a', 'libmp3lame',
            '-progress', 'pipe:1',
            '-y',
            tempCompressed
        ];

        const proc = spawn(ffmpegPath, args, {
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe']
        });

        proc.stdout.on('data', (data) => {
            const lines = data.toString().split('\n');
            for (const line of lines) {
                if (line.startsWith('out_time_ms=')) {
                    const timeMs = Number.parseInt(line.split('=')[1], 10);
                    if (!Number.isNaN(timeMs) && estimatedDuration > 0 && onProgress) {
                        // Pass 1 is 60% of total work
                        const percent = Math.min(60, (timeMs / 1000000) / estimatedDuration * 60);
                        onProgress(percent);
                    }
                }
            }
        });

        proc.on('error', (err) => reject(new Error(`FFmpeg compress error: ${err.message}`)));
        proc.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`FFmpeg compress exited with code ${code}`));
        });

        setTimeout(() => {
            proc.kill();
            reject(new Error('FFmpeg compress timeout'));
        }, 7200000);
    });

    // After Pass 1, probe the COMPRESSED file's actual duration.
    // This is authoritative (already mono 16kHz MP3) and avoids tail truncation
    // if the original estimatedDuration was too low (Finding #14 in tra-plan.md).
    let actualDuration = estimatedDuration;
    try {
        actualDuration = await getAudioDuration(tempCompressed);
    } catch {
        // Fall back to original estimate if FFprobe fails on the compressed file
    }

    // Pass 2: Extract overlapping segments using -ss and -t with -c copy
    const stepSeconds = SEGMENT_DURATION_SECONDS; // gap between segment starts
    const segmentLength = SEGMENT_DURATION_SECONDS + SEGMENT_OVERLAP_SECONDS;
    // Add 1-second safety margin to ensure final segment isn't missed
    const numChunks = Math.ceil((actualDuration + 1) / stepSeconds);

    for (let i = 0; i < numChunks; i++) {
        const startTime = i * stepSeconds;
        const chunkPath = path.join(outputDir, `chunk_${String(i).padStart(3, '0')}.mp3`);

        await new Promise<void>((resolve, reject) => {
            const args = [
                '-ss', String(startTime),
                '-i', tempCompressed,
                '-t', String(segmentLength),
                '-c', 'copy',
                '-y',
                chunkPath
            ];

            const proc = spawn(ffmpegPath, args, {
                windowsHide: true,
                stdio: ['ignore', 'pipe', 'pipe']
            });

            proc.on('error', (err) => reject(new Error(`FFmpeg segment error: ${err.message}`)));
            proc.on('close', (code) => {
                if (code === 0) resolve();
                else reject(new Error(`FFmpeg segment exited with code ${code}`));
            });

            setTimeout(() => {
                proc.kill();
                reject(new Error('FFmpeg segment timeout'));
            }, 60000);
        });

        if (onProgress) {
            // Pass 2 is remaining 40% of total work
            const percent = 60 + ((i + 1) / numChunks) * 40;
            onProgress(Math.min(100, percent));
        }
    }

    // Clean up temp compressed file
    try {
        if (fs.existsSync(tempCompressed)) fs.unlinkSync(tempCompressed);
    } catch {
        // Non-critical cleanup
    }
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

