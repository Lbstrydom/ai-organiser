import { describe, it, expect } from 'vitest';
import { applyEdits, findOccurrences, hasUnsupported, renderLink, typeLabel, type Occurrence, type ScanTarget } from '../src/services/offload/referenceOccurrences';

const TARGET: ScanTarget = {
	path: 'Attachments/Big report.pdf',
	name: 'Big report.pdf',
	resolve: (link) => {
		const l = decodeURIComponent(link).toLowerCase();
		return l === 'big report.pdf' || l.endsWith('/big report.pdf') ? 'Attachments/Big report.pdf' : null;
	},
};
const INFO = { url: 'https://drive.google.com/file/d/Abc123/view', fileName: 'Big report.pdf', sizeBytes: 12 * 1024 * 1024 };

const find = (text: string) => {
	const res = findOccurrences('Notes/a.md', text, 'md', TARGET);
	if (!res.ok) throw new Error(res.error);
	return res.value;
};
const rewrite = (text: string): string => {
	const occ = find(text);
	return applyEdits(text, occ.map((o) => ({ start: o.start, end: o.end, text: renderLink(o, INFO) })));
};

describe('findOccurrences (markdown)', () => {
	it('classifies each reference form with an exact span', () => {
		const text = 'a ![[Big report.pdf]] b [[Big report.pdf]] c ![alt](Attachments/Big%20report.pdf) d [text](Attachments/Big%20report.pdf)';
		const occ = find(text);
		expect(occ.map((o) => o.kind)).toEqual(['wikilink-embed', 'wikilink', 'markdown-embed', 'markdown-link']);
		for (const o of occ) expect(text.slice(o.start, o.end)).toBe(o.original);
	});

	it('ignores other files, external links, fenced code and inline code', () => {
		const text = ['[[Other.pdf]]', '[x](https://example.com/Big report.pdf)', '`![[Big report.pdf]]`', '```', '![[Big report.pdf]]', '```', '~~~', '[[Big report.pdf]]', '~~~'].join('\n');
		expect(find(text)).toEqual([]);
	});

	it('treats an escaped link as text the user is showing, not as a reference', () => {
		expect(find('Example: \\[[Big report.pdf]] and \\![[Big report.pdf]] and \\[x](Attachments/Big%20report.pdf)')).toEqual([]);
		expect(find('literal \\\\[[Big report.pdf]]')).toHaveLength(1); // an escaped backslash does not escape the bracket
	});

	it('captures alias, subpath and page', () => {
		const [a, b, c] = find('[[Big report.pdf|the report]] ![[Big report.pdf#page=3]] [[Big report.pdf#Heading]]');
		expect(a.display).toBe('the report');
		expect(b.subpath).toBe('page=3');
		expect(c.subpath).toBe('Heading');
	});

	it('understands the escaped pipe used inside tables', () => {
		const [o] = find('| [[Big report.pdf\\|short]] |');
		expect(o.display).toBe('short');
	});

	it('reports HTML, reference definitions and frontmatter as unsupported', () => {
		const html = find('<embed src="Attachments/Big report.pdf">');
		expect(html[0]).toMatchObject({ kind: 'unsupported', reason: 'html' });
		const def = find('[ref]: Attachments/Big%20report.pdf');
		expect(def[0]).toMatchObject({ kind: 'unsupported', reason: 'reference-definition' });
		const fm = find('---\ncover: "[[Big report.pdf]]"\n---\nbody');
		expect(fm[0]).toMatchObject({ kind: 'unsupported', reason: 'frontmatter' });
		expect(hasUnsupported(fm)).toBe(true);
		expect(hasUnsupported(find('![[Big report.pdf]]'))).toBe(false);
	});
});

describe('renderLink', () => {
	it('turns an embed into a labelled Drive link', () => {
		expect(rewrite('![[Big report.pdf]]')).toBe('[Big report.pdf (PDF, 12.0 MB) — open in Drive](https://drive.google.com/file/d/Abc123/view)');
	});

	it('adds the page of a PDF subpath', () => {
		expect(rewrite('![[Big report.pdf#page=3]]')).toContain('(page 3)');
	});

	it('uses the alias as link text, but not an image size hint', () => {
		expect(rewrite('[[Big report.pdf|the report]]')).toBe('[the report](https://drive.google.com/file/d/Abc123/view)');
		expect(rewrite('![[Big report.pdf|the report]]')).toBe('[the report](https://drive.google.com/file/d/Abc123/view)');
		expect(rewrite('![[Big report.pdf|300]]')).toContain('open in Drive');
	});

	it('keeps the file name and a heading for a plain link', () => {
		expect(rewrite('[[Big report.pdf]]')).toBe('[Big report.pdf](https://drive.google.com/file/d/Abc123/view)');
		expect(rewrite('[[Big report.pdf#Results]]')).toBe('[Big report.pdf (Results)](https://drive.google.com/file/d/Abc123/view)');
	});

	it('keeps the user\'s text or alt for Markdown links', () => {
		expect(rewrite('[the doc](Attachments/Big%20report.pdf)')).toBe('[the doc](https://drive.google.com/file/d/Abc123/view)');
		expect(rewrite('![diagram](Attachments/Big%20report.pdf)')).toBe('[diagram](https://drive.google.com/file/d/Abc123/view)');
		expect(rewrite('![](Attachments/Big%20report.pdf)')).toContain('open in Drive');
	});

	it('keeps a Markdown link label exactly as written instead of escaping it twice', () => {
		expect(rewrite('[Budget \\*draft\\*](Attachments/Big%20report.pdf)')).toBe('[Budget \\*draft\\*](https://drive.google.com/file/d/Abc123/view)');
	});

	it('escapes brackets in link text and leaves the rest of the line alone', () => {
		const occ: Occurrence = { referrerPath: 'a.md', kind: 'wikilink', start: 0, end: 0, original: '', display: 'a [b]\nc' };
		expect(renderLink(occ, INFO)).toBe('[a \\[b\\] c](https://drive.google.com/file/d/Abc123/view)');
		expect(rewrite('before [[Big report.pdf|c]] after')).toBe('before [c](https://drive.google.com/file/d/Abc123/view) after');
	});

	it('labels the file type from its extension', () => {
		expect(typeLabel('x.mp4')).toBe('MP4');
		expect(typeLabel('noext')).toBe('FILE');
	});
});

describe('applyEdits', () => {
	it('applies edits independent of their order and refuses overlaps', () => {
		expect(applyEdits('0123456789', [{ start: 6, end: 8, text: 'B' }, { start: 1, end: 3, text: 'A' }])).toBe('0A345B89');
		expect(() => applyEdits('0123456789', [{ start: 1, end: 5, text: 'x' }, { start: 3, end: 6, text: 'y' }])).toThrow();
	});
});

describe('findOccurrences (canvas)', () => {
	const canvas = (nodes: unknown[]) => JSON.stringify({ nodes, edges: [] });

	it('finds file nodes that point at the target', () => {
		const res = findOccurrences('B.canvas', canvas([
			{ id: 'n1', type: 'file', file: 'Attachments/Big report.pdf', x: 0, y: 0, width: 1, height: 1, subpath: '#page=2' },
			{ id: 'n2', type: 'file', file: 'Attachments/Other.pdf' },
		]), 'canvas', TARGET);
		expect(res.ok && res.value.map((o) => [o.kind, o.nodeId])).toEqual([['canvas-file', 'n1']]);
	});

	it('treats a link in a text node as unsupported and an unreadable canvas as an error', () => {
		const res = findOccurrences('B.canvas', canvas([{ id: 't', type: 'text', text: 'see ![[Big report.pdf]]' }]), 'canvas', TARGET);
		expect(res.ok && res.value[0]).toMatchObject({ kind: 'unsupported', reason: 'canvas-text-node', nodeId: 't' });
		expect(findOccurrences('B.canvas', 'not json', 'canvas', TARGET)).toEqual({ ok: false, error: 'canvas-unreadable' });
		expect(findOccurrences('B.canvas', '[]', 'canvas', TARGET)).toEqual({ ok: false, error: 'canvas-unreadable' });
	});
});

// keep the type import used
export type _Unused = Occurrence;

describe('inline code inside a link label or alias', () => {
	it('keeps the text as written, so a rewrite never turns the label into blanks', () => {
		const text = 'See [`report` v2](Attachments/Big report.pdf) and [[Attachments/Big report.pdf|the `final` one]] here.';
		const res = findOccurrences('Notes/a.md', text, 'md', TARGET);
		if (!res.ok) throw new Error(res.error);
		const md = res.value.find((o) => o.kind === 'markdown-link');
		const wiki = res.value.find((o) => o.kind === 'wikilink');
		expect(md?.original).toBe('[`report` v2](Attachments/Big report.pdf)');
		expect(md?.display).toBe('`report` v2');
		expect(wiki?.original).toBe('[[Attachments/Big report.pdf|the `final` one]]');
		expect(wiki?.display).toBe('the `final` one');
		// Offsets still point at the whole link in the real text.
		for (const o of res.value) expect(text.slice(o.start, o.end)).toBe(o.original);
		const out = applyEdits(text, res.value.map((o) => ({ start: o.start, end: o.end, text: renderLink(o, INFO) })));
		expect(out).toContain('`report` v2');
		expect(out).toContain('the `final` one');
	});

	it('still ignores a link shown inside inline code', () => {
		const res = findOccurrences('Notes/a.md', 'Write `[[Attachments/Big report.pdf]]` to link it.', 'md', TARGET);
		expect(res).toEqual({ ok: true, value: [] });
	});
});
