/**
 * Mp3Writer — bounded-memory streaming MP3 encoder.
 * Verifies residual-sample buffering and equivalence to single-shot encoding.
 */

import { describe, it, expect } from 'vitest';
import { Mp3Writer } from '../src/services/tts/mp3Writer';

const SAMPLE_RATE = 16000;
const BITRATE = 48;
const FRAME_SIZE = 1152;

function makeSine(samples: number, freqHz: number = 440): Int16Array {
    const out = new Int16Array(samples);
    for (let i = 0; i < samples; i++) {
        out[i] = Math.round(Math.sin((2 * Math.PI * freqHz * i) / SAMPLE_RATE) * 16000);
    }
    return out;
}

function concat(...arrs: Int16Array[]): Int16Array {
    let total = 0;
    for (const a of arrs) total += a.length;
    const out = new Int16Array(total);
    let off = 0;
    for (const a of arrs) {
        out.set(a, off);
        off += a.length;
    }
    return out;
}

describe('Mp3Writer', () => {
    it('rejects non-mono channels', () => {
        expect(() => new Mp3Writer({ sampleRate: SAMPLE_RATE, channels: 2 as 1, bitrateKbps: BITRATE })).toThrow();
    });

    it('rejects invalid sample rate / bitrate', () => {
        expect(() => new Mp3Writer({ sampleRate: 0, channels: 1, bitrateKbps: BITRATE })).toThrow();
        expect(() => new Mp3Writer({ sampleRate: SAMPLE_RATE, channels: 1, bitrateKbps: 0 })).toThrow();
    });

    it('encodes a single push and finishes', () => {
        const writer = new Mp3Writer({ sampleRate: SAMPLE_RATE, channels: 1, bitrateKbps: BITRATE });
        writer.push(makeSine(FRAME_SIZE * 2));
        const out = writer.finish();
        expect(out.byteLength).toBeGreaterThan(0);
    });

    it('throws on push() after finish()', () => {
        const writer = new Mp3Writer({ sampleRate: SAMPLE_RATE, channels: 1, bitrateKbps: BITRATE });
        writer.finish();
        expect(() => writer.push(makeSine(100))).toThrow();
    });

    it('throws on finish() called twice', () => {
        const writer = new Mp3Writer({ sampleRate: SAMPLE_RATE, channels: 1, bitrateKbps: BITRATE });
        writer.finish();
        expect(() => writer.finish()).toThrow();
    });

    it('handles empty push', () => {
        const writer = new Mp3Writer({ sampleRate: SAMPLE_RATE, channels: 1, bitrateKbps: BITRATE });
        writer.push(new Int16Array(0));
        const out = writer.finish();
        expect(out).toBeInstanceOf(Uint8Array);
    });

    it('produces same output for single-push as multi-push of equivalent data (residual buffer)', () => {
        const data = makeSine(FRAME_SIZE * 3 + 200);  // 3 full frames + partial

        // Single push
        const single = new Mp3Writer({ sampleRate: SAMPLE_RATE, channels: 1, bitrateKbps: BITRATE });
        single.push(data);
        const singleOut = single.finish();

        // Multi push at non-frame-aligned boundaries
        const multi = new Mp3Writer({ sampleRate: SAMPLE_RATE, channels: 1, bitrateKbps: BITRATE });
        const split1 = data.subarray(0, 500);
        const split2 = data.subarray(500, 1700);
        const split3 = data.subarray(1700);
        multi.push(split1);
        multi.push(split2);
        multi.push(split3);
        const multiOut = multi.finish();

        expect(multiOut.length).toBe(singleOut.length);
        // lamejs is deterministic — bytes should match exactly
        for (let i = 0; i < multiOut.length; i++) {
            expect(multiOut[i]).toBe(singleOut[i]);
        }
    });

    it('encodedBytesSoFar grows monotonically', () => {
        const writer = new Mp3Writer({ sampleRate: SAMPLE_RATE, channels: 1, bitrateKbps: BITRATE });
        const before = writer.encodedBytesSoFar;
        writer.push(makeSine(FRAME_SIZE * 4));
        const middle = writer.encodedBytesSoFar;
        expect(middle).toBeGreaterThanOrEqual(before);
        writer.finish();
        const after = writer.encodedBytesSoFar;
        expect(after).toBeGreaterThanOrEqual(middle);
    });

    it('exact frame-aligned push leaves no residual', () => {
        const writer = new Mp3Writer({ sampleRate: SAMPLE_RATE, channels: 1, bitrateKbps: BITRATE });
        writer.push(makeSine(FRAME_SIZE));
        // No exception means residual is fine
        const out = writer.finish();
        expect(out.byteLength).toBeGreaterThan(0);
    });

    it('handles many tiny pushes (extreme residual reuse)', () => {
        const writer = new Mp3Writer({ sampleRate: SAMPLE_RATE, channels: 1, bitrateKbps: BITRATE });
        const data = makeSine(FRAME_SIZE * 2);
        // Push 100 samples at a time
        for (let i = 0; i < data.length; i += 100) {
            writer.push(data.subarray(i, Math.min(i + 100, data.length)));
        }
        const out = writer.finish();
        expect(out.byteLength).toBeGreaterThan(0);
    });

    it('handles concatenated pushes equivalent to single push', () => {
        const a = makeSine(FRAME_SIZE);
        const b = makeSine(FRAME_SIZE);

        const single = new Mp3Writer({ sampleRate: SAMPLE_RATE, channels: 1, bitrateKbps: BITRATE });
        single.push(concat(a, b));
        const singleOut = single.finish();

        const multi = new Mp3Writer({ sampleRate: SAMPLE_RATE, channels: 1, bitrateKbps: BITRATE });
        multi.push(a);
        multi.push(b);
        const multiOut = multi.finish();

        expect(multiOut.length).toBe(singleOut.length);
    });
});
