/**
 * Protected folders: the empty list is byte-identical to the plugin without the feature, and a
 * non-empty list blocks every user-note write seam without touching the vault.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { writeNote } from '../src/services/noteEdit/noteWritePort';
import { TagUtils } from '../src/utils/tagUtils';
import { updateAIOMetadata } from '../src/utils/frontmatterUtils';
import { guardActiveNote, installActiveNoteGuard } from '../src/utils/protectedGuard';
import { setActiveProtection } from '../src/core/protectedPaths';
import { ok } from '../src/core/result';
import { createTFile, mockNotices, clearMockNotices } from './mocks/obsidian';

// The tag writers pause briefly via window.setTimeout; the node test environment has no window.
vi.stubGlobal('window', { setTimeout: (fn: () => void) => { fn(); return 0; } });

afterEach(() => {
	setActiveProtection(null);
	installActiveNoteGuard(null, null);
	clearMockNotices();
});

function makeApp(initial: string) {
	let text = initial;
	const process = vi.fn(async (_f: unknown, fn: (s: string) => string) => {
		text = fn(text);
		return text;
	});
	const modify = vi.fn(async (_f: unknown, content: string) => { text = content; });
	const processFrontMatter = vi.fn(async (_f: unknown, fn: (fm: Record<string, unknown>) => void) => { fn({}); });
	const app = {
		vault: { process, modify, read: async () => text },
		workspace: { getLeavesOfType: () => [] },
		metadataCache: { getFileCache: () => null },
		fileManager: { processFrontMatter },
	};
	return { app, process, modify, processFrontMatter, get text() { return text; } };
}

const upper = (current: string) => ok({ content: current.toUpperCase() });

describe('noteWritePort with protected folders', () => {
	it('writes identically when the list is absent or empty', async () => {
		const results: string[] = [];
		for (const protectedFolders of [undefined, [], { protectedFolders: [] }] as const) {
			const h = makeApp('hello');
			const file = createTFile('Notes/a.md');
			const res = await writeNote(h.app as never, file as never, upper, protectedFolders as never);
			expect(res.ok).toBe(true);
			results.push(h.text);
		}
		expect(new Set(results)).toEqual(new Set(['HELLO']));
	});

	it('refuses a protected note without touching the vault', async () => {
		const h = makeApp('hello');
		const file = createTFile('Courses/Live/a.md');
		const res = await writeNote(h.app as never, file as never, upper, ['Courses/Live']);
		expect(res).toEqual({ ok: false, error: 'protected-path' });
		expect(h.process).not.toHaveBeenCalled();
		expect(h.modify).not.toHaveBeenCalled();
		expect(h.text).toBe('hello');
	});

	it('still writes a sibling folder that shares a prefix', async () => {
		const h = makeApp('hello');
		const file = createTFile('Courses/LiveExtra/a.md');
		const res = await writeNote(h.app as never, file as never, upper, ['Courses/Live']);
		expect(res.ok).toBe(true);
		expect(h.text).toBe('HELLO');
	});
});

describe('tag and frontmatter writers', () => {
	const fileIn = (path: string) => createTFile(path) as never;

	it('clearTags skips a protected note and reports it as protected', async () => {
		setActiveProtection(() => ['P']);
		const h = makeApp('---\ntags: [a]\n---\nbody');
		const res = await TagUtils.clearTags(h.app as never, fileIn('P/x.md'));
		expect(res.protected).toBe(true);
		expect(res.success).toBe(true);
		expect(h.modify).not.toHaveBeenCalled();
	});

	it('updateNoteTags and writeTagsToFrontmatter skip a protected note', async () => {
		setActiveProtection(() => ['P']);
		const h = makeApp('body');
		const a = await TagUtils.updateNoteTags(h.app as never, fileIn('P/x.md'), ['t'], [], true);
		const b = await TagUtils.writeTagsToFrontmatter(h.app as never, fileIn('P/x.md'), ['t']);
		expect(a.protected).toBe(true);
		expect(b.protected).toBe(true);
		expect(h.modify).not.toHaveBeenCalled();
	});

	it('writeTagsToFrontmatter still writes an unprotected note', async () => {
		setActiveProtection(() => ['P']);
		const h = makeApp('body');
		const res = await TagUtils.writeTagsToFrontmatter(h.app as never, fileIn('Other/x.md'), ['t']);
		expect(res.success).toBe(true);
		expect(res.protected).toBeUndefined();
		expect(h.modify).toHaveBeenCalledTimes(1);
	});

	it('updateAIOMetadata refuses a protected note and works otherwise', async () => {
		setActiveProtection(() => ['P']);
		const h = makeApp('body');
		expect(await updateAIOMetadata(h.app as never, fileIn('P/x.md'), { aio_status: 'processed' } as never)).toBe(false);
		expect(h.processFrontMatter).not.toHaveBeenCalled();
		expect(await updateAIOMetadata(h.app as never, fileIn('Q/x.md'), { aio_status: 'processed' } as never)).toBe(true);
		expect(h.processFrontMatter).toHaveBeenCalledTimes(1);
	});

	it('with no protection installed the tag writer behaves as before', async () => {
		const h = makeApp('body');
		const res = await TagUtils.writeTagsToFrontmatter(h.app as never, fileIn('P/x.md'), ['t']);
		expect(res.success).toBe(true);
		expect(h.modify).toHaveBeenCalledTimes(1);
	});
});

describe('guardActiveNote', () => {
	it('is true when nothing is installed', () => {
		expect(guardActiveNote()).toBe(true);
	});

	it('is true for an unprotected active note and when there is no active note', () => {
		setActiveProtection(() => ['P']);
		installActiveNoteGuard(() => 'Q/x.md', () => 'protected');
		expect(guardActiveNote()).toBe(true);
		installActiveNoteGuard(() => null, () => 'protected');
		expect(guardActiveNote()).toBe(true);
	});

	it('is false and shows the notice for a protected active note', () => {
		setActiveProtection(() => ['P']);
		installActiveNoteGuard(() => 'P/x.md', () => 'This note is protected');
		expect(guardActiveNote()).toBe(false);
		expect(mockNotices).toContain('This note is protected');
	});
});
