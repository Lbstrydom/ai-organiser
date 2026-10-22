import { describe, it, expect } from 'vitest';
import {
	projectIndex,
	includedRecords,
	parseSignature,
	isSignedFor,
	canonicalScopeJson,
	AGENT_INDEX_GENERATOR,
	type RawRecord,
	type ProjectionScope,
	type ProjectionHeader,
} from '../src/services/agentIndex/agentIndexProjection';

const rec = (path: string, over: Partial<RawRecord> = {}): RawRecord => ({
	path,
	basename: path.split('/').pop()!.replace(/\.md$/, ''),
	folder: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '',
	tags: [],
	mtime: 1000,
	size: 10,
	sha256: 'h-' + path,
	links: [],
	aliases: [],
	headings: [],
	frontmatter: {},
	...over,
});

const header: ProjectionHeader = { generatedAt: '2026-01-01T00:00:00.000Z', outputPath: '.ai-organiser/agent-index.jsonl', buildId: 'b1', scopeHash: 'sh', stale: false };

const scopeExcluding = (...folders: string[]): ProjectionScope => ({
	isIncluded: (p) => !folders.some((f) => p === f || p.startsWith(f + '/')),
	includeAliases: false,
	includeHeadings: false,
	frontmatterKeys: [],
	exportUnresolvedLinks: false,
});

const lines = (text: string) => text.trim().split('\n').map((l) => JSON.parse(l));

describe('projectIndex determinism', () => {
	it('produces identical bytes for any input order', () => {
		const a = [rec('B/b.md', { tags: ['z', 'a', 'a'] }), rec('A/a.md')];
		const b = [rec('A/a.md'), rec('B/b.md', { tags: ['a', 'z'] })];
		expect(projectIndex(a, scopeExcluding(), header)).toBe(projectIndex(b, scopeExcluding(), header));
	});

	it('writes a signed header first and one record per included note, sorted by path', () => {
		const out = lines(projectIndex([rec('b.md'), rec('a.md')], scopeExcluding(), header));
		expect(out[0]).toMatchObject({ type: 'header', schemaVersion: 1, generator: AGENT_INDEX_GENERATOR, outputPath: header.outputPath, buildId: 'b1', stale: false });
		expect(out.slice(1).map((r) => r.path)).toEqual(['a.md', 'b.md']);
		expect(out[0].files).toEqual([
			{ path: 'a.md', mtime: 1000, size: 10, sha256: 'h-a.md' },
			{ path: 'b.md', mtime: 1000, size: 10, sha256: 'h-b.md' },
		]);
	});

	it('never carries note text: only the structural fields exist on a record', () => {
		const out = lines(projectIndex([rec('a.md', { tags: ['t'] })], scopeExcluding(), header));
		expect(Object.keys(out[1]).sort()).toEqual(['basename', 'folder', 'links', 'mtime', 'path', 'sha256', 'size', 'tags', 'type']);
	});
});

describe('exclusion guarantee (byte level)', () => {
	const records = [
		rec('Public/note.md', {
			links: [
				{ target: 'Secret/Budget 2026.md', text: 'Budget 2026' },
				{ target: 'Public/other.md', text: 'other' },
				{ target: null, text: 'Future secret plan' },
			],
			aliases: ['Alias of note'],
			headings: ['Heading mentioning Budget 2026'],
		}),
		rec('Public/other.md'),
		rec('Secret/Budget 2026.md', { tags: ['finance'], headings: ['Salaries'], aliases: ['Pay'] }),
		rec('Secret/sub/Salaries.md'),
	];
	const text = projectIndex(records, scopeExcluding('Secret'), header);

	it('contains no excluded path, folder, name, tag or heading anywhere', () => {
		for (const needle of ['Secret', 'Budget 2026.md', 'Salaries', 'finance', 'Pay"']) {
			expect(text.includes(needle), needle).toBe(false);
		}
	});

	it('shows a link to an excluded note only as an excluded marker', () => {
		const note = lines(text).find((l) => l.path === 'Public/note.md');
		expect(note.links).toEqual(expect.arrayContaining([{ excluded: true }, { to: 'Public/other.md' }]));
		expect(note.links).toHaveLength(2);
	});

	it('omits links to notes that do not exist by default', () => {
		expect(text.includes('Future secret plan')).toBe(false);
	});

	it('exports unresolved link text only when opted in', () => {
		const opted = projectIndex(records, { ...scopeExcluding('Secret'), exportUnresolvedLinks: true }, header);
		expect(opted.includes('Future secret plan')).toBe(true);
		expect(opted.includes('Secret')).toBe(false);
	});

	it('keeps free text out unless opted in, and only for included notes', () => {
		expect(text.includes('Alias of note')).toBe(false);
		expect(text.includes('Heading mentioning')).toBe(false);
		const opted = projectIndex(records, { ...scopeExcluding('Secret'), includeAliases: true, includeHeadings: true }, header);
		expect(opted.includes('Alias of note')).toBe(true);
		expect(opted.includes('Heading mentioning')).toBe(true);
		expect(opted.includes('Salaries')).toBe(false);
		expect(opted.includes('"Pay"')).toBe(false);
	});

	it('includedRecords agrees with the scope', () => {
		expect(includedRecords(records, scopeExcluding('Secret')).map((r) => r.path)).toEqual(['Public/note.md', 'Public/other.md']);
	});
});

describe('frontmatter allowlist', () => {
	const records = [rec('a.md', { frontmatter: { description: 'A note', secretKey: 'x', nested: { a: 1 }, list: ['a', 2, { b: 1 }] } })];

	it('exports nothing from frontmatter by default', () => {
		expect(projectIndex(records, scopeExcluding(), header).includes('A note')).toBe(false);
	});

	it('exports only named keys, scalars and lists of scalars', () => {
		const out = lines(projectIndex(records, { ...scopeExcluding(), frontmatterKeys: ['description', 'list', 'nested', 'missing'] }, header));
		expect(out[1].frontmatter).toEqual({ description: 'A note', list: ['a', 2] });
		expect(JSON.stringify(out)).not.toContain('secretKey');
	});
});

describe('signature', () => {
	it('reads a signature and checks it against an exact path', () => {
		const first = projectIndex([], scopeExcluding(), header).split('\n')[0];
		expect(parseSignature(first)).toEqual({ generator: AGENT_INDEX_GENERATOR, outputPath: header.outputPath, buildId: 'b1' });
		expect(isSignedFor(first, header.outputPath)).toBe(true);
		expect(isSignedFor(first, 'other.jsonl')).toBe(false);
	});

	it('rejects anything that is not one of ours', () => {
		for (const bad of ['', 'not json', '[]', '{"generator":"someone-else","outputPath":"x","buildId":"y"}', '{"generator":"ai-organiser/agent-index"}']) {
			expect(parseSignature(bad), bad).toBeNull();
		}
	});
});

describe('canonicalScopeJson', () => {
	it('ignores order and case of folders and keys', () => {
		const a = canonicalScopeJson({ includeFolders: ['B', 'a'], excludeFolders: [], includeAliases: false, includeHeadings: false, frontmatterKeys: ['y', 'x'], exportUnresolvedLinks: false });
		const b = canonicalScopeJson({ includeFolders: ['A', 'b'], excludeFolders: [], includeAliases: false, includeHeadings: false, frontmatterKeys: ['x', 'y'], exportUnresolvedLinks: false });
		expect(a).toBe(b);
	});

	it('changes when any scope option changes', () => {
		const base = { includeFolders: [], excludeFolders: [], includeAliases: false, includeHeadings: false, frontmatterKeys: [], exportUnresolvedLinks: false };
		expect(canonicalScopeJson(base)).not.toBe(canonicalScopeJson({ ...base, includeAliases: true }));
		expect(canonicalScopeJson(base)).not.toBe(canonicalScopeJson({ ...base, excludeFolders: ['X'] }));
	});
});
