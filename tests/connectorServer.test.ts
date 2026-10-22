/**
 * The read-only connector, run for real as a child process against a synthetic vault: both protocol
 * eras, the envelope rules, the scope (read per request, fail closed), containment, and bounds.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeVault, ServerClient, type TestVault } from './helpers/connectorServerHarness';

let vault: TestVault;
const clients: ServerClient[] = [];
const open = (arg: string | null = vault.root): ServerClient => { const c = new ServerClient(vault.serverFile, arg); clients.push(c); return c; };

beforeAll(() => {
	vault = makeVault();
	vault.write('Notes/Garden.md', '# Garden\nPlants and soil.');
	vault.write('Notes/Soil.md', 'Soil notes');
	vault.write('Notes/readme.txt', 'not a note');
	vault.write('Private/Diary.md', 'private diary');
	vault.write('Course/Exam.md', 'protected exam');
	vault.write('.hidden/Secret.md', 'hidden');
	vault.write('Notes/.hidden/Deep.md', 'deep hidden');
	vault.writeScope({ exclude: ['Private'], protectedFolders: ['Course'] });
	vault.writeIndex([
		{ path: 'Notes/Garden.md', tags: ['plants'], headings: ['Soil care'] },
		{ path: 'Notes/Soil.md', tags: ['soil'] },
		{ path: 'Private/Diary.md', tags: ['plants'] },
		{ path: 'Course/Exam.md', tags: ['plants'] },
		{ path: 'Notes/Gone.md', tags: ['plants'] },
		{ path: '.hidden/Secret.md', tags: ['plants'] },
	]);
});

afterAll(() => { for (const c of clients) c.kill(); vault.cleanup(); });

describe('legacy protocol (initialize handshake)', () => {
	it('refuses tools before initialize, then answers the pinned initialize shape and serves tools', async () => {
		const c = open();
		const early = await c.request('tools/list');
		expect(early.error).toMatchObject({ code: -32600, message: 'initialize first' });
		const init = await c.initialize('2025-06-18');
		expect(init.result).toEqual({
			protocolVersion: '2025-06-18',
			capabilities: { tools: {} },
			serverInfo: { name: 'ai-organiser-vault', version: '1.0.0' },
			instructions: expect.stringContaining('Read-only'),
		});
		expect(await c.quiet()).toBe(true); // the initialized notification gets no reply
		const list = await c.request('tools/list');
		const tools = (list.result as { tools: Array<{ name: string; annotations: { readOnlyHint: boolean }; inputSchema: { type: string } }>; resultType?: string }).tools;
		expect(tools.map((t) => t.name)).toEqual(['search_notes', 'read_note', 'list_folder']);
		expect(tools.every((t) => t.annotations.readOnlyHint && t.inputSchema.type === 'object')).toBe(true);
		expect((list.result as { resultType?: string }).resultType).toBeUndefined();
	});

	it('answers an unknown version with its latest legacy version', async () => {
		const c = open();
		expect((await c.initialize('1999-01-01')).result).toMatchObject({ protocolVersion: '2025-11-25' });
	});

	it('answers ping in any state and rejects an initialize without a version', async () => {
		const c = open();
		expect((await c.request('ping')).result).toEqual({});
		expect((await c.request('initialize', {})).error).toMatchObject({ code: -32602 });
	});
});

describe('modern protocol (per-request metadata)', () => {
	const meta = { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } };

	it('answers server/discover and tools without any handshake, with resultType complete', async () => {
		const c = open();
		const discover = await c.request('server/discover', meta);
		expect(discover.result).toEqual({
			resultType: 'complete',
			supportedVersions: ['2026-07-28'],
			capabilities: { tools: {} },
			_meta: { 'io.modelcontextprotocol/serverInfo': { name: 'ai-organiser-vault', version: '1.0.0' } },
			instructions: expect.any(String),
		});
		const list = await c.request('tools/list', meta);
		expect((list.result as { resultType: string }).resultType).toBe('complete');
		const read = await c.call('read_note', { path: 'Notes/Soil.md' }, true);
		expect(read.isError).toBe(false);
		expect((read.raw.result as { resultType: string }).resultType).toBe('complete');
	});

	it('answers an unsupported version with -32022 and the supported list', async () => {
		const c = open();
		const reply = await c.request('tools/list', { _meta: { 'io.modelcontextprotocol/protocolVersion': '1900-01-01' } });
		expect(reply.error).toEqual({ code: -32022, message: 'Unsupported protocol version', data: { supported: ['2026-07-28'], requested: '1900-01-01' } });
	});
});

describe('envelope and framing', () => {
	it('rejects batches, bad envelopes and garbage, and never answers a notification', async () => {
		const c = open();
		await c.initialize();
		c.sendRaw(JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'ping' }]));
		expect((await c.next()).error).toMatchObject({ code: -32600 });
		c.send({ id: 2, method: 'ping' });
		expect((await c.next()).error).toMatchObject({ code: -32600 });
		c.send({ jsonrpc: '2.0', id: { a: 1 }, method: 'ping' });
		expect((await c.next()).error).toMatchObject({ code: -32600 });
		c.sendRaw('{not json');
		expect((await c.next()).error).toMatchObject({ code: -32700 });
		c.send({ jsonrpc: '2.0', id: 3, method: 'ping', params: [1] });
		expect((await c.next()).error).toMatchObject({ code: -32602 });
		c.send({ jsonrpc: '2.0', method: 'notifications/anything', params: {} });
		c.send({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'read_note', arguments: { path: 'Notes/Soil.md' } } }); // a request without an id is a notification
		expect(await c.quiet()).toBe(true);
		expect((await c.request('nope')).error).toMatchObject({ code: -32601 });
		expect((await c.request('tools/call', { name: 'delete_note', arguments: {} })).error).toMatchObject({ code: -32602 });
	});

	it('survives an over-long line and keeps serving', async () => {
		const c = open();
		await c.initialize();
		c.sendRaw('x'.repeat(1_200_000));
		expect((await c.next()).error).toMatchObject({ code: -32600 });
		expect((await c.request('ping')).result).toEqual({});
	});

	it('exits cleanly when its input closes, and refuses to start without a vault folder', async () => {
		const c = open();
		await c.initialize();
		c.closeInput();
		expect(await c.waitExit()).toBe(0);
		const none = open(null);
		expect(await none.waitExit()).toBe(1);
		expect(none.stderr).toContain('vault folder');
		const missing = open(path.join(vault.root, 'does-not-exist'));
		expect(await missing.waitExit()).toBe(1);
	});
});

describe('reading: scope and containment', () => {
	const refused = 'That is not available.';

	it('reads an included note with a header and the text', async () => {
		const c = open();
		await c.initialize();
		const r = await c.call('read_note', { path: 'Notes/Garden.md' });
		expect(r.isError).toBe(false);
		expect(r.text[0]).toMatch(/^path: Notes\/Garden\.md\nbytes: \d+\nmodified: \d{4}-/);
		expect(r.text[1]).toBe('# Garden\nPlants and soil.');
	});

	it('gives the same refusal for excluded, protected, hidden, missing and non-note paths', async () => {
		const c = open();
		await c.initialize();
		for (const p of ['Private/Diary.md', 'Course/Exam.md', '.hidden/Secret.md', 'Notes/.hidden/Deep.md', 'Notes/Nope.md', 'Notes/readme.txt', 'Notes', 'Notes/', '.ai-organiser/agent-connector-scope.json', '.ai-organiser/agent-index.jsonl']) {
			const r = await c.call('read_note', { path: p });
			expect(r.isError, p).toBe(true);
			expect(r.text, p).toEqual([refused]);
		}
	});

	it('refuses traversal, absolute, drive, backslash, NUL, empty-segment and case-variant spellings', async () => {
		const c = open();
		await c.initialize();
		const outside = path.join(path.dirname(vault.root), 'outside.md');
		fs.writeFileSync(outside, 'outside the vault');
		const bad = [
			'../outside.md', 'Notes/../../outside.md', '..', '/etc/passwd', 'C:/Windows/win.ini', 'C:\\Windows\\win.ini', 'Notes\\Garden.md',
			'Notes/Garden.md\u0000.png', 'Notes//Garden.md', './Notes/Garden.md', 'Notes/./Garden.md', `${vault.root}/Notes/Garden.md`,
			'private/Diary.md', 'PRIVATE/diary.md', 'course/exam.md', 'Notes/Garden.md/', 'x'.repeat(1100),
		];
		for (const p of bad) {
			const r = await c.call('read_note', { path: p });
			expect(r.isError, JSON.stringify(p)).toBe(true);
			expect(r.text.join('\n'), JSON.stringify(p)).not.toContain('outside the vault');
			expect(r.text.join('\n'), JSON.stringify(p)).not.toContain('private diary');
			expect(r.text.join('\n'), JSON.stringify(p)).not.toContain('protected exam');
		}
		for (const bad of [42, null, {}, ['a']]) {
			expect((await c.call('read_note', { path: bad as never })).isError).toBe(true);
		}
		expect((await c.call('read_note', {})).isError).toBe(true);
	});

	it('refuses a folder link (junction or symlink) that leads into an excluded folder, and does not list it', async (ctx) => {
		const dirLink = path.join(vault.root, 'Notes', 'LinkedDir');
		try {
			fs.symlinkSync(path.join(vault.root, 'Private'), dirLink, 'junction');
		} catch {
			ctx.skip(); // reported as skipped, never as passed: this system does not let the test create links
		}
		try {
			const c = open();
			await c.initialize();
			const viaDir = await c.call('read_note', { path: 'Notes/LinkedDir/Diary.md' });
			expect(viaDir.isError).toBe(true);
			expect(viaDir.text.join('\n')).not.toContain('private diary');
			const listing = await c.call('list_folder', { path: 'Notes' });
			expect(listing.text.join('\n')).not.toContain('LinkedDir');
			const into = await c.call('list_folder', { path: 'Notes/LinkedDir' });
			expect(into.isError).toBe(true);
		} finally {
			fs.rmSync(dirLink, { force: true, recursive: false });
		}
	});

	it('refuses a file symlink that points at an excluded note, when the system lets the test make one', async (ctx) => {
		const link = path.join(vault.root, 'Notes', 'Linked.md');
		try {
			fs.symlinkSync(path.join(vault.root, 'Private', 'Diary.md'), link);
		} catch {
			ctx.skip();
		}
		try {
			const c = open();
			await c.initialize();
			const r = await c.call('read_note', { path: 'Notes/Linked.md' });
			expect(r.isError).toBe(true);
			expect(r.text.join('\n')).not.toContain('private diary');
		} finally {
			fs.rmSync(link, { force: true });
		}
	});

	it('refuses a note larger than the cap with a clear message', async () => {
		vault.write('Notes/Big.md', 'a'.repeat(1_100_000));
		const c = open();
		await c.initialize();
		const r = await c.call('read_note', { path: 'Notes/Big.md' });
		expect(r).toMatchObject({ isError: true, text: ['That note is too large to read here.'] });
		fs.rmSync(path.join(vault.root, 'Notes', 'Big.md'));
	});
});

describe('the scope is read on every request and fails closed', () => {
	it('stops serving a folder the moment the scope excludes it, with no restart', async () => {
		const c = open();
		await c.initialize();
		expect((await c.call('read_note', { path: 'Notes/Soil.md' })).isError).toBe(false);
		vault.writeScope({ exclude: ['Private', 'Notes'], protectedFolders: ['Course'] });
		expect((await c.call('read_note', { path: 'Notes/Soil.md' })).isError).toBe(true);
		expect((await c.call('list_folder', { path: 'Notes' })).isError).toBe(true);
		vault.writeScope({ exclude: ['Private'], protectedFolders: ['Course'] });
		expect((await c.call('read_note', { path: 'Notes/Soil.md' })).isError).toBe(false);
	});

	it('serves nothing when the scope says disabled, is missing, damaged or of another kind', async () => {
		const c = open();
		await c.initialize();
		vault.writeScope({ disabled: true });
		expect((await c.call('read_note', { path: 'Notes/Soil.md' })).text).toEqual(['The connector is turned off in Obsidian.']);
		expect((await c.call('search_notes', { query: 'soil' })).isError).toBe(true);
		expect((await c.call('list_folder', {})).isError).toBe(true);
		const scopeFile = path.join(vault.root, '.ai-organiser', 'agent-connector-scope.json');
		const noScope = 'The connector has no valid scope. Open Obsidian with the connector turned on, then try again.';
		fs.rmSync(scopeFile);
		expect((await c.call('read_note', { path: 'Notes/Soil.md' })).text).toEqual([noScope]);
		for (const damaged of ['not json', '{}', JSON.stringify({ generator: 'someone-else', version: 1, disabled: false }), JSON.stringify({ generator: 'ai-organiser/connector-scope', version: 2, disabled: false }),
			JSON.stringify({ generator: 'ai-organiser/connector-scope', version: 1, disabled: false, includeFolders: 'Notes', excludeFolders: [], protectedFolders: [], indexPath: 'x' }), 'x'.repeat(70_000)]) {
			fs.writeFileSync(scopeFile, damaged);
			expect((await c.call('read_note', { path: 'Notes/Soil.md' })).text, damaged.slice(0, 30)).toEqual([noScope]);
		}
		vault.writeScope({ exclude: ['Private'], protectedFolders: ['Course'] });
		expect((await c.call('read_note', { path: 'Notes/Soil.md' })).isError).toBe(false);
	});

	it('honours an include list: only inside it, and the way to it is navigable', async () => {
		vault.writeScope({ include: ['Notes'], exclude: ['Private'], protectedFolders: ['Course'] });
		try {
			const c = open();
			await c.initialize();
			expect((await c.call('read_note', { path: 'Notes/Garden.md' })).isError).toBe(false);
			expect((await c.call('read_note', { path: 'Course/Exam.md' })).isError).toBe(true);
			const root = await c.call('list_folder', {});
			expect(root.text).toEqual(['Notes/']);
		} finally {
			vault.writeScope({ exclude: ['Private'], protectedFolders: ['Course'] });
		}
	});
});

describe('search and listing', () => {
	it('finds included notes, ranked, and never an excluded, protected, hidden or deleted one', async () => {
		const c = open();
		await c.initialize();
		const r = await c.call('search_notes', { query: 'plants' });
		expect(r.isError).toBe(false);
		expect(r.text.join('\n')).toContain('Notes/Garden.md');
		for (const hidden of ['Private/Diary.md', 'Course/Exam.md', 'Notes/Gone.md', '.hidden/Secret.md']) expect(r.text.join('\n')).not.toContain(hidden);
		const multi = await c.call('search_notes', { query: 'soil care' });
		expect(multi.text.join('\n')).toContain('Notes/Garden.md'); // every word matched, in title, path, tag or heading
		expect((await c.call('search_notes', { query: 'zzzz' })).text).toEqual(['No notes matched.']);
	});

	it('does not let out-of-scope records use up the result slots', async () => {
		const many = Array.from({ length: 30 }, (_, i) => ({ path: `Private/Match ${i}.md`, tags: ['zebra', 'zebra', 'zebra'] }));
		vault.writeIndex([...many, { path: 'Notes/Garden.md', tags: ['zebra'] }], '.ai-organiser/crowded.jsonl');
		vault.writeScope({ exclude: ['Private'], protectedFolders: ['Course'], indexPath: '.ai-organiser/crowded.jsonl' });
		try {
			const c = open();
			await c.initialize();
			const r = await c.call('search_notes', { query: 'zebra', limit: 1 });
			expect(r.text.join('\n')).toContain('Notes/Garden.md');
		} finally {
			vault.writeScope({ exclude: ['Private'], protectedFolders: ['Course'] });
		}
	});

	it('validates arguments with clear messages', async () => {
		const c = open();
		await c.initialize();
		for (const args of [{}, { query: '' }, { query: '   ' }, { query: 'x'.repeat(201) }, { query: 'a', limit: 0 }, { query: 'a', limit: 26 }, { query: 'a', limit: 1.5 }, { query: 'a', limit: '3' }, { query: '!!!' }]) {
			const r = await c.call('search_notes', args as never);
			expect(r.isError, JSON.stringify(args)).toBe(true);
			expect(r.text[0]).toMatch(/^Invalid arguments/);
		}
	});

	it('reports a missing or foreign index in plain words', async () => {
		const c = open();
		await c.initialize();
		vault.writeScope({ exclude: ['Private'], protectedFolders: ['Course'], indexPath: '.ai-organiser/missing.jsonl' });
		expect((await c.call('search_notes', { query: 'soil' })).text).toEqual(['No index yet. Build the agent index in Obsidian first.']);
		vault.write('.ai-organiser/foreign.jsonl', `${JSON.stringify({ type: 'header', generator: 'someone-else', outputPath: '.ai-organiser/foreign.jsonl' })}\n`);
		vault.writeScope({ exclude: ['Private'], protectedFolders: ['Course'], indexPath: '.ai-organiser/foreign.jsonl' });
		expect((await c.call('search_notes', { query: 'soil' })).text[0]).toContain('not one made by the plugin');
		vault.writeScope({ exclude: ['Private'], protectedFolders: ['Course'] });
		expect((await c.call('search_notes', { query: 'soil' })).isError).toBe(false);
	});

	it('lists the top level without excluded, protected or hidden folders, and only Markdown notes', async () => {
		const c = open();
		await c.initialize();
		const top = await c.call('list_folder', {});
		expect(top.text).toEqual(['Notes/']);
		const notes = await c.call('list_folder', { path: 'Notes' });
		expect(notes.text).toEqual(['Garden.md\nSoil.md']);
		for (const p of ['Private', 'Course', '.hidden', '../', 'Notes/Garden.md', 'Missing']) expect((await c.call('list_folder', { path: p })).isError, p).toBe(true);
	});

	it('caps a long listing and says how many were left out', async () => {
		for (let i = 0; i < 230; i++) vault.write(`Many/n${String(i).padStart(3, '0')}.md`, 'x');
		const c = open();
		await c.initialize();
		const r = await c.call('list_folder', { path: 'Many' });
		const lines = r.text[0].split('\n');
		expect(lines).toHaveLength(201);
		expect(lines[200]).toBe('... and 30 more');
	});
});

describe('revocation, end to end: the real publisher and the running server', () => {
	it('stops the very next request when the feature is turned off, and resumes when it is turned back on', async () => {
		const { ScopePublisher } = await import('../src/services/agentConnectors/connectorScope');
		const { DEFAULT_SETTINGS } = await import('../src/core/settings');
		const abs = (p: string): string => path.join(vault.root, ...p.split('/'));
		const adapter = {
			exists: async (p: string) => fs.existsSync(abs(p)),
			read: async (p: string) => fs.readFileSync(abs(p), 'utf8'),
			write: async (p: string, d: string) => { fs.mkdirSync(path.dirname(abs(p)), { recursive: true }); fs.writeFileSync(abs(p), d); },
			rename: async (a: string, b: string) => { fs.renameSync(abs(a), abs(b)); },
			remove: async (p: string) => { fs.rmSync(abs(p), { force: true }); },
			mkdir: async (p: string) => { fs.mkdirSync(abs(p), { recursive: true }); },
		};
		let flags: Record<string, boolean> = { 'agent-index': true, 'agent-connectors': true };
		const publisher = new ScopePublisher({
			adapter: adapter as never,
			settings: () => ({ ...structuredClone(DEFAULT_SETTINGS), featureFlags: flags, agentIndexExcludeFolders: ['Private'] }) as never,
			now: () => 'now',
			setStale: async () => undefined,
		});
		const c = open();
		await c.initialize();
		await publisher.sync();
		expect((await c.call('read_note', { path: 'Notes/Soil.md' })).isError).toBe(false);
		expect((await c.call('read_note', { path: 'Private/Diary.md' })).isError).toBe(true);
		flags = { 'agent-index': true, 'agent-connectors': false };
		expect(await publisher.sync()).toEqual({ ok: true, value: 'published' });
		expect((await c.call('read_note', { path: 'Notes/Soil.md' })).text).toEqual(['The connector is turned off in Obsidian.']);
		flags = { 'agent-index': false, 'agent-connectors': true }; // the index it needs went off
		await publisher.sync();
		expect((await c.call('read_note', { path: 'Notes/Soil.md' })).isError).toBe(true);
		flags = { 'agent-index': true, 'agent-connectors': true };
		await publisher.sync();
		expect((await c.call('read_note', { path: 'Notes/Soil.md' })).isError).toBe(false);
		vault.writeScope({ exclude: ['Private'], protectedFolders: ['Course'] }); // leave the shared vault as the other tests expect
	});
});
