import { describe, it, expect, vi, beforeEach } from 'vitest';

const requests: Array<{ body: ArrayBuffer }> = [];
vi.mock('obsidian', async (orig) => ({
    ...(await orig<Record<string, unknown>>()),
    requestUrl: vi.fn(async (param: { body: ArrayBuffer }) => {
        requests.push({ body: param.body });
        return { status: 200, json: { text: 'hello' }, text: '', headers: {} };
    }),
}));

vi.stubGlobal('window', globalThis);

import { transcribeAudioFromData, SUPPORTED_AUDIO_FORMATS } from '../src/services/audioTranscriptionService';

const header = (): string => new TextDecoder().decode(new Uint8Array(requests[requests.length - 1].body).slice(0, 300));

describe('transcribeAudioFromData multipart content type', () => {
    beforeEach(() => { requests.length = 0; });

    it('defaults to audio/mpeg when no extension is given (every existing caller unchanged)', async () => {
        const r = await transcribeAudioFromData(new Uint8Array([1, 2, 3]), 'clip.mp3', { provider: 'openai', apiKey: 'k' });
        expect(r.success).toBe(true);
        expect(header()).toContain('Content-Type: audio/mpeg');
    });

    it('labels each supported container correctly when the caller names it', async () => {
        const expected: Record<string, string> = {
            mp3: 'audio/mpeg', mp4: 'audio/mp4', m4a: 'audio/mp4', wav: 'audio/wav', webm: 'audio/webm',
            mpeg: 'audio/mpeg', mpga: 'audio/mpeg', oga: 'audio/ogg', ogg: 'audio/ogg',
        };
        for (const ext of SUPPORTED_AUDIO_FORMATS) {
            requests.length = 0;
            await transcribeAudioFromData(new Uint8Array([1, 2, 3]), `clip.${ext}`, { provider: 'openai', apiKey: 'k', extension: ext });
            expect(header(), ext).toContain(`Content-Type: ${expected[ext]}`);
        }
    });
});
