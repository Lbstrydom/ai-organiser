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
        refreshConfirmOptions: {
            fileNames: string[];
            onConfirm: () => void;
            onCancel: () => void;
        } | null;
    } = { onPickLocalFile: null, onSubmitShareLink: null, refreshConfirmOptions: null };

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

    class MockOneDriveRefreshConfirmModal {
        constructor(_app: unknown, opts: { fileNames: string[]; onConfirm: () => void; onCancel: () => void }) {
            state.refreshConfirmOptions = opts;
        }
        open(): void {}
    }

    return { state, MockOneDriveLinkModal, MockOneDriveRefreshConfirmModal };
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

vi.mock('../src/ui/modals/OneDriveRefreshConfirmModal', () => ({
    OneDriveRefreshConfirmModal: hoisted.MockOneDriveRefreshConfirmModal,
}));

vi.mock('../src/services/oneDriveEmbedService', () => ({
    copyOneDriveFileIntoVault: vi.fn(),
    findStaleOneDriveEmbeds: vi.fn(),
    refreshOneDriveEmbed: vi.fn(),
}));

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockNotices, clearMockNotices } from './mocks/obsidian';
import { runOneDriveLinkFlow, runOneDriveRefreshFlow } from '../src/commands/oneDriveLinkCommands';
import { tryNativeFilePicker, isNativeFilePickerAvailable } from '../src/ui/utils/filePickers';
import { applyNoteEdit } from '../src/services/noteEdit/applyNoteEdit';
import type { EditSnapshot } from '../src/services/noteEdit/applyNoteEdit';
import {
    copyOneDriveFileIntoVault, findStaleOneDriveEmbeds, refreshOneDriveEmbed,
} from '../src/services/oneDriveEmbedService';

const mockedPicker = tryNativeFilePicker as unknown as ReturnType<typeof vi.fn>;
const mockedApplyNoteEdit = applyNoteEdit as unknown as ReturnType<typeof vi.fn>;
const mockedIsPickerAvailable = isNativeFilePickerAvailable as unknown as ReturnType<typeof vi.fn>;
const mockedCopyIntoVault = copyOneDriveFileIntoVault as unknown as ReturnType<typeof vi.fn>;
const mockedFindStale = findStaleOneDriveEmbeds as unknown as ReturnType<typeof vi.fn>;
const mockedRefreshEmbed = refreshOneDriveEmbed as unknown as ReturnType<typeof vi.fn>;

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
                embedTooLargeNotice: 'Embed too large',
                embedFailedNotice: 'Embed failed',
                refreshNoEmbedsNotice: 'No embeds found',
                refreshUpToDateNotice: 'Up to date',
                refreshConfirmTitle: 'Refresh?',
                refreshConfirmBody: 'These changed:',
                refreshConfirmConfirm: 'Refresh',
                refreshConfirmCancel: 'Cancel',
                refreshFailedNotice: 'Refresh failed',
                refreshPartialNotice: 'Refreshed {refreshed}; {failed} failed',
                refreshDoneNotice: 'Refreshed {n}',
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
        mockedCopyIntoVault.mockReset();
        // Default matches the real "no fs" environment this test file mocks
        // (getFs: () => undefined) — embed/vault-link classifications fall
        // through to the existing file:// link path unless a test overrides
        // this to exercise the new embed behavior specifically.
        mockedCopyIntoVault.mockResolvedValue({ ok: false, error: 'desktop-only' });
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

    describe('visual-embed extension (brainstormed 2026-07-15)', () => {
        it('a picked PDF that copies into the vault inserts a native ![[...]] embed block, not a file:// link', async () => {
            mockedPicker.mockResolvedValue(['C:\\Users\\Alice\\OneDrive\\Report.pdf']);
            mockedCopyIntoVault.mockResolvedValue({
                ok: true,
                value: { vaultPath: 'AI-Organiser/OneDrive Embeds/Report.pdf', mtimeMs: 1752515000000 },
            });
            mockedApplyNoteEdit.mockResolvedValue({ ok: true, value: undefined });

            invokeFlow();
            const outcome = await hoisted.state.onPickLocalFile!();

            expect(outcome).toBe('inserted');
            expect(mockedCopyIntoVault).toHaveBeenCalledWith(expect.anything(), 'C:\\Users\\Alice\\OneDrive\\Report.pdf');
            const [, target] = mockedApplyNoteEdit.mock.calls[0];
            expect(target.text).toContain('onedrive-embed');
            expect(target.text).toContain('![[AI-Organiser/OneDrive Embeds/Report.pdf]]');
            expect(target.text).not.toContain('file://');
        });

        it('a picked PPTX that copies into the vault inserts a [[...]] link block (no native renderer for Office formats)', async () => {
            mockedPicker.mockResolvedValue(['C:\\Users\\Alice\\OneDrive\\Deck.pptx']);
            mockedCopyIntoVault.mockResolvedValue({
                ok: true,
                value: { vaultPath: 'AI-Organiser/OneDrive Embeds/Deck.pptx', mtimeMs: 1000 },
            });
            mockedApplyNoteEdit.mockResolvedValue({ ok: true, value: undefined });

            invokeFlow();
            const outcome = await hoisted.state.onPickLocalFile!();

            expect(outcome).toBe('inserted');
            const [, target] = mockedApplyNoteEdit.mock.calls[0];
            expect(target.text).toContain('[[AI-Organiser/OneDrive Embeds/Deck.pptx]]');
            expect(target.text).not.toContain('![[');
        });

        it('a picked PDF over the size cap falls back to a file:// link and fires embedTooLargeNotice', async () => {
            mockedPicker.mockResolvedValue(['C:\\Users\\Alice\\OneDrive\\Huge.pdf']);
            mockedCopyIntoVault.mockResolvedValue({ ok: false, error: 'too-large' });
            mockedApplyNoteEdit.mockResolvedValue({ ok: true, value: undefined });

            invokeFlow();
            const outcome = await hoisted.state.onPickLocalFile!();

            expect(outcome).toBe('inserted');
            expect(mockNotices).toContain('Embed too large');
            const [, target] = mockedApplyNoteEdit.mock.calls[0];
            expect(target.text).toContain('file://');
            expect(target.text).not.toContain('onedrive-embed');
        });

        it('a picked PDF whose vault-copy fails for another reason falls back to a file:// link and fires embedFailedNotice', async () => {
            mockedPicker.mockResolvedValue(['C:\\Users\\Alice\\OneDrive\\Broken.pdf']);
            mockedCopyIntoVault.mockResolvedValue({ ok: false, error: 'write-failed' });
            mockedApplyNoteEdit.mockResolvedValue({ ok: true, value: undefined });

            invokeFlow();
            const outcome = await hoisted.state.onPickLocalFile!();

            expect(outcome).toBe('inserted');
            expect(mockNotices).toContain('Embed failed');
            const [, target] = mockedApplyNoteEdit.mock.calls[0];
            expect(target.text).toContain('file://');
        });

        it('a picked PDF on a desktop-only ("no fs") environment falls back silently to a file:// link — no Notice', async () => {
            mockedPicker.mockResolvedValue(['C:\\Users\\Alice\\OneDrive\\Report.pdf']);
            mockedCopyIntoVault.mockResolvedValue({ ok: false, error: 'desktop-only' });
            mockedApplyNoteEdit.mockResolvedValue({ ok: true, value: undefined });

            invokeFlow();
            const outcome = await hoisted.state.onPickLocalFile!();

            expect(outcome).toBe('inserted');
            expect(mockNotices).toEqual([]);
            const [, target] = mockedApplyNoteEdit.mock.calls[0];
            expect(target.text).toContain('file://');
        });

        it('an unrecognised extension never calls copyOneDriveFileIntoVault at all', async () => {
            mockedPicker.mockResolvedValue(['C:\\Users\\Alice\\OneDrive\\archive.zip']);
            mockedApplyNoteEdit.mockResolvedValue({ ok: true, value: undefined });

            invokeFlow();
            await hoisted.state.onPickLocalFile!();

            expect(mockedCopyIntoVault).not.toHaveBeenCalled();
        });
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

describe('runOneDriveRefreshFlow (brainstormed 2026-07-15)', () => {
    const MARKER_A = '<!-- onedrive-embed: source="C:\\a\\report.pdf" vault="AI-Organiser/OneDrive Embeds/report.pdf" mtime="1000" -->';
    const NOTE_WITH_MARKER = `# Note\n\n${MARKER_A}\n![[AI-Organiser/OneDrive Embeds/report.pdf]]\n`;

    beforeEach(() => {
        clearMockNotices();
        mockedApplyNoteEdit.mockReset();
        mockedFindStale.mockReset();
        mockedRefreshEmbed.mockReset();
        hoisted.state.refreshConfirmOptions = null;
    });

    function makeRefreshSnapshot(baseline: string): EditSnapshot {
        return { filePath: 'notes/original.md', baseline, cursorAnchor: '', selection: null };
    }

    it('no markers in the note fires refreshNoEmbedsNotice and never calls findStaleOneDriveEmbeds', () => {
        runOneDriveRefreshFlow(makePlugin(), makeRefreshSnapshot('# Just a note, no embeds.'));

        expect(mockNotices).toContain('No embeds found');
        expect(mockedFindStale).not.toHaveBeenCalled();
    });

    it('markers present but none stale fires refreshUpToDateNotice', () => {
        mockedFindStale.mockReturnValue([]);
        runOneDriveRefreshFlow(makePlugin(), makeRefreshSnapshot(NOTE_WITH_MARKER));

        expect(mockedFindStale).toHaveBeenCalledTimes(1);
        expect(mockNotices).toContain('Up to date');
    });

    it('stale markers open a confirm modal listing the affected filenames', () => {
        mockedFindStale.mockReturnValue([
            {
                marker: {
                    source: 'C:\\a\\report.pdf', vaultPath: 'AI-Organiser/OneDrive Embeds/report.pdf',
                    mtimeMs: 1000, raw: MARKER_A,
                },
                currentMtimeMs: 2000,
            },
        ]);
        runOneDriveRefreshFlow(makePlugin(), makeRefreshSnapshot(NOTE_WITH_MARKER));

        expect(hoisted.state.refreshConfirmOptions).not.toBeNull();
        expect(hoisted.state.refreshConfirmOptions!.fileNames).toEqual(['report.pdf']);
    });

    it('confirming the refresh calls refreshOneDriveEmbed and applies a composite edit updating just the marker mtime', async () => {
        const staleEntry = {
            marker: {
                source: 'C:\\a\\report.pdf', vaultPath: 'AI-Organiser/OneDrive Embeds/report.pdf',
                mtimeMs: 1000, raw: MARKER_A,
            },
            currentMtimeMs: 2000,
        };
        mockedFindStale.mockReturnValue([staleEntry]);
        mockedRefreshEmbed.mockResolvedValue({ ok: true, value: { mtimeMs: 2000 } });
        mockedApplyNoteEdit.mockResolvedValue({ ok: true, value: undefined });

        runOneDriveRefreshFlow(makePlugin(), makeRefreshSnapshot(NOTE_WITH_MARKER));
        hoisted.state.refreshConfirmOptions!.onConfirm();
        await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

        expect(mockedRefreshEmbed).toHaveBeenCalledWith(expect.anything(), staleEntry);
        expect(mockedApplyNoteEdit).toHaveBeenCalledTimes(1);
        const [, target, opts] = mockedApplyNoteEdit.mock.calls[0];
        expect(target.kind).toBe('composite');
        // Live-testing finding (2026-07-15): the refresh confirm modal
        // ALREADY gates this write — passing the applyNoteEdit default
        // (review: true) stacked a second, redundant "Review changes" diff
        // modal on top for a purely mechanical mtime update, which silently
        // stalled the commit until that second modal was also accepted.
        expect(opts).toEqual({ review: false });

        const recomputeResult = target.recompute(NOTE_WITH_MARKER);
        expect(recomputeResult.ok).toBe(true);
        expect(recomputeResult.value.content).toContain('mtime="2000"');
        expect(recomputeResult.value.content).not.toContain('mtime="1000"');
        expect(mockNotices).toContain('Refreshed 1');
    });

    it('cancelling the confirm modal does not call refreshOneDriveEmbed', () => {
        mockedFindStale.mockReturnValue([
            {
                marker: {
                    source: 'C:\\a\\report.pdf', vaultPath: 'AI-Organiser/OneDrive Embeds/report.pdf',
                    mtimeMs: 1000, raw: MARKER_A,
                },
                currentMtimeMs: 2000,
            },
        ]);
        runOneDriveRefreshFlow(makePlugin(), makeRefreshSnapshot(NOTE_WITH_MARKER));
        hoisted.state.refreshConfirmOptions!.onCancel();

        expect(mockedRefreshEmbed).not.toHaveBeenCalled();
    });

    it('a refresh failure for every stale entry fires refreshFailedNotice without calling applyNoteEdit', async () => {
        const staleEntry = {
            marker: {
                source: 'C:\\a\\report.pdf', vaultPath: 'AI-Organiser/OneDrive Embeds/report.pdf',
                mtimeMs: 1000, raw: MARKER_A,
            },
            currentMtimeMs: 2000,
        };
        mockedFindStale.mockReturnValue([staleEntry]);
        mockedRefreshEmbed.mockResolvedValue({ ok: false, error: 'read-failed' });

        runOneDriveRefreshFlow(makePlugin(), makeRefreshSnapshot(NOTE_WITH_MARKER));
        hoisted.state.refreshConfirmOptions!.onConfirm();
        await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

        expect(mockNotices).toContain('Refresh failed');
        expect(mockedApplyNoteEdit).not.toHaveBeenCalled();
    });

    it('a partial refresh (one succeeds, one fails) fires refreshPartialNotice', async () => {
        const rawB = '<!-- onedrive-embed: source="C:\\a\\b.pptx" vault="AI-Organiser/OneDrive Embeds/b.pptx" mtime="500" -->';
        const staleA = {
            marker: {
                source: 'C:\\a\\report.pdf', vaultPath: 'AI-Organiser/OneDrive Embeds/report.pdf',
                mtimeMs: 1000, raw: MARKER_A,
            },
            currentMtimeMs: 2000,
        };
        const staleB = {
            marker: { source: 'C:\\a\\b.pptx', vaultPath: 'AI-Organiser/OneDrive Embeds/b.pptx', mtimeMs: 500, raw: rawB },
            currentMtimeMs: 900,
        };
        mockedFindStale.mockReturnValue([staleA, staleB]);
        mockedRefreshEmbed.mockImplementation((_app: unknown, entry: typeof staleA) =>
            entry === staleA
                ? Promise.resolve({ ok: true, value: { mtimeMs: 2000 } })
                : Promise.resolve({ ok: false, error: 'read-failed' }));
        mockedApplyNoteEdit.mockResolvedValue({ ok: true, value: undefined });

        const noteWithBoth = `${NOTE_WITH_MARKER}\n${rawB}\n[[AI-Organiser/OneDrive Embeds/b.pptx]]\n`;
        runOneDriveRefreshFlow(makePlugin(), makeRefreshSnapshot(noteWithBoth));
        hoisted.state.refreshConfirmOptions!.onConfirm();
        await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

        expect(mockNotices).toContain('Refreshed 1; 1 failed');
    });
});
