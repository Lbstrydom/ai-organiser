/**
 * Tests for NoteWritePort — the commit mechanism (editor transaction vs vault.process).
 */

import type { TFile } from 'obsidian';
import { createTFile, MarkdownView } from './mocks/obsidian';
import { writeNote, minimalEdit, type ApplyFn } from '../src/services/noteEdit/noteWritePort';
import { ok, err } from '../src/core/result';

function makeFile(path: string): TFile {
    return createTFile(path) as unknown as TFile;
}

function makeEditor(content: string) {
    const replaceRange = vi.fn();
    return {
        editor: {
            getValue: () => content,
            replaceRange,
            // identity offset→pos so assertions can use raw offsets
            offsetToPos: (o: number) => o,
        } as any,
        replaceRange,
    };
}

/** App with an open markdown leaf whose editor holds `content`. */
function makeAppWithEditor(file: TFile, content: string) {
    const { editor, replaceRange } = makeEditor(content);
    const view = new MarkdownView();
    (view as any).file = file;
    (view as any).editor = editor;
    const app: any = {
        workspace: { getLeavesOfType: () => [{ view }] },
        vault: { process: vi.fn(), modify: vi.fn() },
    };
    return { app, replaceRange, editor };
}

/** App with NO open leaf for the file → vault path. */
function makeAppNoEditor(content: string, withProcess = true) {
    const state = { content };
    const vault: any = {
        read: async () => state.content,
        modify: vi.fn(async (_f: TFile, data: string) => { state.content = data; }),
    };
    if (withProcess) {
        vault.process = vi.fn(async (_f: TFile, fn: (d: string) => string) => {
            const next = fn(state.content); // throws → rejects (abort)
            state.content = next;
            return next;
        });
    }
    const app: any = { workspace: { getLeavesOfType: () => [] }, vault };
    return { app, state, vault };
}

const appendXYZ: ApplyFn = (c) => ok({ content: c + 'XYZ' });

describe('minimalEdit', () => {
    it('computes an append as a zero-width edit at the end', () => {
        expect(minimalEdit('abc', 'abcXYZ')).toEqual({ start: 3, oldEnd: 3, text: 'XYZ' });
    });
    it('computes a middle replacement via common prefix + suffix', () => {
        expect(minimalEdit('hello world', 'hello brave world')).toEqual({ start: 6, oldEnd: 6, text: 'brave ' });
    });
    it('is a no-op when equal', () => {
        expect(minimalEdit('same', 'same')).toEqual({ start: 4, oldEnd: 4, text: '' });
    });
});

describe('writeNote — editor path (file open in a leaf)', () => {
    it('applies a single minimal replaceRange (preserving undo/cursor), not setValue', async () => {
        const file = makeFile('a.md');
        const { app, replaceRange } = makeAppWithEditor(file, 'abc');
        const r = await writeNote(app, file, appendXYZ);
        expect(r.ok).toBe(true);
        expect(replaceRange).toHaveBeenCalledTimes(1);
        expect(replaceRange).toHaveBeenCalledWith('XYZ', 3, 3);
    });

    it('aborts without writing when apply returns err', async () => {
        const file = makeFile('a.md');
        const { app, replaceRange } = makeAppWithEditor(file, 'abc');
        const r = await writeNote(app, file, () => err('baseline-changed'));
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toBe('baseline-changed');
        expect(replaceRange).not.toHaveBeenCalled();
    });

    it('does not write when content is unchanged', async () => {
        const file = makeFile('a.md');
        const { app, replaceRange } = makeAppWithEditor(file, 'abc');
        const r = await writeNote(app, file, (c) => ok({ content: c }));
        expect(r.ok).toBe(true);
        expect(replaceRange).not.toHaveBeenCalled();
    });

    it('returns write-failed (never throws) when the editor transaction throws', async () => {
        const file = makeFile('a.md');
        const { app, replaceRange } = makeAppWithEditor(file, 'abc');
        replaceRange.mockImplementation(() => { throw new Error('CM out of range'); });
        const r = await writeNote(app, file, appendXYZ);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toBe('write-failed');
    });

    it('the minimal edit reconstructs the intended full document (H5)', async () => {
        // Apply the recorded replaceRange against the original string and assert equality.
        const file = makeFile('a.md');
        const original = 'hello world';
        const { app, replaceRange } = makeAppWithEditor(file, original);
        await writeNote(app, file, () => ok({ content: 'hello brave world' }));
        const [text, from, to] = replaceRange.mock.calls[0];
        const reconstructed = original.slice(0, from) + text + original.slice(to);
        expect(reconstructed).toBe('hello brave world');
    });
});

describe('writeNote — vault path (file not open)', () => {
    it('writes via vault.process when the note is not open', async () => {
        const file = makeFile('a.md');
        const { app, state, vault } = makeAppNoEditor('abc');
        const r = await writeNote(app, file, appendXYZ);
        expect(r.ok).toBe(true);
        expect(vault.process).toHaveBeenCalledTimes(1);
        expect(state.content).toBe('abcXYZ');
    });

    it('aborts via throw inside vault.process — file left byte-identical', async () => {
        const file = makeFile('a.md');
        const { app, state, vault } = makeAppNoEditor('abc');
        const r = await writeNote(app, file, () => err('baseline-changed'));
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toBe('baseline-changed');
        expect(state.content).toBe('abc'); // unchanged
        expect(vault.process).toHaveBeenCalledTimes(1);
    });

    it('falls back to read+modify on older Obsidian without vault.process', async () => {
        const file = makeFile('a.md');
        const { app, state, vault } = makeAppNoEditor('abc', false);
        const r = await writeNote(app, file, appendXYZ);
        expect(r.ok).toBe(true);
        expect(state.content).toBe('abcXYZ');
        expect(vault.modify).toHaveBeenCalledTimes(1);
    });
});
