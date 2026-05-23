/**
 * Unit tests for src/ui/coordinators/AudioAttachCoordinator (plan F1 wire, R1 M3).
 *
 * Focus on the coordinator's orchestration contract — picker dispatch, preview
 * lifecycle, vault-import delegation. Underlying pickers / preview / import
 * service have their own test suites; we mock them at the module boundary.
 */

vi.mock('obsidian', async () => {
    const mod = await import('./mocks/obsidian');
    return mod;
});

// vi.hoisted runs BEFORE vi.mock factories — so these handles ARE defined when
// the factory references them (regular `const` at module top is hoisted AFTER
// the mock factory, causing ReferenceError).
const mocks = vi.hoisted(() => ({
    desktopPicker: vi.fn(),
    mobilePicker: vi.fn(),
    vaultPicker: vi.fn(),
    previewSpy: vi.fn(),
    importSpy: vi.fn(),
}));

vi.mock('../src/ui/utils/AudioSourcePicker', () => ({
    pickAudioFromDesktop: mocks.desktopPicker,
    pickAudioFromMobileWebview: mocks.mobilePicker,
    pickAudioFromVault: mocks.vaultPicker,
}));
vi.mock('../src/ui/coordinators/AudioPreviewSource', () => ({
    resolvePreview: mocks.previewSpy,
}));
vi.mock('../src/services/audio/audioImportService', () => ({
    importAudioToVault: mocks.importSpy,
}));

const { desktopPicker, mobilePicker, vaultPicker, previewSpy, importSpy } = mocks;

import { App, Platform, TFile } from 'obsidian';
import { AudioAttachCoordinator } from '../src/ui/coordinators/AudioAttachCoordinator';
import type { AudioSource } from '../src/ui/components/speakerReviewState';

function makeTFile(path: string): TFile {
    const f = Object.create(TFile.prototype) as TFile;
    (f as { path: string }).path = path;
    (f as { name: string }).name = path.split('/').pop() ?? path;
    (f as { extension: string }).extension = path.split('.').pop() ?? '';
    return f;
}

function makeApp(): App {
    return {
        vault: {},
        workspace: {},
    } as unknown as App;
}

beforeEach(() => {
    desktopPicker.mockReset();
    mobilePicker.mockReset();
    vaultPicker.mockReset();
    previewSpy.mockReset();
    importSpy.mockReset();
    (Platform as { isMobile: boolean }).isMobile = false;
});

describe('requestAttachFromDevice', () => {
    it('calls the desktop picker on non-mobile platforms', async () => {
        const source: AudioSource = {
            kind: 'desktop-path',
            absolutePath: '/abs/x.m4a',
            displayName: 'x.m4a',
        };
        desktopPicker.mockResolvedValue([source]);
        const c = new AudioAttachCoordinator(makeApp(), { importTargetFolder: 'Imports' });

        const result = await c.requestAttachFromDevice();

        expect(desktopPicker).toHaveBeenCalledOnce();
        expect(mobilePicker).not.toHaveBeenCalled();
        expect(result).toEqual({ kind: 'sources', sources: [source] });
    });

    it('calls the mobile webview picker on mobile platforms', async () => {
        (Platform as { isMobile: boolean }).isMobile = true;
        const source: AudioSource = {
            kind: 'webview-blob',
            blob: new Blob([new Uint8Array([1])]),
            displayName: 'phone.m4a',
            mimeType: 'audio/mp4',
        };
        mobilePicker.mockResolvedValue([source]);
        const c = new AudioAttachCoordinator(makeApp(), { importTargetFolder: 'Imports' });

        const result = await c.requestAttachFromDevice();

        expect(mobilePicker).toHaveBeenCalledOnce();
        expect(desktopPicker).not.toHaveBeenCalled();
        expect(result).toEqual({ kind: 'sources', sources: [source] });
    });

    it('returns cancelled when picker resolves with empty array', async () => {
        desktopPicker.mockResolvedValue([]);
        const c = new AudioAttachCoordinator(makeApp(), { importTargetFolder: 'Imports' });

        const result = await c.requestAttachFromDevice();

        expect(result).toEqual({ kind: 'cancelled' });
    });

    it('returns failed when picker returns null (platform unavailable)', async () => {
        desktopPicker.mockResolvedValue(null);
        const c = new AudioAttachCoordinator(makeApp(), { importTargetFolder: 'Imports' });

        const result = await c.requestAttachFromDevice();

        expect(result).toEqual({ kind: 'failed', reason: 'platform-unavailable' });
    });

    it('returns failed when picker throws', async () => {
        desktopPicker.mockRejectedValue(new Error('boom'));
        const c = new AudioAttachCoordinator(makeApp(), { importTargetFolder: 'Imports' });

        const result = await c.requestAttachFromDevice();

        expect(result.kind).toBe('failed');
        if (result.kind !== 'failed') return;
        expect(result.reason).toBe('picker-threw');
    });
});

describe('requestVaultPick', () => {
    it('returns sources array when vault picker resolves with a TFile source', async () => {
        const tfile = makeTFile('audio/standup.m4a');
        const source: AudioSource = { kind: 'vault', file: tfile };
        vaultPicker.mockResolvedValue(source);
        const c = new AudioAttachCoordinator(makeApp(), { importTargetFolder: 'Imports' });

        const result = await c.requestVaultPick();

        expect(result).toEqual({ kind: 'sources', sources: [source] });
    });

    it('returns cancelled when vault picker resolves null', async () => {
        vaultPicker.mockResolvedValue(null);
        const c = new AudioAttachCoordinator(makeApp(), { importTargetFolder: 'Imports' });

        const result = await c.requestVaultPick();

        expect(result).toEqual({ kind: 'cancelled' });
    });
});

describe('importToVault', () => {
    it('delegates to audioImportService with the configured target folder', async () => {
        importSpy.mockResolvedValue({
            ok: true,
            value: {
                file: makeTFile('Imports/x.m4a'),
                origin: 'desktop-path',
                originalName: 'x.m4a',
                imported: true,
            },
        });

        const c = new AudioAttachCoordinator(makeApp(), { importTargetFolder: 'CustomFolder' });
        const source: AudioSource = {
            kind: 'desktop-path',
            absolutePath: '/abs/x.m4a',
            displayName: 'x.m4a',
        };
        const signal = new AbortController().signal;

        await c.importToVault(source, signal);

        expect(importSpy).toHaveBeenCalledOnce();
        const [, calledSource, opts] = importSpy.mock.calls[0];
        expect(calledSource).toBe(source);
        expect(opts).toEqual({ targetFolder: 'CustomFolder', signal });
    });
});

describe('buildAttachItem', () => {
    it('wraps an ImportedAudio in an AudioAttachItem with vault source kind', () => {
        const tfile = makeTFile('Imports/x.m4a');
        const c = new AudioAttachCoordinator(makeApp(), { importTargetFolder: 'Imports' });

        const item = c.buildAttachItem({
            file: tfile,
            origin: 'desktop-path',
            originalName: 'x.m4a',
            imported: true,
        });

        expect(item.itemState).toBe('pending');
        expect(item.displayName).toBe('x.m4a');
        expect(item.source).toEqual({ kind: 'vault', file: tfile });
    });
});

describe('attachPreview + dispose', () => {
    it('retains preview handles and disposes them on dispose()', () => {
        const dispose1 = vi.fn();
        const dispose2 = vi.fn();
        previewSpy.mockReturnValueOnce({ url: 'blob:1', dispose: dispose1 });
        previewSpy.mockReturnValueOnce({ url: 'blob:2', dispose: dispose2 });

        const c = new AudioAttachCoordinator(makeApp(), { importTargetFolder: 'Imports' });
        const tfile = makeTFile('audio/a.m4a');
        c.attachPreview({ kind: 'vault', file: tfile });
        c.attachPreview({ kind: 'vault', file: tfile });

        expect(c.getActivePreviewCount()).toBe(2);
        c.dispose();
        expect(dispose1).toHaveBeenCalledOnce();
        expect(dispose2).toHaveBeenCalledOnce();
        expect(c.getActivePreviewCount()).toBe(0);
    });

    it('dispose is idempotent', () => {
        const disposeFn = vi.fn();
        previewSpy.mockReturnValue({ url: 'blob:x', dispose: disposeFn });

        const c = new AudioAttachCoordinator(makeApp(), { importTargetFolder: 'Imports' });
        const tfile = makeTFile('audio/a.m4a');
        c.attachPreview({ kind: 'vault', file: tfile });

        c.dispose();
        c.dispose();
        c.dispose();

        expect(disposeFn).toHaveBeenCalledOnce();
    });

    it('swallows errors from individual dispose() calls', () => {
        const disposeOk = vi.fn();
        const disposeBoom = vi.fn(() => { throw new Error('boom'); });
        previewSpy.mockReturnValueOnce({ url: 'blob:1', dispose: disposeBoom });
        previewSpy.mockReturnValueOnce({ url: 'blob:2', dispose: disposeOk });

        const c = new AudioAttachCoordinator(makeApp(), { importTargetFolder: 'Imports' });
        const tfile = makeTFile('audio/a.m4a');
        c.attachPreview({ kind: 'vault', file: tfile });
        c.attachPreview({ kind: 'vault', file: tfile });

        expect(() => c.dispose()).not.toThrow();
        expect(disposeOk).toHaveBeenCalledOnce();
    });

    it('throws when methods are invoked after dispose', async () => {
        const c = new AudioAttachCoordinator(makeApp(), { importTargetFolder: 'Imports' });
        c.dispose();

        await expect(() => c.requestAttachFromDevice()).rejects.toThrow(/disposed/);
        await expect(() => c.requestVaultPick()).rejects.toThrow(/disposed/);
        expect(() => c.attachPreview({ kind: 'vault', file: makeTFile('a.m4a') })).toThrow(/disposed/);
    });
});
