// @vitest-environment happy-dom
/**
 * Unit tests for src/ui/coordinators/AudioPreviewSource (plan F1 foundation, R1 M2).
 *
 * Coverage:
 *  - vault source: app.vault.getResourcePath URL, no-op dispose
 *  - desktop-path: file:// URL formatting (POSIX + Windows), no-op dispose
 *  - webview-blob / recorder: URL.createObjectURL + revokeObjectURL on dispose
 *  - idempotent dispose: calling twice doesn't double-revoke
 *  - revoke errors are swallowed
 */

vi.mock('obsidian', async () => {
    const mod = await import('./mocks/obsidian');
    return mod;
});

import { App, TFile } from 'obsidian';
import { resolvePreview } from '../src/ui/coordinators/AudioPreviewSource';
import type { AudioSource } from '../src/ui/components/speakerReviewState';

function makeApp(getResourcePath: (file: TFile) => string): App {
    return {
        vault: {
            getResourcePath,
        },
        workspace: {},
    } as unknown as App;
}

function makeTFile(path: string): TFile {
    const f = Object.create(TFile.prototype) as TFile;
    (f as { path: string }).path = path;
    return f;
}

describe('resolvePreview', () => {
    let createObjectURLSpy: ReturnType<typeof vi.spyOn>;
    let revokeObjectURLSpy: ReturnType<typeof vi.spyOn>;
    let urlCounter = 0;

    beforeEach(() => {
        urlCounter = 0;
        createObjectURLSpy = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
            urlCounter += 1;
            return `blob:fake-${urlCounter}`;
        });
        revokeObjectURLSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {
            /* no-op */
        });
    });

    afterEach(() => {
        createObjectURLSpy.mockRestore();
        revokeObjectURLSpy.mockRestore();
    });

    it('vault source uses app.vault.getResourcePath and has no-op dispose', () => {
        const file = makeTFile('audio/meeting.m4a');
        const app = makeApp((f) => `app://local/${f.path}`);
        const source: AudioSource = { kind: 'vault', file };

        const handle = resolvePreview(source, app);

        expect(handle.url).toBe('app://local/audio/meeting.m4a');
        // dispose should not call revoke (vault sources own no object URL)
        handle.dispose();
        expect(revokeObjectURLSpy).not.toHaveBeenCalled();
    });

    it('desktop-path formats Windows paths as file:/// with drive letter', () => {
        const source: AudioSource = {
            kind: 'desktop-path',
            absolutePath: 'C:\\Users\\Alice\\standup.m4a',
            displayName: 'standup.m4a',
        };

        const handle = resolvePreview(source, makeApp(() => ''));

        expect(handle.url).toBe('file:///C:/Users/Alice/standup.m4a');
        handle.dispose();
        expect(revokeObjectURLSpy).not.toHaveBeenCalled();
    });

    it('desktop-path formats POSIX paths as file:// with leading slash', () => {
        const source: AudioSource = {
            kind: 'desktop-path',
            absolutePath: '/home/user/recording.mp3',
            displayName: 'recording.mp3',
        };

        const handle = resolvePreview(source, makeApp(() => ''));

        expect(handle.url).toBe('file:///home/user/recording.mp3');
        handle.dispose();
        expect(revokeObjectURLSpy).not.toHaveBeenCalled();
    });

    it('desktop-path encodes special characters in path', () => {
        const source: AudioSource = {
            kind: 'desktop-path',
            absolutePath: '/home/user/meeting with spaces.m4a',
            displayName: 'meeting.m4a',
        };

        const handle = resolvePreview(source, makeApp(() => ''));

        expect(handle.url).toBe('file:///home/user/meeting%20with%20spaces.m4a');
    });

    it('webview-blob creates an object URL and revokes on dispose', () => {
        const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/mp4' });
        const source: AudioSource = {
            kind: 'webview-blob',
            blob,
            displayName: 'mobile.m4a',
            mimeType: 'audio/mp4',
        };

        const handle = resolvePreview(source, makeApp(() => ''));

        expect(createObjectURLSpy).toHaveBeenCalledWith(blob);
        expect(handle.url).toBe('blob:fake-1');

        handle.dispose();
        expect(revokeObjectURLSpy).toHaveBeenCalledWith('blob:fake-1');
    });

    it('recorder source uses the same blob URL machinery', () => {
        const blob = new Blob([new Uint8Array([4, 5, 6])], { type: 'audio/webm' });
        const source: AudioSource = {
            kind: 'recorder',
            blob,
            displayName: 'recording.webm',
            mimeType: 'audio/webm',
            durationMs: 1200,
        };

        const handle = resolvePreview(source, makeApp(() => ''));

        expect(handle.url).toBe('blob:fake-1');
        handle.dispose();
        expect(revokeObjectURLSpy).toHaveBeenCalledOnce();
    });

    it('dispose is idempotent — calling twice revokes once', () => {
        const blob = new Blob([new Uint8Array([1])], { type: 'audio/mp4' });
        const source: AudioSource = {
            kind: 'webview-blob',
            blob,
            displayName: 'x.m4a',
            mimeType: 'audio/mp4',
        };

        const handle = resolvePreview(source, makeApp(() => ''));
        handle.dispose();
        handle.dispose();
        handle.dispose();

        expect(revokeObjectURLSpy).toHaveBeenCalledTimes(1);
    });

    it('swallows revoke errors (e.g. URL already revoked by browser)', () => {
        revokeObjectURLSpy.mockImplementation(() => {
            throw new Error('already revoked');
        });
        const blob = new Blob([new Uint8Array([1])], { type: 'audio/mp4' });
        const source: AudioSource = {
            kind: 'webview-blob',
            blob,
            displayName: 'x.m4a',
            mimeType: 'audio/mp4',
        };

        const handle = resolvePreview(source, makeApp(() => ''));

        expect(() => handle.dispose()).not.toThrow();
    });
});
