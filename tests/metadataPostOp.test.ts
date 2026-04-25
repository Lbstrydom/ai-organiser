/**
 * markNoteProcessed unit tests.
 *
 * Covers the 11 cases from docs/plans/post-op-metadata-helper.md §6:
 *   1. skips when enableStructuredMetadata = false
 *   2. flips pending → processed
 *   3. flips undefined status → processed
 *   4. leaves error status alone
 *   5. leaves processed status alone
 *   6. leaves custom status alone
 *   7. skipStatusFlip honoured
 *   8. skipWordCount honoured
 *   9. contentForWordCount override used
 *  10. default reads vault.read for word count
 *  11. updateAIOMetadata failure → returns false
 *
 * Plus: caller-supplied patch fields merge cleanly with derived fields.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TFile } from 'obsidian';
import { markNoteProcessed } from '../src/services/metadataPostOp';

// In the test we treat the helper as a black box over (plugin, file) — we mock
// the two dependencies it talks to: app.fileManager.processFrontMatter (for the
// write) and app.vault.read (for word_count). Status read goes through
// app.metadataCache.getFileCache.

interface Frontmatter { [k: string]: unknown }

function makeFile(path = 'note.md'): TFile {
    const f = Object.create(TFile.prototype) as TFile;
    Object.assign(f, { path, name: path.split('/').pop() ?? path, basename: 'note', extension: 'md' });
    return f;
}

function makePlugin(opts: {
    enableStructuredMetadata?: boolean;
    fmInitial?: Frontmatter;
    vaultContent?: string;
    processFrontMatterShouldThrow?: boolean;
} = {}) {
    const fm: Frontmatter = { ...(opts.fmInitial ?? {}) };
    const processFrontMatter = vi.fn(async (_file: TFile, mutator: (frontmatter: Frontmatter) => void) => {
        if (opts.processFrontMatterShouldThrow) throw new Error('write failure');
        mutator(fm);
    });
    const vaultRead = vi.fn(async () => opts.vaultContent ?? 'word '.repeat(42).trim());
    const getFileCache = vi.fn(() => ({ frontmatter: { ...fm } }));

    return {
        plugin: {
            settings: { enableStructuredMetadata: opts.enableStructuredMetadata ?? true },
            app: {
                fileManager: { processFrontMatter },
                vault: { read: vaultRead },
                metadataCache: { getFileCache },
            },
        } as never,
        fm,
        processFrontMatter,
        vaultRead,
        getFileCache,
    };
}

describe('markNoteProcessed', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('skips when enableStructuredMetadata is false', async () => {
        const ctx = makePlugin({ enableStructuredMetadata: false });
        const result = await markNoteProcessed(ctx.plugin, makeFile(), { summary: 'x' });
        expect(result).toBe(false);
        expect(ctx.processFrontMatter).not.toHaveBeenCalled();
        expect(ctx.vaultRead).not.toHaveBeenCalled();
    });

    it('flips pending → processed', async () => {
        const ctx = makePlugin({ fmInitial: { status: 'pending' } });
        await markNoteProcessed(ctx.plugin, makeFile());
        expect(ctx.fm.status).toBe('processed');
    });

    it('flips undefined status → processed', async () => {
        const ctx = makePlugin({ fmInitial: {} });
        await markNoteProcessed(ctx.plugin, makeFile());
        expect(ctx.fm.status).toBe('processed');
    });

    it('leaves error status alone', async () => {
        const ctx = makePlugin({ fmInitial: { status: 'error' } });
        await markNoteProcessed(ctx.plugin, makeFile());
        expect(ctx.fm.status).toBe('error');
    });

    it('leaves processed status alone (idempotent)', async () => {
        const ctx = makePlugin({ fmInitial: { status: 'processed' } });
        await markNoteProcessed(ctx.plugin, makeFile());
        expect(ctx.fm.status).toBe('processed');
    });

    it('leaves custom status alone', async () => {
        const ctx = makePlugin({ fmInitial: { status: 'archived' } });
        await markNoteProcessed(ctx.plugin, makeFile());
        expect(ctx.fm.status).toBe('archived');
    });

    it('skipStatusFlip skips the flip', async () => {
        const ctx = makePlugin({ fmInitial: { status: 'pending' } });
        await markNoteProcessed(ctx.plugin, makeFile(), {}, { skipStatusFlip: true });
        expect(ctx.fm.status).toBe('pending');
    });

    it('skipWordCount skips word_count and the vault read', async () => {
        const ctx = makePlugin();
        await markNoteProcessed(ctx.plugin, makeFile(), {}, { skipWordCount: true });
        expect(ctx.vaultRead).not.toHaveBeenCalled();
        expect(ctx.fm.word_count).toBeUndefined();
    });

    it('uses contentForWordCount override when provided (skips vault read)', async () => {
        const ctx = makePlugin();
        await markNoteProcessed(ctx.plugin, makeFile(), {}, { contentForWordCount: 'one two three four five' });
        expect(ctx.vaultRead).not.toHaveBeenCalled();
        expect(ctx.fm.word_count).toBe(5);
    });

    it('reads from vault.read by default for word count', async () => {
        const ctx = makePlugin({ vaultContent: 'hello world from the vault' });
        await markNoteProcessed(ctx.plugin, makeFile());
        expect(ctx.vaultRead).toHaveBeenCalledTimes(1);
        expect(ctx.fm.word_count).toBe(5);
    });

    it('returns false when the underlying write fails', async () => {
        const ctx = makePlugin({ processFrontMatterShouldThrow: true });
        const result = await markNoteProcessed(ctx.plugin, makeFile(), { summary: 'x' });
        expect(result).toBe(false);
    });

    it('returns false when vault.read throws (file deleted mid-op)', async () => {
        const ctx = makePlugin();
        ctx.vaultRead.mockRejectedValueOnce(new Error('ENOENT: no such file'));
        const result = await markNoteProcessed(ctx.plugin, makeFile(), { summary: 'x' });
        expect(result).toBe(false);
        // Should not have proceeded to the write
        expect(ctx.processFrontMatter).not.toHaveBeenCalled();
    });

    it('does not call vault.read when contentForWordCount is provided (avoids deleted-file race)', async () => {
        const ctx = makePlugin();
        ctx.vaultRead.mockRejectedValueOnce(new Error('ENOENT'));
        const result = await markNoteProcessed(ctx.plugin, makeFile(), { summary: 'x' }, { contentForWordCount: 'one two three' });
        expect(result).toBe(true);
        expect(ctx.vaultRead).not.toHaveBeenCalled();
        expect(ctx.fm.word_count).toBe(3);
    });

    it('caller-supplied patch.status overrides the pending → processed flip', async () => {
        // G-WD-M6 fix: explicit caller fields must win over derived defaults.
        const ctx = makePlugin({ fmInitial: { status: 'pending' } });
        await markNoteProcessed(ctx.plugin, makeFile(), { status: 'error' });
        expect(ctx.fm.status).toBe('error');
    });

    it('caller-supplied patch.word_count overrides the derived count', async () => {
        const ctx = makePlugin({ vaultContent: 'one two three four five' });
        await markNoteProcessed(ctx.plugin, makeFile(), { word_count: 999 });
        expect(ctx.fm.word_count).toBe(999);
    });

    it('merges caller-supplied patch with derived fields atomically', async () => {
        const ctx = makePlugin({ fmInitial: { status: 'pending' }, vaultContent: 'one two three' });
        await markNoteProcessed(ctx.plugin, makeFile(), { summary: 'hello', source_url: 'https://example.com' });
        expect(ctx.fm.summary).toBe('hello');
        expect(ctx.fm.source_url).toBe('https://example.com');
        expect(ctx.fm.status).toBe('processed');
        expect(ctx.fm.word_count).toBe(3);
        expect(ctx.processFrontMatter).toHaveBeenCalledTimes(1);
    });
});
