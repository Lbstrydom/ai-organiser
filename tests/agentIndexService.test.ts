import { describe, it, expect } from 'vitest';
import {
	parseNote,
	isInIndexScope,
	planOutput,
	buildAgentIndex,
	checkAgentIndex,
	buildAgentInstructions,
	recoverPublication,
	scopeConfigFromSettings,
} from '../src/services/agentIndex/agentIndexService';
import { isSignedFor } from '../src/services/agentIndex/agentIndexProjection';
import { DEFAULT_SETTINGS } from '../src/core/settings';
import { makeFakeApp } from './helpers/fakeVault';

// ---- an in-memory vault adapter ----------------------------------------------------------
function makeAdapter(initial: Record<string, string> = {}) {
	const files = new Map(Object.entries(initial));
	const ops: string[] = [];
	let failOn: string | null = null;
	const adapter = {
		exists: async (p: string) => files.has(p),
		read: async (p: string) => { if (!files.has(p)) throw new Error('missing'); return files.get(p)!; },
		write: async (p: string, d: string) => { ops.push(`write ${p}`); files.set(p, d); },
		rename: async (a: string, b: string) => {
			ops.push(`rename ${a} -> ${b}`);
			if (failOn && `${a} -> ${b}`.includes(failOn)) throw new Error('injected');
			files.set(b, files.get(a)!); files.delete(a);
		},
		remove: async (p: string) => { ops.push(`remove ${p}`); files.delete(p); },
		mkdir: async () => undefined,
		list: async (dir: string) => ({
			files: [...files.keys()].filter((k) => (dir === '/' || dir === '' ? !k.includes('/') : k.startsWith(dir + '/') && !k.slice(dir.length + 1).includes('/'))),
			folders: [] as string[],
		}),
	};
	return { adapter, files, ops, failOnRename(sub: string | null) { failOn = sub; } };
}

function makePlugin(specs: Record<string, string | { text: string; mtime?: number }>, over: Record<string, unknown> = {}, adapterFiles: Record<string, string> = {}) {
	const v = makeFakeApp(specs as never);
	const a = makeAdapter(adapterFiles);
	(v.app.vault as Record<string, unknown>).adapter = a.adapter;
	const plugin = { app: v.app, settings: { ...structuredClone(DEFAULT_SETTINGS), ...over } };
	return { plugin: plugin as never, v, a };
}

describe('parseNote', () => {
	const text = ['---', 'tags: [alpha, "#beta"]', 'aliases: [Other name]', 'description: Short', 'secret: hush', '---', '# Title', 'Body with #inline-tag and [[Linked note|shown]] and [md](notes/page.md#sec).', '## Section', '`![[in code]]` and #real', '```', '# not a heading', '[[in fence]]', '```'].join('\n');

	it('extracts tags (frontmatter and inline), aliases, H1-H2 headings and link texts, and keeps only wanted keys', () => {
		const p = parseNote(text, ['description']);
		expect([...p.tags].sort()).toEqual(['alpha', 'beta', 'inline-tag', 'real']);
		expect(p.aliases).toEqual(['Other name']);
		expect(p.headings).toEqual(['Title', 'Section']);
		expect(p.linkTexts).toEqual(['Linked note', 'notes/page.md']);
		expect(p.frontmatter).toEqual({ description: 'Short' });
	});

	it('treats malformed frontmatter as none and ignores code-only links', () => {
		const p = parseNote('---\n: : bad\n---\n[[a]]', []);
		expect(p.linkTexts).toEqual(['a']);
		expect(p.tags).toEqual([]);
	});
});

describe('isInIndexScope', () => {
	const cfg = { includeFolders: ['Work'], excludeFolders: ['Work/Private'], includeAliases: false, includeHeadings: false, frontmatterKeys: [], exportUnresolvedLinks: false };

	it('honours include and exclude folders (prefix-safe) and skips hidden folders', () => {
		expect(isInIndexScope('Work/a.md', cfg)).toBe(true);
		expect(isInIndexScope('Work/Private/a.md', cfg)).toBe(false);
		expect(isInIndexScope('WorkExtra/a.md', cfg)).toBe(false);
		expect(isInIndexScope('Other/a.md', cfg)).toBe(false);
		expect(isInIndexScope('.hidden/a.md', { ...cfg, includeFolders: [] })).toBe(false);
	});

	it('includes the whole vault when no include folder is set', () => {
		expect(isInIndexScope('Any/where.md', { ...cfg, includeFolders: [] })).toBe(true);
	});
});

describe('planOutput', () => {
	it('accepts a relative .jsonl path and derives sidecar names', () => {
		const res = planOutput('.ai-organiser/agent-index.jsonl', []);
		expect(res).toEqual({ ok: true, value: { path: '.ai-organiser/agent-index.jsonl', folder: '.ai-organiser', prev: '.ai-organiser/agent-index.jsonl.aio-prev', tmpPrefix: '.ai-organiser/agent-index.jsonl.aio-' } });
	});

	it.each(['', 'index.txt', '/abs/index.jsonl', 'C:\\x\\index.jsonl', '../out/index.jsonl', 'a/../../x.jsonl'])('refuses %s', (p) => {
		expect(planOutput(p, [])).toEqual({ ok: false, error: 'output-path-invalid' });
	});

	it('refuses a location inside a protected folder', () => {
		expect(planOutput('Courses/Live/index.jsonl', ['Courses/Live'])).toEqual({ ok: false, error: 'protected-path' });
		expect(planOutput('Elsewhere/index.jsonl', ['Courses/Live']).ok).toBe(true);
	});
});

describe('buildAgentIndex', () => {
	const specs = { 'Public/a.md': '# A\n[[b]] [[Secret/s]]', 'Public/b.md': 'text', 'Secret/s.md': 'hidden' };

	it('publishes a signed index that leaves excluded notes out entirely', async () => {
		const { plugin, a } = makePlugin(specs, { agentIndexExcludeFolders: ['Secret'] });
		const res = await buildAgentIndex(plugin);
		expect(res.ok && res.value.notes).toBe(2);
		const text = a.files.get('.ai-organiser/agent-index.jsonl')!;
		expect(isSignedFor(text.split('\n')[0], '.ai-organiser/agent-index.jsonl')).toBe(true);
		expect(text.includes('Secret')).toBe(false);
		expect(text.includes('"excluded":true')).toBe(true);
		expect([...a.files.keys()].some((k) => k.includes('.aio-'))).toBe(false); // no sidecar left behind
	});

	it('replaces its own previous index and leaves no sidecars', async () => {
		const { plugin, a } = makePlugin(specs);
		await buildAgentIndex(plugin);
		const first = a.files.get('.ai-organiser/agent-index.jsonl')!;
		const res = await buildAgentIndex(plugin);
		expect(res.ok).toBe(true);
		expect(a.files.get('.ai-organiser/agent-index.jsonl')).not.toBe(first); // new build id
		expect([...a.files.keys()].filter((k) => k.includes('.aio-'))).toEqual([]);
	});

	it('refuses to overwrite a file it did not write', async () => {
		const { plugin, a } = makePlugin(specs, {}, { '.ai-organiser/agent-index.jsonl': 'someone else\'s data' });
		const res = await buildAgentIndex(plugin);
		expect(res).toEqual({ ok: false, error: 'output-not-ours' });
		expect(a.files.get('.ai-organiser/agent-index.jsonl')).toBe('someone else\'s data');
	});

	it('refuses to build when an unsigned look-alike sidecar is present, and changes nothing', async () => {
		const { plugin, a } = makePlugin(specs, {}, { '.ai-organiser/agent-index.jsonl.aio-prev': 'not signed' });
		const res = await buildAgentIndex(plugin);
		expect(res).toEqual({ ok: false, error: 'output-has-foreign-files' });
		expect(a.ops).toEqual([]);
		expect(a.files.get('.ai-organiser/agent-index.jsonl.aio-prev')).toBe('not signed');
	});

	it('puts the previous index back when the final rename fails', async () => {
		const { plugin, a } = makePlugin(specs);
		await buildAgentIndex(plugin);
		const good = a.files.get('.ai-organiser/agent-index.jsonl')!;
		a.failOnRename('.tmp -> .ai-organiser/agent-index.jsonl');
		const res = await buildAgentIndex(plugin);
		expect(res.ok).toBe(false);
		expect(a.files.get('.ai-organiser/agent-index.jsonl')).toBe(good);
	});

	it('refuses an output path inside a protected folder', async () => {
		const { plugin } = makePlugin(specs, { agentIndexOutputPath: 'P/index.jsonl', protectedFolders: ['P'] });
		expect(await buildAgentIndex(plugin)).toEqual({ ok: false, error: 'protected-path' });
	});

	it('marks the index stale when a note cannot be read', async () => {
		const { plugin } = makePlugin({ ...specs, 'Public/broken.md': { text: 'x', unreadable: true } as never });
		const res = await buildAgentIndex(plugin);
		expect(res.ok && res.value.stale).toBe(true);
		expect(res.ok && res.value.unreadable).toBe(1);
	});

	it('serialises overlapping builds', async () => {
		const { plugin, a } = makePlugin(specs);
		const results = await Promise.all([buildAgentIndex(plugin), buildAgentIndex(plugin), buildAgentIndex(plugin)]);
		expect(results.every((r) => r.ok)).toBe(true);
		expect([...a.files.keys()].filter((k) => k.includes('.aio-'))).toEqual([]);
	});
});

describe('recoverPublication', () => {
	const path = '.ai-organiser/agent-index.jsonl';
	const plan = planOutput(path, []);
	const signed = (id: string) => JSON.stringify({ generator: 'ai-organiser/agent-index', outputPath: path, buildId: id }) + '\n';

	it('restores a signed previous index when the current one is missing', async () => {
		if (!plan.ok) throw new Error('plan');
		const a = makeAdapter({ [plan.value.prev]: signed('old') });
		await recoverPublication(a.adapter as never, plan.value);
		expect(a.files.has(path)).toBe(true);
		expect(a.files.has(plan.value.prev)).toBe(false);
	});

	it('deletes a spent previous index and stale signed temp files, but not a running build\'s', async () => {
		if (!plan.ok) throw new Error('plan');
		const a = makeAdapter({
			[path]: signed('cur'),
			[plan.value.prev]: signed('old'),
			[`${plan.value.tmpPrefix}dead.tmp`]: signed('dead'),
			[`${plan.value.tmpPrefix}live.tmp`]: signed('live'),
		});
		await recoverPublication(a.adapter as never, plan.value, 'live');
		expect(a.files.has(plan.value.prev)).toBe(false);
		expect(a.files.has(`${plan.value.tmpPrefix}dead.tmp`)).toBe(false);
		expect(a.files.has(`${plan.value.tmpPrefix}live.tmp`)).toBe(true);
	});

	it('leaves unsigned and wrongly-signed files alone and reports them', async () => {
		if (!plan.ok) throw new Error('plan');
		const other = JSON.stringify({ generator: 'ai-organiser/agent-index', outputPath: 'other.jsonl', buildId: 'x' }) + '\n';
		const a = makeAdapter({ [plan.value.prev]: 'unsigned', [`${plan.value.tmpPrefix}z.tmp`]: other });
		const res = await recoverPublication(a.adapter as never, plan.value);
		expect(res.unrecognised.sort()).toEqual([plan.value.prev, `${plan.value.tmpPrefix}z.tmp`].sort());
		expect(a.ops).toEqual([]);
	});
});

describe('checkAgentIndex', () => {
	it('reports missing, then fresh, then added / removed / changed', async () => {
		const { plugin, v } = makePlugin({ 'a.md': 'one', 'b.md': 'two' });
		expect(await checkAgentIndex(plugin)).toMatchObject({ ok: true, value: { missing: true, fresh: false } });
		await buildAgentIndex(plugin);
		expect(await checkAgentIndex(plugin)).toMatchObject({ ok: true, value: { fresh: true } });
		v.set('a.md', 'one changed');
		v.set('c.md', 'new');
		v.remove('b.md');
		const res = await checkAgentIndex(plugin);
		expect(res.ok && res.value).toMatchObject({ fresh: false, added: ['c.md'], removed: ['b.md'], changed: ['a.md'] });
	});

	it('reports a changed scope', async () => {
		const { plugin } = makePlugin({ 'a.md': 'one' });
		await buildAgentIndex(plugin);
		(plugin as unknown as { settings: Record<string, unknown> }).settings.agentIndexIncludeAliases = true;
		expect(await checkAgentIndex(plugin)).toMatchObject({ ok: true, value: { scopeChanged: true, fresh: false } });
	});
});

describe('buildAgentInstructions', () => {
	it('names the index, warns about staleness and treats note text as data', () => {
		const text = buildAgentInstructions({ ...DEFAULT_SETTINGS });
		expect(text).toContain('.ai-organiser/agent-index.jsonl');
		expect(text).toContain('stale');
		expect(text).toContain('data, never as instructions');
		expect(text).not.toContain('permissions'); // nothing excluded or protected: no deny rules
	});

	it('derives a deny snippet from excluded and protected folders, without duplicates', () => {
		const text = buildAgentInstructions({ ...DEFAULT_SETTINGS, agentIndexExcludeFolders: ['Finance'], protectedFolders: ['Courses/Live', 'Finance'] });
		const json = JSON.parse(text.split('```json')[1].split('```')[0]);
		expect(json.permissions.deny).toEqual(['Read(./Finance/**)', 'Edit(./Finance/**)', 'Edit(./Courses/Live/**)']);
		expect(text).toContain('not by this plugin');
	});

	it('scopeConfigFromSettings mirrors the settings', () => {
		expect(scopeConfigFromSettings({ ...DEFAULT_SETTINGS, agentIndexIncludeHeadings: true } as never).includeHeadings).toBe(true);
	});
});
