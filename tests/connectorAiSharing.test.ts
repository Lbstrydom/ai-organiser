/**
 * AI sharing on the read-only connector: the opt-in allow-list for the notes it serves, and the pack tool. The real server runs as
 * a child process against a synthetic vault. With the opt-in off, nothing about what it serves changes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { makeVault, ServerClient, type TestVault } from './helpers/connectorServerHarness';
import { CONNECTOR_SERVER_SOURCE } from '../src/services/agentConnectors/connectorServerSource';
import { buildScopeDocument, parseScopeDocument } from '../src/services/agentConnectors/connectorScope';
import { isInIndexScope } from '../src/services/agentIndex/agentIndexService';
import { normaliseShareFolders, shareFolderOf, shareOptInActive } from '../src/services/aiWorkspaces/aiShareScope';
import { DEFAULT_SETTINGS } from '../src/core/settings';
import { sha256Hex } from '../src/services/attachmentDuplicateService';

const ID = '3f2b8f4e-1c2d-4e5f-8a6b-7c8d9e0f1a2b';
const OTHER = '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d';

let vault: TestVault;
const clients: ServerClient[] = [];
const open = (): ServerClient => { const c = new ServerClient(vault.serverFile, vault.root); clients.push(c); return c; };
afterAll(() => { for (const c of clients) c.kill(); vault.cleanup(); });

beforeAll(() => {
	vault = makeVault();
	vault.write('Work/Plan.md', 'work plan');
	vault.write('Work/Sub/Deep.md', 'deep work');
	vault.write('Personal/Diary.md', 'personal diary');
	vault.write('Misc/Loose.md', 'loose');
	vault.writeIndex([
		{ path: 'Work/Plan.md', tags: ['plan'] },
		{ path: 'Work/Sub/Deep.md', tags: ['plan'] },
		{ path: 'Personal/Diary.md', tags: ['plan'] },
		{ path: 'Misc/Loose.md', tags: ['plan'] },
	]);
});

const readable = async (c: ServerClient, p: string): Promise<boolean> => !(await c.call('read_note', { path: p }, true)).isError;

describe('opt-in off: the connector serves what it always did', () => {
	it('a scope without the sharing fields, or with an allow-list but no opt-in, changes nothing for notes', async () => {
		vault.writeScope({});
		let c = open();
		for (const p of ['Work/Plan.md', 'Personal/Diary.md', 'Misc/Loose.md']) expect(await readable(c, p), p).toBe(true);
		vault.writeScope({ shareFolders: ['Work'] });
		c = open();
		for (const p of ['Work/Plan.md', 'Personal/Diary.md', 'Misc/Loose.md']) expect(await readable(c, p), p).toBe(true);
		const list = (await c.call('list_folder', {}, true)).text.join('\n');
		expect(list).toContain('Personal/');
	});
});

describe('opt-in on: default deny, served notes follow the allow-list', () => {
	it('reads, searches and lists only inside the share folders; folders on the way are visible', async () => {
		vault.writeScope({ shareFolders: ['Work'], requireOptIn: true });
		const c = open();
		expect(await readable(c, 'Work/Plan.md')).toBe(true);
		expect(await readable(c, 'Work/Sub/Deep.md')).toBe(true);
		expect(await readable(c, 'Personal/Diary.md')).toBe(false);
		expect(await readable(c, 'Misc/Loose.md')).toBe(false);
		const found = (await c.call('search_notes', { query: 'plan' }, true)).text.join('\n');
		expect(found).toContain('Work/Plan.md');
		expect(found).not.toContain('Personal/Diary.md');
		const top = (await c.call('list_folder', {}, true)).text.join('\n');
		expect(top).toContain('Work/');
		expect(top).not.toContain('Personal/');
		expect(top).not.toContain('Misc/');
	});

	it('an empty allow-list serves nothing', async () => {
		vault.writeScope({ shareFolders: [], requireOptIn: true });
		const c = open();
		for (const p of ['Work/Plan.md', 'Personal/Diary.md']) expect(await readable(c, p), p).toBe(false);
		expect((await c.call('search_notes', { query: 'plan' }, true)).text.join('\n')).toContain('No notes matched');
	});

	it('still honours exclusions and protected folders inside a share folder', async () => {
		vault.writeScope({ shareFolders: ['Work'], requireOptIn: true, exclude: ['Work/Sub'] });
		const c = open();
		expect(await readable(c, 'Work/Plan.md')).toBe(true);
		expect(await readable(c, 'Work/Sub/Deep.md')).toBe(false);
	});

	it('fails closed on a document that opts in without a readable allow-list, or with malformed fields', async () => {
		for (const raw of [{ requireOptIn: true }, { requireOptIn: false, shareFolders: [] }, { requireOptIn: true, shareFolders: [42] }, { shareFolders: 'Work' }, { packs: { folder: 'P', revision: 'r' } }, { shareFolders: [], packs: { folder: '.hidden/P', revision: 'r' } }]) {
			vault.writeScope({ raw });
			const r = await open().call('read_note', { path: 'Work/Plan.md' }, true);
			expect(r.isError, JSON.stringify(raw)).toBe(true);
			expect(r.text.join(' ')).toContain('no valid scope');
		}
	});
});

// ─── The pack tool ──────────────────────────────────────────────────────────

const sha = (text: string): string => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const PACK_FOLDER = 'AI-Organiser/Workspace packs';
const PACK_NAME = 'pack-20261026-090507-aaaaaaaaaaaa';

function writePack(over: { sources?: Array<{ path: string; contentHash: string }>; revision?: string; text?: string; digest?: string; pointerPath?: string; id?: string } = {}): void {
	const id = over.id ?? ID;
	const text = over.text ?? '# Context pack\n\nProject words.\n';
	vault.write(`${PACK_FOLDER}/${id}/${PACK_NAME}.md`, text);
	vault.write(`${PACK_FOLDER}/${id}/latest.json`, JSON.stringify({
		packId: PACK_NAME, path: over.pointerPath ?? `${PACK_FOLDER}/${id}/${PACK_NAME}.md`, digest: over.digest ?? sha(text), createdAt: 'now', generatorVersion: 1,
		sharePolicyRevision: over.revision ?? 'rev1', sources: over.sources ?? [{ path: 'Work/Plan.md', contentHash: 'h' }],
	}));
}
const packScope = (extra: { shareFolders?: string[]; revision?: string; exclude?: string[] } = {}): void =>
	vault.writeScope({ shareFolders: extra.shareFolders ?? ['Work'], packs: { folder: PACK_FOLDER, revision: extra.revision ?? 'rev1' }, ...(extra.exclude ? { exclude: extra.exclude } : {}) });
const getPack = async (id = ID): Promise<{ text: string; isError: boolean }> => { const r = await open().call('get_workspace_pack', { id }, true); return { text: r.text.join('\n'), isError: r.isError }; };

describe('get_workspace_pack', () => {
	it('is listed only while the published scope serves packs', async () => {
		vault.writeScope({});
		let names = ((await open().request('tools/list', { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } })).result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
		expect(names).toEqual(['search_notes', 'read_note', 'list_folder']);
		const refused = await open().call('get_workspace_pack', { id: ID }, true);
		expect(refused.isError).toBe(true);
		expect(refused.text.join(' ')).toContain('not available');
		packScope();
		names = ((await open().request('tools/list', { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } })).result as { tools: Array<{ name: string; annotations: { readOnlyHint: boolean } }> }).tools.map((t) => t.name);
		expect(names).toEqual(['search_notes', 'read_note', 'list_folder', 'get_workspace_pack']);
	});

	it('serves the latest pack when every source is shareable and the policy is the one it was made under', async () => {
		writePack();
		packScope();
		const r = await getPack();
		expect(r.isError).toBe(false);
		expect(r.text).toContain('Project words.');
	});

	it('says so when there is no pack yet, and refuses a bad id', async () => {
		packScope();
		expect((await getPack(OTHER)).text).toContain('no pack');
		expect((await open().call('get_workspace_pack', { id: '../x' }, true)).isError).toBe(true);
	});

	it('withdraws a pack when a source is no longer shareable: removed from the allow-list, excluded, or outside it', async () => {
		writePack();
		packScope({ shareFolders: ['Personal'] });
		expect((await getPack()).text).toContain('no longer available');
		packScope({ exclude: ['Work'] });
		expect((await getPack()).text).toContain('no longer available');
		writePack({ sources: [{ path: 'Work/Plan.md', contentHash: 'h' }, { path: 'Misc/Loose.md', contentHash: 'h' }] });
		packScope();
		expect((await getPack()).text).toContain('no longer available');
	});

	it('withdraws a pack made under another share policy, one whose bytes changed, and a pointer that names something else', async () => {
		writePack({ revision: 'old' });
		packScope();
		expect((await getPack()).text).toContain('no longer available');
		writePack();
		vault.write(`${PACK_FOLDER}/${ID}/${PACK_NAME}.md`, 'tampered');
		expect((await getPack()).text).toContain('no longer available');
		writePack({ pointerPath: 'Work/Plan.md' });
		expect((await getPack()).text).toContain('no longer available');
		writePack({ pointerPath: `${PACK_FOLDER}/${OTHER}/${PACK_NAME}.md` });
		expect((await getPack()).text).toContain('no longer available');
		writePack({ digest: 'nothex' });
		expect((await getPack()).text).toContain('no longer available');
		writePack({ sources: [] });
		expect((await getPack()).text).toContain('no longer available');
	});

	it('never serves a source inside the pack folder itself', async () => {
		writePack({ sources: [{ path: `${PACK_FOLDER}/${OTHER}/x.md`, contentHash: 'h' }] });
		packScope({ shareFolders: ['AI-Organiser', 'Work'] });
		expect((await getPack()).text).toContain('no longer available');
	});
});

// ─── Parity with the plugin's rule ──────────────────────────────────────────

describe('scope parity: the server and the plugin agree with the opt-in on', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-share-parity-'));
	const file = path.join(dir, 'server.cjs');
	fs.writeFileSync(file, CONNECTOR_SERVER_SOURCE);
	const server = createRequire(path.join(process.cwd(), 'package.json'))(file) as {
		scopeAllows(p: string, scope: Record<string, unknown>): boolean;
		folderVisible(p: string, scope: Record<string, unknown>): boolean;
	};
	afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

	let seed = 7;
	const rand = (n: number): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
	const segs = ['Work', 'work', 'Personal', 'A', 'B b', 'Sub', '.hid', 'x'];
	const pick = (): string => Array.from({ length: 1 + rand(3) }, () => segs[rand(segs.length)]).join('/');

	it('gives the same answer as isInIndexScope + the share allow-list over generated paths and scopes', () => {
		let checked = 0;
		for (let s = 0; s < 40; s++) {
			const include = rand(2) ? [] : [pick()];
			const exclude = rand(2) ? [] : [pick()];
			const prot = rand(3) ? [] : [pick()];
			const share = rand(4) ? [pick(), pick()] : [];
			const optIn = rand(3) !== 0;
			const config = { includeFolders: include, excludeFolders: exclude, protectedFolders: prot, includeAliases: false, includeHeadings: false, frontmatterKeys: [], exportUnresolvedLinks: false };
			for (let i = 0; i < 100; i++) {
				const p = `${pick()}/${rand(2) ? 'n' : 'm'}.md`;
				const expected = isInIndexScope(p, config) && (!optIn || shareFolderOf(p, { aiShareFolders: share }) !== null);
				const got = server.scopeAllows(p, { includeFolders: include, excludeFolders: exclude, protectedFolders: prot, shareFolders: share, ...(optIn ? { requireOptIn: true } : {}) });
				expect(got, `${JSON.stringify({ include, exclude, prot, share, optIn })} ${p}`).toBe(expected);
				checked++;
			}
		}
		expect(checked).toBe(4000);
	});

	it('shows a folder whenever a note inside it could be served, and never one outside the allow-list', () => {
		const scope = { includeFolders: [], excludeFolders: [], protectedFolders: [], shareFolders: ['Work/Sub'], requireOptIn: true };
		expect(server.folderVisible('Work', scope)).toBe(true);
		expect(server.folderVisible('Work/Sub', scope)).toBe(true);
		expect(server.folderVisible('Work/Sub/Deeper', scope)).toBe(true);
		expect(server.folderVisible('Work/Other', scope)).toBe(false);
		expect(server.folderVisible('Personal', scope)).toBe(false);
		expect(server.folderVisible('Personal', { ...scope, requireOptIn: undefined })).toBe(true);
	});
});

// ─── The plugin side ────────────────────────────────────────────────────────

describe('the published scope document', () => {
	const base = { ...DEFAULT_SETTINGS, featureFlags: { provider: true, 'agent-index': true, 'agent-connectors': true } as typeof DEFAULT_SETTINGS.featureFlags };
	const legacyRevision = async (doc: { disabled: boolean; includeFolders: string[]; excludeFolders: string[]; protectedFolders: string[]; indexPath: string }): Promise<string> =>
		(await sha256Hex(new TextEncoder().encode(JSON.stringify([doc.disabled, doc.includeFolders, doc.excludeFolders, doc.protectedFolders, doc.indexPath])).buffer)).slice(0, 16);

	it('without AI workspaces it is exactly what it was: no sharing fields, the same revision', async () => {
		const res = await buildScopeDocument({ ...base, aiShareRequireOptIn: true, aiShareFolders: ['Work'] }, 'now');
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.value).not.toHaveProperty('shareFolders');
		expect(res.value).not.toHaveProperty('requireOptIn');
		expect(res.value).not.toHaveProperty('packs');
		expect(res.value.revision).toBe(await legacyRevision(res.value));
	});

	it('with AI workspaces on it carries the allow-list and the pack policy; the opt-in only when switched on', async () => {
		const on = { ...base, featureFlags: { ...base.featureFlags, 'ai-workspaces': true }, aiShareFolders: ['Work ', 'Work'], aiWorkspacePackFolder: 'Packs/ai' };
		const a = await buildScopeDocument({ ...on, aiShareRequireOptIn: false }, 'now');
		const b = await buildScopeDocument({ ...on, aiShareRequireOptIn: true }, 'now');
		if (!a.ok || !b.ok) throw new Error('scope');
		expect(a.value.shareFolders).toEqual(['Work']);
		expect(a.value).not.toHaveProperty('requireOptIn');
		expect(a.value.packs?.folder).toBe('Packs/ai');
		expect(b.value.requireOptIn).toBe(true);
		expect(a.value.revision).not.toBe(b.value.revision);
		expect(a.value.revision).not.toBe(await legacyRevision(a.value));
		expect(parseScopeDocument(JSON.stringify(b.value))).not.toBeNull();
		expect(shareOptInActive({ ...on, aiShareRequireOptIn: true })).toBe(true);
		expect(shareOptInActive({ ...base, aiShareRequireOptIn: true })).toBe(false);
	});

	it('refuses to read back a document with inconsistent sharing fields', () => {
		const ok = { generator: 'ai-organiser/connector-scope', version: 1, revision: 'r', generatedAt: 'n', disabled: false, includeFolders: [], excludeFolders: [], protectedFolders: [], indexPath: 'i' };
		expect(parseScopeDocument(JSON.stringify({ ...ok, requireOptIn: true }))).toBeNull();
		expect(parseScopeDocument(JSON.stringify({ ...ok, shareFolders: [1] }))).toBeNull();
		expect(parseScopeDocument(JSON.stringify({ ...ok, packs: { folder: 'p', revision: 'r' } }))).toBeNull();
		expect(parseScopeDocument(JSON.stringify({ ...ok, shareFolders: [], packs: { folder: 'p', revision: 'r' } }))).not.toBeNull();
		expect(normaliseShareFolders([' A ', 'a'])).toEqual(['A']);
	});
});

describe('the pack folder is never an ordinary note path', () => {
	it('read_note, search and list refuse the pack folder even when the allow-list would cover it', async () => {
		writePack();
		vault.writeIndex([{ path: 'Work/Plan.md', tags: ['plan'] }, { path: `${PACK_FOLDER}/${ID}/${PACK_NAME}.md`, tags: ['plan'] }]);
		vault.writeScope({ shareFolders: ['AI-Organiser', 'Work'], requireOptIn: true, packs: { folder: PACK_FOLDER, revision: 'rev1' } });
		const c = open();
		expect(await readable(c, `${PACK_FOLDER}/${ID}/${PACK_NAME}.md`)).toBe(false);
		expect((await c.call('search_notes', { query: 'plan' }, true)).text.join('\n')).not.toContain('Workspace packs');
		const inner = (await c.call('list_folder', { path: 'AI-Organiser' }, true)).text.join('\n');
		expect(inner).not.toContain('Workspace packs');
	});

	it('the plugin parser rejects the same packs.folder values the server does', () => {
		const ok = { generator: 'ai-organiser/connector-scope', version: 1, revision: 'r', generatedAt: 'n', disabled: false, includeFolders: [], excludeFolders: [], protectedFolders: [], indexPath: 'i', shareFolders: [] };
		for (const folder of ['', '   ', '.hidden/P', 'A/.b', '/']) expect(parseScopeDocument(JSON.stringify({ ...ok, packs: { folder, revision: 'r' } })), JSON.stringify(folder)).toBeNull();
		expect(parseScopeDocument(JSON.stringify({ ...ok, packs: { folder: 'AI-Organiser/Workspace packs', revision: 'r' } }))).not.toBeNull();
	});
});

describe('packs are never ordinary notes, wherever the pack folder used to be', () => {
	it('the server refuses a file named like a pack outside the current pack folder, with or without the opt-in', async () => {
		vault.write(`Old stuff/Packs/${ID}/${PACK_NAME}.md`, 'an old pack');
		vault.writeScope({ packs: { folder: PACK_FOLDER, revision: 'rev1' }, shareFolders: [] });
		expect(await readable(open(), `Old stuff/Packs/${ID}/${PACK_NAME}.md`)).toBe(false);
		vault.writeScope({ packs: { folder: PACK_FOLDER, revision: 'rev1' }, shareFolders: ['Old stuff'], requireOptIn: true });
		expect(await readable(open(), `Old stuff/Packs/${ID}/${PACK_NAME}.md`)).toBe(false);
		// the same name does not matter when packs are not served at all (the connector as it always was)
		vault.writeScope({});
		expect(await readable(open(), `Old stuff/Packs/${ID}/${PACK_NAME}.md`)).toBe(true);
	});
});

describe('the vault map follows the same policy', () => {
	it('lists no pack file and, with the opt-in, only the allow-list; unchanged when AI workspaces are off', async () => {
		const { optedInScope } = await import('../src/services/agentConnectors/connectorRuntime');
		const base = { isIncluded: () => true, includeAliases: false, includeHeadings: false, frontmatterKeys: [], exportUnresolvedLinks: false };
		const on = { ...DEFAULT_SETTINGS, featureFlags: { provider: true, 'agent-index': true, 'ai-workspaces': true } as typeof DEFAULT_SETTINGS.featureFlags, aiShareFolders: ['Work'], aiWorkspacePackFolder: 'AI-Organiser/Workspace packs' };
		const packPath = `AI-Organiser/Workspace packs/${ID}/${PACK_NAME}.md`;
		const noOptIn = optedInScope(base, { ...on, aiShareRequireOptIn: false });
		expect(noOptIn.isIncluded('Personal/Diary.md')).toBe(true);
		expect(noOptIn.isIncluded(packPath)).toBe(false);
		expect(noOptIn.isIncluded(`Elsewhere/${PACK_NAME}.md`)).toBe(false);
		const optIn = optedInScope(base, { ...on, aiShareRequireOptIn: true });
		expect(optIn.isIncluded('Work/Plan.md')).toBe(true);
		expect(optIn.isIncluded('Personal/Diary.md')).toBe(false);
		expect(optedInScope(base, { ...on, featureFlags: { provider: true, 'agent-index': true } as typeof DEFAULT_SETTINGS.featureFlags, aiShareRequireOptIn: true })).toBe(base);
	});
});
