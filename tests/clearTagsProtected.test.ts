import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('obsidian', async () => await import('./mocks/obsidian'));

import { App, mockNotices, clearMockNotices } from 'obsidian';
import AIOrganiserPlugin from '../src/main';
import { DEFAULT_SETTINGS } from '../src/core/settings';
import { splitByProtection } from '../src/core/protectedPaths';
import { plural } from '../src/utils/plural';
import { en } from '../src/i18n/en';

describe('plural', () => {
	it('fills the count and picks the singular only for one', () => {
		expect(plural('{count} file[s] found', 1)).toBe('1 file found');
		expect(plural('{count} file[s] found', 0)).toBe('0 files found');
		expect(plural('{count} file[s] found', 2)).toBe('2 files found');
		expect(plural('{count} note[s] [was|were] kept', 1)).toBe('1 note was kept');
		expect(plural('{count} note[s] [was|were] kept', 3)).toBe('3 notes were kept');
		expect(plural('No markers here {count}', 1)).toBe('No markers here 1');
	});
});

describe('splitByProtection', () => {
	const files = [{ path: 'Course/Lecture 1.md' }, { path: 'Notes/a.md' }, { path: 'course/deep/b.md' }, { path: 'Courseware/c.md' }];

	it('separates notes inside a protected folder from the rest, keeping order', () => {
		const { writable, protectedOut } = splitByProtection(['Course'], files);
		expect(protectedOut.map((f) => f.path)).toEqual(['Course/Lecture 1.md', 'course/deep/b.md']);
		expect(writable.map((f) => f.path)).toEqual(['Notes/a.md', 'Courseware/c.md']);
	});

	it('protects nothing when no folder is protected', () => {
		const { writable, protectedOut } = splitByProtection([], files);
		expect(writable).toHaveLength(4);
		expect(protectedOut).toHaveLength(0);
	});
});

describe('vault-wide clear tags', () => {
	const file = (path: string) => ({ path });
	let confirmText: string | null;

	function makePlugin(protectedFolders: string[], files: { path: string }[], confirmed = true) {
		const cleared: string[][] = [];
		confirmText = null;
		const plugin = new AIOrganiserPlugin(new App() as never, { id: 'test', version: '1', name: 'T', author: 'T', minAppVersion: '0', description: 'T' } as never);
		plugin.settings = { ...DEFAULT_SETTINGS, protectedFolders };
		plugin.getNonExcludedMarkdownFiles = () => files as never;
		plugin.showConfirmationDialog = (async (text: string) => { confirmText = text; return confirmed; }) as never;
		(plugin as unknown as { tagOperations: unknown }).tagOperations = { clearDirectoryTags: async (list: { path: string }[]) => { cleared.push(list.map((f) => f.path)); } };
		return { plugin, cleared };
	}

	beforeEach(() => clearMockNotices());

	it('counts a protected note as left unchanged, never as cleared, in the question and the result', async () => {
		const { plugin, cleared } = makePlugin(['Course'], [file('Notes/a.md'), file('Notes/b.md'), file('Course/Lecture 2.md')]);
		await plugin.clearAllNotesTags();
		expect(confirmText).toContain('Remove all tags from 2 notes?');
		expect(confirmText).toContain('1 note in protected folders will be left unchanged.');
		expect(cleared).toEqual([['Notes/a.md', 'Notes/b.md']]);
		expect(mockNotices.at(-1)).toBe('Cleared tags from 2 notes. 1 note in protected folders was left unchanged.');
	});

	it('uses the plain wording when nothing is protected', async () => {
		const { plugin, cleared } = makePlugin([], [file('Notes/a.md'), file('Notes/b.md')]);
		await plugin.clearAllNotesTags();
		expect(confirmText).toBe('Remove all tags from 2 notes? This action cannot be undone.');
		expect(cleared).toEqual([['Notes/a.md', 'Notes/b.md']]);
		expect(mockNotices.at(-1)).toBe(en.messages.successfullyClearedAllVault);
	});

	it('says so and writes nothing when every note is protected', async () => {
		const { plugin, cleared } = makePlugin(['Course'], [file('Course/Lecture 1.md')]);
		await plugin.clearAllNotesTags();
		expect(confirmText).toBeNull();
		expect(cleared).toEqual([]);
		expect(mockNotices.at(-1)).toBe(en.messages.clearTagsAllProtected);
	});

	it('does nothing when the person declines', async () => {
		const { plugin, cleared } = makePlugin(['Course'], [file('Notes/a.md'), file('Course/x.md')], false);
		await plugin.clearAllNotesTags();
		expect(cleared).toEqual([]);
	});
});
