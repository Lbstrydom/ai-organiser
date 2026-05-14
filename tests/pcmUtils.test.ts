/**
 * PCM utilities — Int16Array sample-domain operations.
 */

import { describe, it, expect } from 'vitest';
import {
    downsamplePcm16,
    base64ToUint8Array,
    pcmBytesToInt16,
    dynamicNormalize,
} from '../src/services/tts/pcmUtils';

function rms(samples: Int16Array, start = 0, end = samples.length): number {
    let sumSq = 0;
    for (let i = start; i < end; i++) sumSq += samples[i] * samples[i];
    const len = end - start;
    return len > 0 ? Math.sqrt(sumSq / len) : 0;
}

function makeSineWithFade(
    durationSec: number,
    sampleRate: number,
    startAmp: number,
    endAmp: number,
    freq = 440,
): Int16Array {
    const n = Math.floor(durationSec * sampleRate);
    const out = new Int16Array(n);
    for (let i = 0; i < n; i++) {
        const t = i / n;
        const amp = startAmp + (endAmp - startAmp) * t;
        out[i] = Math.round(amp * Math.sin((2 * Math.PI * freq * i) / sampleRate));
    }
    return out;
}

describe('pcmBytesToInt16', () => {
    it('converts even-length byte buffer to Int16Array', () => {
        const bytes = new Uint8Array([0x01, 0x00, 0xff, 0xff]);  // [1, -1] in LE
        const samples = pcmBytesToInt16(bytes);
        expect(samples.length).toBe(2);
        expect(samples[0]).toBe(1);
        expect(samples[1]).toBe(-1);
    });

    it('drops trailing odd byte', () => {
        const bytes = new Uint8Array([0x01, 0x00, 0xff]);  // 1 + dangling byte
        const samples = pcmBytesToInt16(bytes);
        expect(samples.length).toBe(1);
        expect(samples[0]).toBe(1);
    });

    it('returns empty Int16Array for empty input', () => {
        const samples = pcmBytesToInt16(new Uint8Array(0));
        expect(samples.length).toBe(0);
    });
});

describe('downsamplePcm16', () => {
    it('returns copy of input when source==target rate', () => {
        const input = new Int16Array([100, 200, 300]);
        const out = downsamplePcm16(input, 16000, 16000);
        expect(Array.from(out)).toEqual([100, 200, 300]);
        // Must be a copy (caller may release input)
        expect(out).not.toBe(input);
    });

    it('halves rate via 2:1 box-filter', () => {
        const input = new Int16Array([100, 200, 300, 400]);
        const out = downsamplePcm16(input, 24000, 12000);
        expect(out.length).toBe(2);
        // First output sample averages [100, 200] → 150
        expect(out[0]).toBe(150);
        // Second averages [300, 400] → 350
        expect(out[1]).toBe(350);
    });

    it('handles 24kHz → 16kHz ratio (1.5:1)', () => {
        // 6 input samples → ~4 output (5 actually because window math)
        const input = new Int16Array([100, 200, 300, 400, 500, 600]);
        const out = downsamplePcm16(input, 24000, 16000);
        expect(out.length).toBeGreaterThan(0);
        expect(out.length).toBeLessThan(input.length);
    });

    it('clamps overflow to int16 range', () => {
        const input = new Int16Array([32767, 32767, 32767, 32767]);
        const out = downsamplePcm16(input, 24000, 12000);
        expect(out[0]).toBeLessThanOrEqual(32767);
        expect(out[0]).toBeGreaterThanOrEqual(-32768);
    });

    it('throws on invalid sample rates', () => {
        expect(() => downsamplePcm16(new Int16Array(4), 0, 16000)).toThrow();
        expect(() => downsamplePcm16(new Int16Array(4), 24000, -1)).toThrow();
    });

    it('produces independent output (caller can release input)', () => {
        const input = new Int16Array([100, 200, 300, 400]);
        const out = downsamplePcm16(input, 24000, 12000);
        // Verify no buffer aliasing
        input[0] = 999;
        expect(out[0]).toBe(150);  // unchanged
    });
});

describe('dynamicNormalize', () => {
    it('returns empty Int16Array for empty input', () => {
        const out = dynamicNormalize(new Int16Array(0), 16000);
        expect(out.length).toBe(0);
    });

    it('throws on invalid sample rate', () => {
        expect(() => dynamicNormalize(new Int16Array(100), 0)).toThrow();
        expect(() => dynamicNormalize(new Int16Array(100), -1)).toThrow();
    });

    it('returns a new Int16Array (input is not aliased)', () => {
        const input = new Int16Array([1000, 2000, 3000, 4000]);
        const out = dynamicNormalize(input, 16000);
        expect(out).not.toBe(input);
        expect(out.length).toBe(input.length);
    });

    it('compensates an intra-chunk fade — tail RMS rises toward head RMS', () => {
        // 3 seconds at 16 kHz with linear amp fade 10000 → 2000
        const sampleRate = 16000;
        const input = makeSineWithFade(3, sampleRate, 10000, 2000);
        const out = dynamicNormalize(input, sampleRate);

        // Compare first vs last 500 ms RMS.
        const win = sampleRate / 2;
        const headOriginal = rms(input, 0, win);
        const tailOriginal = rms(input, input.length - win);
        const headNormalized = rms(out, 0, win);
        const tailNormalized = rms(out, out.length - win);

        // The fade ratio in input should narrow significantly post-AGC.
        const ratioBefore = headOriginal / tailOriginal;
        const ratioAfter = headNormalized / tailNormalized;
        expect(ratioBefore).toBeGreaterThan(3);   // ~5x fade
        expect(ratioAfter).toBeLessThan(2);       // tightened to <2x
    });

    it('levels chunks with different absolute RMS toward a common target', () => {
        const sampleRate = 16000;
        // Two synthetic "chunks" at very different levels.
        const quietChunk = makeSineWithFade(2, sampleRate, 1500, 1500);
        const loudChunk = makeSineWithFade(2, sampleRate, 12000, 12000);

        const quietOut = dynamicNormalize(quietChunk, sampleRate);
        const loudOut = dynamicNormalize(loudChunk, sampleRate);

        // After per-chunk AGC, both should sit within ~30% of each other.
        const quietRms = rms(quietOut, sampleRate);   // skip attack region
        const loudRms = rms(loudOut, sampleRate);
        const ratio = Math.max(quietRms, loudRms) / Math.min(quietRms, loudRms);
        expect(ratio).toBeLessThan(1.5);
    });

    it('does not amplify silence (holds gain through quiet blocks)', () => {
        const sampleRate = 16000;
        // 1 s loud, 0.5 s silence, 1 s loud again.
        const loud = makeSineWithFade(1, sampleRate, 8000, 8000);
        const silence = new Int16Array(sampleRate / 2);
        const more = makeSineWithFade(1, sampleRate, 8000, 8000);
        const input = new Int16Array(loud.length + silence.length + more.length);
        input.set(loud, 0);
        input.set(silence, loud.length);
        input.set(more, loud.length + silence.length);

        const out = dynamicNormalize(input, sampleRate);

        // Silence region should remain effectively silent (no breath/noise pump).
        const silenceStart = loud.length;
        const silenceEnd = loud.length + silence.length;
        const silenceRms = rms(out, silenceStart, silenceEnd);
        expect(silenceRms).toBeLessThan(50);
    });

    it('hard-limits peaks below Int16 max', () => {
        const sampleRate = 16000;
        // Very quiet input that would otherwise need huge gain.
        const tiny = new Int16Array(sampleRate);
        for (let i = 0; i < tiny.length; i++) {
            tiny[i] = Math.round(200 * Math.sin((2 * Math.PI * 440 * i) / sampleRate));
        }
        const out = dynamicNormalize(tiny, sampleRate);
        for (const sample of out) {
            expect(sample).toBeLessThanOrEqual(30000);
            expect(sample).toBeGreaterThanOrEqual(-30000);
        }
    });

    it('processes a 90-second chunk in well under 200 ms', () => {
        // Performance budget — must be negligible vs the multi-second TTS RTT.
        const sampleRate = 16000;
        const input = makeSineWithFade(90, sampleRate, 10000, 3000);
        const t0 = performance.now();
        dynamicNormalize(input, sampleRate);
        const elapsed = performance.now() - t0;
        expect(elapsed).toBeLessThan(200);
    });
});

describe('base64ToUint8Array', () => {
    it('decodes basic base64', () => {
        // 'AAEC' = base64 of [0x00, 0x01, 0x02]
        const bytes = base64ToUint8Array('AAEC');
        expect(Array.from(bytes)).toEqual([0, 1, 2]);
    });

    it('handles empty string', () => {
        const bytes = base64ToUint8Array('');
        expect(bytes.length).toBe(0);
    });
});
