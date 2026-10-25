import { describe, it, expect } from 'vitest';
import {
	parseCanvasFileRefs,
	collectOccurrences,
	buildCandidateIndex,
	scanNotes,
} from '../src/services/embedScanService';
import { makeFakeApp } from './helpers/fakeVault';

const canvas = (nodes: unknown[]) => JSON.stringify({ nodes, edges: [] });

describe('parseCanvasFileRefs', () => {
	it('reads file nodes with their id and subpath, ignoring other node types', () => {
		const res = parseCanvasFileRefs(
			canvas([
				{ id: 'a1', type: 'file', file: 'Docs/report.pdf', subpath: '#page=3', x: 0, y: 0 },
				{ id: 'b2', type: 'text', text: 'hello' },
				{ id: 'c3', type: 'link', url: 'https://example.com' },
				{ id: 'd4', type: 'file', file: '' },
			]),
		);
		expect(res).toEqual({ ok: true, value: [{ nodeId: 'a1', file: 'Docs/report.pdf', subpath: '#page=3' }] });
	});

	it('treats a canvas with no nodes field as having no references', () => {
		expect(parseCanvasFileRefs('{}')).toEqual({ ok: true, value: [] });
	});

	it('reports malformed JSON, non-objects and a non-array nodes field as unreadable', () => {
		for (const bad of ['{not json', '[]', '"x"', 'null', '{"nodes": 5}']) {
			expect(parseCanvasFileRefs(bad), bad).toEqual({ ok: false, error: 'canvas-unreadable' });
		}
	});

	it('skips malformed node entries without failing the whole canvas', () => {
		const res = parseCanvasFileRefs(canvas([null, 5, { type: 'file', file: 'a.png' }]));
		expect(res.ok && res.value.length).toBe(1);
	});
});

describe('collectOccurrences', () => {
	it('collects only non-markdown targets from markdown, skipping external URLs and note links', () => {
		const text = ['See ![[scan.pdf#page=2]] and [[Another note]]', '![](https://x.test/a.png) ![alt](img/pic.png)', '[doc](files/spec.docx)'].join('\n');
		const { occurrences } = collectOccurrences('n.md', 'md', text);
		expect(occurrences.map((o) => o.linktext)).toEqual(['scan.pdf', 'img/pic.png', 'files/spec.docx']);
		expect(occurrences.map((o) => o.lineNumber)).toEqual([1, 2, 3]);
	});

	it('collects canvas file nodes and flags an unreadable canvas as a coverage failure', () => {
		const ok = collectOccurrences('c.canvas', 'canvas', canvas([{ id: 'n', type: 'file', file: 'a/b.pdf' }]));
		expect(ok.occurrences).toEqual([{ referrerPath: 'c.canvas', kind: 'canvas', linktext: 'a/b.pdf', lineNumber: 0 }]);
		const bad = collectOccurrences('c.canvas', 'canvas', '{oops');
		expect(bad.failure).toEqual({ path: 'c.canvas', kind: 'canvas-unreadable' });
		expect(bad.occurrences).toEqual([]);
	});

	it('handles unicode and percent-encoded names without crashing', () => {
		const { occurrences } = collectOccurrences('n.md', 'md', '![[Écoles/résumé été.pdf]] ![x](my%20file.png)');
		// a markdown destination is decoded like Obsidian does (this used to be pinned as the raw '%20' text, which never resolved)
		expect(occurrences.map((o) => o.linktext).sort()).toEqual(['Écoles/résumé été.pdf', 'my file.png'].sort());
	});
});

describe('buildCandidateIndex', () => {
	const candidates = buildCandidateIndex(['A/report.pdf', 'B/report.pdf', 'C/other.pdf', 'B/sub/Report.PDF']);

	it('finds every file with the same name for a bare link', () => {
		expect(candidates('report.pdf').sort()).toEqual(['A/report.pdf', 'B/report.pdf', 'B/sub/Report.PDF']);
	});

	it('narrows by a trailing path', () => {
		expect(candidates('B/report.pdf')).toEqual(['B/report.pdf']);
		expect(candidates('sub/report.pdf')).toEqual(['B/sub/Report.PDF']);
	});

	it('returns nothing for an unknown name', () => {
		expect(candidates('missing.pdf')).toEqual([]);
	});
});

describe('scanNotes with canvases', () => {
	it('counts a canvas file node as a reference and records the canvas as the source', async () => {
		const v = makeFakeApp({
			'Docs/report.pdf': { size: 5000 },
			'Board.canvas': canvas([{ id: 'n1', type: 'file', file: 'Docs/report.pdf' }]),
			'note.md': 'plain text',
		});
		const result = await scanNotes(v.app as never, [...v.files.values()].filter((f) => f.extension !== 'pdf') as never, { includeOrphans: true });
		expect(result.targets).toHaveLength(1);
		const target = result.targets[0];
		expect(target.file?.path).toBe('Docs/report.pdf');
		expect(target.references).toHaveLength(1);
		expect(target.references[0].kind).toBe('canvas');
		expect(target.references[0].nodeId).toBe('n1');
		expect(result.possiblyOrphaned).toEqual([]);
		expect(result.canvasesScanned).toBe(1);
		expect(result.notesScanned).toBe(1);
		expect(result.coverageFailures).toEqual([]);
	});

	it('records a malformed canvas and an unreadable note as coverage failures', async () => {
		const v = makeFakeApp({
			'Bad.canvas': '{oops',
			'broken.md': { text: 'x', unreadable: true },
			'ok.md': '![[a.png]]',
			'a.png': { size: 10 },
		});
		const result = await scanNotes(v.app as never, [...v.files.values()].filter((f) => f.extension !== 'png') as never);
		expect(result.coverageFailures).toEqual(
			expect.arrayContaining([
				{ path: 'Bad.canvas', kind: 'canvas-unreadable' },
				{ path: 'broken.md', kind: 'markdown-unreadable' },
			]),
		);
		expect(result.targets).toHaveLength(1);
	});

	it('flags every file a bare link could mean when two files share a name', async () => {
		const v = makeFakeApp({
			'A/scan.pdf': { size: 10 },
			'B/scan.pdf': { size: 20 },
			'n.md': '![[scan.pdf]]',
		});
		const result = await scanNotes(v.app as never, [v.files.get('n.md')!] as never);
		expect(result.ambiguousPaths?.sort()).toEqual(['A/scan.pdf', 'B/scan.pdf']);
		expect(result.targets.find((t) => t.ambiguous)).toBeDefined();
	});

	it('stores occurrences and the scan start time for later revalidation', async () => {
		const v = makeFakeApp({ 'a.png': {}, 'n.md': '![[a.png]]' });
		const before = Date.now();
		const result = await scanNotes(v.app as never, [v.files.get('n.md')!] as never);
		expect(result.occurrences).toEqual([{ referrerPath: 'n.md', kind: 'markdown', linktext: 'a.png', lineNumber: 1 }]);
		expect(result.scanStartedAt).toBeGreaterThanOrEqual(before);
	});

	it('reports cancellation without partial targets', async () => {
		const v = makeFakeApp({ 'n.md': '![[a.png]]', 'a.png': {} });
		const ctl = new AbortController();
		ctl.abort();
		const result = await scanNotes(v.app as never, [v.files.get('n.md')!] as never, { signal: ctl.signal });
		expect(result.cancelled).toBe(true);
		expect(result.targets).toEqual([]);
	});
});
