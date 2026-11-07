/**
 * Upgrade metadata (MigrationService.migrateNote) and the `status` property: the plugin's processing mark is written only
 * over no status or its own mark. A user's status and any adopted note's status survive, even with "Overwrite existing".
 */
import { describe, it, expect, vi } from 'vitest';
import { TFile } from 'obsidian';
import { MigrationService } from '../src/services/migrationService';

type Fm = Record<string, unknown>;

function setup(initial: Fm) {
    const fm: Fm = { ...initial };
    const file = Object.create(TFile.prototype) as TFile;
    Object.assign(file, { path: 'P/Note.md', name: 'Note.md', basename: 'Note', extension: 'md', stat: { mtime: 0 } });
    const app = {
        vault: { read: vi.fn(async () => 'Some body text here') },
        metadataCache: { getFileCache: vi.fn(() => ({ frontmatter: { ...fm } })) },
        fileManager: { processFrontMatter: vi.fn(async (_f: TFile, mutate: (f: Fm) => void) => { mutate(fm); }) },
    };
    const plugin = { settings: { autoDetectContentType: false } };
    const service = new MigrationService(app as never, plugin as never);
    return { fm, file, service };
}

const overwrite = { overwriteExisting: true, extractSummary: false } as never;

describe('Upgrade metadata keeps a status that is not the AI mark', () => {
    it('writes the mark over no status, and over its own mark when overwriting (unchanged behaviour)', async () => {
        const none = setup({ tags: ['a'] });
        await none.service.migrateNote(none.file, overwrite);
        expect(none.fm.status).toBe('processed');
        const own = setup({ status: 'pending', tags: ['a'] });
        await own.service.migrateNote(own.file, overwrite);
        expect(own.fm.status).toBe('processed');
    });

    it('never replaces a user status, even with Overwrite existing metadata', async () => {
        for (const status of ['active', 'draft', 'Processed']) {
            const w = setup({ status, tags: ['a'] });
            await w.service.migrateNote(w.file, overwrite);
            expect(w.fm.status).toBe(status);
            expect(w.fm.word_count).toBeDefined();
        }
    });

    it('never writes a status on an adopted project, area or container', async () => {
        const project = setup({ 'aio-role': 'project', tags: ['a'] });
        await project.service.migrateNote(project.file, overwrite);
        expect(project.fm.status).toBeUndefined();
        const area = setup({ 'aio-role': 'area', status: 'processed', tags: ['a'] });
        await area.service.migrateNote(area.file, overwrite);
        expect(area.fm.status).toBe('processed');
    });
});
