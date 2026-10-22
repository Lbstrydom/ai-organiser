import { describe, it, expect, afterEach } from 'vitest';
import {
	normalisePath,
	resolveProtectedFolders,
	isProtectedPath,
	assertWritable,
	rewriteOnRename,
	findOutputRootConflicts,
	setActiveProtection,
	assertWritableActive,
	isProtectedActive,
	PROTECTED_PATH_ERROR,
} from '../src/core/protectedPaths';

afterEach(() => setActiveProtection(null));

describe('normalisePath / resolveProtectedFolders', () => {
	it('normalises slashes, trailing slashes and dot segments', () => {
		expect(normalisePath('\\A\\B\\')).toBe('A/B');
		expect(normalisePath('./A//B/')).toBe('A/B');
	});

	it('drops empty and non-string entries and de-duplicates case-insensitively', () => {
		expect(resolveProtectedFolders(['A/B', 'a/b/', '', '/', 5 as unknown as string])).toEqual(['A/B']);
	});

	it('accepts the settings shape and null', () => {
		expect(resolveProtectedFolders({ protectedFolders: ['X'] })).toEqual(['X']);
		expect(resolveProtectedFolders(null)).toEqual([]);
		expect(resolveProtectedFolders({})).toEqual([]);
	});
});

describe('isProtectedPath', () => {
	const list = ['Courses/Live'];

	it('is prefix-safe', () => {
		expect(isProtectedPath(list, 'Courses/Live')).toBe(true);
		expect(isProtectedPath(list, 'Courses/Live/note.md')).toBe(true);
		expect(isProtectedPath(list, 'Courses/LiveExtra/note.md')).toBe(false);
		expect(isProtectedPath(list, 'Courses/Liv')).toBe(false);
	});

	it('is case-insensitive and slash-insensitive', () => {
		expect(isProtectedPath(list, 'courses\\live\\Note.md')).toBe(true);
		expect(isProtectedPath(['courses/live/'], 'Courses/Live/Note.md')).toBe(true);
	});

	it('protects nothing for an empty list', () => {
		expect(isProtectedPath([], 'Courses/Live/note.md')).toBe(false);
	});

	it('handles unicode and diacritics', () => {
		expect(isProtectedPath(['Écoles/Été'], 'écoles/été/résumé.md')).toBe(true);
	});
});

describe('assertWritable', () => {
	const list = ['Courses/Live'];

	it('returns ok for an empty list without inspecting paths', () => {
		expect(assertWritable([], 'modify', 'anything').ok).toBe(true);
		expect(assertWritable(undefined, 'create', ['a', 'b']).ok).toBe(true);
	});

	it('refuses create, modify, delete and rename inside a protected folder', () => {
		for (const op of ['create', 'modify', 'delete', 'rename'] as const) {
			const res = assertWritable(list, op, 'Courses/Live/n.md');
			expect(res).toEqual({ ok: false, error: PROTECTED_PATH_ERROR });
		}
	});

	it('checks both source and destination of a move', () => {
		expect(assertWritable(list, 'rename', ['Courses/Live/n.md', 'Inbox/n.md']).ok).toBe(false);
		expect(assertWritable(list, 'rename', ['Inbox/n.md', 'Courses/Live/n.md']).ok).toBe(false);
		expect(assertWritable(list, 'rename', ['Inbox/n.md', 'Archive/n.md']).ok).toBe(true);
	});

	it('treats a folder operation on an ancestor as touching its protected descendants', () => {
		expect(assertWritable(list, 'rename', { path: 'Courses', folder: true }).ok).toBe(false);
		expect(assertWritable(list, 'delete', { path: 'Courses', folder: true }).ok).toBe(false);
		// a plain file path equal to an ancestor name is not a folder operation
		expect(assertWritable(list, 'modify', { path: 'Courses' }).ok).toBe(true);
		expect(assertWritable(list, 'rename', { path: 'Elsewhere', folder: true }).ok).toBe(true);
	});

	it('still blocks creates when the protected folder no longer exists (string-based, fail closed)', () => {
		expect(assertWritable(['Gone/Folder'], 'create', 'Gone/Folder/new.md').ok).toBe(false);
	});

	it('does not match a sibling that shares a prefix', () => {
		expect(assertWritable(['A/B'], 'modify', 'A/BC/x.md').ok).toBe(true);
	});

	it('accepts the settings object', () => {
		expect(assertWritable({ protectedFolders: ['P'] }, 'modify', 'P/x.md').ok).toBe(false);
	});
});

describe('rewriteOnRename', () => {
	it('moves an exact entry', () => {
		expect(rewriteOnRename(['A/B'], 'A/B', 'C/B')).toEqual({ list: ['C/B'], changed: true });
	});

	it('follows an ancestor rename', () => {
		expect(rewriteOnRename(['A/B/Deep', 'Z'], 'A', 'Q')).toEqual({ list: ['Q/B/Deep', 'Z'], changed: true });
	});

	it('leaves a sibling with a shared prefix alone', () => {
		expect(rewriteOnRename(['A/BC'], 'A/B', 'X')).toEqual({ list: ['A/BC'], changed: false });
	});

	it('does not change when a descendant of the protected folder is renamed', () => {
		expect(rewriteOnRename(['A'], 'A/Sub', 'A/Other')).toEqual({ list: ['A'], changed: false });
	});

	it('is case-insensitive on the old path', () => {
		expect(rewriteOnRename(['Courses/Live'], 'courses/live', 'Archive/Live').changed).toBe(true);
	});
});

describe('findOutputRootConflicts', () => {
	it('is empty for an empty list', () => {
		expect(findOutputRootConflicts([], [{ label: 'chat', path: 'AI Chat' }])).toEqual([]);
	});

	it('detects a root inside a protected folder and a protected folder inside a root', () => {
		const roots = [
			{ label: 'chat', path: 'Courses/Live/Chats' },
			{ label: 'export', path: 'Out' },
			{ label: 'newsletter', path: 'Courses' },
		];
		const res = findOutputRootConflicts(['Courses/Live'], roots);
		expect(res.map((c) => c.label)).toEqual(['chat', 'newsletter']);
	});

	it('treats an empty root (vault root) as colliding with any protected folder', () => {
		expect(findOutputRootConflicts(['A'], [{ label: 'x', path: '' }]).length).toBe(1);
	});
});

describe('active registry', () => {
	it('defaults to no protection', () => {
		expect(assertWritableActive('modify', 'a/b.md').ok).toBe(true);
		expect(isProtectedActive('a/b.md')).toBe(false);
	});

	it('reads the live list on every call', () => {
		let list = ['P'];
		setActiveProtection(() => list);
		expect(assertWritableActive('modify', 'P/x.md').ok).toBe(false);
		list = [];
		expect(assertWritableActive('modify', 'P/x.md').ok).toBe(true);
	});
});
