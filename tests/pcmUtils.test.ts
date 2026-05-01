/**
 * PCM utilities — Int16Array sample-domain operations.
 */

import { describe, it, expect } from 'vitest';
import { downsamplePcm16, base64ToUint8Array, pcmBytesToInt16 } from '../src/services/tts/pcmUtils';

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
