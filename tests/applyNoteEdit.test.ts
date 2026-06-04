/**
 * Tests for applyNoteEdit — the compare-and-commit write primitive.
 */

import type { TFile } from 'obsidian';
import { createTFile, MarkdownView } from './mocks/obsidian';

// Control the review gate deterministically (no real modal in unit tests).
vi.mock('../src/utils/reviewEditsHelper', () => ({
    showReviewOrApply: vi.fn(),
}));

import { applyNoteEdit, type EditTarget } from '../src/services/noteEdit/applyNoteEdit';
import { NoteMutation } from '../src/services/noteEdit/noteMutation';
import { showReviewOrApply } from '../src/utils/reviewEditsHelper';

const reviewMock = showReviewOrApply as unknown as ReturnType<typeof vi.fn>;

const MESSAGES = {
    noteDeletedEditCancelled: 'deleted',
    nothingToInsert: 'nothing',
    noteChangedReRun: 'changed',
    couldNotWriteNote: 'failed',
    insertionPointMovedAppended: 'moved',
    openNote: 'open',
};

function makeFile(path: string): TFile {
    return createTFile(path) as unknown as TFile;
}

function makePlugin(file: TFile | null, editorContent: string) {
    const replaceRange = vi.fn();
    const view = new MarkdownView();
    (view as any).file = file;
    (view as any).editor = {
        getValue: () => editorContent,
        replaceRange,
        offsetToPos: (o: number) => o,
    };
    const plugin: any = {
        app: {
            vault: {
                getAbstractFileByPath: (p: string) => (file && p === file.path ? file : null),
                modify: vi.fn(),
            },
            workspace: { getLeavesOfType: () => (file ? [{ view }] : []) },
        },
        settings: { enableReviewedEdits: false, autoEnsureNoteStructure: false },
        t: { messages: MESSAGES },
    };
    return { plugin, replaceRange };
}

beforeEach(() => {
    reviewMock.mockReset();
    // Default: accept → run applyFn (mimics review off / accept).
    reviewMock.mockImplementation(async (_p: unknown, _old: string, _new: string, applyFn: () => Promise<void>) => {
        await applyFn();
        return 'accept';
    });
});

describe('applyNoteEdit — full-replace', () => {
    it('commits when the baseline matches (review off)', async () => {
        const file = makeFile('a.md');
        const { plugin, replaceRange } = makePlugin(file, 'BASE');
        const target: EditTarget = { kind: 'full-replace', filePath: 'a.md', baseline: 'BASE', nextContent: 'NEXT' };
        const r = await applyNoteEdit(plugin, target, { review: false });
        expect(r.ok).toBe(true);
        expect(replaceRange).toHaveBeenCalledTimes(1);
    });

    it('aborts with baseline-changed when the note changed under us', async () => {
        const file = makeFile('a.md');
        const { plugin, replaceRange } = makePlugin(file, 'EDITED-SINCE-CAPTURE');
        const target: EditTarget = { kind: 'full-replace', filePath: 'a.md', baseline: 'BASE', nextContent: 'NEXT' };
        const r = await applyNoteEdit(plugin, target, { review: false });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toBe('baseline-changed');
        expect(replaceRange).not.toHaveBeenCalled();
    });
});

describe('applyNoteEdit — guards', () => {
    it('returns target-missing when the captured file no longer resolves', async () => {
        const { plugin } = makePlugin(null, '');
        const target: EditTarget = { kind: 'full-replace', filePath: 'gone.md', baseline: 'B', nextContent: 'N' };
        const r = await applyNoteEdit(plugin, target, { review: false });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toBe('target-missing');
    });

    it('returns empty-output for a whitespace-only insert (no destructive write)', async () => {
        const file = makeFile('a.md');
        const { plugin, replaceRange } = makePlugin(file, 'BASE');
        const target: EditTarget = { kind: 'cursor-insert', filePath: 'a.md', baseline: 'BASE', anchorSnippet: 'BA', text: '   ' };
        const r = await applyNoteEdit(plugin, target, { review: false });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toBe('empty-output');
        expect(replaceRange).not.toHaveBeenCalled();
    });
});

describe('applyNoteEdit — cursor-insert degrade', () => {
    it('degrades to append (ok) when the anchor is lost', async () => {
        const file = makeFile('a.md');
        const { plugin, replaceRange } = makePlugin(file, 'completely different content now');
        const target: EditTarget = { kind: 'cursor-insert', filePath: 'a.md', baseline: 'old', anchorSnippet: 'NONEXISTENT-ANCHOR', text: '\n\nINSERTED' };
        const r = await applyNoteEdit(plugin, target, { review: false });
        expect(r.ok).toBe(true);
        expect(replaceRange).toHaveBeenCalledTimes(1);
    });
});

describe('applyNoteEdit — review gate', () => {
    it('routes through showReviewOrApply when review is on (accept commits)', async () => {
        const file = makeFile('a.md');
        const { plugin, replaceRange } = makePlugin(file, 'BASE');
        const target: EditTarget = { kind: 'full-replace', filePath: 'a.md', baseline: 'BASE', nextContent: 'NEXT' };
        const r = await applyNoteEdit(plugin, target, { review: true });
        expect(reviewMock).toHaveBeenCalledTimes(1);
        expect(r.ok).toBe(true);
        expect(replaceRange).toHaveBeenCalledTimes(1);
    });

    it('returns rejected and does not write when the user rejects', async () => {
        reviewMock.mockImplementation(async () => 'reject');
        const file = makeFile('a.md');
        const { plugin, replaceRange } = makePlugin(file, 'BASE');
        const target: EditTarget = { kind: 'full-replace', filePath: 'a.md', baseline: 'BASE', nextContent: 'NEXT' };
        const r = await applyNoteEdit(plugin, target, { review: true });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toBe('rejected');
        expect(replaceRange).not.toHaveBeenCalled();
    });
});

describe('applyNoteEdit — composite (additive)', () => {
    it('commits an additive composite with no baseline gate even if content changed', async () => {
        const file = makeFile('a.md');
        // editor content differs from target.baseline — additive must NOT abort.
        const { plugin, replaceRange } = makePlugin(file, 'live content the user just typed');
        const target: EditTarget = {
            kind: 'composite',
            filePath: 'a.md',
            baseline: 'captured baseline',
            recompute: new NoteMutation().appendToEnd('SUMMARY').build(),
        };
        const r = await applyNoteEdit(plugin, target, { review: false });
        expect(r.ok).toBe(true);
        expect(replaceRange).toHaveBeenCalledTimes(1);
    });
});
