import { describe, it, expect, vi } from 'vitest';

// The note-edit seam is exercised by its own tests; here it applies the transform to the stored text.
vi.mock('../src/services/noteEdit/applyNoteEdit', () => ({
	applyNoteEdit: async (plugin: { __vault: Map<string, string> }, target: { filePath: string; recompute: (c: string) => { ok: boolean; value?: { content: string }; error?: string } }) => {
		const current = plugin.__vault.get(target.filePath) ?? '';
		const res = target.recompute(current);
		if (!res.ok) return { ok: false, error: res.error };
		plugin.__vault.set(target.filePath, res.value!.content);
		return { ok: true, value: undefined };
	},
}));

import { decodeListPage, hubNotePath, refreshPair, checkPair, testConnection, inventoryConfigKey, approvedRoots, toTestResult } from '../src/services/cloudInventory/cloudInventoryService';
import { evaluateSetup, toFolderSet } from '../src/core/setupState';
import { DEFAULT_SETTINGS, migrateOldSettings, type CloudInventoryPair } from '../src/core/settings';
import { en } from '../src/i18n/en';
import { rootsHashOf } from '../src/services/cloudInventory/scriptTemplate';
import type { TreeListing } from '../src/services/cloudInventory/driveListClient';
import { TFile } from './mocks/obsidian';

const ID = 'FolderRoot_A1';
const pair = (over: Partial<CloudInventoryPair> = {}): CloudInventoryPair => ({ id: 'p1', vaultFolder: 'Projects/Garden', driveFolderId: ID, placement: 'beside', ...over });

describe('hubNotePath', () => {
	it('puts the note beside the folder by default and inside on request', () => {
		expect(hubNotePath(pair(), [])).toEqual({ ok: true, value: 'Projects/Garden — Drive.md' });
		expect(hubNotePath(pair({ placement: 'inside' }), [])).toEqual({ ok: true, value: 'Projects/Garden/Garden — Drive.md' });
	});

	it('uses a label when given and a vault-root pair always goes inside', () => {
		expect(hubNotePath(pair({ label: 'Garden files' }), [])).toEqual({ ok: true, value: 'Projects/Garden files — Drive.md' });
		expect(hubNotePath(pair({ vaultFolder: '', placement: 'beside' }), [])).toEqual({ ok: true, value: 'Vault — Drive.md' });
	});

	it('moves beside a protected folder, and rejects a pair whose final location is protected', () => {
		expect(hubNotePath(pair({ placement: 'inside' }), ['Projects/Garden'])).toEqual({ ok: true, value: 'Projects/Garden — Drive.md' });
		expect(hubNotePath(pair({ placement: 'inside' }), ['Projects'])).toEqual({ ok: false, error: 'protected-path' });
		expect(hubNotePath(pair({ vaultFolder: '' }), [''].filter(Boolean))).toEqual({ ok: true, value: 'Vault — Drive.md' });
	});

	it('removes characters Obsidian does not allow in a name', () => {
		const res = hubNotePath(pair({ label: 'a/b:c*d#e' }), []);
		expect(res.ok && res.value).toBe('Projects/a b c d e — Drive.md');
	});
});

// ---- refresh against a fake plugin -------------------------------------------------------
function makePlugin(over: { protectedFolders?: string[]; notes?: Record<string, string> } = {}) {
	const vault = new Map<string, string>(Object.entries(over.notes ?? {}));
	const created: string[] = [];
	const folders: string[] = [];
	const app = {
		vault: {
			getAbstractFileByPath: (p: string) => {
				if (vault.has(p)) { const f = new TFile(); f.path = p; return f; }
				return folders.includes(p) ? ({ path: p } as unknown) : null;
			},
			read: async (f: { path: string }) => vault.get(f.path) ?? '',
			create: async (p: string, c: string) => { vault.set(p, c); created.push(p); },
			createFolder: async (p: string) => { folders.push(p); },
		},
	};
	return { plugin: { app, t: en, settings: { ...structuredClone(DEFAULT_SETTINGS), protectedFolders: over.protectedFolders ?? [] }, __vault: vault } as never, vault, created };
}

const listing = (names: string[], status: TreeListing['status'] = 'complete'): TreeListing => ({
	status,
	foldersVisited: 1,
	files: names.map((n, i) => ({ id: `id${i}`, name: n, mimeType: 'application/pdf', size: 100, modifiedTime: '2026-01-01T00:00:00Z', path: '' })),
});

describe('refreshPair', () => {
	const NOTE = 'Projects/Garden — Drive.md';

	it('creates the hub note with a block on the first refresh', async () => {
		const { plugin, vault, created } = makePlugin();
		const res = await refreshPair(plugin, pair(), { list: async () => listing(['a.pdf']), now: () => new Date('2026-05-05T00:00:00Z') });
		expect(res).toMatchObject({ ok: true, value: { state: 'created', path: NOTE } });
		expect(created).toEqual([NOTE]);
		expect(vault.get(NOTE)).toContain('a.pdf');
		expect(vault.get(NOTE)).toContain('edits inside this block are overwritten');
	});

	it('is a byte-identical no-op when nothing changed (and keeps the listed time)', async () => {
		const { plugin, vault } = makePlugin();
		await refreshPair(plugin, pair(), { list: async () => listing(['a.pdf']), now: () => new Date('2026-05-05T00:00:00Z') });
		const before = vault.get(NOTE);
		const res = await refreshPair(plugin, pair(), { list: async () => listing(['a.pdf']), now: () => new Date('2026-06-06T00:00:00Z') });
		expect(res).toMatchObject({ ok: true, value: { state: 'unchanged' } });
		expect(vault.get(NOTE)).toBe(before);
	});

	it('updates only the block and keeps the user\'s own text', async () => {
		const { plugin, vault } = makePlugin();
		await refreshPair(plugin, pair(), { list: async () => listing(['a.pdf']) });
		vault.set(NOTE, vault.get(NOTE)!.replace('# Garden', '# Garden\n\nMy own paragraph.'));
		const res = await refreshPair(plugin, pair(), { list: async () => listing(['a.pdf', 'b.pdf']) });
		expect(res).toMatchObject({ ok: true, value: { state: 'updated' } });
		expect(vault.get(NOTE)).toContain('My own paragraph.');
		expect(vault.get(NOTE)).toContain('b.pdf');
	});

	it('restores a hand-edited row even when Drive did not change', async () => {
		const { plugin, vault } = makePlugin();
		await refreshPair(plugin, pair(), { list: async () => listing(['a.pdf']) });
		vault.set(NOTE, vault.get(NOTE)!.replace('a.pdf', 'edited by hand'));
		const res = await refreshPair(plugin, pair(), { list: async () => listing(['a.pdf']) });
		expect(res).toMatchObject({ ok: true, value: { state: 'updated' } });
		expect(vault.get(NOTE)).toContain('a.pdf');
		expect(vault.get(NOTE)).not.toContain('edited by hand');
	});

	it('writes nothing and reports a conflict when the markers are damaged', async () => {
		const { plugin, vault } = makePlugin();
		await refreshPair(plugin, pair(), { list: async () => listing(['a.pdf']) });
		const damaged = vault.get(NOTE)! + '\n' + vault.get(NOTE)!;
		vault.set(NOTE, damaged);
		const res = await refreshPair(plugin, pair(), { list: async () => listing(['a.pdf', 'z.pdf']) });
		expect(res).toEqual({ ok: false, error: 'marker-conflict' });
		expect(vault.get(NOTE)).toBe(damaged);
	});

	it('writes nothing when the listing failed, and shows a truncated listing as such', async () => {
		const { plugin, vault } = makePlugin();
		await refreshPair(plugin, pair(), { list: async () => listing(['a.pdf']) });
		const before = vault.get(NOTE);
		const failed = await refreshPair(plugin, pair(), { list: async () => ({ status: 'failed', files: [], error: 'script-network', foldersVisited: 0 }) });
		expect(failed).toEqual({ ok: false, error: 'script-network' });
		expect(vault.get(NOTE)).toBe(before);
		await refreshPair(plugin, pair(), { list: async () => listing(['a.pdf'], 'truncated') });
		expect(vault.get(NOTE)).toContain('incomplete');
		expect(vault.get(NOTE)).toContain('status=truncated');
	});

	it('asks before adding a block to an existing note and leaves it alone when declined', async () => {
		const { plugin, vault } = makePlugin({ notes: { [NOTE]: '# Mine\n\nHand-written.\n' } });
		const declined = await refreshPair(plugin, pair(), { list: async () => listing(['a.pdf']), confirmAppend: async () => false });
		expect(declined).toMatchObject({ ok: true, value: { state: 'declined' } });
		expect(vault.get(NOTE)).toBe('# Mine\n\nHand-written.\n');
		const accepted = await refreshPair(plugin, pair(), { list: async () => listing(['a.pdf']), confirmAppend: async () => true });
		expect(accepted).toMatchObject({ ok: true, value: { state: 'updated' } });
		expect(vault.get(NOTE)).toContain('Hand-written.');
		expect(vault.get(NOTE)).toContain('a.pdf');
	});

	it('does not create a note in a protected location', async () => {
		const { plugin, created } = makePlugin({ protectedFolders: ['Projects'] });
		const res = await refreshPair(plugin, pair(), { list: async () => listing(['a.pdf']) });
		expect(res).toEqual({ ok: false, error: 'protected-path' });
		expect(created).toEqual([]);
	});
});

describe('refreshPair consent', () => {
	it('stops when the note gained a block after the user was asked', async () => {
		const NOTE = 'Projects/Garden — Drive.md';
		const { plugin, vault } = makePlugin({ notes: { [NOTE]: '# Mine\n' } });
		const res = await refreshPair(plugin, pair(), {
			list: async () => listing(['a.pdf']),
			confirmAppend: async () => {
				// The note changes while the dialog is open: it now already holds a block for this pair.
				vault.set(NOTE, vault.get(NOTE)! + '\n' + [
					'<!-- aio:drive-inventory pair=p1 folder=' + ID + ' -->',
					'<!-- /aio:drive-inventory pair=p1 folder=' + ID + ' -->',
				].join('\n') + '\n');
				return true;
			},
		});
		expect(res).toEqual({ ok: false, error: 'baseline-changed' });
	});
});

describe('decodeListPage', () => {
	it('accepts a well-formed page, including a valid empty one', () => {
		expect(decodeListPage({ files: [], folders: [], nextPageToken: null })).toEqual({ ok: true, value: { files: [], folders: [], nextPageToken: null } });
		const page = decodeListPage({ files: [{ id: 'a', name: 'A', mimeType: 'x', size: '5' }], folders: [{ id: 'f', name: 'F' }], nextPageToken: 't' });
		expect(page.ok && page.value.nextPageToken).toBe('t');
	});

	it.each([
		['an empty object', {}],
		['no folders', { files: [] }],
		['non-array files', { files: {}, folders: [] }],
		['a file without an id', { files: [{ name: 'A', mimeType: 'x' }], folders: [] }],
		['a folder without a name', { files: [], folders: [{ id: 'f' }] }],
		['a numeric token', { files: [], folders: [], nextPageToken: 5 }],
		['null', null],
	])('rejects %s as a bad response', (_n, value) => {
		expect(decodeListPage(value)).toEqual({ ok: false, error: 'script-bad-response' });
	});
});

describe('checkPair', () => {
	it('reports a change without writing', async () => {
		const { plugin, vault } = makePlugin();
		await refreshPair(plugin, pair(), { list: async () => listing(['a.pdf']) });
		const before = vault.get('Projects/Garden — Drive.md');
		expect(await checkPair(plugin, pair(), { list: async () => listing(['a.pdf']) })).toMatchObject({ ok: true, value: { changed: false } });
		expect(await checkPair(plugin, pair(), { list: async () => listing(['a.pdf', 'b.pdf']) })).toMatchObject({ ok: true, value: { changed: true } });
		expect(vault.get('Projects/Garden — Drive.md')).toBe(before);
	});
});

// ---- connection ---------------------------------------------------------------------------
describe('testConnection', () => {
	const URL_OK = 'https://script.google.com/macros/s/AKfycbxTEST/exec';
	const reply = (body: unknown) => async () => ({ status: 200, text: JSON.stringify(body) });

	it('connects when the script is current and approves the roots', async () => {
		const rootsHash = await rootsHashOf([ID]);
		const res = await testConnection({ url: URL_OK, secret: 's', roots: [ID], folderId: ID, transport: reply({ ok: true, scriptVersion: 1, rootsHash, folder: { id: ID, name: 'Garden' } }) });
		expect(res).toEqual({ ok: true, value: { scriptVersion: 1, rootsHash, folderName: 'Garden' } });
	});

	it('says the script is out of date when the approved roots differ or the version is too old', async () => {
		const stale = await testConnection({ url: URL_OK, secret: 's', roots: [ID, 'AnotherFolder_2'], transport: reply({ ok: true, scriptVersion: 1, rootsHash: await rootsHashOf([ID]), folder: null }) });
		expect(stale).toEqual({ ok: false, error: 'script-outdated' });
		const old = await testConnection({ url: URL_OK, secret: 's', roots: [ID], transport: reply({ ok: true, scriptVersion: 0, rootsHash: await rootsHashOf([ID]), folder: null }) });
		expect(old).toEqual({ ok: false, error: 'script-outdated' });
	});

	it('says the folder is not approved when the script does not return it', async () => {
		const res = await testConnection({ url: URL_OK, secret: 's', roots: [ID], folderId: ID, transport: reply({ ok: true, scriptVersion: 1, rootsHash: await rootsHashOf([ID]), folder: null }) });
		expect(res).toEqual({ ok: false, error: 'script-not-approved' });
	});

	it('passes the transport errors through as stable codes', async () => {
		expect(await testConnection({ url: URL_OK, secret: 's', roots: [ID], transport: async () => ({ status: 200, text: '<html>sign in</html>' }) })).toEqual({ ok: false, error: 'script-login-page' });
		expect(await testConnection({ url: URL_OK, secret: 's', roots: [ID], transport: reply({ ok: false, error: { code: 'auth' } }) })).toEqual({ ok: false, error: 'script-auth' });
		expect(await testConnection({ url: 'https://example.com', secret: 's', roots: [] })).toEqual({ ok: false, error: 'script-invalid-endpoint' });
	});
});

// ---- setup state ---------------------------------------------------------------------------
describe('setup state for the Drive inventory', () => {
	const base = { ...structuredClone(DEFAULT_SETTINGS) };
	const configured = (over: Record<string, unknown> = {}) => ({
		...base,
		cloudInventoryScriptUrl: 'https://script.google.com/macros/s/AKfycbxTEST/exec',
		cloudInventoryPairs: [pair()],
		featureSetupCompletedAt: { 'cloud-inventory': 'T' },
		...over,
	});
	const key = (s: ReturnType<typeof configured>) => inventoryConfigKey(s.cloudInventoryScriptUrl, s.cloudInventoryPairs);

	it('is not set up by default, and incomplete until the wizard finishes', () => {
		expect(evaluateSetup('cloud-inventory', base).state).toBe('not-set-up');
		expect(evaluateSetup('cloud-inventory', configured({ featureSetupCompletedAt: {} })).state).toBe('not-set-up');
	});

	it('needs attention until a connection test passes for the current configuration', () => {
		const s = configured();
		expect(evaluateSetup('cloud-inventory', s, { configHash: key(s) })).toEqual({ state: 'needs-attention', reason: 'connection-untested' });
		expect(evaluateSetup('cloud-inventory', s, { configHash: key(s), connection: toTestResult(key(s), null, 'T') }).reason).toBe('connection-failed');
		const passed = toTestResult(key(s), { scriptVersion: 1, rootsHash: 'r', folderName: null }, 'T');
		expect(evaluateSetup('cloud-inventory', s, { configHash: key(s), connection: passed }).state).toBe('ready');
	});

	it('goes stale when a folder is added after the test', () => {
		const s = configured();
		const passed = toTestResult(key(s), { scriptVersion: 1, rootsHash: 'r', folderName: null }, 'T');
		const s2 = configured({ cloudInventoryPairs: [pair(), pair({ id: 'p2', driveFolderId: 'AnotherFolder_2' })] });
		expect(evaluateSetup('cloud-inventory', s2, { configHash: key(s2), connection: passed }).reason).toBe('connection-stale');
		expect(approvedRoots(s2.cloudInventoryPairs)).toEqual([ID, 'AnotherFolder_2']);
	});

	it('needs attention when a pair vault folder no longer exists', () => {
		const s = configured();
		const passed = toTestResult(key(s), { scriptVersion: 1, rootsHash: 'r', folderName: null }, 'T');
		const obs = { configHash: key(s), connection: passed };
		expect(evaluateSetup('cloud-inventory', s, { ...obs, existingFolders: toFolderSet(['Other']) })).toEqual({ state: 'needs-attention', reason: 'missing-folder' });
		expect(evaluateSetup('cloud-inventory', s, { ...obs, existingFolders: toFolderSet(['projects/garden']) }).state).toBe('ready');
	});

	it('a duplicate pair does not change the configuration key', () => {
		const s = configured();
		expect(inventoryConfigKey(s.cloudInventoryScriptUrl, [pair(), pair({ id: 'p9' })])).toBe(key(s));
	});
});

describe('settings migration for the inventory', () => {
	it('drops invalid pairs, clamps limits and keeps a valid test result', () => {
		const out = migrateOldSettings({
			cloudInventoryScriptUrl: '  https://script.google.com/macros/s/x/exec ',
			cloudInventoryPairs: [pair(), { id: 'bad', driveFolderId: 'short' }, { id: 'p1', driveFolderId: 'AnotherFolder_2' }, 'x', null],
			cloudInventoryMaxFolders: 0,
			cloudInventoryMaxFiles: 'many',
			cloudInventoryDeadlineMinutes: 999,
			cloudInventoryLastTest: { ok: true, configHash: 'k', at: 'T', scriptVersion: 1 },
		}) as Record<string, unknown>;
		expect(out.cloudInventoryScriptUrl).toBe('https://script.google.com/macros/s/x/exec');
		expect((out.cloudInventoryPairs as CloudInventoryPair[]).map((p) => p.id)).toEqual(['p1']);
		expect(out.cloudInventoryMaxFolders).toBe(1);
		expect(out.cloudInventoryMaxFiles).toBe(3000);
		expect(out.cloudInventoryDeadlineMinutes).toBe(30);
		expect(out.cloudInventoryLastTest).toMatchObject({ ok: true, configHash: 'k' });
	});

	it('drops a pair with no vault folder instead of guessing the vault root', () => {
		const out = migrateOldSettings({ cloudInventoryPairs: [{ id: 'x', driveFolderId: ID }, pair({ id: 'ok' })] }) as Record<string, unknown>;
		expect((out.cloudInventoryPairs as CloudInventoryPair[]).map((p) => p.id)).toEqual(['ok']);
	});

	it('keeps a lone folder string as one include folder', () => {
		const out = migrateOldSettings({ agentIndexIncludeFolders: ' Projects ' }) as Record<string, unknown>;
		expect(out.agentIndexIncludeFolders).toEqual(['Projects']);
	});

	it('is idempotent and defaults an invalid test result to null', () => {
		const once = migrateOldSettings({ cloudInventoryLastTest: { ok: 'yes' } }) as Record<string, unknown>;
		expect(once.cloudInventoryLastTest).toBeNull();
		expect(migrateOldSettings(structuredClone(once))).toEqual(once);
	});
});
