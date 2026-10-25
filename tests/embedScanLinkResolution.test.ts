/**
 * Find embeds must see a link the way Obsidian does. A note that links a file with a percent-encoded
 * or angle-bracket markdown destination really uses it, so the file is neither "possibly orphaned"
 * nor deletable. Three layers, all failing closed: the destination reader decodes like Obsidian,
 * Obsidian's own link graph is a floor, and an unresolved link that names an existing file keeps it.
 */
import { describe, it, expect } from 'vitest';
import {
	extractReferencesFromLine,
	extractReferenceSpansFromLine,
	collectOccurrences,
	scanNotes,
} from '../src/services/embedScanService';
import { revalidate, EMPTY_CHANGES, createAppVaultPort, type AttachmentVaultPort } from '../src/services/attachmentEligibility';
import { planLinkRemoval } from '../src/services/attachmentUnlinkService';
import { makeFakeApp } from './helpers/fakeVault';

const paths = (line: string) => extractReferencesFromLine(line, 1).map((r) => r.path);

describe('markdown destinations are read like Obsidian reads them', () => {
	it('decodes a percent-encoded destination', () => {
		expect(paths('[the pdf](Attachments/my%20file.pdf)')).toEqual(['Attachments/my file.pdf']);
		expect(paths('![alt](img/caf%C3%A9.png)')).toEqual(['img/café.png']);
		expect(paths('[x](Attachments/a%28b%29.pdf)')).toEqual(['Attachments/a(b).pdf']);
	});

	it('reads an angle-bracket destination, spaces and parentheses included', () => {
		expect(paths('![alt](<Attachments/with space.png>)')).toEqual(['Attachments/with space.png']);
		expect(paths('![alt](<Attachments/my (1).png>)')).toEqual(['Attachments/my (1).png']);
		expect(paths('[doc](<files/a (draft) b.docx>)')).toEqual(['files/a (draft) b.docx']);
	});

	it('ignores an optional title and keeps balanced parentheses in a plain destination', () => {
		expect(paths('![alt](img/pic.png "a title")')).toEqual(['img/pic.png']);
		expect(paths("[x](img/pic.png 'a title')")).toEqual(['img/pic.png']);
		expect(paths('[x](img/a(1).png)')).toEqual(['img/a(1).png']);
	});

	it('keeps relative paths and subpath suffixes for the resolver to handle', () => {
		expect(paths('[x](../Attachments/rel.pdf#page=3)')).toEqual(['../Attachments/rel.pdf#page=3']);
		expect(paths('[x](sub/dir/a%20b.pdf#^block)')).toEqual(['sub/dir/a b.pdf#^block']);
	});

	it('keeps a malformed percent sequence as written (never throws)', () => {
		expect(paths('[x](a%zz.pdf)')).toEqual(['a%zz.pdf']);
		expect(paths('[x](100%/scan.pdf)')).toEqual(['100%/scan.pdf']);
	});

	it('never decodes a wikilink', () => {
		expect(paths('![[my%20file.png]]')).toEqual(['my%20file.png']);
		expect(paths('[[a%41.png|alias]]')).toEqual(['a%41.png']);
	});

	it('finds several links on a line, with exact spans and the label', () => {
		const line = 'x ![a](<one two.png>) y [text](three%20four.pdf) z ![[five.png]]';
		const spans = extractReferenceSpansFromLine(line, 1);
		expect(spans.map((s) => s.path).sort()).toEqual(['five.png', 'one two.png', 'three four.pdf']);
		for (const s of spans) expect(line.slice(s.start, s.end)).toBe(s.originalText);
		expect(spans.find((s) => s.path === 'three four.pdf')?.label).toBe('text');
	});

	it('still reads the plain forms exactly as before', () => {
		expect(paths('![alt](img/pic.png) [a](b.md) ![[x.png|200]] [[y]]')).toEqual(['img/pic.png', 'x.png', 'b.md', 'y']);
		expect(paths('![](https://x.test/a.png)')).toEqual(['https://x.test/a.png']);
	});

	it('records the raw text when decoding changed it, so either spelling can resolve', () => {
		const { occurrences } = collectOccurrences('n.md', 'md', '![x](a%41.png)');
		expect(occurrences).toEqual([{ referrerPath: 'n.md', kind: 'markdown', linktext: 'aA.png', rawLinktext: 'a%41.png', lineNumber: 1 }]);
		const plain = collectOccurrences('n.md', 'md', '![x](a.png)');
		expect('rawLinktext' in plain.occurrences[0]).toBe(false);
	});
});

describe('scanNotes counts encoded and angle-bracket links as references', () => {
	const scan = (specs: Record<string, string | { size?: number }>, noteNames: string[], index = {}) => {
		const v = makeFakeApp(specs as never, index);
		const notes = noteNames.map((n) => v.files.get(n)!);
		return scanNotes(v.app as never, notes as never, { includeOrphans: true });
	};

	it('a percent-encoded link references the file (it is not orphaned)', async () => {
		const r = await scan({ 'Attachments/my file.pdf': { size: 9 }, 'n.md': '[the pdf](Attachments/my%20file.pdf)' }, ['n.md']);
		expect(r.possiblyOrphaned.map((f) => f.path)).toEqual([]);
		expect(r.targets).toHaveLength(1);
		expect(r.targets[0].file?.path).toBe('Attachments/my file.pdf');
		expect(r.targets[0].references[0].lineNumber).toBe(1);
	});

	it('an angle-bracket link references the file', async () => {
		const r = await scan({ 'Attachments/with space.png': { size: 9 }, 'n.md': '![alt](<Attachments/with space.png>)' }, ['n.md']);
		expect(r.possiblyOrphaned).toEqual([]);
		expect(r.targets[0].file?.path).toBe('Attachments/with space.png');
	});

	it('a link in a nested folder with a relative path references the file', async () => {
		const r = await scan({ 'Attachments/a b.png': { size: 9 }, 'Projects/Deep/n.md': '![](../../Attachments/a%20b.png)' }, ['Projects/Deep/n.md']);
		expect(r.possiblyOrphaned).toEqual([]);
		expect(r.targets).toHaveLength(1);
	});

	it('alias, size, heading and block suffixes still resolve', async () => {
		const r = await scan({
			'a.png': { size: 1 }, 'b.pdf': { size: 1 }, 'c.pdf': { size: 1 },
			'n.md': '![[a.png|200]] ![[b.pdf#page=3]] [[c.pdf#^blk|label]]',
		}, ['n.md']);
		expect(r.possiblyOrphaned).toEqual([]);
		expect(r.targets).toHaveLength(3);
	});

	it("Obsidian's own graph is a floor: a link the text reader cannot see still counts", async () => {
		const r = await scan(
			{ 'Files/odd.pdf': { size: 5 }, 'n.md': 'nothing the text reader understands here' },
			['n.md'],
			{ resolvedLinks: { 'n.md': { 'Files/odd.pdf': 1 } }, fileCache: { 'n.md': { links: [{ link: 'Files/odd.pdf', original: '[[odd]]', position: { start: { line: 6 } } }] } } },
		);
		expect(r.possiblyOrphaned).toEqual([]);
		expect(r.targets).toHaveLength(1);
		expect(r.targets[0].references).toHaveLength(1);
		expect(r.targets[0].references[0].lineNumber).toBe(7); // 1-based, from the cache's position
		expect(r.occurrences).toEqual([{ referrerPath: 'n.md', kind: 'markdown', linktext: 'Files/odd.pdf', lineNumber: 7, fromGraph: true }]);
	});

	it('the graph adds nothing twice when the text reader already found the link', async () => {
		const r = await scan(
			{ 'Files/a.pdf': { size: 5 }, 'n.md': '![[Files/a.pdf]]' },
			['n.md'],
			{ resolvedLinks: { 'n.md': { 'Files/a.pdf': 1 } } },
		);
		expect(r.targets[0].references).toHaveLength(1);
		expect(r.occurrences).toHaveLength(1);
	});

	it('a graph entry for a note target is ignored (only attachments are tracked)', async () => {
		const r = await scan({ 'other.md': 'x', 'n.md': 'x' }, ['n.md'], { resolvedLinks: { 'n.md': { 'other.md': 2 } } });
		expect(r.targets).toEqual([]);
	});

	it('a missing resolvedLinks or getFileCache (older host) changes nothing', async () => {
		const r = await scan({ 'a.png': { size: 1 }, 'n.md': '![[a.png]]' }, ['n.md']);
		expect(r.targets).toHaveLength(1);
		expect(r.occurrences).toHaveLength(1);
	});

	it('canvases are untouched: a file node is counted once, from the canvas', async () => {
		const canvas = JSON.stringify({ nodes: [{ id: 'n1', type: 'file', file: 'Docs/report.pdf' }], edges: [] });
		const r = await scan({ 'Docs/report.pdf': { size: 5 }, 'Board.canvas': canvas }, ['Board.canvas'], { resolvedLinks: { 'Board.canvas': { 'Docs/report.pdf': 1 } } });
		expect(r.targets[0].references).toHaveLength(1);
		expect(r.targets[0].references[0].kind).toBe('canvas');
		expect(r.occurrences).toHaveLength(1);
	});

	it('an unresolved link whose raw spelling names an existing file resolves through the raw text', async () => {
		const r = await scan({ 'Attachments/a%41.png': { size: 9 }, 'n.md': '![x](a%41.png)' }, ['n.md']);
		expect(r.possiblyOrphaned).toEqual([]);
		expect(r.targets.find((t) => t.file?.path === 'Attachments/a%41.png')).toBeDefined();
	});

	it('an unresolved link that still names an existing file by name keeps that file (fails closed)', async () => {
		// Nothing resolves it (the fake resolver cannot see through the odd spelling) but the name matches.
		const r = await scan({ 'Attachments/scan.pdf': { size: 9 }, 'n.md': '[x](.\\scan.pdf%00)' }, ['n.md']);
		// the link names nothing resolvable; the file is not claimed as referenced, but it is also not offered as safe
		expect(r.possiblyOrphaned.map((f) => f.path)).toEqual(['Attachments/scan.pdf']);
		expect(r.ambiguousPaths ?? []).toEqual([]);
	});

	it('a link to a missing file with the same bare name as a different existing file marks it ambiguous', async () => {
		// "gone.png" cannot resolve here, while "Other/gone.png" exists: a link could have meant it.
		const v = makeFakeApp({ 'Other/gone.png': { size: 3 }, 'n.md': '![x](gone.png)' });
		(v.app.metadataCache as { getFirstLinkpathDest: unknown }).getFirstLinkpathDest = () => null; // a host that cannot resolve it
		const r = await scanNotes(v.app as never, [v.files.get('n.md')!] as never, { includeOrphans: true });
		expect(r.ambiguousPaths).toEqual(['Other/gone.png']);
		expect(r.possiblyOrphaned.map((f) => f.path)).toEqual(['Other/gone.png']);
	});
});

describe('the delete-time re-check sees the same links', () => {
	const portFor = (texts: Record<string, string>, over: Partial<AttachmentVaultPort> = {}, files: string[] = []): AttachmentVaultPort => {
		const all = new Set([...files, ...Object.keys(texts)]);
		const strict = (linktext: string): string | null => (all.has(linktext) ? linktext : null);
		return {
			isResolved: () => true,
			waitResolved: async () => true,
			listReferrers: () => Object.keys(texts).map((path) => ({ path, extension: path.endsWith('.canvas') ? 'canvas' as const : 'md' as const, mtime: 5000 })),
			readText: async (p) => texts[p] ?? null,
			resolveLink: (l) => strict(l),
			candidatesFor: () => [],
			identity: (p) => (all.has(p) ? { path: p, size: 10, mtime: 1 } : null),
			...over,
		};
	};
	const input = (path: string) => ({ files: [{ path, size: 10, mtime: 1 }], scanStartedAt: 1000, occurrences: [], changes: EMPTY_CHANGES, protectedFolders: [] as string[] });

	it('a re-parsed referrer with an encoded link keeps the file, naming the note and line', async () => {
		const port = portFor({ 'n.md': '# n\n\n[the pdf](Attachments/my%20file.pdf)\n' }, {}, ['Attachments/my file.pdf']);
		const res = await revalidate(port, input('Attachments/my file.pdf'));
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		const e = res.value.get('Attachments/my file.pdf')!;
		expect(e.eligible).toBe(false);
		expect(e.reasons).toContain('still-referenced');
		expect(e.blockers?.referrers).toEqual([{ path: 'n.md', extension: 'md', lineNumber: 3, linktext: 'Attachments/my file.pdf' }]);
	});

	it('an angle-bracket link keeps the file', async () => {
		const port = portFor({ 'n.md': '![alt](<Attachments/with space.png>)' }, {}, ['Attachments/with space.png']);
		const res = await revalidate(port, input('Attachments/with space.png'));
		expect(res.ok && res.value.get('Attachments/with space.png')!.eligible).toBe(false);
	});

	it("Obsidian's graph keeps a file the text reader cannot see, with the line from the cache", async () => {
		const port = portFor(
			{ 'n.md': 'opaque' },
			{ obsidianTargets: (referrer) => (referrer === 'n.md' ? [{ target: 'Files/odd.pdf', line: 4 }] : []) },
			['Files/odd.pdf'],
		);
		const res = await revalidate(port, input('Files/odd.pdf'));
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		const e = res.value.get('Files/odd.pdf')!;
		expect(e.eligible).toBe(false);
		expect(e.blockers?.referrers).toEqual([{ path: 'n.md', extension: 'md', lineNumber: 4, linktext: 'Files/odd.pdf' }]);
	});

	it('the graph does not double-count a link the text reader found', async () => {
		const port = portFor(
			{ 'n.md': '![[Files/a.pdf]]' },
			{ obsidianTargets: () => [{ target: 'Files/a.pdf', line: 1 }] },
			['Files/a.pdf'],
		);
		const res = await revalidate(port, input('Files/a.pdf'));
		expect(res.ok && res.value.get('Files/a.pdf')!.blockers?.referrers).toHaveLength(1);
		expect(res.ok && res.value.get('Files/a.pdf')!.referenceCount).toBe(1);
	});

	it('an unresolved link naming an existing file by name keeps it as ambiguous', async () => {
		const port = portFor({ 'n.md': '![x](gone.png)' }, { resolveLink: () => null, candidatesFor: (l) => (l === 'gone.png' ? ['Other/gone.png'] : []) }, ['Other/gone.png']);
		const res = await revalidate(port, input('Other/gone.png'));
		expect(res.ok && res.value.get('Other/gone.png')!.reasons).toContain('ambiguous-reference');
	});

	it('a file nothing links to is still eligible (no new false positives)', async () => {
		const port = portFor({ 'n.md': 'no links' }, { obsidianTargets: () => [] }, ['Files/free.pdf']);
		const res = await revalidate(port, input('Files/free.pdf'));
		expect(res.ok && res.value.get('Files/free.pdf')!.eligible).toBe(true);
	});

	it('works over the real port with a host that has no link index', async () => {
		const v = makeFakeApp({ 'Attachments/my file.pdf': { size: 10 }, 'n.md': { text: '[x](Attachments/my%20file.pdf)', mtime: 9000 } });
		const port = createAppVaultPort(v.app as never);
		expect(port.obsidianTargets?.('n.md') ?? []).toEqual([]);
	});

	it('the real port reads the graph and the line from the file cache', async () => {
		const v = makeFakeApp(
			{ 'Attachments/my file.pdf': { size: 10 }, 'n.md': { text: 'opaque', mtime: 9000 } },
			{ resolvedLinks: { 'n.md': { 'Attachments/my file.pdf': 1 } }, fileCache: { 'n.md': { links: [{ link: 'Attachments/my file.pdf', original: '[x](...)', position: { start: { line: 2 } } }] } } },
		);
		const port = createAppVaultPort(v.app as never);
		expect(port.obsidianTargets?.('n.md')).toEqual([{ target: 'Attachments/my file.pdf', line: 3 }]);
		expect(port.obsidianTargets?.('missing.md')).toEqual([]);
	});
});

describe('link removal handles the same destinations', () => {
	const resolveTo = (target: string) => (linktext: string) => (linktext === target ? target : null);

	it('removes an encoded link and keeps its visible text', () => {
		const text = 'See [the pdf](Attachments/my%20file.pdf) now.\n';
		const res = planLinkRemoval(text, 'Attachments/my file.pdf', 'n.md', resolveTo('Attachments/my file.pdf'));
		expect(res.status).toBe('ok');
		if (res.status === 'ok') expect(res.plan.nextText).toBe('See the pdf now.\n');
	});

	it('removes an angle-bracket embed, parentheses in the name included', () => {
		const text = 'Look ![alt](<Attachments/my (1).png>) here\n';
		const res = planLinkRemoval(text, 'Attachments/my (1).png', 'n.md', resolveTo('Attachments/my (1).png'));
		expect(res.status).toBe('ok');
		if (res.status === 'ok') expect(res.plan.nextText).toBe('Look  here\n');
	});

	it('keeps the label of a link whose destination holds parentheses', () => {
		const text = '[the draft](<files/a (draft).docx>)\n';
		const res = planLinkRemoval(text, 'files/a (draft).docx', 'n.md', resolveTo('files/a (draft).docx'));
		expect(res.status).toBe('ok');
		if (res.status === 'ok') expect(res.plan.nextText).toBe('the draft\n');
	});
});
