import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/services/noteEdit/applyNoteEdit', () => ({
	applyNoteEdit: async (plugin: { __vault: Map<string, string> }, target: { filePath: string; baseline: string; nextContent: string }) => {
		if ((plugin.__vault.get(target.filePath) ?? '') !== target.baseline) return { ok: false, error: 'baseline-changed' };
		plugin.__vault.set(target.filePath, target.nextContent);
		return { ok: true, value: undefined };
	},
}));

import { connectorFolderPath, exportChatProject, exportRevision, vaultBasePath } from '../src/services/agentConnectors/connectorRuntime';
import { CHAT_EXPORT_MARKER } from '../src/services/agentConnectors/chatExport';
import { DEFAULT_SETTINGS } from '../src/core/settings';
import { FileSystemAdapter, TFile, TFolder } from './mocks/obsidian';

describe('connectorFolderPath', () => {
	it('needs a choice, and accepts only a visible folder inside the vault', () => {
		expect(connectorFolderPath('', [])).toEqual({ ok: false, error: 'connector-folder-missing' });
		expect(connectorFolderPath('   ', [])).toEqual({ ok: false, error: 'connector-folder-missing' });
		expect(connectorFolderPath(' AI connectors ', [])).toEqual({ ok: true, value: 'AI connectors' });
		expect(connectorFolderPath('Tools\\Maps', [])).toEqual({ ok: true, value: 'Tools/Maps' });
		for (const bad of ['/abs', 'C:/x', '../out', 'a/../b', '.hidden', 'a/.b', '/']) {
			expect(connectorFolderPath(bad, []).ok, bad).toBe(false);
		}
		expect(connectorFolderPath('Course/Maps', ['Course'])).toEqual({ ok: false, error: 'protected-path' });
	});
});

describe('vaultBasePath', () => {
	it('reads the folder on disk from the desktop adapter and refuses anything else', () => {
		const withAdapter = (adapter: unknown) => ({ app: { vault: { adapter } } }) as never;
		expect(vaultBasePath(withAdapter(new FileSystemAdapter('C:\\Vaults\\My Vault')))).toEqual({ ok: true, value: 'C:\\Vaults\\My Vault' });
		expect(vaultBasePath(withAdapter({}))).toEqual({ ok: false, error: 'connector-vault-path-unavailable' });
		expect(vaultBasePath(withAdapter(new FileSystemAdapter('')))).toEqual({ ok: false, error: 'connector-vault-path-unavailable' });
	});
});

interface Harness {
	plugin: never;
	vault: Map<string, string>;
	trashed: string[];
	settings: Record<string, unknown>;
}

function makePlugin(notes: Record<string, string>, over: Record<string, unknown> = {}, existing: Record<string, string> = {}): Harness {
	const vault = new Map<string, string>(Object.entries(existing));
	const trashed: string[] = [];
	const settings = { ...structuredClone(DEFAULT_SETTINGS), agentConnectorFolder: 'AI connectors', ...over } as Record<string, unknown>;
	const folders = new Set<string>();
	const fileFor = (path: string): TFile => {
		const f = new TFile();
		f.path = path;
		f.name = path.slice(path.lastIndexOf('/') + 1);
		f.basename = f.name.replace(/\.md$/, '');
		f.extension = 'md';
		f.stat = { mtime: 1, ctime: 1, size: (vault.get(path) ?? notes[path] ?? '').length };
		return f;
	};
	const noteFiles = Object.keys(notes).map(fileFor);
	const plugin = {
		__vault: vault,
		settings,
		app: {
			vault: {
				getMarkdownFiles: () => noteFiles,
				cachedRead: async (f: { path: string }) => notes[f.path] ?? '',
				read: async (f: { path: string }) => vault.get(f.path) ?? '',
				getAbstractFileByPath: (p: string) => {
					if (vault.has(p)) return fileFor(p);
					if (folders.has(p)) {
						const folder = new TFolder();
						folder.path = p;
						folder.children = [...vault.keys()].filter((k) => k.startsWith(`${p}/`) && !k.slice(p.length + 1).includes('/')).map(fileFor);
						return folder;
					}
					return null;
				},
				create: async (p: string, c: string) => { vault.set(p, c); },
				createFolder: async (p: string) => { folders.add(p); },
			},
			metadataCache: { getFirstLinkpathDest: () => null },
			fileManager: { trashFile: async (f: { path: string }) => { vault.delete(f.path); trashed.push(f.path); } },
		},
	};
	// A folder that already holds files counts as existing.
	for (const key of vault.keys()) if (key.includes('/')) folders.add(key.slice(0, key.lastIndexOf('/')));
	return { plugin: plugin as never, vault, trashed, settings };
}

describe('exportChatProject', () => {
	const notes = { 'Notes/Garden.md': '# Garden\nsecret body text', 'Notes/Soil.md': 'x', 'Private/Diary.md': 'private body' };

	it('writes one file into the chosen folder, with no note text and no excluded note', async () => {
		const h = makePlugin(notes, { agentIndexExcludeFolders: ['Private'] });
		const res = await exportChatProject(h.plugin);
		expect(res).toEqual({ ok: true, value: { paths: ['AI connectors/AI Organiser vault map.md'], notes: 2, removed: 0 } });
		const text = h.vault.get('AI connectors/AI Organiser vault map.md')!;
		expect(text.startsWith(`${CHAT_EXPORT_MARKER}\n`)).toBe(true);
		expect(text).toContain('- Notes/Garden.md');
		expect(text).not.toContain('secret body');
		expect(text).not.toContain('Private');
	});

	it('needs a chosen folder and notes in scope, and writes nothing otherwise', async () => {
		const none = makePlugin(notes, { agentConnectorFolder: '' });
		expect(await exportChatProject(none.plugin)).toEqual({ ok: false, error: 'connector-folder-missing' });
		expect(none.vault.size).toBe(0);
		const empty = makePlugin(notes, { agentIndexIncludeFolders: ['Nowhere'] });
		expect(await exportChatProject(empty.plugin)).toEqual({ ok: false, error: 'export-nothing-in-scope' });
		expect(empty.vault.size).toBe(0);
		const guarded = makePlugin(notes, { protectedFolders: ['AI connectors'] });
		expect(await exportChatProject(guarded.plugin)).toEqual({ ok: false, error: 'protected-path' });
	});

	it('replaces only its own earlier file and leaves any other file at that path alone', async () => {
		const path = 'AI connectors/AI Organiser vault map.md';
		const own = makePlugin(notes, {}, { [path]: `${CHAT_EXPORT_MARKER}\nold map\n` });
		expect((await exportChatProject(own.plugin)).ok).toBe(true);
		expect(own.vault.get(path)).toContain('- Notes/Garden.md');
		const foreign = makePlugin(notes, {}, { [path]: '# My own notes\n' });
		expect(await exportChatProject(foreign.plugin)).toEqual({ ok: false, error: 'connector-file-not-ours' });
		expect(foreign.vault.get(path)).toBe('# My own notes\n');
	});

	it('retires superseded parts of its own, never an unmarked file with a similar name', async () => {
		const dir = 'AI connectors';
		const h = makePlugin(notes, {}, {
			[`${dir}/AI Organiser vault map (part 1 of 3).md`]: `${CHAT_EXPORT_MARKER}\nold part 1\n`,
			[`${dir}/AI Organiser vault map (part 2 of 3).md`]: `${CHAT_EXPORT_MARKER}\nold part 2\n`,
			[`${dir}/AI Organiser vault map (part 3 of 3).md`]: '# Someone else wrote this\n',
			[`${dir}/Other note.md`]: 'unrelated',
		});
		const res = await exportChatProject(h.plugin);
		expect(res).toEqual({ ok: true, value: { paths: [`${dir}/AI Organiser vault map.md`], notes: 3, removed: 2 } });
		expect(h.trashed.sort()).toEqual([`${dir}/AI Organiser vault map (part 1 of 3).md`, `${dir}/AI Organiser vault map (part 2 of 3).md`]);
		expect(h.vault.get(`${dir}/AI Organiser vault map (part 3 of 3).md`)).toBe('# Someone else wrote this\n');
		expect(h.vault.get(`${dir}/Other note.md`)).toBe('unrelated');
	});

	it('writes nothing when the scope or folder changed since the confirmation', async () => {
		const h = makePlugin(notes);
		const revision = await exportRevision(h.plugin);
		(h.settings.agentIndexExcludeFolders as string[]) = ['Notes'];
		expect(await exportChatProject(h.plugin, { expectedRevision: revision })).toEqual({ ok: false, error: 'baseline-changed' });
		expect(h.vault.size).toBe(0);
		const same = makePlugin(notes);
		expect((await exportChatProject(same.plugin, { expectedRevision: await exportRevision(same.plugin) })).ok).toBe(true);
	});
});
