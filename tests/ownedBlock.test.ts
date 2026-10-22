import { describe, it, expect } from 'vitest';
import { findMarkedBlock, replaceMarkedBlock, type BlockMarkers } from '../src/utils/ownedBlock';

const M: BlockMarkers = { start: '<!-- aio:x -->', end: '<!-- /aio:x -->', nestedPrefixes: ['<!-- aio:x', '<!-- /aio:x'] };
const block = `${M.start}\nbody\n${M.end}`;

describe('findMarkedBlock', () => {
	it('finds nothing in a note without markers', () => {
		expect(findMarkedBlock('# Just text', M)).toEqual({ ok: true, value: null });
	});

	it('finds the exact span', () => {
		const text = `before\n${block}\nafter`;
		const res = findMarkedBlock(text, M);
		expect(res.ok && res.value && text.slice(res.value.start, res.value.end)).toBe(block);
	});

	it.each([
		['duplicate start', `${M.start}\n${block}`],
		['duplicate block', `${block}\n${block}`],
		['missing end', block.replace(M.end, '')],
		['missing start', block.replace(M.start, '')],
		['end before start', `${M.end}\n${M.start}`],
		['nested', `${M.start}\n<!-- aio:x2 -->\n${M.end}`],
	])('reports a conflict for %s', (_n, text) => {
		expect(findMarkedBlock(text, M)).toEqual({ ok: false, error: 'marker-conflict' });
	});

	it('ignores markers in fenced code and frontmatter, and markers that are not alone on their line', () => {
		expect(findMarkedBlock('```\n' + block + '\n```', M)).toEqual({ ok: true, value: null });
		expect(findMarkedBlock(`---\nnote: ${M.start}\n---\nbody`, M)).toEqual({ ok: true, value: null });
		expect(findMarkedBlock(`see ${M.start} and ${M.end} in prose`, M)).toEqual({ ok: true, value: null });
	});

	it('recognises a fenced example inside a list item', () => {
		expect(findMarkedBlock('- item\n  ```\n  ' + M.start + '\n  ' + M.end + '\n  ```\n', M)).toEqual({ ok: true, value: null });
	});
});

describe('replaceMarkedBlock', () => {
	it('appends once, keeping the user\'s text, and is idempotent', () => {
		const first = replaceMarkedBlock('# Mine\n\nWords.\n', block, M);
		expect(first).toEqual({ ok: true, value: `# Mine\n\nWords.\n\n${block}\n` });
		if (!first.ok) return;
		expect(replaceMarkedBlock(first.value, block, M)).toEqual(first);
	});

	it('never trims or rewrites the user\'s own text when it appends', () => {
		const mine = '# Mine\n\nWords.   \n\n\n';
		expect(replaceMarkedBlock(mine, block, M)).toEqual({ ok: true, value: `${mine}${block}\n` });
		expect(replaceMarkedBlock('no newline at all', block, M)).toEqual({ ok: true, value: `no newline at all\n\n${block}\n` });
		expect(replaceMarkedBlock('one newline\n', block, M)).toEqual({ ok: true, value: `one newline\n\n${block}\n` });
	});

	it('replaces only the block, byte for byte', () => {
		const note = `Intro\n\n${M.start}\nold\n${M.end}\n\nOutro\n`;
		expect(replaceMarkedBlock(note, block, M)).toEqual({ ok: true, value: `Intro\n\n${block}\n\nOutro\n` });
	});

	it('writes into an empty note without leading blank lines', () => {
		expect(replaceMarkedBlock('', block, M)).toEqual({ ok: true, value: `${block}\n` });
	});

	it('refuses to append after an unclosed fence and on a damaged block', () => {
		expect(replaceMarkedBlock('# Hub\n\n```\nnever closed\n', block, M)).toEqual({ ok: false, error: 'marker-conflict' });
		expect(replaceMarkedBlock(`${block}\n${block}`, block, M)).toEqual({ ok: false, error: 'marker-conflict' });
	});

	it('round-trips: an appended block is found and replaced', () => {
		const added = replaceMarkedBlock('# Hub\n', block, M);
		if (!added.ok) throw new Error('first');
		expect(findMarkedBlock(added.value, M).ok).toBe(true);
		const next = `${M.start}\nnew\n${M.end}`;
		const res = replaceMarkedBlock(added.value, next, M);
		expect(res.ok && res.value).toContain('new');
		expect(res.ok && res.value).not.toContain('body');
	});
});

describe('notes saved with Windows line endings', () => {
	const CR = String.fromCharCode(13);
	const crlf = (text: string): string => text.split('\n').join(CR + '\n');

	it('treats a marker inside a fenced code block as example text, as it does with plain line endings', () => {
		const note = crlf(['# Hub', '', '```', M.start, M.end, '```', ''].join('\n'));
		expect(findMarkedBlock(note, M)).toEqual({ ok: true, value: null });
	});

	it('refuses to append after an unclosed fence, and finds a real block next to a fenced example', () => {
		expect(replaceMarkedBlock(crlf('# Hub\n\n```\nnever closed\n'), block, M)).toEqual({ ok: false, error: 'marker-conflict' });
		const note = crlf(['```', M.start, '```', '', M.start, 'body', M.end, ''].join('\n'));
		const found = findMarkedBlock(note, M);
		expect(found.ok && found.value?.text.startsWith(M.start)).toBe(true);
	});
});
