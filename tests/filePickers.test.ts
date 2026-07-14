// @vitest-environment happy-dom
/**
 * Unit tests for src/ui/utils/filePickers — shared Electron + vault file pickers
 * extracted from FreeChatModeHandler during plan phase F0.
 *
 * Coverage:
 *  - tryNativeFilePicker: dialog returns paths, cancel → [], remote unavailable → null,
 *    remote throws → null, multiSelections toggle, filters pass-through.
 *  - openVaultFilePicker: markdown ordering, predicate filtering, onChoose dispatch,
 *    placeholder propagation.
 */

vi.mock('obsidian', async () => {
    const mod = await import('./mocks/obsidian');
    return mod;
});

import { App, FuzzySuggestModal, TFile } from 'obsidian';
import { tryNativeFilePicker, openVaultFilePicker } from '../src/ui/utils/filePickers';

interface MockRemoteDialog {
    showOpenDialog: ReturnType<typeof vi.fn>;
}

function setRequireImpl(impl: ((mod: string) => unknown) | null): void {
    if (impl === null) {
        delete (globalThis as { require?: unknown }).require;
    } else {
        (globalThis as { require?: (mod: string) => unknown }).require = impl;
    }
}

function makeRemote(dialog: MockRemoteDialog): (mod: string) => unknown {
    return (mod: string) => {
        if (mod === '@electron/remote') return { dialog };
        throw new Error(`Unexpected require: ${mod}`);
    };
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

describe('tryNativeFilePicker', () => {
    afterEach(() => {
        setRequireImpl(null);
        vi.restoreAllMocks();
    });

    it('returns file paths when dialog resolves with selections', async () => {
        const showOpenDialog = vi.fn().mockResolvedValue({
            canceled: false,
            filePaths: ['/abs/a.docx', '/abs/b.pdf'],
        });
        setRequireImpl(makeRemote({ showOpenDialog }));

        const result = await tryNativeFilePicker([{ name: 'Docs', extensions: ['docx', 'pdf'] }]);

        expect(result).toEqual(['/abs/a.docx', '/abs/b.pdf']);
        expect(showOpenDialog).toHaveBeenCalledOnce();
    });

    it('returns empty array when the user cancels', async () => {
        const showOpenDialog = vi.fn().mockResolvedValue({ canceled: true, filePaths: [] });
        setRequireImpl(makeRemote({ showOpenDialog }));

        const result = await tryNativeFilePicker([{ name: 'All', extensions: ['*'] }]);

        expect(result).toEqual([]);
    });

    it('returns null when @electron/remote is unavailable (mobile)', async () => {
        setRequireImpl(null);

        const result = await tryNativeFilePicker([{ name: 'All', extensions: ['*'] }]);

        expect(result).toBeNull();
    });

    it('returns null when the require call throws', async () => {
        setRequireImpl((mod: string) => {
            throw new Error(`Module not found: ${mod}`);
        });

        const result = await tryNativeFilePicker([{ name: 'All', extensions: ['*'] }]);

        expect(result).toBeNull();
    });

    it('returns null when showOpenDialog itself rejects', async () => {
        const showOpenDialog = vi.fn().mockRejectedValue(new Error('boom'));
        setRequireImpl(makeRemote({ showOpenDialog }));

        const result = await tryNativeFilePicker([{ name: 'All', extensions: ['*'] }]);

        expect(result).toBeNull();
    });

    it('passes filters and default multi-select properties through', async () => {
        const showOpenDialog = vi.fn().mockResolvedValue({ canceled: false, filePaths: [] });
        setRequireImpl(makeRemote({ showOpenDialog }));

        const filters = [
            { name: 'Audio', extensions: ['m4a', 'mp3', 'wav'] },
            { name: 'All Files', extensions: ['*'] },
        ];
        await tryNativeFilePicker(filters);

        expect(showOpenDialog).toHaveBeenCalledWith({
            properties: ['openFile', 'multiSelections'],
            filters,
        });
    });

    it('omits multiSelections when caller opts out', async () => {
        const showOpenDialog = vi.fn().mockResolvedValue({ canceled: false, filePaths: [] });
        setRequireImpl(makeRemote({ showOpenDialog }));

        await tryNativeFilePicker([{ name: 'Audio', extensions: ['m4a'] }], { multiSelections: false });

        expect(showOpenDialog).toHaveBeenCalledWith({
            properties: ['openFile'],
            filters: [{ name: 'Audio', extensions: ['m4a'] }],
        });
    });
});

describe('openVaultFilePicker', () => {
    // Capture the FuzzySuggestModal subclass instance the helper creates so we can
    // exercise its overridden getItems / onChooseItem / setPlaceholder methods
    // directly. Without this we'd be testing the mock instead of the helper.
    let capturedInstance: FuzzySuggestModal<TFile> | null = null;
    let openSpy: ReturnType<typeof vi.spyOn>;
    let setPlaceholderSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        capturedInstance = null;
        openSpy = vi.spyOn(FuzzySuggestModal.prototype, 'open').mockImplementation(function (this: FuzzySuggestModal<TFile>) {
            capturedInstance = this;
        });
        setPlaceholderSpy = vi.spyOn(FuzzySuggestModal.prototype, 'setPlaceholder');
    });

    afterEach(() => {
        openSpy.mockRestore();
        setPlaceholderSpy.mockRestore();
    });

    function makeApp(files: TFile[]): App {
        const md = files.filter((f) => f.path.endsWith('.md'));
        const all = files;
        return {
            vault: {
                getMarkdownFiles: () => md,
                getFiles: () => all,
            },
            workspace: {},
        } as unknown as App;
    }

    it('opens the modal and lists markdown files first, then non-markdown', () => {
        const files = [
            makeTFile('audio/meeting.m4a'),
            makeTFile('notes/alpha.md'),
            makeTFile('docs/report.pdf'),
            makeTFile('notes/beta.md'),
        ];

        openVaultFilePicker(makeApp(files), { onChoose: () => {} });

        expect(openSpy).toHaveBeenCalledOnce();
        expect(capturedInstance).not.toBeNull();
        const items = capturedInstance!.getItems();
        expect(items.map((f) => f.path)).toEqual([
            'notes/alpha.md',
            'notes/beta.md',
            'audio/meeting.m4a',
            'docs/report.pdf',
        ]);
    });

    it('applies predicate to both markdown and non-markdown sets', () => {
        const files = [
            makeTFile('notes/alpha.md'),
            makeTFile('audio/meeting.m4a'),
            makeTFile('docs/report.pdf'),
            makeTFile('audio/standup.mp3'),
        ];

        openVaultFilePicker(makeApp(files), {
            predicate: (f) => ['m4a', 'mp3', 'wav'].includes(f.extension),
            onChoose: () => {},
        });

        expect(capturedInstance).not.toBeNull();
        const items = capturedInstance!.getItems();
        expect(items.map((f) => f.path)).toEqual(['audio/meeting.m4a', 'audio/standup.mp3']);
    });

    it('uses path as the item text for fuzzy matching', () => {
        const f = makeTFile('docs/report.pdf');
        openVaultFilePicker(makeApp([f]), { onChoose: () => {} });

        expect(capturedInstance).not.toBeNull();
        expect(capturedInstance!.getItemText(f)).toBe('docs/report.pdf');
    });

    it('forwards selected file to onChoose when an item is chosen', () => {
        const file = makeTFile('notes/alpha.md');
        const onChoose = vi.fn();

        openVaultFilePicker(makeApp([file]), { onChoose });

        expect(capturedInstance).not.toBeNull();
        // Obsidian invokes onChooseItem(item, evt); our subclass forwards just the item.
        capturedInstance!.onChooseItem(file, undefined as never);

        expect(onChoose).toHaveBeenCalledWith(file);
    });

    it('sets the placeholder when provided', () => {
        openVaultFilePicker(makeApp([]), {
            placeholder: 'Search vault…',
            onChoose: () => {},
        });

        expect(setPlaceholderSpy).toHaveBeenCalledWith('Search vault…');
    });

    it('skips setPlaceholder when placeholder is omitted', () => {
        openVaultFilePicker(makeApp([]), { onChoose: () => {} });

        expect(setPlaceholderSpy).not.toHaveBeenCalled();
    });
});
