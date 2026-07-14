// @vitest-environment happy-dom
/**
 * Azure Speech Fast Transcription diarization adapter tests (azure-audio Phase 2).
 *
 * Fixture-driven: tests/fixtures/azureSpeech/fast-transcription-2speaker.json
 * mirrors the live-verified response shape (plan §A, 2026-06-08). The standard
 * matrix (plan §9): success · provider-error body · malformed/empty · abort ·
 * invalid/missing config · size preflight. The multipart `definition` gotcha
 * (inline application/json part) is asserted against the raw request body.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const mockRequestUrl = vi.fn();
vi.mock('obsidian', async () => {
    const actual = await vi.importActual('./mocks/obsidian');
    return {
        ...actual,
        requestUrl: (...args: unknown[]) => mockRequestUrl(...args),
    };
});

import {
    AzureSpeechDiarizationAdapter,
    parseFastTranscription,
} from '../src/services/diarization/azureSpeechDiarizationAdapter';
import { DEEPGRAM_MAX_FILE_BYTES } from '../src/services/diarization/types';
import { normalizeSpeechLocale } from '../src/services/audioTranscriptionService';
import { PLUGIN_SECRET_IDS } from '../src/core/secretIds';

const FIXTURE = JSON.parse(fs.readFileSync(
    path.join(__dirname, 'fixtures', 'azureSpeech', 'fast-transcription-2speaker.json'), 'utf-8',
));

const SPEECH_EP = 'https://res.cognitiveservices.azure.com';

function makePlugin(overrides: Record<string, unknown> = {}): any {
    return {
        settings: {
            cloudServiceType: 'azure-claude',
            azureSpeechEndpoint: SPEECH_EP,
            azureSpeechRegion: 'swedencentral',
            azureSpeechVoice: 'en-US-AvaNeural',
            azureSpeechMaxSpeakers: 4,
            azureSpeechRequired: false,
            azureApiKey: '',
            ...overrides,
        },
        secretStorageService: {
            isAvailable: () => true,
            getSecret: async (id: string) =>
                id === PLUGIN_SECRET_IDS.AZURE_SPEECH ? 'SPEECH-KEY' : null,
            resolveApiKey: async () => null,
        },
    };
}

function makeApp(): any { return { vault: {} }; }
function bytes(n = 2048): ArrayBuffer { return new ArrayBuffer(n); }

function okResponse(json: unknown, status = 200): any {
    return { status, text: JSON.stringify(json), json, headers: {}, arrayBuffer: new ArrayBuffer(0) };
}

/** Decode the multipart body (string + binary parts) for assertions. */
function bodyText(call: { body: ArrayBuffer }): string {
    return new TextDecoder('utf-8', { fatal: false }).decode(call.body);
}

describe('AzureSpeechDiarizationAdapter — happy path (verified §A fixture)', () => {
    let adapter: AzureSpeechDiarizationAdapter;

    beforeEach(() => {
        mockRequestUrl.mockReset();
        adapter = new AzureSpeechDiarizationAdapter(makePlugin());
    });

    it('parses the 2-speaker fixture into a LabelledTimedTranscript', async () => {
        mockRequestUrl.mockResolvedValueOnce(okResponse(FIXTURE));
        const r = await adapter.transcribeWithDiarization(makeApp(), bytes(), { filename: 'board.mp3' });
        expect(r.ok).toBe(true);
        if (!r.ok) throw new Error('unreachable');
        const v = r.value;
        expect(v.provider).toBe('azure-speech');
        expect(v.detectedLanguage).toBe('en-US');
        expect(v.labelled.speakers).toEqual(['Speaker 1', 'Speaker 2']);
        expect(v.labelled.segments.length).toBe(4);
        expect(v.labelled.segments[0]).toMatchObject({
            startMs: 160, endMs: 2640, speaker: 'Speaker 1',
        });
        expect(v.durationSec).toBeCloseTo(16.48, 3);
        expect(v.transcriptText).toContain('budget review');
    });

    it('cost is typed unknown (account-level billing, M6)', async () => {
        mockRequestUrl.mockResolvedValueOnce(okResponse(FIXTURE));
        const r = await adapter.transcribeWithDiarization(makeApp(), bytes());
        expect(r.ok).toBe(true);
        if (!r.ok) throw new Error('unreachable');
        expect(r.value.cost).toEqual({ kind: 'unknown' });
    });

    it('POSTs to the :transcribe endpoint with Ocp-Apim-Subscription-Key', async () => {
        mockRequestUrl.mockResolvedValueOnce(okResponse(FIXTURE));
        await adapter.transcribeWithDiarization(makeApp(), bytes(), { filename: 'a.wav' });
        const call = mockRequestUrl.mock.calls[0][0];
        expect(call.url).toBe(`${SPEECH_EP}/speechtotext/transcriptions:transcribe?api-version=2025-10-15`);
        expect(call.headers['Ocp-Apim-Subscription-Key']).toBe('SPEECH-KEY');
        expect(call.headers['Content-Type']).toMatch(/^multipart\/form-data; boundary=/);
    });

    it('definition is an INLINE application/json part with diarization enabled (§A gotcha)', async () => {
        mockRequestUrl.mockResolvedValueOnce(okResponse(FIXTURE));
        await adapter.transcribeWithDiarization(makeApp(), bytes(), { languageHint: 'en' });
        const text = bodyText(mockRequestUrl.mock.calls[0][0]);
        // Inline JSON part — name="definition", its own Content-Type, NOT a file attachment.
        expect(text).toMatch(/Content-Disposition: form-data; name="definition"\r\nContent-Type: application\/json/);
        expect(text).not.toMatch(/name="definition"; filename=/);
        const defMatch = /name="definition"\r\nContent-Type: application\/json\r\n\r\n(\{.*?\})\r\n/s.exec(text);
        expect(defMatch).toBeTruthy();
        const def = JSON.parse(defMatch![1]);
        expect(def.diarization).toEqual({ enabled: true, maxSpeakers: 4 });
        // BCP-47 normalization (§2e): 'en' → 'en-US'
        expect(def.locales).toEqual(['en-US']);
    });

    it('omits locales for auto language identification when no hint', async () => {
        mockRequestUrl.mockResolvedValueOnce(okResponse(FIXTURE));
        await adapter.transcribeWithDiarization(makeApp(), bytes());
        const text = bodyText(mockRequestUrl.mock.calls[0][0]);
        const defMatch = /name="definition"\r\nContent-Type: application\/json\r\n\r\n(\{.*?\})\r\n/s.exec(text);
        const def = JSON.parse(defMatch![1]);
        expect(def.locales).toBeUndefined();
    });

    it('clamps maxSpeakers from settings (1–10)', async () => {
        mockRequestUrl.mockResolvedValueOnce(okResponse(FIXTURE));
        const a = new AzureSpeechDiarizationAdapter(makePlugin({ azureSpeechMaxSpeakers: 99 }));
        await a.transcribeWithDiarization(makeApp(), bytes());
        const text = bodyText(mockRequestUrl.mock.calls[0][0]);
        expect(text).toContain('"maxSpeakers":10');
    });
});

describe('AzureSpeechDiarizationAdapter — config + error matrix', () => {
    beforeEach(() => mockRequestUrl.mockReset());

    it('empty audio → empty-audio (no egress)', async () => {
        const a = new AzureSpeechDiarizationAdapter(makePlugin());
        const r = await a.transcribeWithDiarization(makeApp(), new ArrayBuffer(0));
        expect(r).toEqual({ ok: false, error: 'empty-audio' });
        expect(mockRequestUrl).not.toHaveBeenCalled();
    });

    it('over-cap audio → file-too-large BEFORE any egress (G3/G4 single-call cap)', async () => {
        const a = new AzureSpeechDiarizationAdapter(makePlugin());
        const big = new ArrayBuffer(DEEPGRAM_MAX_FILE_BYTES + 1);
        const r = await a.transcribeWithDiarization(makeApp(), big);
        expect(r.ok).toBe(false);
        if (r.ok) throw new Error('unreachable');
        expect(r.error).toMatch(/^file-too-large:/);
        expect(mockRequestUrl).not.toHaveBeenCalled();
    });

    it('missing endpoint → no-endpoint (D10 — never a guessed string)', async () => {
        const a = new AzureSpeechDiarizationAdapter(makePlugin({ azureSpeechEndpoint: '' }));
        const r = await a.transcribeWithDiarization(makeApp(), bytes());
        expect(r).toEqual({ ok: false, error: 'no-endpoint' });
        expect(mockRequestUrl).not.toHaveBeenCalled();
    });

    it('host-anchored endpoint rejection (R2-M2)', async () => {
        const a = new AzureSpeechDiarizationAdapter(makePlugin({
            azureSpeechEndpoint: 'https://res.cognitiveservices.azure.com.attacker.com',
        }));
        const r = await a.transcribeWithDiarization(makeApp(), bytes());
        expect(r).toEqual({ ok: false, error: 'bad-endpoint' });
        expect(mockRequestUrl).not.toHaveBeenCalled();
    });

    it('no key anywhere → no-key', async () => {
        const plugin = makePlugin();
        plugin.secretStorageService.getSecret = async () => null;
        const a = new AzureSpeechDiarizationAdapter(plugin);
        const r = await a.transcribeWithDiarization(makeApp(), bytes());
        expect(r).toEqual({ ok: false, error: 'no-key' });
    });

    it('provider error body → typed http error (no retry on 4xx)', async () => {
        mockRequestUrl.mockResolvedValueOnce({ status: 400, text: '{"error":"bad audio"}', json: undefined, headers: {} });
        const a = new AzureSpeechDiarizationAdapter(makePlugin());
        const r = await a.transcribeWithDiarization(makeApp(), bytes());
        expect(r.ok).toBe(false);
        if (r.ok) throw new Error('unreachable');
        expect(r.error).toMatch(/^http-400/);
        expect(mockRequestUrl).toHaveBeenCalledTimes(1);
    });

    it('empty/malformed 200 body → malformed-response', async () => {
        mockRequestUrl.mockResolvedValueOnce({ status: 200, text: '', json: null, headers: {} });
        const a = new AzureSpeechDiarizationAdapter(makePlugin());
        const r = await a.transcribeWithDiarization(makeApp(), bytes());
        expect(r).toEqual({ ok: false, error: 'malformed-response' });
    });

    it('200 with no phrases → no-phrases', async () => {
        mockRequestUrl.mockResolvedValueOnce(okResponse({ combinedPhrases: [{ text: 'x' }] }));
        const a = new AzureSpeechDiarizationAdapter(makePlugin());
        const r = await a.transcribeWithDiarization(makeApp(), bytes());
        expect(r).toEqual({ ok: false, error: 'no-phrases' });
    });

    it('pre-aborted signal → aborted (no egress)', async () => {
        const ctrl = new AbortController();
        ctrl.abort();
        const a = new AzureSpeechDiarizationAdapter(makePlugin());
        const r = await a.transcribeWithDiarization(makeApp(), bytes(), { signal: ctrl.signal });
        expect(r).toEqual({ ok: false, error: 'aborted' });
        expect(mockRequestUrl).not.toHaveBeenCalled();
    });
});

describe('parseFastTranscription — pure parser', () => {
    it('phrases without speaker get no label', () => {
        const r = parseFastTranscription({
            durationMilliseconds: 1000,
            combinedPhrases: [{ text: 'hello' }],
            phrases: [{ offsetMilliseconds: 0, durationMilliseconds: 1000, text: 'hello' }],
        });
        expect(r.ok).toBe(true);
        if (!r.ok) throw new Error('unreachable');
        expect(r.value.labelled.segments[0].speaker).toBeUndefined();
        expect(r.value.labelled.speakers).toEqual([]);
    });

    it('falls back to joined phrase text when combinedPhrases absent', () => {
        const r = parseFastTranscription({
            phrases: [
                { offsetMilliseconds: 0, durationMilliseconds: 500, text: 'a', speaker: 1 },
                { offsetMilliseconds: 500, durationMilliseconds: 500, text: 'b', speaker: 2 },
            ],
        });
        expect(r.ok).toBe(true);
        if (!r.ok) throw new Error('unreachable');
        expect(r.value.transcriptText).toBe('a b');
        // duration falls back to last segment end
        expect(r.value.durationSec).toBe(1);
    });

    it('language falls back to und when no locale present', () => {
        const r = parseFastTranscription({
            phrases: [{ offsetMilliseconds: 0, durationMilliseconds: 100, text: 'x' }],
        });
        expect(r.ok).toBe(true);
        if (!r.ok) throw new Error('unreachable');
        expect(r.value.detectedLanguage).toBe('und');
    });
});

describe('normalizeSpeechLocale (§2e)', () => {
    it('maps short codes to regioned BCP-47', () => {
        expect(normalizeSpeechLocale('en')).toBe('en-US');
        expect(normalizeSpeechLocale('fi')).toBe('fi-FI');
        expect(normalizeSpeechLocale('sv')).toBe('sv-SE');
    });
    it('passes through already-regioned tags', () => {
        expect(normalizeSpeechLocale('en-GB')).toBe('en-GB');
        expect(normalizeSpeechLocale('zh-CN')).toBe('zh-CN');
    });
    it('returns null for unknown/empty input (caller omits locales)', () => {
        expect(normalizeSpeechLocale('xx')).toBeNull();
        expect(normalizeSpeechLocale('')).toBeNull();
        expect(normalizeSpeechLocale(undefined)).toBeNull();
    });
});
