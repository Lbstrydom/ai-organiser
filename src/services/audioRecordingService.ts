/**
 * Audio Recording Service
 * MediaRecorder wrapper for in-plugin audio recording
 * Works on desktop and mobile via MediaRecorder mime negotiation (MP4/AAC preferred, WebM/Opus fallback)
 */

import { MAX_FILE_SIZE_BYTES } from './audioTranscriptionService';

/** Bitrate presets for recording quality */
export const RECORDING_BITRATES = {
    speech: 64000,   // ~52 min under 25MB — sufficient for voice
    high: 128000,    // ~26 min under 25MB — music or detailed audio
} as const;
export type RecordingQuality = keyof typeof RECORDING_BITRATES;

/** @deprecated Use RECORDING_BITRATES.speech instead */
export const RECORDING_BITRATE = RECORDING_BITRATES.speech;

export interface MimeSelection {
    mimeType: string;    // e.g. 'audio/mp4', 'audio/webm;codecs=opus'
    extension: string;   // e.g. '.m4a', '.webm'
}

/**
 * Map a mime type string to a file extension.
 * Used as fallback when isTypeSupported is unreliable.
 */
export function mapMimeToExtension(mimeType: string): string {
    if (mimeType.includes('mp4') || mimeType.includes('aac')) return '.m4a';
    if (mimeType.includes('webm')) return '.webm';
    if (mimeType.includes('ogg')) return '.ogg';
    return '.webm';  // Safe default
}

/**
 * Check if the browser/webview supports audio recording.
 * Checks both getUserMedia and MediaRecorder APIs.
 */
export function isRecordingSupported(): boolean {
    return !!(
        typeof navigator !== 'undefined' &&
        typeof navigator.mediaDevices?.getUserMedia === 'function' &&
        typeof MediaRecorder !== 'undefined'
    );
}

/**
 * Negotiate best mime type for audio recording.
 * Tries iOS-friendly mp4 first, then desktop webm/opus, then fallbacks.
 * Returns null if none are supported (caller should try fallback path).
 */
export function selectMime(): MimeSelection | null {
    if (typeof MediaRecorder === 'undefined') return null;

    const candidates: MimeSelection[] = [
        { mimeType: 'audio/mp4', extension: '.m4a' },
        { mimeType: 'audio/webm;codecs=opus', extension: '.webm' },
        { mimeType: 'audio/webm', extension: '.webm' },
        { mimeType: 'audio/ogg;codecs=opus', extension: '.ogg' },
    ];
    for (const c of candidates) {
        if (MediaRecorder.isTypeSupported(c.mimeType)) return c;
    }
    return null;
}

/**
 * Calculate approximate max recording minutes before hitting Whisper file size limit.
 * Based on target bitrate (actual duration may vary with VBR encoding).
 */
export function getMaxRecordingMinutes(quality: RecordingQuality = 'speech'): number {
    const bytesPerSecond = RECORDING_BITRATES[quality] / 8;
    return Math.floor(MAX_FILE_SIZE_BYTES / bytesPerSecond / 60);
}

export class AudioRecordingService {
    private mediaRecorder: MediaRecorder | null = null;
    private chunks: Blob[] = [];
    private stream: MediaStream | null = null;
    private startTime: number = 0;
    private recordedBytes: number = 0;
    private mime: MimeSelection = { mimeType: '', extension: '.webm' };

    /**
     * Start recording audio from the microphone.
     * Negotiates best mime type, with fallback to default MediaRecorder.
     * Uses 1-second timeslice for accurate size tracking.
     * @param bitrate Target audio bitrate in bits/sec (default: 64000 for speech)
     */
    async startRecording(bitrate: number = RECORDING_BITRATES.speech): Promise<void> {
        if (this.mediaRecorder?.state === 'recording') {
            throw new Error('Already recording');
        }

        // Request microphone access
        this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        this.chunks = [];
        this.recordedBytes = 0;

        // Negotiate mime type
        const negotiated = selectMime();
        let options: MediaRecorderOptions;

        if (negotiated) {
            this.mime = negotiated;
            options = {
                mimeType: negotiated.mimeType,
                audioBitsPerSecond: bitrate
            };
        } else {
            // Fallback: let browser pick default, read mimeType from instance
            options = {
                audioBitsPerSecond: bitrate
            };
        }

        try {
            this.mediaRecorder = new MediaRecorder(this.stream, options);
        } catch (err) {
            // MediaRecorder constructor can throw (e.g. unsupported mime on this device).
            // Release the mic stream we already acquired to avoid a leak.
            this.releaseStream();
            throw err;
        }

        // If we used the fallback path, read actual mimeType from instance
        if (!negotiated && this.mediaRecorder.mimeType) {
            this.mime = {
                mimeType: this.mediaRecorder.mimeType,
                extension: mapMimeToExtension(this.mediaRecorder.mimeType)
            };
        } else if (!negotiated) {
            // No mimeType available at all — use safe default
            this.mime = { mimeType: 'audio/webm', extension: '.webm' };
        }

        // Accumulate chunks with real size tracking.
        // Also capture the actual mime type from the first chunk — this is the
        // ground truth when isTypeSupported was unreliable or the browser
        // silently chose a different codec than requested.
        this.mediaRecorder.ondataavailable = (event: BlobEvent) => {
            if (event.data.size > 0) {
                if (this.chunks.length === 0 && event.data.type) {
                    this.mime = {
                        mimeType: event.data.type,
                        extension: mapMimeToExtension(event.data.type)
                    };
                }
                this.chunks.push(event.data);
                this.recordedBytes += event.data.size;
            }
        };

        // Start with 1-second timeslice for accurate live size display
        this.startTime = Date.now();
        try {
            this.mediaRecorder.start(1000);
        } catch (err) {
            // start() can throw InvalidStateError or NotSupportedError.
            // Release the mic stream to avoid a leak.
            this.releaseStream();
            this.mediaRecorder = null;
            throw err;
        }

        // Some browsers only populate mimeType after start().
        // Use it as a secondary truth source if we don't have one yet.
        if (this.mediaRecorder.mimeType && this.mime.mimeType !== this.mediaRecorder.mimeType) {
            this.mime = {
                mimeType: this.mediaRecorder.mimeType,
                extension: mapMimeToExtension(this.mediaRecorder.mimeType)
            };
        }
    }

    /**
     * Stop recording and return the complete audio blob.
     * Releases microphone stream.
     */
    stopRecording(): Promise<Blob> {
        return new Promise((resolve, reject) => {
            if (!this.mediaRecorder || this.mediaRecorder.state !== 'recording') {
                reject(new Error('Not recording'));
                return;
            }

            this.mediaRecorder.onstop = () => {
                // Use the actual mime type from the recorder instance as the
                // definitive source — it reflects what the browser really encoded.
                const actualMime = this.mediaRecorder?.mimeType;
                if (actualMime && actualMime !== this.mime.mimeType) {
                    this.mime = {
                        mimeType: actualMime,
                        extension: mapMimeToExtension(actualMime)
                    };
                }
                const blob = new Blob(this.chunks, { type: this.mime.mimeType });
                this.releaseStream();
                resolve(blob);
            };

            this.mediaRecorder.onerror = (event: Event) => {
                this.releaseStream();
                reject(new Error('Recording error: ' + (event as ErrorEvent).message));
            };

            this.mediaRecorder.stop();
        });
    }

    /** Elapsed recording time in seconds */
    getElapsedSeconds(): number {
        if (this.startTime === 0) return 0;
        return Math.floor((Date.now() - this.startTime) / 1000);
    }

    /** Actual recorded bytes (accumulated from data chunks) */
    getRecordedBytes(): number {
        return this.recordedBytes;
    }

    /** Whether we're currently recording */
    isRecording(): boolean {
        return this.mediaRecorder?.state === 'recording';
    }

    /** Whether there's unsaved recorded data */
    hasData(): boolean {
        return this.chunks.length > 0;
    }

    /** Get the negotiated mime selection */
    getMimeSelection(): MimeSelection {
        return this.mime;
    }

    /** Clean up: stop recording, release mic, clear data */
    dispose(): void {
        if (this.mediaRecorder?.state === 'recording') {
            try {
                this.mediaRecorder.stop();
            } catch {
                // Already stopped
            }
        }
        this.releaseStream();
        this.chunks = [];
        this.recordedBytes = 0;
        this.startTime = 0;
        this.mediaRecorder = null;
    }

    private releaseStream(): void {
        if (this.stream) {
            this.stream.getTracks().forEach(track => track.stop());
            this.stream = null;
        }
    }
}
