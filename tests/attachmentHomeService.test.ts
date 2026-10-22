import { describe, it, expect, vi } from 'vitest';
import {
	suggestHomes,
	rankByTitleOverlap,
	titleTokens,
	alreadyLinks,
	appendAttachmentLink,
	HOME_QUERY_CHARS,
	type HomeContext,
} from '../src/services/attachmentHomeService';

const notes = ['Garden/Tomato growing.md', 'Garden/Soil notes.md', 'Finance/Tax 2025.md', 'Courses/Live/Week 3.md', 'Chats/log.md'];

function ctx(over: Partial<HomeContext> = {}): HomeContext {
	return {
		protectedFolders: [],
		markdownPaths: () => notes,
		isAllowed: (p) => !p.startsWith('Chats/'),
		readText: async () => null,
		embeddingIsExternal: false,
		...over,
	};
}

describe('titleTokens / rankByTitleOverlap', () => {
	it('lower-cases, splits on punctuation, drops short and stop words', () => {
		expect([...titleTokens('The Tomato-growing PDF of 2025!')].sort()).toEqual(['2025', 'growing', 'tomato']);
	});

	it('works for non-Latin and accented text', () => {
		expect(titleTokens('Écoles été').has('écoles')).toBe(true);
		expect(titleTokens('番茄 种植指南').size).toBeGreaterThan(0);
	});

	it('ranks notes by how much of their name appears in the attachment', () => {
		const ranked = rankByTitleOverlap('tomato growing guide.pdf', '', notes);
		expect(ranked[0].path).toBe('Garden/Tomato growing.md');
		expect(ranked.every((r) => r.score > 0)).toBe(true);
	});

	it('returns nothing when there is no overlap', () => {
		expect(rankByTitleOverlap('zzz.pdf', 'qqq', notes)).toEqual([]);
	});
});

describe('suggestHomes (basic match)', () => {
	it('returns up to three allowed notes, best first, with no egress', async () => {
		const search = vi.fn();
		const res = await suggestHomes(ctx({ semanticSearch: undefined }), 'Docs/tomato growing guide.pdf');
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.value.method).toBe('basic');
		expect(res.value.candidates[0].path).toBe('Garden/Tomato growing.md');
		expect(res.value.candidates.length).toBeLessThanOrEqual(3);
		expect(search).not.toHaveBeenCalled();
	});

	it('never offers a note from a disallowed folder', async () => {
		const res = await suggestHomes(ctx(), 'log chats.pdf');
		expect(res.ok && res.value.candidates.some((c) => c.path.startsWith('Chats/'))).toBe(false);
	});

	it('marks protected notes so they show as not linkable', async () => {
		const res = await suggestHomes(ctx({ protectedFolders: ['Courses/Live'] }), 'week 3 slides.pdf');
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		const week = res.value.candidates.find((c) => c.path === 'Courses/Live/Week 3.md');
		expect(week?.protected).toBe(true);
	});

	it('returns an empty list rather than failing when nothing matches', async () => {
		const res = await suggestHomes(ctx(), 'zzz.pdf');
		expect(res).toEqual({ ok: true, value: { candidates: [], method: 'basic', egressDeclined: false } });
	});
});

describe('suggestHomes (semantic)', () => {
	const longText = 'tomato '.repeat(500);

	it('uses only the first 1,000 characters of the text as the query', async () => {
		const search = vi.fn(async () => ['Garden/Soil notes.md', 'Garden/Tomato growing.md', 'Chats/log.md']);
		const res = await suggestHomes(ctx({ readText: async () => longText, semanticSearch: search }), 'x.pdf');
		expect(search).toHaveBeenCalledTimes(1);
		expect((search.mock.calls[0] as unknown as [string, number])[0].length).toBe(HOME_QUERY_CHARS);
		expect(res.ok && res.value.method).toBe('semantic');
		expect(res.ok && res.value.candidates.map((c) => c.path)).toEqual(['Garden/Soil notes.md', 'Garden/Tomato growing.md']);
	});

	it('asks before sending text to an external embedding provider and falls back when declined', async () => {
		const search = vi.fn(async () => ['Garden/Soil notes.md']);
		const confirm = vi.fn(async () => false);
		const res = await suggestHomes(
			ctx({ readText: async () => longText, semanticSearch: search, embeddingIsExternal: true, confirmEgress: confirm }),
			'tomato growing.pdf',
		);
		expect(confirm).toHaveBeenCalledTimes(1);
		expect(search).not.toHaveBeenCalled();
		expect(res.ok && res.value.method).toBe('basic');
		expect(res.ok && res.value.egressDeclined).toBe(true);
	});

	it('sends the text when the user agrees', async () => {
		const search = vi.fn(async () => ['Garden/Soil notes.md']);
		const res = await suggestHomes(
			ctx({ readText: async () => longText, semanticSearch: search, embeddingIsExternal: true, confirmEgress: async () => true }),
			'x.pdf',
		);
		expect(search).toHaveBeenCalled();
		expect(res.ok && res.value.method).toBe('semantic');
	});

	it('does not ask for a local embedding provider', async () => {
		const confirm = vi.fn(async () => false);
		await suggestHomes(ctx({ readText: async () => longText, semanticSearch: async () => [], embeddingIsExternal: false, confirmEgress: confirm }), 'x.pdf');
		expect(confirm).not.toHaveBeenCalled();
	});

	it('falls back to the basic match when semantic search finds nothing allowed', async () => {
		const res = await suggestHomes(ctx({ readText: async () => 'tomato', semanticSearch: async () => ['Chats/log.md'] }), 'tomato growing.pdf');
		expect(res.ok && res.value.method).toBe('basic');
	});

	it('does not send anything when there is no text', async () => {
		const search = vi.fn(async () => []);
		await suggestHomes(ctx({ readText: async () => '   ', semanticSearch: search, embeddingIsExternal: true, confirmEgress: async () => true }), 'x.pdf');
		expect(search).not.toHaveBeenCalled();
	});

	it('returns an error result instead of throwing', async () => {
		const res = await suggestHomes(ctx({ readText: async () => { throw new Error('boom'); } }), 'x.pdf');
		expect(res.ok).toBe(false);
	});
});

describe('alreadyLinks', () => {
	const f = 'Docs/Scan 1.pdf';
	const resolveToF = (linktext: string) => (linktext.toLowerCase() === 'scan 1.pdf' ? f : null);

	it('matches the full path with subpaths and aliases, without needing a resolver', () => {
		for (const text of ['![[Docs/Scan 1.pdf]]', '![[Docs/Scan 1.pdf#page=2]]', '![[Docs/Scan 1.pdf|alias]]', '[[ docs/scan 1.PDF ]]']) {
			expect(alreadyLinks(text, f), text).toBe(true);
		}
	});

	it('does not treat a bare name as proof without resolving it', () => {
		expect(alreadyLinks('![[Scan 1.pdf]]', f)).toBe(false);
	});

	it('accepts a bare name only when it resolves, from the note, to this very file', () => {
		expect(alreadyLinks('![[Scan 1.pdf]]', f, resolveToF)).toBe(true);
		expect(alreadyLinks('![[Scan 1.pdf]]', f, () => 'Other/Scan 1.pdf')).toBe(false);
		expect(alreadyLinks('![[Scan 1.pdf]]', f, () => null)).toBe(false);
	});

	it('does not match a different file or a partial name', () => {
		expect(alreadyLinks('![[Scan 10.pdf]] ![[Other/Scan 1.pdfx]]', f, resolveToF)).toBe(false);
	});

	it('ignores links inside fenced code', () => {
		expect(alreadyLinks('```\n![[Docs/Scan 1.pdf]]\n```', f)).toBe(false);
	});
});

describe('appendAttachmentLink', () => {
	const f = 'Docs/a.pdf';

	it('creates the heading at the end when missing', () => {
		const res = appendAttachmentLink('Body text\n', f, 'Attachments');
		expect(res).toEqual({ ok: true, value: { content: 'Body text\n\n## Attachments\n![[Docs/a.pdf]]\n', info: 'heading-created' } });
	});

	it('works on an empty note', () => {
		expect(appendAttachmentLink('', f, 'Attachments')).toEqual({ ok: true, value: { content: '## Attachments\n![[Docs/a.pdf]]\n', info: 'heading-created' } });
	});

	it('appends under an existing heading at any level, case-insensitively, before the next same-level heading', () => {
		const note = '# T\n\n### attachments\n![[x.png]]\n\n### Other\ntext\n';
		const res = appendAttachmentLink(note, f, 'Attachments');
		expect(res.ok && res.value.content).toBe('# T\n\n### attachments\n![[x.png]]\n![[Docs/a.pdf]]\n\n### Other\ntext\n');
	});

	it('is idempotent: an existing link leaves the content unchanged', () => {
		const note = '## Attachments\n![[Docs/a.pdf]]\n';
		const res = appendAttachmentLink(note, f, 'Attachments');
		expect(res).toEqual({ ok: true, value: { content: note, info: 'already-linked' } });
	});

	it('is idempotent for a bare-name link that resolves to the same file', () => {
		const note = '## Attachments\n![[a.pdf]]\n';
		const res = appendAttachmentLink(note, f, 'Attachments', (l) => (l === 'a.pdf' ? f : null));
		expect(res.ok && res.value.info).toBe('already-linked');
	});

	it('adds the link when a same-named file in another folder is the one already linked', () => {
		const note = '## Attachments\n![[a.pdf]]\n';
		const res = appendAttachmentLink(note, f, 'Attachments', () => 'Other/a.pdf');
		expect(res.ok && res.value.content).toContain('![[Docs/a.pdf]]');
	});

	it('does not mistake a heading inside a fenced code block for the real heading', () => {
		const note = '```\n## Attachments\n```\n\nBody\n';
		const res = appendAttachmentLink(note, f, 'Attachments');
		expect(res.ok && res.value.content).toBe('```\n## Attachments\n```\n\nBody\n\n## Attachments\n![[Docs/a.pdf]]\n');
	});

	it('does not end the section at a heading-like line inside a fence', () => {
		const note = '## Attachments\n![[x.png]]\n```\n# not a heading\n```\n![[y.png]]\n\n## Other\n';
		const res = appendAttachmentLink(note, f, 'Attachments');
		expect(res.ok && res.value.content).toBe('## Attachments\n![[x.png]]\n```\n# not a heading\n```\n![[y.png]]\n![[Docs/a.pdf]]\n\n## Other\n');
	});

	it('treats the heading text literally (no regex surprises)', () => {
		const res = appendAttachmentLink('x', f, 'Files (new)');
		expect(res.ok && res.value.content).toContain('## Files (new)');
	});
});
