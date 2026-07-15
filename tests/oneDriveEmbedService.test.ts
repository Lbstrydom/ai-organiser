// @vitest-environment happy-dom
/**
 * Unit tests for src/services/oneDriveEmbedService (onedrive-link-insert
 * "visual embed" extension, brainstormed 2026-07-15).
 *
 * Coverage:
 *  - copyOneDriveFileIntoVault: desktop-only guard, stat/read/write failures,
 *    size-cap rejection, collision-safe naming, mtime passthrough.
 *  - findStaleOneDriveEmbeds: mtime mismatch detection, unreachable source
 *    silently excluded (not an error), desktop-only guard.
 *  - refreshOneDriveEmbed: overwrite-in-place, missing vault copy, read/write failures.
 */

vi.mock('obsidian', async () => {
    const mod = await import('./mocks/obsidian');
    return mod;
});

import { App, TFile } from 'obsidian';
import {
    copyOneDriveFileIntoVault, findStaleOneDriveEmbeds, refreshOneDriveEmbed,
    ONEDRIVE_EMBED_MAX_BYTES, ONEDRIVE_EMBED_FOLDER,
} from '../src/services/oneDriveEmbedService';
import type { OneDriveEmbedMarker } from '../src/ui/utils/oneDriveLinkUtils';

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
    return f;
}

function makeFsImpl(opts: {
    statImpl?: (p: string) => { size: number; mtimeMs: number };
    readImpl?: (p: string) => Buffer;
}): (mod: string) => unknown {
    return (mod: string) => {
        if (mod === 'fs') {
            return {
                statSync: opts.statImpl ?? (() => ({ size: 100, mtimeMs: 1000 })),
                readFileSync: opts.readImpl ?? (() => Buffer.from('bytes')),
            };
        }
        throw new Error(`unexpected require: ${mod}`);
    };
}

function makeApp(opts?: {
    existing?: Set<string>;
    createBinarySpy?: ReturnType<typeof vi.fn>;
    modifyBinarySpy?: ReturnType<typeof vi.fn>;
    vaultFile?: TFile | null;
}): App {
    const existing = opts?.existing ?? new Set<string>();
    return {
        vault: {
            getAbstractFileByPath: (p: string) =>
                opts?.vaultFile !== undefined ? opts.vaultFile : (existing.has(p) ? {} as unknown : null),
            createFolder: vi.fn().mockResolvedValue(undefined),
            createBinary: opts?.createBinarySpy ?? vi.fn().mockResolvedValue(makeTFile('x')),
            modifyBinary: opts?.modifyBinarySpy ?? vi.fn().mockResolvedValue(undefined),
        },
    } as unknown as App;
}

describe('copyOneDriveFileIntoVault', () => {
    afterEach(() => setRequireImpl(null));

    it('returns desktop-only when fs is unavailable', async () => {
        setRequireImpl(() => undefined);
        const result = await copyOneDriveFileIntoVault(makeApp(), 'C:\\a\\report.pdf');
        expect(result).toEqual({ ok: false, error: 'desktop-only' });
    });

    it('returns stat-failed when statSync throws', async () => {
        setRequireImpl(makeFsImpl({ statImpl: () => { throw new Error('ENOENT'); } }));
        const result = await copyOneDriveFileIntoVault(makeApp(), 'C:\\a\\report.pdf');
        expect(result).toEqual({ ok: false, error: 'stat-failed' });
    });

    it('returns too-large when the source exceeds the size cap', async () => {
        setRequireImpl(makeFsImpl({ statImpl: () => ({ size: ONEDRIVE_EMBED_MAX_BYTES + 1, mtimeMs: 1000 }) }));
        const result = await copyOneDriveFileIntoVault(makeApp(), 'C:\\a\\report.pdf');
        expect(result).toEqual({ ok: false, error: 'too-large' });
    });

    it('accepts a file exactly at the size cap', async () => {
        setRequireImpl(makeFsImpl({ statImpl: () => ({ size: ONEDRIVE_EMBED_MAX_BYTES, mtimeMs: 1000 }) }));
        const result = await copyOneDriveFileIntoVault(makeApp(), 'C:\\a\\report.pdf');
        expect(result.ok).toBe(true);
    });

    it('returns read-failed when readFileSync throws', async () => {
        setRequireImpl(makeFsImpl({ readImpl: () => { throw new Error('EPERM'); } }));
        const result = await copyOneDriveFileIntoVault(makeApp(), 'C:\\a\\report.pdf');
        expect(result).toEqual({ ok: false, error: 'read-failed' });
    });

    it('returns write-failed when vault.createBinary rejects', async () => {
        setRequireImpl(makeFsImpl({}));
        const createBinarySpy = vi.fn().mockRejectedValue(new Error('disk full'));
        const result = await copyOneDriveFileIntoVault(makeApp({ createBinarySpy }), 'C:\\a\\report.pdf');
        expect(result).toEqual({ ok: false, error: 'write-failed' });
    });

    it('writes into the managed OneDrive Embeds folder with the source mtime', async () => {
        setRequireImpl(makeFsImpl({ statImpl: () => ({ size: 100, mtimeMs: 1752515000000 }) }));
        const createBinarySpy = vi.fn().mockResolvedValue(makeTFile('x'));
        const result = await copyOneDriveFileIntoVault(makeApp({ createBinarySpy }), 'C:\\a\\report.pdf');
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.vaultPath.startsWith(ONEDRIVE_EMBED_FOLDER)).toBe(true);
        expect(result.value.vaultPath.endsWith('report.pdf')).toBe(true);
        expect(result.value.mtimeMs).toBe(1752515000000);
    });

    it('uses a collision-safe suffix when the target vault path already exists', async () => {
        setRequireImpl(makeFsImpl({}));
        const existingPath = `${ONEDRIVE_EMBED_FOLDER}/report.pdf`;
        const createBinarySpy = vi.fn().mockResolvedValue(makeTFile('x'));
        const result = await copyOneDriveFileIntoVault(
            makeApp({ existing: new Set([existingPath]), createBinarySpy }),
            'C:\\a\\report.pdf',
        );
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.vaultPath).not.toBe(existingPath);
        expect(result.value.vaultPath).toContain('report');
    });
});

describe('findStaleOneDriveEmbeds', () => {
    afterEach(() => setRequireImpl(null));

    function makeMarker(overrides?: Partial<OneDriveEmbedMarker>): OneDriveEmbedMarker {
        return {
            source: 'C:\\a\\report.pdf',
            vaultPath: 'AI-Organiser/OneDrive Embeds/report.pdf',
            mtimeMs: 1000,
            raw: '<!-- onedrive-embed: source="C:\\a\\report.pdf" vault="AI-Organiser/OneDrive Embeds/report.pdf" mtime="1000" -->',
            ...overrides,
        };
    }

    it('returns [] when fs is unavailable', () => {
        setRequireImpl(() => undefined);
        expect(findStaleOneDriveEmbeds([makeMarker()])).toEqual([]);
    });

    it('flags a marker whose source mtime differs from the recorded one', () => {
        setRequireImpl(makeFsImpl({ statImpl: () => ({ size: 1, mtimeMs: 2000 }) }));
        const marker = makeMarker({ mtimeMs: 1000 });
        const stale = findStaleOneDriveEmbeds([marker]);
        expect(stale).toEqual([{ marker, currentMtimeMs: 2000 }]);
    });

    it('does not flag a marker whose source mtime is unchanged', () => {
        setRequireImpl(makeFsImpl({ statImpl: () => ({ size: 1, mtimeMs: 1000 }) }));
        expect(findStaleOneDriveEmbeds([makeMarker({ mtimeMs: 1000 })])).toEqual([]);
    });

    it('silently excludes (not errors on) a source that can no longer be stat\'d', () => {
        setRequireImpl(makeFsImpl({ statImpl: () => { throw new Error('ENOENT'); } }));
        expect(findStaleOneDriveEmbeds([makeMarker()])).toEqual([]);
    });

    it('handles a mixed list — only the genuinely-changed marker is returned', () => {
        const unchanged = makeMarker({ source: 'C:\\a\\unchanged.pdf', mtimeMs: 500 });
        const changed = makeMarker({ source: 'C:\\a\\changed.pdf', mtimeMs: 500 });
        setRequireImpl(makeFsImpl({
            statImpl: (p: string) => ({ size: 1, mtimeMs: p === 'C:\\a\\changed.pdf' ? 999 : 500 }),
        }));
        const stale = findStaleOneDriveEmbeds([unchanged, changed]);
        expect(stale).toHaveLength(1);
        expect(stale[0].marker.source).toBe('C:\\a\\changed.pdf');
    });
});

describe('refreshOneDriveEmbed', () => {
    afterEach(() => setRequireImpl(null));

    const marker: OneDriveEmbedMarker = {
        source: 'C:\\a\\report.pdf',
        vaultPath: 'AI-Organiser/OneDrive Embeds/report.pdf',
        mtimeMs: 1000,
        raw: '<!-- onedrive-embed: source="C:\\a\\report.pdf" vault="AI-Organiser/OneDrive Embeds/report.pdf" mtime="1000" -->',
    };

    it('returns desktop-only when fs is unavailable', async () => {
        setRequireImpl(() => undefined);
        const result = await refreshOneDriveEmbed(makeApp(), { marker, currentMtimeMs: 2000 });
        expect(result).toEqual({ ok: false, error: 'desktop-only' });
    });

    it('returns read-failed when the source can no longer be read', async () => {
        setRequireImpl(makeFsImpl({ readImpl: () => { throw new Error('ENOENT'); } }));
        const result = await refreshOneDriveEmbed(makeApp(), { marker, currentMtimeMs: 2000 });
        expect(result).toEqual({ ok: false, error: 'read-failed' });
    });

    it('returns vault-copy-missing when the previously-copied vault file no longer exists', async () => {
        setRequireImpl(makeFsImpl({}));
        const result = await refreshOneDriveEmbed(makeApp({ vaultFile: null }), { marker, currentMtimeMs: 2000 });
        expect(result).toEqual({ ok: false, error: 'vault-copy-missing' });
    });

    it('returns write-failed when vault.modifyBinary rejects', async () => {
        setRequireImpl(makeFsImpl({}));
        const modifyBinarySpy = vi.fn().mockRejectedValue(new Error('disk full'));
        const result = await refreshOneDriveEmbed(
            makeApp({ vaultFile: makeTFile(marker.vaultPath), modifyBinarySpy }),
            { marker, currentMtimeMs: 2000 },
        );
        expect(result).toEqual({ ok: false, error: 'write-failed' });
    });

    it('overwrites the existing vault file in place and returns the new mtime', async () => {
        setRequireImpl(makeFsImpl({}));
        const modifyBinarySpy = vi.fn().mockResolvedValue(undefined);
        const vaultFile = makeTFile(marker.vaultPath);
        const result = await refreshOneDriveEmbed(
            makeApp({ vaultFile, modifyBinarySpy }),
            { marker, currentMtimeMs: 1752515000000 },
        );
        expect(result).toEqual({ ok: true, value: { mtimeMs: 1752515000000 } });
        expect(modifyBinarySpy).toHaveBeenCalledWith(vaultFile, expect.anything());
    });
});
