// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/utils/minutesUtils', () => ({
    ensureFolderExists: vi.fn().mockResolvedValue(undefined),
    sanitizeFileName: (n: string) => n,
}));

import {
    synthesizeScriptToMp3,
    generateEpisodeAudio,
    verifyEpisodeAudio,
    computeEpisodeFingerprint,
    generateAudioPodcast,
} from '../src/services/newsletter/newsletterAudioService';
import { sha256Hex } from '../src/services/tts/fingerprint';
import type { TtsEngine } from '../src/services/tts/ttsEngine';
import { makeCatchUpVault } from './helpers/catchUpVault';

const FOLDER = 'AI-Organiser/Newsletter Inbox/Catch-up';
const PATH = `${FOLDER}/catchup-20261023-081502-a1b2-c3d4e5f6.mp3`;

function tone(seconds = 1): Int16Array {
    const out = new Int16Array(24000 * seconds);
    for (let i = 0; i < out.length; i++) out[i] = Math.round(Math.sin((2 * Math.PI * 440 * i) / 24000) * 8000);
    return out;
}
const engine = (fn?: TtsEngine['synthesizeChunk']) => ({ providerId: 'fixture', synthesizeChunk: vi.fn(fn ?? (async () => tone())) }) as TtsEngine & { synthesizeChunk: ReturnType<typeof vi.fn> };

const LONG = Array.from({ length: 3 }, (_, p) => `Paragraph ${p}. ` + 'Synthetic sentence about fictional events. '.repeat(40)).join('\n\n');

let vault: ReturnType<typeof makeCatchUpVault>;
beforeEach(() => { vault = makeCatchUpVault(); });

describe('synthesizeScriptToMp3', () => {
    it('returns bytes and a measured duration without touching the vault', async () => {
        const r = await synthesizeScriptToMp3(engine(), 'A short synthetic script.', 'Charon');
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.bytes.byteLength).toBeGreaterThan(1000);
        expect(r.durationSec).toBeCloseTo(1, 1);
        expect(vault.app.vault.createBinary).not.toHaveBeenCalled();
    });

    it('duration sums across chunks', async () => {
        const e = engine();
        const r = await synthesizeScriptToMp3(e, LONG, 'Charon');
        expect(e.synthesizeChunk.mock.calls.length).toBeGreaterThan(1);
        expect(r.ok && r.durationSec).toBeCloseTo(e.synthesizeChunk.mock.calls.length, 0);
    });

    it('reports progress per chunk', async () => {
        const seen: Array<[number, number]> = [];
        const e = engine();
        await synthesizeScriptToMp3(e, LONG, 'Charon', { onProgress: (d, t) => seen.push([d, t]) });
        const total = e.synthesizeChunk.mock.calls.length;
        expect(seen).toHaveLength(total);
        expect(seen[0]).toEqual([1, total]);
        expect(seen.at(-1)).toEqual([total, total]);
    });

    it('stops at the next chunk when aborted and returns the abort message', async () => {
        const ac = new AbortController();
        const e = engine(async () => { ac.abort(); return tone(); });
        const r = await synthesizeScriptToMp3(e, LONG, 'Charon', { signal: ac.signal });
        expect(r).toEqual({ ok: false, error: 'Aborted' });
        expect(e.synthesizeChunk).toHaveBeenCalledTimes(1);
    });

    it('turns an engine failure into a failure result, never a throw', async () => {
        const r = await synthesizeScriptToMp3(engine(async () => { throw new Error('fixture down'); }), 'x.', 'Charon');
        expect(r.ok).toBe(false);
        expect(!r.ok && r.error).toContain('fixture down');
    });
});

describe('generateEpisodeAudio', () => {
    it('writes the file at the exact path it was given and reports size, duration and hash', async () => {
        const r = await generateEpisodeAudio(vault.app as never, 'A short synthetic script.', { engine: engine(), voice: 'Charon', filePath: PATH, outputFolder: FOLDER });
        expect(r.success).toBe(true);
        expect(r.filePath).toBe(PATH);
        expect(r.bytes).toBe((vault.files.get(PATH) as ArrayBuffer).byteLength);
        expect(r.durationSec).toBeCloseTo(1, 1);
        expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(await verifyEpisodeAudio(vault.app as never, PATH, { bytes: r.bytes, sha256: r.sha256 })).toBe(true);
    });

    it('never prunes: an unrelated earlier episode in the same folder survives', async () => {
        const earlier = `${FOLDER}/catchup-20261020-000000-0000-11111111.mp3`;
        vault.set(earlier, new ArrayBuffer(4));
        await generateEpisodeAudio(vault.app as never, 'Another synthetic script.', { engine: engine(), voice: 'Charon', filePath: PATH, outputFolder: FOLDER });
        expect(vault.exists(earlier)).toBe(true);
        expect(vault.app.fileManager.trashFile).not.toHaveBeenCalled();
    });

    it('refuses to overwrite an existing file (it may be an interrupted partial)', async () => {
        vault.set(PATH, new ArrayBuffer(10));
        const e = engine();
        const r = await generateEpisodeAudio(vault.app as never, 'x.', { engine: e, voice: 'Charon', filePath: PATH, outputFolder: FOLDER });
        expect(r.success).toBe(false);
        expect(r.error).toMatch(/already exists/);
        expect(e.synthesizeChunk).not.toHaveBeenCalled();
        expect(vault.app.vault.createBinary).not.toHaveBeenCalled();
    });

    it('an abort before the write leaves the vault untouched', async () => {
        const ac = new AbortController();
        const e = engine(async () => { ac.abort(); return tone(); });
        const r = await generateEpisodeAudio(vault.app as never, 'x.', { engine: e, voice: 'Charon', filePath: PATH, outputFolder: FOLDER, signal: ac.signal });
        expect(r.success).toBe(false);
        expect(vault.exists(PATH)).toBe(false);
    });

    it('a vault write failure is a failure result, not a throw', async () => {
        vault.app.vault.createBinary.mockRejectedValueOnce(new Error('disk full'));
        const r = await generateEpisodeAudio(vault.app as never, 'x.', { engine: engine(), voice: 'Charon', filePath: PATH, outputFolder: FOLDER });
        expect(r).toEqual({ success: false, error: 'disk full' });
    });
});

describe('verifyEpisodeAudio', () => {
    it('fails closed on anything it cannot prove', async () => {
        vault.set(PATH, new ArrayBuffer(8));
        expect(await verifyEpisodeAudio(vault.app as never, PATH, {})).toBe(false);
        expect(await verifyEpisodeAudio(vault.app as never, PATH, { bytes: 8 })).toBe(false);
        expect(await verifyEpisodeAudio(vault.app as never, PATH, { sha256: 'ab' })).toBe(false);
        expect(await verifyEpisodeAudio(vault.app as never, `${FOLDER}/none.mp3`, { bytes: 8, sha256: 'ab' })).toBe(false);
    });

    it('detects truncation and corruption', async () => {
        const r = await generateEpisodeAudio(vault.app as never, 'x.', { engine: engine(), voice: 'Charon', filePath: PATH, outputFolder: FOLDER });
        const whole = vault.files.get(PATH) as ArrayBuffer;
        vault.set(PATH, whole.slice(0, whole.byteLength - 10));
        expect(await verifyEpisodeAudio(vault.app as never, PATH, { bytes: r.bytes, sha256: r.sha256 })).toBe(false);
        const flipped = new Uint8Array(whole.slice(0));
        flipped[100] ^= 0xff;
        vault.set(PATH, flipped.buffer);
        expect(await verifyEpisodeAudio(vault.app as never, PATH, { bytes: r.bytes, sha256: r.sha256 })).toBe(false);
    });
});

describe('fingerprints', () => {
    it('an episode fingerprint changes with the provider; the legacy one does not exist for it', async () => {
        const a = await computeEpisodeFingerprint('s', 'Charon', 'gemini', 'm');
        const b = await computeEpisodeFingerprint('s', 'Charon', 'azure-openai', 'm');
        expect(a).not.toBe(b);
        expect(a).toBe(await sha256Hex(['s', 'Charon', 'gemini', 'm']));
    });

    it('leaves the LEGACY fingerprint inputs untouched: [script, voice, model] only', async () => {
        const legacy = await generateAudioPodcast(vault.app as never, 'S.', {
            apiKey: 'k', voice: 'Charon', outputFolder: 'AI-Organiser/Newsletter Inbox/2026-04-23', dateStr: '2026-04-23',
            engine: engine(), modelId: 'fixture-model',
        } as never);
        const fp = (await sha256Hex(['S.', 'Charon', 'fixture-model'])).slice(0, 8);
        expect(legacy.filePath).toBe(`AI-Organiser/Newsletter Inbox/2026-04-23/brief-2026-04-23-${fp}.mp3`);
    });
});
