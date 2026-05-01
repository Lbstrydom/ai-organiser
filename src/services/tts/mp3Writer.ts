/**
 * Mp3Writer — bounded-memory streaming MP3 encoder.
 *
 * Wraps `lamejs.Mp3Encoder` to accept per-chunk Int16Array PCM via repeated
 * `push()` calls and return the final MP3 bytes via `finish()`. Keeps a
 * residual-sample buffer to handle non-1152-aligned pushes correctly.
 *
 * Memory ceiling: O(MP3 size). Does NOT hold accumulated PCM in memory — only
 * the encoded MP3 frames + a small (<1152 samples) residual buffer.
 */

import lamejs from '@breezystack/lamejs';

const FRAME_SIZE = 1152;  // MPEG-1 Layer-III frame size in samples

export interface Mp3WriterOptions {
    sampleRate: number;
    channels: 1;            // v1 supports mono only — guard in constructor
    bitrateKbps: number;
}

export class Mp3Writer {
    private encoder: lamejs.Mp3Encoder;
    private frames: Uint8Array[] = [];
    private residual: Int16Array = new Int16Array(0);  // <FRAME_SIZE samples
    private finished = false;
    private encodedBytes = 0;

    constructor(opts: Mp3WriterOptions) {
        if (opts.channels !== 1) {
            throw new Error('Mp3Writer v1 supports mono only (channels must be 1).');
        }
        if (opts.sampleRate <= 0 || opts.bitrateKbps <= 0) {
            throw new Error(`Invalid Mp3Writer options: rate=${opts.sampleRate}, bitrate=${opts.bitrateKbps}`);
        }
        this.encoder = new lamejs.Mp3Encoder(opts.channels, opts.sampleRate, opts.bitrateKbps);
    }

    /** Bytes already encoded — for progress reporting. */
    get encodedBytesSoFar(): number {
        return this.encodedBytes;
    }

    /**
     * Encode a PCM segment. Concatenates onto residual buffer, encodes complete
     * 1152-sample frames, and leaves the sub-1152 tail in the residual buffer
     * for the next push.
     */
    push(pcm: Int16Array): void {
        if (this.finished) {
            throw new Error('Mp3Writer.push called after finish().');
        }
        if (pcm.length === 0) return;

        // Concatenate residual + new pcm into a single working buffer
        const total = this.residual.length + pcm.length;
        let working: Int16Array;
        if (this.residual.length === 0) {
            working = pcm;
        } else {
            working = new Int16Array(total);
            working.set(this.residual, 0);
            working.set(pcm, this.residual.length);
        }

        // Encode complete frames
        const completeFrames = Math.floor(working.length / FRAME_SIZE);
        const consumedSamples = completeFrames * FRAME_SIZE;
        for (let i = 0; i < consumedSamples; i += FRAME_SIZE) {
            const frame = working.subarray(i, i + FRAME_SIZE);
            const out = this.encoder.encodeBuffer(frame);
            this.pushFrame(out);
        }

        // Save residual (everything past the last complete frame)
        if (consumedSamples < working.length) {
            this.residual = working.slice(consumedSamples);
        } else {
            this.residual = new Int16Array(0);
        }
    }

    /**
     * Flush remaining residual + encoder. Returns the complete MP3 bytes.
     * Idempotent throws on second call.
     */
    finish(): Uint8Array {
        if (this.finished) {
            throw new Error('Mp3Writer.finish called twice.');
        }
        // Encode any residual samples (lamejs accepts <FRAME_SIZE)
        if (this.residual.length > 0) {
            const out = this.encoder.encodeBuffer(this.residual);
            this.pushFrame(out);
            this.residual = new Int16Array(0);
        }
        // Flush encoder's internal buffer
        const tail = this.encoder.flush();
        this.pushFrame(tail);
        this.finished = true;

        // Single concat at the end
        const total = this.encodedBytes;
        const result = new Uint8Array(total);
        let offset = 0;
        for (const f of this.frames) {
            result.set(f, offset);
            offset += f.length;
        }
        // Release frames for GC
        this.frames = [];
        return result;
    }

    private pushFrame(frame: Uint8Array): void {
        if (frame && frame.length > 0) {
            this.frames.push(frame);
            this.encodedBytes += frame.length;
        }
    }
}
