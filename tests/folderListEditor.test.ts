import { describe, it, expect } from 'vitest';
import { addFolderToList, removeFolderFromList, notesUnder } from '../src/ui/setup/FolderListEditor';
import { createTFile } from './mocks/obsidian';

describe('addFolderToList', () => {
	it('normalises and appends', () => {
		expect(addFolderToList(['A'], '\\B\\C\\')).toEqual({ list: ['A', 'B/C'], added: true });
	});

	it('ignores empty input and case-insensitive duplicates', () => {
		expect(addFolderToList(['A/B'], '')).toEqual({ list: ['A/B'], added: false });
		expect(addFolderToList(['A/B'], 'a/b/')).toEqual({ list: ['A/B'], added: false });
	});

	it('does not mutate the input', () => {
		const list = ['A'];
		addFolderToList(list, 'B');
		expect(list).toEqual(['A']);
	});
});

describe('removeFolderFromList', () => {
	it('removes case-insensitively and keeps the rest', () => {
		expect(removeFolderFromList(['A', 'B/C', 'D'], 'b/c/')).toEqual(['A', 'D']);
	});

	it('is a no-op for a folder that is not listed', () => {
		expect(removeFolderFromList(['A'], 'Z')).toEqual(['A']);
	});
});

describe('notesUnder', () => {
	it('counts only files inside the folder, prefix-safe', () => {
		const files = ['A/x.md', 'A/sub/y.md', 'AB/z.md', 'a/q.md'].map(createTFile);
		expect(notesUnder(files as never, 'A').map((f) => f.path)).toEqual(['A/x.md', 'A/sub/y.md', 'a/q.md']);
	});
});
