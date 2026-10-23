// @vitest-environment happy-dom
/**
 * Legacy `generateAudioPodcast` characterization.
 *
 * Captured against the UNCHANGED service before the shared synthesis core was extracted for
 * catch-up episodes. A `daily` install must keep the same file name, fingerprint inputs,
 * pruning, error strings and — the strongest check — the same MP3 bytes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/utils/minutesUtils', () => ({
    ensureFolderExists: vi.fn().mockResolvedValue(undefined),
    sanitizeFileName: (n: string) => n,
}));

import { generateAudioPodcast } from '../src/services/newsletter/newsletterAudioService';
import { sha256Hex } from '../src/services/tts/fingerprint';
import type { TtsEngine } from '../src/services/tts/ttsEngine';
import { makeCatchUpVault } from './helpers/catchUpVault';

const FOLDER = 'AI-Organiser/Newsletter Inbox/2026-04-23';
const DATE = '2026-04-23';

/** One second of a deterministic 440 Hz tone at the 24 kHz engine contract. */
function tone(seconds = 1): Int16Array {
    const out = new Int16Array(24000 * seconds);
    for (let i = 0; i < out.length; i++) out[i] = Math.round(Math.sin((2 * Math.PI * 440 * i) / 24000) * 8000);
    return out;
}

function engine(over: Partial<TtsEngine> = {}): TtsEngine & { synthesizeChunk: ReturnType<typeof vi.fn> } {
    return {
        providerId: 'fixture',
        synthesizeChunk: vi.fn(async () => tone()),
        ...over,
    } as never;
}

async function sha256Bytes(buf: ArrayBuffer): Promise<string> {
    const h = await crypto.subtle.digest('SHA-256', buf);
    return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const SCRIPT = 'Good morning. This is a short synthetic briefing about invented events.';
// Three paragraphs long enough to force more than one TTS chunk.
const LONG_SCRIPT = Array.from({ length: 3 }, (_, p) => `Paragraph ${p}. ` + 'Synthetic sentence about fictional events. '.repeat(40)).join('\n\n');

let vault: ReturnType<typeof makeCatchUpVault>;
beforeEach(() => { vault = makeCatchUpVault(); });

const run = (script: string, over: Record<string, unknown> = {}) =>
    generateAudioPodcast(vault.app as never, script, {
        apiKey: 'unused',
        voice: 'Charon',
        outputFolder: FOLDER,
        dateStr: DATE,
        engine: over.engine as TtsEngine ?? engine(),
        modelId: 'fixture-model',
        ...over,
    } as never);

describe('generateAudioPodcast — legacy behaviour', () => {
    it('names the file brief-<date>-<fp8>.mp3 from [script, voice, model]', async () => {
        const fp = (await sha256Hex([SCRIPT, 'Charon', 'fixture-model'])).slice(0, 8);
        const res = await run(SCRIPT);
        expect(res).toEqual({ success: true, filePath: `${FOLDER}/brief-${DATE}-${fp}.mp3` });
        expect(vault.exists(`${FOLDER}/brief-${DATE}-${fp}.mp3`)).toBe(true);
    });

    it('a different voice or model gives a different file name', async () => {
        const a = await run(SCRIPT);
        const b = await run(SCRIPT, { voice: 'Puck' });
        const c = await run(SCRIPT, { modelId: 'other-model' });
        expect(new Set([a.filePath, b.filePath, c.filePath]).size).toBe(3);
    });

    it('is idempotent: an existing file means no synthesis at all', async () => {
        const e = engine();
        await run(SCRIPT, { engine: e });
        e.synthesizeChunk.mockClear();
        const again = await run(SCRIPT, { engine: e });
        expect(again.success).toBe(true);
        expect(e.synthesizeChunk).not.toHaveBeenCalled();
        expect(vault.app.vault.createBinary).toHaveBeenCalledTimes(1);
    });

    it('synthesises one chunk per split and passes the voice through', async () => {
        const e = engine();
        await run(LONG_SCRIPT, { engine: e });
        expect(e.synthesizeChunk.mock.calls.length).toBeGreaterThan(1);
        for (const call of e.synthesizeChunk.mock.calls) expect(call[1]).toBe('Charon');
    });

    it('prunes stale same-date files (other fingerprint, legacy wav) but leaves other dates alone', async () => {
        vault.set(`${FOLDER}/brief-${DATE}-deadbeef.mp3`, new ArrayBuffer(4));
        vault.set(`${FOLDER}/brief-${DATE}-cafef00d.wav`, new ArrayBuffer(4));
        vault.set(`${FOLDER}/brief-2026-04-22-deadbeef.mp3`, new ArrayBuffer(4));
        const res = await run(SCRIPT);
        expect(vault.exists(`${FOLDER}/brief-${DATE}-deadbeef.mp3`)).toBe(false);
        expect(vault.exists(`${FOLDER}/brief-${DATE}-cafef00d.wav`)).toBe(false);
        expect(vault.exists(`${FOLDER}/brief-2026-04-22-deadbeef.mp3`)).toBe(true);
        expect(vault.exists(res.filePath!)).toBe(true);
    });

    it('produces byte-identical MP3 output for identical samples (golden hash)', async () => {
        const res = await run(SCRIPT);
        const bytes = vault.files.get(res.filePath!) as ArrayBuffer;
        expect(bytes.byteLength).toBeGreaterThan(1000);
        expect(await sha256Bytes(bytes)).toBe('73087440f903a410bfd425f3a876c4c99a140cafdcd09ee58ff9aa73634f124e');
    });

    it('multi-chunk output is byte-identical to the pre-refactor service (golden hash)', async () => {
        // Captured from the service as it was BEFORE the shared synthesis core was extracted
        // (5d9882e^), so chunk joining, trimming and gap handling are pinned, not just one chunk.
        const e = engine();
        const res = await run(LONG_SCRIPT, { engine: e });
        expect(e.synthesizeChunk.mock.calls.length).toBeGreaterThan(1);
        const bytes = vault.files.get(res.filePath!) as ArrayBuffer;
        expect(bytes.byteLength).toBe(18576);
        expect(await sha256Bytes(bytes)).toBe('3d7d13e8b131e41656f51ea1a725e40c412835feb37b2e0f0e81b17a222472fc');
    });

    describe('failures never escape the result contract', () => {
        it('an aborted signal returns the abort message and writes nothing', async () => {
            const ac = new AbortController();
            ac.abort();
            const res = await run(SCRIPT, { signal: ac.signal });
            expect(res.success).toBe(false);
            expect(res.error).toBe('Aborted');
            expect(vault.app.vault.createBinary).not.toHaveBeenCalled();
        });

        it('an engine failure is reported with its message and writes nothing', async () => {
            const e = engine({ synthesizeChunk: vi.fn().mockRejectedValue(new Error('fixture tts down')) as never });
            const res = await run(SCRIPT, { engine: e });
            expect(res.success).toBe(false);
            expect(res.error).toContain('fixture tts down');
            expect(vault.app.vault.createBinary).not.toHaveBeenCalled();
        });

        it('a vault write failure is reported, not thrown', async () => {
            vault.app.vault.createBinary.mockRejectedValueOnce(new Error('disk full'));
            const res = await run(SCRIPT);
            expect(res).toEqual({ success: false, error: 'disk full' });
        });
    });
});
