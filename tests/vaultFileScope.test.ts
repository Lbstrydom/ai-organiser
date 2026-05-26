// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';

vi.mock('obsidian', async () => {
    const mod = await import('./mocks/obsidian');
    return mod;
});

import type { App, TFile } from 'obsidian';
import { getScopedFiles, pickDefaultScope } from '../src/ui/utils/vaultFileScope';

function mkFile(path: string, extension: string): TFile {
    return { path, extension, name: path.split('/').pop() } as unknown as TFile;
}

function mkApp(opts: {
    allFiles: TFile[];
    sourceCache?: { embeds?: Array<{ link: string }>; links?: Array<{ link: string }> };
    resolve?: (link: string) => TFile | null;
}): App {
    return {
        vault: {
            getFiles: () => opts.allFiles,
        },
        metadataCache: {
            getFileCache: () => opts.sourceCache ?? null,
            getFirstLinkpathDest: (link: string) => (opts.resolve ? opts.resolve(link) : null),
        },
    } as unknown as App;
}

describe('getScopedFiles', () => {
    it('returns all-vault when sourceFile is null', () => {
        const allFiles = [mkFile('a.docx', 'docx'), mkFile('b.pdf', 'pdf')];
        const app = mkApp({ allFiles });
        const result = getScopedFiles(app, null, 'active-note', () => true);
        expect(result.scope).toBe('all-vault');
        expect(result.files).toHaveLength(2);
        expect(result.activeNoteCount).toBe(0);
    });

    it('returns in-note files when scope=active-note and note has embeds', () => {
        const inNote = mkFile('docs/vat.docx', 'docx');
        const other = mkFile('archive/old.docx', 'docx');
        const source = mkFile('meeting.md', 'md');
        const app = mkApp({
            allFiles: [inNote, other, source],
            sourceCache: { embeds: [{ link: 'docs/vat.docx' }] },
            resolve: (link) => (link === 'docs/vat.docx' ? inNote : null),
        });
        const result = getScopedFiles(app, source, 'active-note', (f) => f.extension === 'docx');
        expect(result.scope).toBe('active-note');
        expect(result.files).toEqual([inNote]);
        expect(result.activeNoteCount).toBe(1);
        expect(result.vaultCount).toBe(2);
    });

    it('falls back to all-vault when scope=active-note but no in-note files', () => {
        const source = mkFile('meeting.md', 'md');
        const all = [mkFile('a.docx', 'docx'), source];
        const app = mkApp({
            allFiles: all,
            sourceCache: { embeds: [] },
            resolve: () => null,
        });
        const result = getScopedFiles(app, source, 'active-note', (f) => f.extension === 'docx');
        expect(result.scope).toBe('all-vault');
        expect(result.activeNoteCount).toBe(0);
    });

    it('respects roleFilter when collecting in-note files', () => {
        const docFile = mkFile('a.docx', 'docx');
        const audioFile = mkFile('a.mp3', 'mp3');
        const source = mkFile('meeting.md', 'md');
        const app = mkApp({
            allFiles: [docFile, audioFile, source],
            sourceCache: { links: [{ link: 'a.docx' }, { link: 'a.mp3' }] },
            resolve: (link) => (link === 'a.docx' ? docFile : link === 'a.mp3' ? audioFile : null),
        });
        const result = getScopedFiles(app, source, 'active-note', (f) => f.extension === 'docx');
        expect(result.files).toEqual([docFile]);
        expect(result.activeNoteCount).toBe(1);
    });

    it('returns all-vault when scope=all-vault even with in-note files present', () => {
        const inNote = mkFile('a.docx', 'docx');
        const other = mkFile('b.docx', 'docx');
        const source = mkFile('meeting.md', 'md');
        const app = mkApp({
            allFiles: [inNote, other, source],
            sourceCache: { embeds: [{ link: 'a.docx' }] },
            resolve: () => inNote,
        });
        const result = getScopedFiles(app, source, 'all-vault', (f) => f.extension === 'docx');
        expect(result.scope).toBe('all-vault');
        expect(result.files).toHaveLength(2);
    });
});

describe('pickDefaultScope', () => {
    it('returns active-note when in-note count > 0', () => {
        expect(pickDefaultScope(3)).toBe('active-note');
    });
    it('returns all-vault when in-note count = 0', () => {
        expect(pickDefaultScope(0)).toBe('all-vault');
    });
});
