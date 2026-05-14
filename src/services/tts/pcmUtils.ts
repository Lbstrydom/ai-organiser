/**
 * PCM utilities — sample-domain math on Int16Array.
 *
 * Documented contract: all PCM is mono, signed 16-bit, native byte order. On
 * all Obsidian targets (Electron desktop x64/ARM64, iOS/Android WebView) the
 * host is little-endian. The Gemini TTS API also returns LINEAR16 LE, so a
 * typed-array view over the response bytes is correct without byteswap.
 */

/**
 * Reinterpret raw LE byte payload as Int16 sample array. Drops a trailing
 * odd byte if present (defensive — Gemini always returns even-length payloads).
 */
export function pcmBytesToInt16(bytes: Uint8Array): Int16Array {
    const sampleCount = Math.floor(bytes.byteLength / 2);
    if (sampleCount === 0) return new Int16Array(0);
    return new Int16Array(bytes.buffer, bytes.byteOffset, sampleCount);
}

/**
 * Box-filter decimation downsample. For each output sample, average input
 * samples in its window. Good enough for speech (acts as crude anti-alias).
 * Returns a freshly-allocated Int16Array (output is independent of input,
 * so the caller can release the input PCM for GC after this call).
 */
export function downsamplePcm16(
    samples: Int16Array,
    sourceRate: number,
    targetRate: number,
): Int16Array {
    if (sourceRate === targetRate) {
        const copy = new Int16Array(samples.length);
        copy.set(samples);
        return copy;
    }
    if (sourceRate <= 0 || targetRate <= 0) {
        throw new Error(`Invalid sample rates: source=${sourceRate}, target=${targetRate}`);
    }
    const ratio = sourceRate / targetRate;
    const inputCount = samples.length;
    const outputCount = Math.floor(inputCount / ratio);
    const out = new Int16Array(outputCount);

    for (let i = 0; i < outputCount; i++) {
        const start = Math.floor(i * ratio);
        const end = Math.min(Math.floor((i + 1) * ratio), inputCount);
        let sum = 0;
        let count = 0;
        for (let j = start; j < end; j++) {
            sum += samples[j];
            count++;
        }
        const avg = count > 0 ? Math.round(sum / count) : 0;
        out[i] = avg < -32768 ? -32768 : avg > 32767 ? 32767 : avg;
    }
    return out;
}

// ── Dynamic normalization ──────────────────────────────────────────────────
//
// Gemini TTS (and most autoregressive neural TTS) produces audio whose level
// varies both within a chunk (attention decay → quieter tail) and between
// chunks (no consistent absolute reference). The fix is a one-pass block-based
// AGC: estimate per-block RMS, derive a smoothed gain curve, apply it with a
// hard limiter. Sample-domain on Int16Array → no decode/encode pass needed,
// works on mobile (FFmpeg is desktop-only).
//
// Cost: 2 linear passes over samples + O(blocks) gain smoothing. ~30 ms for a
// 90-second chunk at 16 kHz on a typical CPU — negligible vs the multi-second
// network round-trip per chunk. Always-on, no toggle.

const NORM_TARGET_RMS = 5200;       // ~-16 dBFS (Int16) — broadcast headroom
const NORM_PEAK_LIMIT = 30000;      // ~-0.7 dBFS — leaves margin for MP3 encoder
const NORM_BLOCK_MS = 50;           // RMS analysis window
const NORM_MAX_GAIN = 6;            // cap boost (~+15 dB) to avoid amplifying noise floor
const NORM_MIN_GAIN = 0.2;          // cap attenuation (~-14 dB)
const NORM_SILENCE_RMS = 80;        // below this, treat block as silence (hold gain)
const NORM_ATTACK_BLOCKS = 2;       // ~100 ms — fast clamp on transients
const NORM_RELEASE_BLOCKS = 8;      // ~400 ms — slower lift to avoid pumping
const NORM_HEADROOM_GAIN = 0.97;    // safety scale on smoothed gain

function clampGain(g: number): number {
    return Math.min(NORM_MAX_GAIN, Math.max(NORM_MIN_GAIN, g));
}

/** Pass 1: per-block RMS via sum-of-squares. Float64 accumulator handles ~1.5e15. */
function computeBlockRms(samples: Int16Array, blockSize: number, blockCount: number): Float32Array {
    const out = new Float32Array(blockCount);
    for (let b = 0; b < blockCount; b++) {
        const start = b * blockSize;
        const end = Math.min(start + blockSize, samples.length);
        let sumSq = 0;
        for (let i = start; i < end; i++) {
            const s = samples[i];
            sumSq += s * s;
        }
        out[b] = Math.sqrt(sumSq / (end - start));
    }
    return out;
}

/** Pass 2: per-block desired gain. Silent blocks hold the previous gain to
 *  avoid amplifying breath/noise floor (a common pumping artefact source). */
function computeDesiredGain(blockRms: Float32Array): Float32Array {
    const out = new Float32Array(blockRms.length);
    let lastNonSilent = 1;
    for (let b = 0; b < blockRms.length; b++) {
        if (blockRms[b] < NORM_SILENCE_RMS) {
            out[b] = lastNonSilent;
        } else {
            const clamped = clampGain(NORM_TARGET_RMS / blockRms[b]);
            out[b] = clamped;
            lastNonSilent = clamped;
        }
    }
    return out;
}

/** Pass 3: asymmetric one-pole smoothing. Attack (gain dropping) is fast for
 *  transients; release (gain rising) is slow so the AGC fills the chunk-tail
 *  fade gradually rather than punching it back to full level. */
function smoothGain(desired: Float32Array): Float32Array {
    const out = new Float32Array(desired.length);
    if (desired.length === 0) return out;
    const attackCoef = 1 - Math.exp(-1 / NORM_ATTACK_BLOCKS);
    const releaseCoef = 1 - Math.exp(-1 / NORM_RELEASE_BLOCKS);
    let g = desired[0];
    out[0] = g * NORM_HEADROOM_GAIN;
    for (let b = 1; b < desired.length; b++) {
        const target = desired[b];
        const coef = target < g ? attackCoef : releaseCoef;
        g = g + (target - g) * coef;
        out[b] = g * NORM_HEADROOM_GAIN;
    }
    return out;
}

/** Pass 4: apply linearly-interpolated gain across each block + hard limit. */
function applyGainWithLimit(
    samples: Int16Array,
    smoothed: Float32Array,
    blockSize: number,
): Int16Array {
    const out = new Int16Array(samples.length);
    const blockCount = smoothed.length;
    for (let b = 0; b < blockCount; b++) {
        const start = b * blockSize;
        const end = Math.min(start + blockSize, samples.length);
        const gStart = smoothed[b];
        const gEnd = b + 1 < blockCount ? smoothed[b + 1] : gStart;
        const span = end - start;
        for (let i = start; i < end; i++) {
            const t = span > 0 ? (i - start) / span : 0;
            const gain = gStart + (gEnd - gStart) * t;
            const scaled = samples[i] * gain;
            const clipped = Math.min(NORM_PEAK_LIMIT, Math.max(-NORM_PEAK_LIMIT, scaled));
            out[i] = Math.trunc(clipped);
        }
    }
    return out;
}

/**
 * Compensate volume undulation in TTS output. Levels each chunk to a target
 * RMS and tracks slow level changes within the chunk (the Gemini fade) via
 * sliding-window AGC. Called per-chunk after rate conversion, before MP3
 * encoding.
 *
 * Pure function: returns a freshly allocated Int16Array; input is unmodified.
 */
export function dynamicNormalize(samples: Int16Array, sampleRate: number): Int16Array {
    if (samples.length === 0) return new Int16Array(0);
    if (sampleRate <= 0) {
        throw new Error(`Invalid sample rate: ${sampleRate}`);
    }

    const blockSize = Math.max(1, Math.floor((sampleRate * NORM_BLOCK_MS) / 1000));
    const blockCount = Math.ceil(samples.length / blockSize);

    const blockRms = computeBlockRms(samples, blockSize, blockCount);
    const desired = computeDesiredGain(blockRms);
    const smoothed = smoothGain(desired);
    return applyGainWithLimit(samples, smoothed, blockSize);
}

/**
 * Decode base64 to Uint8Array. Used at the engine boundary; downstream code
 * works in Int16Array sample units (see pcmBytesToInt16).
 */
export function base64ToUint8Array(b64: string): Uint8Array {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.codePointAt(i) ?? 0;
    }
    return bytes;
}
