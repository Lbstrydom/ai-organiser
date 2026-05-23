// @vitest-environment happy-dom
/**
 * Unit tests for src/ui/utils/AudioSourcePicker (plan F1 foundation, R1 H1).
 *
 * The desktop adapter delegates to filePickers.tryNativeFilePicker — already
 * covered there. These tests focus on:
 *  - pickAudioFromDesktop wrapping behaviour (filters, AudioSource shape, null pass-through)
 *  - pickAudioFromMobileWebview using a programmatic <input type="file"> for the
 *    mobile-P0 path (this is the core R1 H1 fix)
 *  - pickAudioFromVault delegating to filePickers.openVaultFilePicker with the
 *    audio predicate
 *  - helpers (isAudioFile, guessMimeFromExtension)
 */

vi.mock('obsidian', async () => {
    const mod = await import('./mocks/obsidian');
    return mod;
});

import { App, FuzzySuggestModal, TFile } from 'obsidian';
import {
    pickAudioFromDesktop,
    pickAudioFromMobileWebview,
    pickAudioFromVault,
    isAudioFile,
    guessMimeFromExtension,
    AUDIO_EXTENSIONS,
} from '../src/ui/utils/AudioSourcePicker';

function setRequireImpl(impl: ((mod: string) => unknown) | null): void {
    if (impl === null) {
        delete (globalThis as { require?: unknown }).require;
    } else {
        (globalThis as { require?: (mod: string) => unknown }).require = impl;
    }
}

function makeTFile(path: string): TFile {
    const f = Object.create(TFile.prototype) as TFile;
    (f as { path: string }).path = path;
    const ext = path.includes('.') ? path.split('.').pop() ?? '' : '';
    (f as { extension: string }).extension = ext;
    const basename = path.split('/').pop() ?? path;
    (f as { name: string }).name = basename;
    (f as { stat: { mtime: number } }).stat = { mtime: 0 };
    return f;
}

// ============================================================================
// pickAudioFromDesktop
// ============================================================================

describe('pickAudioFromDesktop', () => {
    afterEach(() => {
        setRequireImpl(null);
        vi.restoreAllMocks();
    });

    it('returns desktop-path AudioSource entries on success', async () => {
        const showOpenDialog = vi.fn().mockResolvedValue({
            canceled: false,
            filePaths: ['C:/meetings/standup.m4a', '/home/user/recording.mp3'],
        });
        setRequireImpl((mod: string) => {
            if (mod === '@electron/remote') return { dialog: { showOpenDialog } };
            throw new Error(`unexpected require: ${mod}`);
        });

        const result = await pickAudioFromDesktop();

        expect(result).toEqual([
            { kind: 'desktop-path', absolutePath: 'C:/meetings/standup.m4a', displayName: 'standup.m4a' },
            { kind: 'desktop-path', absolutePath: '/home/user/recording.mp3', displayName: 'recording.mp3' },
        ]);
    });

    it('passes audio extensions as the dialog filter', async () => {
        const showOpenDialog = vi.fn().mockResolvedValue({ canceled: false, filePaths: [] });
        setRequireImpl((mod: string) => {
            if (mod === '@electron/remote') return { dialog: { showOpenDialog } };
            throw new Error(`unexpected require: ${mod}`);
        });

        await pickAudioFromDesktop();

        const call = showOpenDialog.mock.calls[0][0];
        expect(call.filters[0]).toEqual({ name: 'Audio Files', extensions: [...AUDIO_EXTENSIONS] });
        expect(call.filters[1]).toEqual({ name: 'All Files', extensions: ['*'] });
        expect(call.properties).toContain('multiSelections');
    });

    it('returns null when electron remote is unavailable (mobile)', async () => {
        setRequireImpl(null);

        const result = await pickAudioFromDesktop();

        expect(result).toBeNull();
    });

    it('returns empty array when user cancels', async () => {
        const showOpenDialog = vi.fn().mockResolvedValue({ canceled: true, filePaths: [] });
        setRequireImpl((mod: string) => {
            if (mod === '@electron/remote') return { dialog: { showOpenDialog } };
            throw new Error(`unexpected require: ${mod}`);
        });

        const result = await pickAudioFromDesktop();

        expect(result).toEqual([]);
    });
});

// ============================================================================
// pickAudioFromMobileWebview — the core R1 H1 fix
// ============================================================================

describe('pickAudioFromMobileWebview', () => {
    let appendedInputs: HTMLInputElement[] = [];

    beforeEach(() => {
        appendedInputs = [];
        // jsdom provides document; intercept appendChild to capture the input.
        const origAppend = document.body.appendChild.bind(document.body);
        vi.spyOn(document.body, 'appendChild').mockImplementation(<T extends Node>(node: T): T => {
            if (node instanceof HTMLInputElement && node.type === 'file') {
                appendedInputs.push(node);
            }
            return origAppend(node);
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
        for (const input of appendedInputs) {
            if (input.parentElement) input.parentElement.removeChild(input);
        }
    });

    it('configures the input element with accept="audio/*" and multiple=true', async () => {
        // Don't await — kick it off, inspect the element, then resolve manually.
        const pending = pickAudioFromMobileWebview();
        // Allow the input element to be appended.
        await Promise.resolve();
        const input = appendedInputs[0];
        expect(input).toBeDefined();
        expect(input.accept).toBe('audio/*');
        expect(input.multiple).toBe(true);

        // Resolve by simulating cancel via focus event.
        window.dispatchEvent(new Event('focus'));
        // Focus fallback waits 200ms before resolving; advance fake timers OR
        // just await the real timer.
        const result = await pending;
        expect(result).toEqual([]);
    });

    it('resolves with webview-blob AudioSource entries for selected audio files', async () => {
        const pending = pickAudioFromMobileWebview();
        await Promise.resolve();
        const input = appendedInputs[0];

        const file = new File([new Uint8Array([1, 2, 3])], 'meeting.m4a', { type: 'audio/mp4' });
        Object.defineProperty(input, 'files', {
            value: { 0: file, length: 1, item: (i: number) => (i === 0 ? file : null), [Symbol.iterator]: function* () { yield file; } } as unknown as FileList,
            configurable: true,
        });

        input.dispatchEvent(new Event('change'));

        const result = await pending;
        expect(result).toHaveLength(1);
        expect(result![0]).toMatchObject({
            kind: 'webview-blob',
            displayName: 'meeting.m4a',
            mimeType: 'audio/mp4',
        });
    });

    it('filters out non-audio files even if the user picked them via the OS dialog', async () => {
        const pending = pickAudioFromMobileWebview();
        await Promise.resolve();
        const input = appendedInputs[0];

        const audio = new File([new Uint8Array([1])], 'meeting.m4a', { type: 'audio/mp4' });
        const pdf = new File([new Uint8Array([2])], 'agenda.pdf', { type: 'application/pdf' });

        const fakeFileList = {
            0: audio,
            1: pdf,
            length: 2,
            item: (i: number) => [audio, pdf][i] ?? null,
            [Symbol.iterator]: function* () {
                yield audio;
                yield pdf;
            },
        } as unknown as FileList;
        Object.defineProperty(input, 'files', { value: fakeFileList, configurable: true });

        input.dispatchEvent(new Event('change'));

        const result = await pending;
        expect(result).toHaveLength(1);
        expect(result![0].displayName).toBe('meeting.m4a');
    });

    it('respects multiSelections=false', async () => {
        const pending = pickAudioFromMobileWebview({ multiSelections: false });
        await Promise.resolve();
        const input = appendedInputs[0];
        expect(input.multiple).toBe(false);

        // Cancel the picker.
        window.dispatchEvent(new Event('focus'));
        const result = await pending;
        expect(result).toEqual([]);
    });

    it('returns null when document is unavailable', async () => {
        const origDocument = (globalThis as { document?: Document }).document;
        delete (globalThis as { document?: Document }).document;
        try {
            const result = await pickAudioFromMobileWebview();
            expect(result).toBeNull();
        } finally {
            (globalThis as { document?: Document }).document = origDocument;
        }
    });

    it('resolves with empty array on cancel event', async () => {
        const pending = pickAudioFromMobileWebview();
        await Promise.resolve();
        const input = appendedInputs[0];

        input.dispatchEvent(new Event('cancel'));
        const result = await pending;

        expect(result).toEqual([]);
    });
});

// ============================================================================
// pickAudioFromVault
// ============================================================================

describe('pickAudioFromVault', () => {
    let capturedInstance: FuzzySuggestModal<TFile> | null = null;
    let openSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        capturedInstance = null;
        openSpy = vi.spyOn(FuzzySuggestModal.prototype, 'open').mockImplementation(function (
            this: FuzzySuggestModal<TFile>
        ) {
            capturedInstance = this;
        });
    });

    afterEach(() => {
        openSpy.mockRestore();
    });

    function makeApp(files: TFile[]): App {
        const md = files.filter((f) => f.path.endsWith('.md'));
        return {
            vault: {
                getMarkdownFiles: () => md,
                getFiles: () => files,
            },
            workspace: {},
        } as unknown as App;
    }

    it('filters vault to audio extensions only', () => {
        const files = [
            makeTFile('notes/meeting.md'),
            makeTFile('audio/standup.m4a'),
            makeTFile('docs/report.pdf'),
            makeTFile('audio/lecture.mp3'),
        ];

        void pickAudioFromVault(makeApp(files));

        expect(openSpy).toHaveBeenCalledOnce();
        expect(capturedInstance).not.toBeNull();
        const items = capturedInstance!.getItems();
        expect(items.map((f) => f.path)).toEqual(['audio/standup.m4a', 'audio/lecture.mp3']);
    });

    it('resolves with a vault AudioSource when an item is chosen', async () => {
        const audio = makeTFile('audio/standup.m4a');
        const promise = pickAudioFromVault(makeApp([audio]));

        // Simulate selection.
        expect(capturedInstance).not.toBeNull();
        capturedInstance!.onChooseItem(audio, undefined as never);

        const result = await promise;
        expect(result).toEqual({ kind: 'vault', file: audio });
    });
});

// ============================================================================
// Helpers
// ============================================================================

describe('helpers', () => {
    it('isAudioFile recognises every entry in AUDIO_EXTENSIONS', () => {
        for (const ext of AUDIO_EXTENSIONS) {
            expect(isAudioFile(makeTFile(`sample.${ext}`))).toBe(true);
        }
    });

    it('isAudioFile rejects non-audio extensions', () => {
        expect(isAudioFile(makeTFile('note.md'))).toBe(false);
        expect(isAudioFile(makeTFile('doc.pdf'))).toBe(false);
        expect(isAudioFile(makeTFile('img.png'))).toBe(false);
    });

    it('guessMimeFromExtension covers known audio extensions', () => {
        expect(guessMimeFromExtension('a.m4a')).toBe('audio/mp4');
        expect(guessMimeFromExtension('a.mp3')).toBe('audio/mpeg');
        expect(guessMimeFromExtension('a.wav')).toBe('audio/wav');
        expect(guessMimeFromExtension('a.webm')).toBe('audio/webm');
        expect(guessMimeFromExtension('a.ogg')).toBe('audio/ogg');
        expect(guessMimeFromExtension('a.flac')).toBe('audio/flac');
        expect(guessMimeFromExtension('a.aac')).toBe('audio/aac');
    });

    it('guessMimeFromExtension falls back to application/octet-stream', () => {
        expect(guessMimeFromExtension('a.unknownext')).toBe('application/octet-stream');
        expect(guessMimeFromExtension('noextension')).toBe('application/octet-stream');
    });
});
