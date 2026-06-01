/**
 * Unit tests for src/services/audio/audioImportService (plan F1 wire, R2 H2).
 *
 * Coverage:
 *  - vault source: pass-through with imported=false
 *  - desktop-path: fs.readFile → vault.createBinary; missing fs → desktop-fs-unavailable
 *  - webview-blob: blob.arrayBuffer() → vault.createBinary
 *  - recorder: same path as webview-blob
 *  - MIME validation: rejects non-audio MIME with non-audio extension
 *  - MIME validation: accepts octet-stream when extension is whitelisted
 *  - Collision handling: getAvailableFilePath used (existing file → (2) suffix)
 *  - Abort: pre-write abort → returns 'aborted', no write attempted
 *  - Abort: post-write abort → file trashed via fileManager.trashFile
 */

vi.mock('obsidian', async () => {
    const mod = await import('./mocks/obsidian');
    return mod;
});

import { App, TFile } from 'obsidian';
import { importAudioToVault } from '../src/services/audio/audioImportService';
import type { AudioSource } from '../src/ui/components/speakerReviewState';

const makeReadFileSpy = vi.fn();
function setRequireImpl(impl: ((mod: string) => unknown) | null): void {
    if (impl === null) {
        delete (globalThis as { require?: unknown }).require;
    } else {
        (globalThis as { require?: (mod: string) => unknown }).require = impl;
    }
}

function makeFsAvailable(): void {
    setRequireImpl((mod: string) => {
        if (mod === 'fs') return { promises: { readFile: makeReadFileSpy } };
        if (mod === 'path') return { basename: (p: string) => p.split(/[\\/]/).pop() ?? p };
        throw new Error(`unexpected require: ${mod}`);
    });
}

function makeTFile(path: string, ext: string, name: string): TFile {
    const f = Object.create(TFile.prototype) as TFile;
    (f as { path: string }).path = path;
    (f as { extension: string }).extension = ext;
    (f as { name: string }).name = name;
    return f;
}

function makeApp(opts?: {
    existing?: Set<string>;
    createBinaryImpl?: (path: string, data: ArrayBuffer) => Promise<TFile>;
    trashFileSpy?: ReturnType<typeof vi.fn>;
}): App {
    const existing = opts?.existing ?? new Set<string>();
    const createBinary =
        opts?.createBinaryImpl ??
        ((path: string) =>
            Promise.resolve(makeTFile(path, path.split('.').pop() ?? '', path.split('/').pop() ?? '')));
    return {
        vault: {
            getAbstractFileByPath: (p: string) => (existing.has(p) ? ({} as unknown) : null),
            createFolder: vi.fn().mockResolvedValue(undefined),
            createBinary,
        },
        fileManager: {
            trashFile: opts?.trashFileSpy ?? vi.fn().mockResolvedValue(undefined),
        },
        workspace: {},
    } as unknown as App;
}

describe('importAudioToVault', () => {
    afterEach(() => {
        setRequireImpl(null);
        makeReadFileSpy.mockReset();
        vi.restoreAllMocks();
    });

    it('returns vault source unchanged with imported=false', async () => {
        const existing = makeTFile('audio/meeting.m4a', 'm4a', 'meeting.m4a');
        const source: AudioSource = { kind: 'vault', file: existing };

        const result = await importAudioToVault(makeApp(), source, { targetFolder: 'Imports' });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.file).toBe(existing);
        expect(result.value.imported).toBe(false);
        expect(result.value.origin).toBe('vault');
    });

    it('reads desktop-path via fs and writes to vault', async () => {
        const bytes = Uint8Array.from([1, 2, 3, 4]);
        makeReadFileSpy.mockResolvedValue(Buffer.from(bytes));
        makeFsAvailable();

        const createBinary = vi.fn((path: string, _data: ArrayBuffer) =>
            Promise.resolve(makeTFile(path, 'm4a', 'standup.m4a'))
        );
        const app = makeApp({ createBinaryImpl: createBinary });

        const source: AudioSource = {
            kind: 'desktop-path',
            absolutePath: 'C:/meetings/standup.m4a',
            displayName: 'standup.m4a',
        };
        const result = await importAudioToVault(app, source, { targetFolder: 'Imports' });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.imported).toBe(true);
        expect(result.value.origin).toBe('desktop-path');
        expect(createBinary).toHaveBeenCalledOnce();
        const [path, data] = createBinary.mock.calls[0];
        expect(path).toBe('Imports/standup.m4a');
        expect(new Uint8Array(data as ArrayBuffer)).toEqual(bytes);
    });

    it('returns desktop-fs-unavailable when fs is missing (mobile)', async () => {
        setRequireImpl(null);
        const source: AudioSource = {
            kind: 'desktop-path',
            absolutePath: '/tmp/audio.m4a',
            displayName: 'audio.m4a',
        };

        const result = await importAudioToVault(makeApp(), source, { targetFolder: 'Imports' });

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error).toBe('desktop-fs-unavailable');
    });

    it('reads webview-blob via Blob.arrayBuffer() and writes to vault', async () => {
        const bytes = Uint8Array.from([9, 8, 7]);
        const blob = new Blob([bytes], { type: 'audio/mp4' });

        const createBinary = vi.fn((path: string, _data: ArrayBuffer) =>
            Promise.resolve(makeTFile(path, 'm4a', 'mobile.m4a'))
        );
        const app = makeApp({ createBinaryImpl: createBinary });

        const source: AudioSource = {
            kind: 'webview-blob',
            blob,
            displayName: 'mobile.m4a',
            mimeType: 'audio/mp4',
        };
        const result = await importAudioToVault(app, source, { targetFolder: 'Imports' });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.origin).toBe('webview-blob');
        expect(result.value.imported).toBe(true);
        const [, data] = createBinary.mock.calls[0];
        expect(new Uint8Array(data as ArrayBuffer)).toEqual(bytes);
    });

    it('handles recorder source via the same blob path', async () => {
        const blob = new Blob([Uint8Array.from([0])], { type: 'audio/webm' });
        const source: AudioSource = {
            kind: 'recorder',
            blob,
            displayName: 'recording.webm',
            mimeType: 'audio/webm',
            durationMs: 1000,
        };

        const result = await importAudioToVault(makeApp(), source, { targetFolder: 'Imports' });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.origin).toBe('recorder');
    });

    it('rejects non-audio MIME with unsupported-mime', async () => {
        const blob = new Blob(['hi'], { type: 'text/plain' });
        const source: AudioSource = {
            kind: 'webview-blob',
            blob,
            displayName: 'notes.txt',
            mimeType: 'text/plain',
        };

        const result = await importAudioToVault(makeApp(), source, { targetFolder: 'Imports' });

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error).toBe('unsupported-mime');
    });

    it('accepts application/octet-stream when extension is whitelisted', async () => {
        const blob = new Blob([Uint8Array.from([1])], { type: 'application/octet-stream' });
        const source: AudioSource = {
            kind: 'webview-blob',
            blob,
            displayName: 'noisy.m4a',
            mimeType: 'application/octet-stream',
        };

        const result = await importAudioToVault(makeApp(), source, { targetFolder: 'Imports' });

        expect(result.ok).toBe(true);
    });

    it('rejects octet-stream when extension is NOT whitelisted', async () => {
        const blob = new Blob([Uint8Array.from([1])], { type: 'application/octet-stream' });
        const source: AudioSource = {
            kind: 'webview-blob',
            blob,
            displayName: 'mystery.bin',
            mimeType: 'application/octet-stream',
        };

        const result = await importAudioToVault(makeApp(), source, { targetFolder: 'Imports' });

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error).toBe('unsupported-mime');
    });

    it('uses getAvailableFilePath collision suffix when target exists', async () => {
        const blob = new Blob([Uint8Array.from([1])], { type: 'audio/mp4' });
        const createBinary = vi.fn((path: string) =>
            Promise.resolve(makeTFile(path, 'm4a', path.split('/').pop() ?? ''))
        );
        const app = makeApp({
            existing: new Set(['Imports/dup.m4a']),
            createBinaryImpl: createBinary,
        });

        const source: AudioSource = {
            kind: 'webview-blob',
            blob,
            displayName: 'dup.m4a',
            mimeType: 'audio/mp4',
        };
        await importAudioToVault(app, source, { targetFolder: 'Imports' });

        const path = createBinary.mock.calls[0][0] as string;
        // Expect the (2) collision-safe suffix.
        expect(path).toBe('Imports/dup (2).m4a');
    });

    it('returns aborted when signal is already aborted before write', async () => {
        const controller = new AbortController();
        controller.abort();

        const blob = new Blob([Uint8Array.from([1])], { type: 'audio/mp4' });
        const createBinary = vi.fn();
        const app = makeApp({ createBinaryImpl: createBinary });

        const source: AudioSource = {
            kind: 'webview-blob',
            blob,
            displayName: 'cancelled.m4a',
            mimeType: 'audio/mp4',
        };
        const result = await importAudioToVault(app, source, {
            targetFolder: 'Imports',
            signal: controller.signal,
        });

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error).toBe('aborted');
        expect(createBinary).not.toHaveBeenCalled();
    });

    it('trashes the partial write when aborted post-write', async () => {
        const trashFile = vi.fn().mockResolvedValue(undefined);
        const writtenFile = makeTFile('Imports/x.m4a', 'm4a', 'x.m4a');
        const blob = new Blob([Uint8Array.from([1])], { type: 'audio/mp4' });

        const controller = new AbortController();
        const app = makeApp({
            createBinaryImpl: async (path: string) => {
                // Abort RIGHT as the write completes.
                controller.abort();
                return writtenFile;
            },
            trashFileSpy: trashFile,
        });

        const source: AudioSource = {
            kind: 'webview-blob',
            blob,
            displayName: 'x.m4a',
            mimeType: 'audio/mp4',
        };
        const result = await importAudioToVault(app, source, {
            targetFolder: 'Imports',
            signal: controller.signal,
        });

        expect(result.ok).toBe(false);
        expect(trashFile).toHaveBeenCalledWith(writtenFile);
    });
});
