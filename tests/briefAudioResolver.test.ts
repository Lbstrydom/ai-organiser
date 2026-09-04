import { describe, it, expect } from 'vitest';
import { resolveBriefAudioBucket } from '../src/services/newsletter/briefAudioResolver';

const ROOT = 'AI-Organiser/Newsletter Inbox';
const digestPathForDate = (d: string) => `${ROOT}/Digest — ${d}.md`;
const resolve = (sourcePath: string, audioSrc: string) =>
    resolveBriefAudioBucket({ sourcePath, audioSrc, digestPathForDate });

describe('resolveBriefAudioBucket', () => {
    it('resolves a genuine digest + brief audio pair', () => {
        expect(resolve(digestPathForDate('2026-09-01'), 'app://local/brief-abc123.wav'))
            .toEqual({ bucketDate: '2026-09-01', audioBasename: 'brief-abc123.wav' });
    });

    it('accepts mp3 as well as wav', () => {
        expect(resolve(digestPathForDate('2026-09-01'), 'brief-x.mp3')?.audioBasename).toBe('brief-x.mp3');
    });

    it('rejects a note in the wrong folder', () => {
        expect(resolve('Some Other Folder/Digest — 2026-09-01.md', 'brief-a.wav')).toBeNull();
    });

    it('rejects a nested subfolder that is not the digest path', () => {
        expect(resolve(`${ROOT}/2026-09-01/Digest — 2026-09-01.md`, 'brief-a.wav')).toBeNull();
    });

    it('rejects a non-digest note that happens to contain a date', () => {
        expect(resolve(`${ROOT}/Notes 2026-09-01.md`, 'brief-a.wav')).toBeNull();
    });

    it('rejects an impossible calendar date', () => {
        expect(resolve(`${ROOT}/Digest — 2026-02-31.md`, 'brief-a.wav')).toBeNull();
    });

    it('rejects audio that is not a brief recording', () => {
        expect(resolve(digestPathForDate('2026-09-01'), 'recording-2026.wav')).toBeNull();
        expect(resolve(digestPathForDate('2026-09-01'), 'brief-a.png')).toBeNull();
    });

    it('normalises backslash separators', () => {
        expect(resolve(`${ROOT}\\Digest — 2026-09-01.md`.replaceAll('/', '\\'), 'brief-a.wav'))
            .toEqual({ bucketDate: '2026-09-01', audioBasename: 'brief-a.wav' });
    });

    it('decodes percent-encoding in the audio src', () => {
        expect(resolve(digestPathForDate('2026-09-01'), 'app://local/brief-my%20file.wav')?.audioBasename)
            .toBe('brief-my file.wav');
    });

    it('strips a query string and fragment', () => {
        expect(resolve(digestPathForDate('2026-09-01'), 'app://local/brief-a.wav?1234#t=10')?.audioBasename)
            .toBe('brief-a.wav');
    });

    it('does not throw on a malformed percent sequence', () => {
        // decodeURIComponent throws on %zz, and this runs inside a markdown
        // post-processor where a throw breaks rendering for the whole note.
        expect(() => resolve(digestPathForDate('2026-09-01'), 'brief-%zz.wav')).not.toThrow();
    });

    it('returns null for empty input', () => {
        expect(resolve('', 'brief-a.wav')).toBeNull();
        expect(resolve(digestPathForDate('2026-09-01'), '')).toBeNull();
    });

    it('returns null rather than throwing when the path factory throws', () => {
        expect(resolveBriefAudioBucket({
            sourcePath: digestPathForDate('2026-09-01'),
            audioSrc: 'brief-a.wav',
            digestPathForDate: () => { throw new Error('boom'); },
        })).toBeNull();
    });

    it('tracks a change to the digest naming rule instead of hard-coding it', () => {
        // The resolver asks the supplied factory rather than asserting a shape,
        // so a future folder change propagates automatically.
        const custom = (d: string) => `Custom/Root/Daily ${d}.md`;
        expect(resolveBriefAudioBucket({
            sourcePath: 'Custom/Root/Daily 2026-09-01.md',
            audioSrc: 'brief-a.wav',
            digestPathForDate: custom,
        })).toEqual({ bucketDate: '2026-09-01', audioBasename: 'brief-a.wav' });
    });
});
