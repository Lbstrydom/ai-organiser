/**
 * Unit/integration tests for src/commands/oneDriveLinkCommands —
 * docs/plans/onedrive-link-insert.md §9, round-1 M5's testable seam.
 *
 * Exercises runOneDriveLinkFlow() directly with OneDriveLinkModal and
 * tryNativeFilePicker both mocked — never touches a real OS dialog or
 * renders real DOM. Covers the round-3 discriminated PickOutcome/ShareOutcome
 * contract per the plan's Testing Strategy.
 */
const hoisted = vi.hoisted(() => {
    const state: {
        onPickLocalFile: (() => Promise<string>) | null;
        onSubmitShareLink: ((labelText: string, url: string) => Promise<string>) | null;
    } = { onPickLocalFile: null, onSubmitShareLink: null };

    class MockOneDriveLinkModal {
        constructor(
            _app: unknown,
            _t: unknown,
            onPickLocalFile: () => Promise<string>,
            onSubmitShareLink: (labelText: string, url: string) => Promise<string>,
        ) {
            state.onPickLocalFile = onPickLocalFile;
            state.onSubmitShareLink = onSubmitShareLink;
        }
        open(): void {}
    }

    return { state, MockOneDriveLinkModal };
});

vi.mock('obsidian', async () => {
    const mod = await import('./mocks/obsidian');
    return mod;
});

vi.mock('../src/ui/utils/filePickers', () => ({
    tryNativeFilePicker: vi.fn(),
    // round-5 M2: isNativeFilePickerAvailable() replaced the round-3 M4
    // getElectron() precheck — it checks the SAME `@electron/remote`
    // dependency tryNativeFilePicker itself uses, instead of the unrelated
    // `electron` module. Defaults to "available" so existing tests (written
    // before the precheck existed) keep exercising the picker itself; the
    // dedicated precheck tests below override this per-case.
    isNativeFilePickerAvailable: vi.fn(() => true),
}));

vi.mock('../src/utils/desktopRequire', () => ({
    getPath: () => ({ basename: (p: string) => p.split(/[\\/]/).pop() ?? p }),
    // detectOneDriveFolders() (oneDriveLinkUtils.ts) also imports getOs/getFs —
    // stubbed to undefined so it gracefully returns [] (mirrors the real
    // "unavailable" path); these tests only care about the picker's own
    // mocked result, not the defaultPath convenience it feeds.
    getOs: () => undefined,
    getFs: () => undefined,
}));

vi.mock('../src/services/noteEdit/applyNoteEdit', () => ({
    applyNoteEdit: vi.fn(),
}));

vi.mock('../src/ui/modals/OneDriveLinkModal', () => ({
    OneDriveLinkModal: hoisted.MockOneDriveLinkModal,
}));

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockNotices, clearMockNotices } from './mocks/obsidian';
import { runOneDriveLinkFlow } from '../src/commands/oneDriveLinkCommands';
import { tryNativeFilePicker, isNativeFilePickerAvailable } from '../src/ui/utils/filePickers';
import { applyNoteEdit } from '../src/services/noteEdit/applyNoteEdit';
import type { EditSnapshot } from '../src/services/noteEdit/applyNoteEdit';

const mockedPicker = tryNativeFilePicker as unknown as ReturnType<typeof vi.fn>;
const mockedApplyNoteEdit = applyNoteEdit as unknown as ReturnType<typeof vi.fn>;
const mockedIsPickerAvailable = isNativeFilePickerAvailable as unknown as ReturnType<typeof vi.fn>;

function makeSnapshot(): EditSnapshot {
    return {
        filePath: 'notes/original.md',
        baseline: 'hello world',
        cursorAnchor: 'hello ',
        selection: null,
    };
}

function makePlugin(): any {
    return {
        app: {},
        t: {
            oneDriveLink: {
                pickerUnavailableNotice: 'Picker unavailable',
                pickerFailedNotice: 'Picker failed',
                unbuildablePathNotice: 'Unbuildable path',
                unexpectedErrorNotice: 'Unexpected error',
            },
        },
    };
}

function invokeFlow(): { plugin: any; snapshot: EditSnapshot } {
    const plugin = makePlugin();
    const snapshot = makeSnapshot();
    runOneDriveLinkFlow(plugin, snapshot);
    return { plugin, snapshot };
}

describe('runOneDriveLinkFlow — onPickLocalFile', () => {
    beforeEach(() => {
        clearMockNotices();
        mockedPicker.mockReset();
        mockedApplyNoteEdit.mockReset();
        mockedIsPickerAvailable.mockReset();
        mockedIsPickerAvailable.mockReturnValue(true);
        hoisted.state.onPickLocalFile = null;
        hoisted.state.onSubmitShareLink = null;
    });

    it('native picker unavailable (isNativeFilePickerAvailable returns false) resolves "failed", fires pickerUnavailableNotice, and never calls tryNativeFilePicker (round-3 M4, round-5 M2)', async () => {
        mockedIsPickerAvailable.mockReturnValue(false);

        invokeFlow();
        const outcome = await hoisted.state.onPickLocalFile!();

        expect(outcome).toBe('failed');
        expect(mockNotices).toContain('Picker unavailable');
        expect(mockedPicker).not.toHaveBeenCalled();
    });

    it('native picker available but tryNativeFilePicker returns null (operational failure) fires the distinct pickerFailedNotice, not pickerUnavailableNotice (round-3 M4)', async () => {
        mockedPicker.mockResolvedValue(null);

        invokeFlow();
        const outcome = await hoisted.state.onPickLocalFile!();

        expect(outcome).toBe('failed');
        expect(mockNotices).toContain('Picker failed');
        expect(mockNotices).not.toContain('Picker unavailable');
    });

    it('a chosen path resolves "inserted" and calls applyNoteEdit with a cursor-insert target', async () => {
        mockedPicker.mockResolvedValue(['C:\\Users\\Alice\\OneDrive\\Report.docx']);
        mockedApplyNoteEdit.mockResolvedValue({ ok: true, value: undefined });

        const { snapshot } = invokeFlow();
        const outcome = await hoisted.state.onPickLocalFile!();

        expect(outcome).toBe('inserted');
        expect(mockedApplyNoteEdit).toHaveBeenCalledTimes(1);
        const [, target] = mockedApplyNoteEdit.mock.calls[0];
        expect(target.kind).toBe('cursor-insert');
        expect(target.filePath).toBe(snapshot.filePath);
        expect(target.baseline).toBe(snapshot.baseline);
        expect(target.anchorSnippet).toBe(snapshot.cursorAnchor);
        expect(target.text).toBe('[Report.docx](file:///C:/Users/Alice/OneDrive/Report.docx)');
    });

    it('picker returning null (operational failure, Electron available) resolves "failed" and does not insert', async () => {
        mockedPicker.mockResolvedValue(null);

        invokeFlow();
        const outcome = await hoisted.state.onPickLocalFile!();

        expect(outcome).toBe('failed');
        expect(mockNotices).toContain('Picker failed');
        expect(mockedApplyNoteEdit).not.toHaveBeenCalled();
    });

    it('picker returning [] (cancelled) resolves "cancelled", distinct from "failed", and does not insert', async () => {
        mockedPicker.mockResolvedValue([]);

        invokeFlow();
        const outcome = await hoisted.state.onPickLocalFile!();

        expect(outcome).toBe('cancelled');
        expect(mockedApplyNoteEdit).not.toHaveBeenCalled();
    });

    it('an unexpected exception (e.g. tryNativeFilePicker rejects) resolves "failed" and fires the generic unexpected-error Notice (round-5 M1)', async () => {
        mockedPicker.mockRejectedValue(new Error('boom'));

        invokeFlow();
        const outcome = await hoisted.state.onPickLocalFile!();

        expect(outcome).toBe('failed');
        expect(mockNotices).toContain('Unexpected error');
    });

    it('applyNoteEdit failure resolves "failed" (no duplicate Notice — applyNoteEdit owns its own failure Notice)', async () => {
        mockedPicker.mockResolvedValue(['/Users/alice/OneDrive/report.docx']);
        mockedApplyNoteEdit.mockResolvedValue({ ok: false, error: 'target-missing' });

        invokeFlow();
        const outcome = await hoisted.state.onPickLocalFile!();

        expect(outcome).toBe('failed');
    });

    it('the snapshot filePath/baseline/anchorSnippet are threaded through unchanged (round-1 H1)', async () => {
        mockedPicker.mockResolvedValue(['/Users/alice/OneDrive/report.docx']);
        mockedApplyNoteEdit.mockResolvedValue({ ok: true, value: undefined });

        const { snapshot } = invokeFlow();
        await hoisted.state.onPickLocalFile!();

        const [, target] = mockedApplyNoteEdit.mock.calls[0];
        expect(target.filePath).toBe(snapshot.filePath);
        expect(target.baseline).toBe(snapshot.baseline);
        expect(target.anchorSnippet).toBe(snapshot.cursorAnchor);
    });
});

describe('runOneDriveLinkFlow — onSubmitShareLink', () => {
    beforeEach(() => {
        clearMockNotices();
        mockedPicker.mockReset();
        mockedApplyNoteEdit.mockReset();
        hoisted.state.onPickLocalFile = null;
        hoisted.state.onSubmitShareLink = null;
    });

    it('a safe https:// URL resolves "inserted" with the typed label as display text (round-2 H1 — independent of Section A)', async () => {
        mockedApplyNoteEdit.mockResolvedValue({ ok: true, value: undefined });

        invokeFlow();
        const outcome = await hoisted.state.onSubmitShareLink!('My Report', 'https://contoso-my.sharepoint.com/x');

        expect(outcome).toBe('inserted');
        expect(mockedApplyNoteEdit).toHaveBeenCalledTimes(1);
        const [, target] = mockedApplyNoteEdit.mock.calls[0];
        expect(target.text).toBe('[My Report](https://contoso-my.sharepoint.com/x)');
    });

    it('a non-https URL resolves "invalid-link" before applyNoteEdit is ever called, no Notice (round-3 M1 scheme gate)', async () => {
        invokeFlow();
        const outcome = await hoisted.state.onSubmitShareLink!('label', 'javascript:alert(1)');

        expect(outcome).toBe('invalid-link');
        expect(mockedApplyNoteEdit).not.toHaveBeenCalled();
        expect(mockNotices).toEqual([]);
    });

    it('an http:// (non-encrypted) URL is also rejected — the allowlist is https only', async () => {
        invokeFlow();
        const outcome = await hoisted.state.onSubmitShareLink!('label', 'http://example.com');

        expect(outcome).toBe('invalid-link');
        expect(mockedApplyNoteEdit).not.toHaveBeenCalled();
    });

    it('a degenerate "https://" with no host is rejected (round-2 M1/M2 — prefix-only regex was insufficient)', async () => {
        invokeFlow();
        const outcome = await hoisted.state.onSubmitShareLink!('label', 'https://');

        expect(outcome).toBe('invalid-link');
        expect(mockedApplyNoteEdit).not.toHaveBeenCalled();
    });

    it('a genuinely malformed URL (unparseable) is rejected, not thrown', async () => {
        invokeFlow();
        const outcome = await hoisted.state.onSubmitShareLink!('label', 'https://[not-valid');

        expect(outcome).toBe('invalid-link');
        expect(mockedApplyNoteEdit).not.toHaveBeenCalled();
    });

    it('an https:// URL containing a literal < resolves "invalid-link" (round-2 M1), no Notice', async () => {
        invokeFlow();
        const outcome = await hoisted.state.onSubmitShareLink!('label', 'https://example.com/<bad>');

        expect(outcome).toBe('invalid-link');
        expect(mockedApplyNoteEdit).not.toHaveBeenCalled();
        expect(mockNotices).toEqual([]);
    });

    it('applyNoteEdit failure resolves "failed"', async () => {
        mockedApplyNoteEdit.mockResolvedValue({ ok: false, error: 'target-missing' });

        invokeFlow();
        const outcome = await hoisted.state.onSubmitShareLink!('label', 'https://example.com');

        expect(outcome).toBe('failed');
    });

    it('an unexpected exception (e.g. applyNoteEdit rejects) resolves "failed" and fires the generic unexpected-error Notice (round-5 M1)', async () => {
        mockedApplyNoteEdit.mockRejectedValue(new Error('boom'));

        invokeFlow();
        const outcome = await hoisted.state.onSubmitShareLink!('label', 'https://example.com');

        expect(outcome).toBe('failed');
        expect(mockNotices).toContain('Unexpected error');
    });

    it('the snapshot filePath/baseline/anchorSnippet are threaded through unchanged', async () => {
        mockedApplyNoteEdit.mockResolvedValue({ ok: true, value: undefined });

        const { snapshot } = invokeFlow();
        await hoisted.state.onSubmitShareLink!('label', 'https://example.com');

        const [, target] = mockedApplyNoteEdit.mock.calls[0];
        expect(target.filePath).toBe(snapshot.filePath);
        expect(target.baseline).toBe(snapshot.baseline);
        expect(target.anchorSnippet).toBe(snapshot.cursorAnchor);
    });
});
