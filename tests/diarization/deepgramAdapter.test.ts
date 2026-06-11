/**
 * Deepgram adapter unit tests
 * ---------------------------
 *
 * Fixture-driven parse + error-handling coverage per plan §9 + acceptance
 * criteria §10. Mocks Obsidian's requestUrl via vi.mock.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const mockRequestUrl = vi.fn();
vi.mock('obsidian', async () => {
    const actual = await vi.importActual('../mocks/obsidian');
    return {
        ...actual,
        requestUrl: (...args: unknown[]) => mockRequestUrl(...args),
    };
});

import { DeepgramAdapter, parseResponse } from '../../src/services/diarization/deepgramAdapter';
import {
    DEEPGRAM_COST_PER_MIN_USD,
    type DiarizationResult,
} from '../../src/services/diarization/types';
import type { Result } from '../../src/core/result';

const FIXTURE_PATH = path.join(
    __dirname,
    '..',
    'fixtures',
    'diarization',
    'deepgram-sanitized-20min.json',
);
const fixtureJson = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf-8'));

function makeApp(): any {
    return { vault: { adapter: {} } };
}

function makeBytes(size = 1024): ArrayBuffer {
    return new ArrayBuffer(size);
}

function okResponse(json: unknown, status = 200): any {
    return {
        status,
        text: JSON.stringify(json),
        json,
        headers: {},
        arrayBuffer: new ArrayBuffer(0),
    };
}

function errResponse(status: number, body = '{}'): any {
    return {
        status,
        text: body,
        json: undefined,
        headers: {},
        arrayBuffer: new ArrayBuffer(0),
    };
}

describe('DeepgramAdapter — happy path (sanitized 20-min fixture)', () => {
    let adapter: DeepgramAdapter;

    beforeEach(() => {
        mockRequestUrl.mockReset();
        adapter = new DeepgramAdapter(async () => 'fake-key');
    });

    it('parses sanitized fixture to expected shape', async () => {
        mockRequestUrl.mockResolvedValueOnce(okResponse(fixtureJson));
        const r = await adapter.transcribeWithDiarization(
            makeApp(),
            makeBytes(),
            { filename: 'hamina.mp3' },
        );

        expect(r.ok).toBe(true);
        if (!r.ok) throw new Error('unreachable');
        const v = r.value;
        expect(v.provider).toBe('deepgram');
        expect(v.detectedLanguage).toBe('en');
        expect(v.labelled.languageCode).toBe('en');
        expect(v.labelled.speakers.length).toBe(4);
        expect(v.labelled.segments.length).toBeGreaterThan(300);
        expect(v.durationSec).toBeGreaterThan(1190);
    });

    it('converts utterance start/end from seconds to integer ms (G2-H2)', async () => {
        mockRequestUrl.mockResolvedValueOnce(okResponse(fixtureJson));
        const r = await adapter.transcribeWithDiarization(
            makeApp(),
            makeBytes(),
        );

        expect(r.ok).toBe(true);
        if (!r.ok) throw new Error('unreachable');
        for (const seg of r.value.labelled.segments) {
            expect(Number.isInteger(seg.startMs)).toBe(true);
            expect(Number.isInteger(seg.endMs)).toBe(true);
        }
        const first = r.value.labelled.segments[0];
        const expected = Math.round(fixtureJson.results.utterances[0].start * 1000);
        expect(first.startMs).toBe(expected);
    });

    it('formats speaker labels as 1-indexed "Speaker N" (G2-L1)', async () => {
        mockRequestUrl.mockResolvedValueOnce(okResponse(fixtureJson));
        const r = await adapter.transcribeWithDiarization(makeApp(), makeBytes());

        expect(r.ok).toBe(true);
        if (!r.ok) throw new Error('unreachable');
        for (const seg of r.value.labelled.segments) {
            if (seg.speaker !== undefined) {
                expect(seg.speaker).toMatch(/^Speaker \d+$/);
            }
        }
        // Speaker IDs are 0..3 in the fixture → labels Speaker 1..4
        expect(r.value.labelled.speakers).toEqual(
            expect.arrayContaining(['Speaker 1', 'Speaker 2', 'Speaker 3', 'Speaker 4']),
        );
    });

    it('computes typed actual cost from durationSec (G2 + azure-audio M6)', async () => {
        mockRequestUrl.mockResolvedValueOnce(okResponse(fixtureJson));
        const r = await adapter.transcribeWithDiarization(makeApp(), makeBytes());

        expect(r.ok).toBe(true);
        if (!r.ok) throw new Error('unreachable');
        const expected = Math.round(
            (r.value.durationSec / 60) * DEEPGRAM_COST_PER_MIN_USD * 10000,
        ) / 10000;
        expect(r.value.cost.kind).toBe('actual');
        expect(r.value.cost.usd).toBeCloseTo(expected, 6);
    });

    it('sends Deepgram URL with all required params (incl. mip_opt_out=true)', async () => {
        mockRequestUrl.mockResolvedValueOnce(okResponse(fixtureJson));
        await adapter.transcribeWithDiarization(makeApp(), makeBytes(), {
            filename: 'meeting.mp3',
        });

        expect(mockRequestUrl).toHaveBeenCalledTimes(1);
        const callArgs = mockRequestUrl.mock.calls[0][0] as { url: string; headers: Record<string, string> };
        const url = new URL(callArgs.url);
        expect(url.searchParams.get('model')).toBe('nova-3');
        expect(url.searchParams.get('diarize')).toBe('true');
        expect(url.searchParams.get('utterances')).toBe('true');
        expect(url.searchParams.get('detect_language')).toBe('true');
        expect(url.searchParams.get('mip_opt_out')).toBe('true');
        expect(callArgs.headers.Authorization).toBe('Token fake-key');
        expect(callArgs.headers['Content-Type']).toBe('audio/mpeg');
    });

    it('honors options.mimeType override (G3-M1)', async () => {
        mockRequestUrl.mockResolvedValueOnce(okResponse(fixtureJson));
        await adapter.transcribeWithDiarization(makeApp(), makeBytes(), {
            filename: 'recording.webm',
            mimeType: 'audio/ogg;codecs=opus',
        });
        const callArgs = mockRequestUrl.mock.calls[0][0] as { headers: Record<string, string> };
        expect(callArgs.headers['Content-Type']).toBe('audio/ogg;codecs=opus');
    });
});

describe('DeepgramAdapter — error handling', () => {
    let adapter: DeepgramAdapter;

    beforeEach(() => {
        mockRequestUrl.mockReset();
        adapter = new DeepgramAdapter(async () => 'fake-key');
    });

    it('returns no-api-key when the resolver yields no key (H3 — provider-owned creds)', async () => {
        const noKey = new DeepgramAdapter(async () => null);
        const r = await noKey.transcribeWithDiarization(makeApp(), makeBytes());
        expect(r.ok).toBe(false);
        if (r.ok) throw new Error('unreachable');
        expect(r.error).toBe('no-api-key');
        expect(mockRequestUrl).not.toHaveBeenCalled();
    });

    it('returns no-api-key when the resolver throws (never throws outward)', async () => {
        const throwing = new DeepgramAdapter(async () => { throw new Error('storage'); });
        const r = await throwing.transcribeWithDiarization(makeApp(), makeBytes());
        expect(r.ok).toBe(false);
        if (r.ok) throw new Error('unreachable');
        expect(r.error).toBe('no-api-key');
    });

    it('returns empty-audio when audioBytes is zero-length', async () => {
        const r = await adapter.transcribeWithDiarization(makeApp(), new ArrayBuffer(0));
        expect(r.ok).toBe(false);
        if (r.ok) throw new Error('unreachable');
        expect(r.error).toBe('empty-audio');
    });

    it('returns http-401 on bad key', async () => {
        mockRequestUrl.mockResolvedValueOnce(errResponse(401, '{"err":"unauth"}'));
        const r = await adapter.transcribeWithDiarization(makeApp(), makeBytes());
        expect(r.ok).toBe(false);
        if (r.ok) throw new Error('unreachable');
        expect(r.error).toBe('http-401');
    });

    it('returns http-500 on server error (no retry)', async () => {
        mockRequestUrl.mockResolvedValueOnce(errResponse(500, '{"err":"oops"}'));
        const r = await adapter.transcribeWithDiarization(makeApp(), makeBytes());
        expect(r.ok).toBe(false);
        if (r.ok) throw new Error('unreachable');
        expect(r.error).toBe('http-500');
        expect(mockRequestUrl).toHaveBeenCalledTimes(1);
    });

    it('returns malformed-response when body is not JSON', async () => {
        mockRequestUrl.mockResolvedValueOnce({
            status: 200,
            text: 'not-json',
            json: undefined,
            headers: {},
            arrayBuffer: new ArrayBuffer(0),
        });
        const r = await adapter.transcribeWithDiarization(makeApp(), makeBytes());
        expect(r.ok).toBe(false);
        if (r.ok) throw new Error('unreachable');
        expect(r.error).toMatch(/malformed-response/);
    });

    it('returns no-utterances when utterances[] is absent', async () => {
        mockRequestUrl.mockResolvedValueOnce(
            okResponse({ metadata: { duration: 10 }, results: { channels: [] } }),
        );
        const r = await adapter.transcribeWithDiarization(makeApp(), makeBytes());
        expect(r.ok).toBe(false);
        if (r.ok) throw new Error('unreachable');
        expect(r.error).toBe('no-utterances');
    });
});

describe('DeepgramAdapter — retry policy (R2 M5 + R4 M4)', () => {
    let adapter: DeepgramAdapter;
    let sleeperCalls: number[];

    beforeEach(() => {
        mockRequestUrl.mockReset();
        sleeperCalls = [];
        adapter = new DeepgramAdapter(async () => 'fake-key', {
            _sleeper: async (ms) => {
                sleeperCalls.push(ms);
            },
            _jitter: (base) => base, // deterministic — no jitter in tests
        });
    });

    it('retries exactly 2x on 429 (3 attempts total) with backoffs 1s then 4s', async () => {
        mockRequestUrl
            .mockResolvedValueOnce(errResponse(429))
            .mockResolvedValueOnce(errResponse(429))
            .mockResolvedValueOnce(errResponse(429));
        const r = await adapter.transcribeWithDiarization(makeApp(), makeBytes());
        expect(r.ok).toBe(false);
        if (r.ok) throw new Error('unreachable');
        expect(r.error).toBe('http-429');
        expect(mockRequestUrl).toHaveBeenCalledTimes(3);
        expect(sleeperCalls).toEqual([1000, 4000]);
    });

    it('succeeds on retry-1 if 429 then 200', async () => {
        mockRequestUrl
            .mockResolvedValueOnce(errResponse(429))
            .mockResolvedValueOnce(okResponse(fixtureJson));
        const r = await adapter.transcribeWithDiarization(makeApp(), makeBytes());
        expect(r.ok).toBe(true);
        expect(mockRequestUrl).toHaveBeenCalledTimes(2);
        expect(sleeperCalls).toEqual([1000]);
    });

    it('does NOT retry on non-429 errors', async () => {
        mockRequestUrl.mockResolvedValueOnce(errResponse(503));
        const r = await adapter.transcribeWithDiarization(makeApp(), makeBytes());
        expect(r.ok).toBe(false);
        expect(mockRequestUrl).toHaveBeenCalledTimes(1);
        expect(sleeperCalls).toEqual([]);
    });
});

describe('DeepgramAdapter — abort + transport (R2 M1 + R4 H3)', () => {
    let adapter: DeepgramAdapter;

    beforeEach(() => {
        mockRequestUrl.mockReset();
        adapter = new DeepgramAdapter(async () => 'fake-key');
    });

    it('returns aborted when signal is pre-aborted', async () => {
        const ctrl = new AbortController();
        ctrl.abort();
        const r = await adapter.transcribeWithDiarization(makeApp(), makeBytes(), {
            signal: ctrl.signal,
        });
        expect(r.ok).toBe(false);
        if (r.ok) throw new Error('unreachable');
        expect(r.error).toBe('aborted');
    });

    it('classifies DNS rejection as network-dns', async () => {
        mockRequestUrl.mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND api.deepgram.com'));
        const r = await adapter.transcribeWithDiarization(makeApp(), makeBytes());
        expect(r.ok).toBe(false);
        if (r.ok) throw new Error('unreachable');
        expect(r.error).toBe('network-dns');
    });

    it('classifies TLS rejection as network-tls', async () => {
        mockRequestUrl.mockRejectedValueOnce(new Error('TLS handshake failed: cert expired'));
        const r = await adapter.transcribeWithDiarization(makeApp(), makeBytes());
        expect(r.ok).toBe(false);
        if (r.ok) throw new Error('unreachable');
        expect(r.error).toBe('network-tls');
    });

    it('classifies offline rejection as network-offline', async () => {
        mockRequestUrl.mockRejectedValueOnce(new Error('connect ENETUNREACH 0.0.0.0'));
        const r = await adapter.transcribeWithDiarization(makeApp(), makeBytes());
        expect(r.ok).toBe(false);
        if (r.ok) throw new Error('unreachable');
        expect(r.error).toBe('network-offline');
    });

    it('falls back to network-other for unknown transport errors', async () => {
        mockRequestUrl.mockRejectedValueOnce(new Error('something weird happened'));
        const r = await adapter.transcribeWithDiarization(makeApp(), makeBytes());
        expect(r.ok).toBe(false);
        if (r.ok) throw new Error('unreachable');
        expect(r.error).toMatch(/^network-other:/);
    });
});

describe('parseResponse — pure parser', () => {
    function buildOk(json: unknown): Result<DiarizationResult> {
        return parseResponse({
            status: 200,
            text: JSON.stringify(json),
            json,
            headers: {},
            arrayBuffer: new ArrayBuffer(0),
        } as any);
    }

    it('returns ok for fixture', () => {
        const r = buildOk(fixtureJson);
        expect(r.ok).toBe(true);
    });

    it('reports unknown cost when duration is missing', () => {
        const r = buildOk({
            metadata: {},
            results: {
                channels: [{ alternatives: [], detected_language: 'en' }],
                utterances: [
                    { start: 0, end: 1, transcript: 'hi', confidence: 0.9, channel: 0, words: [], speaker: 0 },
                ],
            },
        });
        expect(r.ok).toBe(true);
        if (!r.ok) throw new Error('unreachable');
        expect(r.value.cost).toEqual({ kind: 'unknown' });
    });

    it('handles utterances without speaker (no label assigned)', () => {
        const r = buildOk({
            metadata: { duration: 5 },
            results: {
                channels: [{ alternatives: [], detected_language: 'en' }],
                utterances: [
                    { start: 0, end: 1, transcript: 'no-speaker', confidence: 0.9, channel: 0, words: [] },
                ],
            },
        });
        expect(r.ok).toBe(true);
        if (!r.ok) throw new Error('unreachable');
        expect(r.value.labelled.segments[0].speaker).toBeUndefined();
        expect(r.value.labelled.speakers).toEqual([]);
    });
});
