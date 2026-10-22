import { describe, expect, it } from 'vitest';
import { buildScopeDocument, CONNECTOR_SCOPE_PATH, parseScopeDocument, ScopePublisher } from '../src/services/agentConnectors/connectorScope';
import { DEFAULT_SETTINGS } from '../src/core/settings';

const settings = (over: Record<string, unknown> = {}, flags: Record<string, boolean> = { 'agent-index': true, 'agent-connectors': true }) =>
	({ ...structuredClone(DEFAULT_SETTINGS), featureFlags: flags, ...over }) as never;

function memoryAdapter(opts: { failRenameTo?: string; failRead?: boolean } = {}) {
	const files = new Map<string, string>();
	const folders = new Set<string>();
	let failed = false; // the swap fails once; the put-back that follows works
	const adapter = {
		exists: async (p: string) => files.has(p) || folders.has(p),
		read: async (p: string) => { if (opts.failRead) throw new Error('read'); const v = files.get(p); if (v === undefined) throw new Error('missing'); return v; },
		write: async (p: string, d: string) => { files.set(p, d); },
		rename: async (a: string, b: string) => { if (opts.failRenameTo === b && !failed) { failed = true; throw new Error('rename'); } files.set(b, files.get(a)!); files.delete(a); },
		remove: async (p: string) => { files.delete(p); },
		mkdir: async (p: string) => { folders.add(p); },
	};
	return { files, adapter };
}

function publisher(getSettings: () => never, adapter: never, now = () => '2026-10-22T10:00:00.000Z') {
	const stale: boolean[] = [];
	const p = new ScopePublisher({ adapter, settings: getSettings, now, setStale: async (v) => { stale.push(v); } });
	return { p, stale };
}

describe('buildScopeDocument', () => {
	it('carries the index scope, the protected folders and the configured index path', async () => {
		const doc = await buildScopeDocument(settings({ agentIndexIncludeFolders: ['Notes'], agentIndexExcludeFolders: ['Private', 'Private'], protectedFolders: ['Course'], agentIndexOutputPath: 'Tools/index.jsonl' }), 'T');
		if (!doc.ok) throw new Error(doc.error);
		expect(doc.value).toMatchObject({ generator: 'ai-organiser/connector-scope', version: 1, disabled: false, includeFolders: ['Notes'], excludeFolders: ['Private'], protectedFolders: ['Course'], indexPath: 'Tools/index.jsonl', generatedAt: 'T' });
		expect(doc.value.revision).toMatch(/^[0-9a-f]{16}$/);
	});

	it('has a revision that follows the content, not the clock', async () => {
		const a = await buildScopeDocument(settings(), 'T1');
		const b = await buildScopeDocument(settings(), 'T2');
		const c = await buildScopeDocument(settings({ agentIndexExcludeFolders: ['X'] }), 'T1');
		if (!a.ok || !b.ok || !c.ok) throw new Error('build');
		expect(a.value.revision).toBe(b.value.revision);
		expect(a.value.revision).not.toBe(c.value.revision);
	});

	it('is the tombstone when the feature, or the index it needs, is off', async () => {
		const cases: Array<Record<string, boolean>> = [{}, { 'agent-connectors': true }, { 'agent-connectors': true, 'agent-index': false }, { 'agent-index': true }];
		for (const flags of cases) {
			const doc = await buildScopeDocument(settings({ agentIndexExcludeFolders: ['Private'] }, flags), 'T');
			if (!doc.ok) throw new Error(doc.error);
			expect(doc.value).toMatchObject({ disabled: true, includeFolders: [], excludeFolders: [], protectedFolders: [], indexPath: '' });
		}
	});

	it('refuses an index path it cannot publish', async () => {
		expect((await buildScopeDocument(settings({ agentIndexOutputPath: '../escape.jsonl' }), 'T')).ok).toBe(false);
	});

	it('parses only documents of its own kind', () => {
		expect(parseScopeDocument('{}')).toBeNull();
		expect(parseScopeDocument('nope')).toBeNull();
		expect(parseScopeDocument(JSON.stringify({ generator: 'x', version: 1 }))).toBeNull();
	});
});

describe('ScopePublisher', () => {
	it('writes nothing at all for an installation that never turned the feature on', async () => {
		const m = memoryAdapter();
		const { p } = publisher(() => settings({}, {}), m.adapter as never);
		expect(await p.sync()).toEqual({ ok: true, value: 'skipped' });
		expect(m.files.size).toBe(0);
	});

	it('publishes the scope when on, then leaves an unchanged scope alone', async () => {
		const m = memoryAdapter();
		let current = settings({ agentIndexExcludeFolders: ['Private'] });
		const { p, stale } = publisher(() => current, m.adapter as never);
		expect(await p.sync()).toEqual({ ok: true, value: 'published' });
		const doc = parseScopeDocument(m.files.get(CONNECTOR_SCOPE_PATH)!)!;
		expect(doc.excludeFolders).toEqual(['Private']);
		expect(await p.sync()).toEqual({ ok: true, value: 'unchanged' });
		current = settings({ agentIndexExcludeFolders: ['Private', 'Other'] });
		expect(await p.sync()).toEqual({ ok: true, value: 'published' });
		expect(parseScopeDocument(m.files.get(CONNECTOR_SCOPE_PATH)!)!.excludeFolders).toEqual(['Other', 'Private']);
		expect(stale.every((v) => v === false)).toBe(true);
		expect([...m.files.keys()]).toEqual([CONNECTOR_SCOPE_PATH]); // no temp or previous file is left behind
	});

	it('publishes and verifies a tombstone when the feature is turned off, and again when the index it needs is turned off', async () => {
		const m = memoryAdapter();
		let flags: Record<string, boolean> = { 'agent-index': true, 'agent-connectors': true };
		const { p } = publisher(() => settings({}, flags), m.adapter as never);
		await p.sync();
		expect(parseScopeDocument(m.files.get(CONNECTOR_SCOPE_PATH)!)!.disabled).toBe(false);
		flags = { 'agent-index': true, 'agent-connectors': false };
		expect(await p.sync()).toEqual({ ok: true, value: 'published' });
		expect(parseScopeDocument(m.files.get(CONNECTOR_SCOPE_PATH)!)).toMatchObject({ disabled: true, includeFolders: [], indexPath: '' });
		expect(await p.sync()).toEqual({ ok: true, value: 'unchanged' });
		flags = { 'agent-index': true, 'agent-connectors': true };
		await p.sync();
		flags = { 'agent-index': false, 'agent-connectors': true };
		await p.sync();
		expect(parseScopeDocument(m.files.get(CONNECTOR_SCOPE_PATH)!)!.disabled).toBe(true);
	});

	it('reports a failed publication, remembers it, and recovers on the next sync', async () => {
		const m = memoryAdapter({ failRenameTo: CONNECTOR_SCOPE_PATH });
		const { p, stale } = publisher(() => settings(), m.adapter as never);
		expect(await p.sync()).toEqual({ ok: false, error: 'connector-scope-write-failed' });
		expect(stale.at(-1)).toBe(true);
		expect([...m.files.keys()].filter((k) => k.endsWith('.tmp'))).toEqual([]);
		const ok = memoryAdapter();
		const second = publisher(() => settings(), ok.adapter as never);
		expect((await second.p.sync()).ok).toBe(true);
		expect(second.stale.at(-1)).toBe(false);
	});

	it('keeps the previous scope when the swap fails, so access never silently widens or vanishes', async () => {
		const m = memoryAdapter();
		let current = settings({ agentIndexExcludeFolders: ['Private'] });
		const { p } = publisher(() => current, m.adapter as never);
		await p.sync();
		const before = m.files.get(CONNECTOR_SCOPE_PATH);
		const failing = memoryAdapter({ failRenameTo: CONNECTOR_SCOPE_PATH });
		failing.files.set(CONNECTOR_SCOPE_PATH, before!);
		const second = publisher(() => (current = settings({ agentIndexExcludeFolders: ['Private', 'More'] })), failing.adapter as never);
		expect((await second.p.sync()).ok).toBe(false);
		expect(failing.files.get(CONNECTOR_SCOPE_PATH)).toBe(before);
	});

	it('never overwrites a file at the scope path that is not its own', async () => {
		const m = memoryAdapter();
		m.files.set(CONNECTOR_SCOPE_PATH, '{"somebody":"else"}');
		const { p } = publisher(() => settings(), m.adapter as never);
		expect(await p.sync()).toEqual({ ok: false, error: 'connector-file-not-ours' });
		expect(m.files.get(CONNECTOR_SCOPE_PATH)).toBe('{"somebody":"else"}');
	});

	it('restores an interrupted swap before deciding what to do', async () => {
		const m = memoryAdapter();
		const first = publisher(() => settings({ agentIndexExcludeFolders: ['Private'] }), m.adapter as never);
		await first.p.sync();
		m.files.set(`${CONNECTOR_SCOPE_PATH}.aio-prev`, m.files.get(CONNECTOR_SCOPE_PATH)!);
		m.files.delete(CONNECTOR_SCOPE_PATH); // died between the two renames
		const { p } = publisher(() => settings({ agentIndexExcludeFolders: ['Private'] }), m.adapter as never);
		expect(await p.sync()).toEqual({ ok: true, value: 'unchanged' });
		expect(m.files.has(CONNECTOR_SCOPE_PATH)).toBe(true);
	});

	it('refuses to write into a protected folder', async () => {
		const m = memoryAdapter();
		const { p, stale } = publisher(() => settings({ protectedFolders: ['.ai-organiser'] }), m.adapter as never);
		expect(await p.sync()).toEqual({ ok: false, error: 'connector-scope-write-failed' });
		expect(m.files.size).toBe(0);
		expect(stale.at(-1)).toBe(true);
	});

	it('serialises overlapping syncs', async () => {
		const m = memoryAdapter();
		const { p } = publisher(() => settings(), m.adapter as never);
		const results = await Promise.all([p.sync(), p.sync(), p.sync()]);
		expect(results.map((r) => (r.ok ? r.value : r.error)).sort()).toEqual(['published', 'unchanged', 'unchanged']);
	});
});

describe('ScopePublisher: trust the content, not the label', () => {
	it('corrects a file whose stored revision matches but whose permissions were widened by hand', async () => {
		const m = memoryAdapter();
		const { p } = publisher(() => settings({ agentIndexExcludeFolders: ['Private'] }), m.adapter as never);
		await p.sync();
		const doc = parseScopeDocument(m.files.get(CONNECTOR_SCOPE_PATH)!)!;
		m.files.set(CONNECTOR_SCOPE_PATH, JSON.stringify({ ...doc, excludeFolders: [] })); // same revision label, wider access
		expect(await p.sync()).toEqual({ ok: true, value: 'published' });
		expect(parseScopeDocument(m.files.get(CONNECTOR_SCOPE_PATH)!)!.excludeFolders).toEqual(['Private']);
	});

	it('does not bring back an enabled backup when the wanted state is off', async () => {
		const m = memoryAdapter();
		let flags: Record<string, boolean> = { 'agent-index': true, 'agent-connectors': true };
		const { p } = publisher(() => settings({}, flags), m.adapter as never);
		await p.sync();
		m.files.set(`${CONNECTOR_SCOPE_PATH}.aio-prev`, m.files.get(CONNECTOR_SCOPE_PATH)!);
		m.files.delete(CONNECTOR_SCOPE_PATH); // died between the two renames, with access still granted in the backup
		flags = { 'agent-index': true, 'agent-connectors': false };
		expect(await p.sync()).toMatchObject({ ok: true });
		const now = m.files.get(CONNECTOR_SCOPE_PATH);
		expect(now === undefined || parseScopeDocument(now)!.disabled).toBe(true); // never the enabled backup
	});

	it('leaves a foreign file in the backup slot alone and reports the failure', async () => {
		const m = memoryAdapter();
		m.files.set(`${CONNECTOR_SCOPE_PATH}.aio-prev`, 'user backup');
		const { p, stale } = publisher(() => settings(), m.adapter as never);
		expect((await p.sync()).ok).toBe(false);
		expect(m.files.get(`${CONNECTOR_SCOPE_PATH}.aio-prev`)).toBe('user backup');
		expect(stale.at(-1)).toBe(true);
	});

	it('marks a foreign scope file as a visible failure', async () => {
		const m = memoryAdapter();
		m.files.set(CONNECTOR_SCOPE_PATH, '{"somebody":"else"}');
		const { p, stale } = publisher(() => settings(), m.adapter as never);
		expect((await p.sync()).ok).toBe(false);
		expect(stale.at(-1)).toBe(true);
	});
});

describe('ScopePublisher: a backup is restored only when it grants what is wanted', () => {
	it('ignores a backup that is wider than the current settings and publishes the current ones', async () => {
		const m = memoryAdapter();
		const wide = publisher(() => settings({ agentIndexExcludeFolders: [] }), m.adapter as never);
		await wide.p.sync();
		m.files.set(`${CONNECTOR_SCOPE_PATH}.aio-prev`, m.files.get(CONNECTOR_SCOPE_PATH)!);
		m.files.delete(CONNECTOR_SCOPE_PATH);
		const narrow = publisher(() => settings({ agentIndexExcludeFolders: ['Private'] }), m.adapter as never);
		expect(await narrow.p.sync()).toEqual({ ok: true, value: 'published' });
		expect(parseScopeDocument(m.files.get(CONNECTOR_SCOPE_PATH)!)!.excludeFolders).toEqual(['Private']);
	});
});
