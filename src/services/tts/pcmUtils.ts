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
