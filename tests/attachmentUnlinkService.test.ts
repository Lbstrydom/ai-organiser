import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/services/noteEdit/applyNoteEdit', () => ({ applyNoteEdit: vi.fn() }));

import { applyNoteEdit } from '../src/services/noteEdit/applyNoteEdit';
import { err, ok } from '../src/core/result';
import {
	planLinkRemoval,
	removeLinks,
	isLinkRemovalEnabled,
	type NotePlan,
} from '../src/services/attachmentUnlinkService';

const FILE = 'Rec/meeting.m4a';
const resolve = (linktext: string): string | null => (linktext === 'meeting.m4a' || linktext === 'Rec/meeting.m4a' ? FILE : linktext === 'other.m4a' ? 'Other/other.m4a' : null);

function planOf(text: string) {
	const res = planLinkRemoval(text, FILE, 'Notes/a.md', resolve);
	if (res.status !== 'ok') throw new Error('expected a plan, got ' + res.status);
	return res.plan;
}

describe('planLinkRemoval', () => {
	it('removes a wiki embed and drops the line it leaves empty', () => {
		const plan = planOf('# T\n![[meeting.m4a]]\nnext');
		expect(plan.nextText).toBe('# T\nnext');
		expect(plan.changes).toEqual([{ line: 2, before: '![[meeting.m4a]]', after: null }]);
	});

	it('removes embeds with a size or alias part', () => {
		expect(planOf('a ![[meeting.m4a|200]] b').nextText).toBe('a  b');
	});

	it('removes a markdown embed', () => {
		expect(planOf('![rec](meeting.m4a)\ntext').nextText).toBe('text');
	});

	it('keeps the display text of an alias link, a markdown link, and the file name of a bare link', () => {
		expect(planOf('See [[meeting.m4a|the recording]] now').nextText).toBe('See the recording now');
		expect(planOf('See [the recording](meeting.m4a) now').nextText).toBe('See the recording now');
		expect(planOf('See [[Rec/meeting.m4a]] now').nextText).toBe('See meeting.m4a now');
	});

	it('handles several references on one line and on several lines', () => {
		const plan = planOf('![[meeting.m4a]] and [[meeting.m4a|x]]\n\n![[meeting.m4a]]');
		expect(plan.nextText).toBe(' and x\n');
		expect(plan.changes).toHaveLength(2);
	});

	it('leaves a link to a same-named file elsewhere alone (resolved from the note\'s own folder)', () => {
		const sameName = (linktext: string, source: string): string | null => (linktext === 'x.m4a' ? (source.startsWith('A/') ? 'A/x.m4a' : 'B/x.m4a') : null);
		expect(planLinkRemoval('![[x.m4a]]', 'B/x.m4a', 'A/note.md', sameName).status).toBe('nothing');
		const ok = planLinkRemoval('![[x.m4a]]', 'B/x.m4a', 'B/note.md', sameName);
		expect(ok.status).toBe('ok');
		expect(planLinkRemoval('![[other.m4a]]', FILE, 'Notes/a.md', resolve).status).toBe('nothing');
	});

	it('rewrites by position: identical text elsewhere on the line, or one form inside another, is never touched', () => {
		// The bare link text is a substring of the embed text; replacing by text would corrupt the embed.
		expect(planOf('![[meeting.m4a]] and [[meeting.m4a]]').nextText).toBe(' and meeting.m4a');
		expect(planOf('[[meeting.m4a]] then ![[meeting.m4a]]').nextText).toBe('meeting.m4a then ');
	});

	it('leaves a reference written inside inline code alone, and says so when it is the only one', () => {
		expect(planOf('real ![[meeting.m4a]] and `![[meeting.m4a]]`').nextText).toBe('real  and `![[meeting.m4a]]`');
		expect(planLinkRemoval('write `![[meeting.m4a]]` to embed', FILE, 'Notes/a.md', resolve).status).toBe('not-removable');
	});

	it('does not treat an escaped backtick as the start of a code span', () => {
		// \` is a literal backtick: the embed after it is a real link, and the later backtick closes nothing.
		expect(planOf('cost \\` then ![[meeting.m4a]] and `code`').nextText).toBe('cost \\` then  and `code`');
		// A properly opened span still protects its content.
		expect(planOf('![[meeting.m4a]] `a ![[meeting.m4a]] b`').nextText).toBe(' `a ![[meeting.m4a]] b`');
	});

	it('treats a code span that crosses a line break as code', () => {
		expect(planLinkRemoval('see `start\n![[meeting.m4a]] end` after', FILE, 'Notes/a.md', resolve).status).toBe('not-removable');
		// A blank line ends the paragraph, so an unclosed backtick does not reach the next one.
		expect(planOf('open `tick\n\n![[meeting.m4a]]').nextText).toBe('open `tick\n');
	});

	it('lists the extra blank line it drops, so the approved plan covers every edit', () => {
		const plan = planOf('para\n\n![[meeting.m4a]]\n\nnext');
		expect(plan.nextText).toBe('para\n\nnext');
		expect(plan.changes).toEqual([
			{ line: 3, before: '![[meeting.m4a]]', after: null },
			{ line: 4, before: '', after: null },
		]);
	});

	it('measures list structure inside a blockquote like outside one', () => {
		expect(planOf('> - ![[meeting.m4a]]\n>   - child\n> - three').nextText).toBe('> - \n>   - child\n> - three');
		expect(planOf('> - one\n> - ![[meeting.m4a]]\n> - three').nextText).toBe('> - one\n> - three');
	});

	it('drops a list item that is left empty when it has no children', () => {
		expect(planOf('- one\n- ![[meeting.m4a]]\n- three').nextText).toBe('- one\n- three');
		expect(planOf('- [ ] ![[meeting.m4a]]\n- three').nextText).toBe('- three');
	});

	it('keeps the marker of an emptied list item that still has children or a continuation', () => {
		const plan = planOf('- ![[meeting.m4a]]\n  - child\n- three');
		expect(plan.nextText).toBe('- \n  - child\n- three');
	});

	it('keeps the remaining text of a list item', () => {
		expect(planOf('- Call ![[meeting.m4a]]').nextText).toBe('- Call ');
	});

	it('does not leave two blank lines in a row when a standalone embed is dropped', () => {
		expect(planOf('para\n\n![[meeting.m4a]]\n\nnext').nextText).toBe('para\n\nnext');
	});

	it('never edits frontmatter or fenced code, and says so', () => {
		const onlyCode = planLinkRemoval('---\nrec: "![[meeting.m4a]]"\n---\n```\n![[meeting.m4a]]\n```\n', FILE, 'Notes/a.md', resolve);
		expect(onlyCode.status).toBe('not-removable');
		const mixed = planOf('![[meeting.m4a]]\n```\n![[meeting.m4a]]\n```');
		expect(mixed.nextText).toBe('```\n![[meeting.m4a]]\n```');
	});

	it('keeps CRLF line endings', () => {
		const plan = planOf('a\r\n![[meeting.m4a]]\r\nb\r\n');
		expect(plan.nextText).toBe('a\r\nb\r\n');
	});

	it('reports nothing when the note does not reference the file', () => {
		expect(planLinkRemoval('plain', FILE, 'Notes/a.md', resolve).status).toBe('nothing');
	});

	it('ignores external links', () => {
		expect(planLinkRemoval('[x](https://e.com/meeting.m4a)', FILE, 'Notes/a.md', resolve).status).toBe('nothing');
	});
});

// ---- removeLinks ---------------------------------------------------------

const apply = vi.mocked(applyNoteEdit);

type Batch = Awaited<ReturnType<typeof removeLinks>>;
/** The written notes and the others, as "path:status" in the order the plans were given. */
function flat(res: Batch, order: string[]): string[] {
	if (!res.ok) return ['error:' + res.error];
	const written = new Set(res.value.items.map((i) => i.notePath));
	const failed = new Map(res.value.errors.map((e) => [e.source, e.error]));
	return order.map((p) => p + ':' + (written.has(p) ? 'written' : failed.get(p) ?? 'missing'));
}

function plugin(over: { allow?: boolean; feature?: boolean } = {}) {
	return {
		settings: {
			attachmentAllowLinkRemoval: over.allow ?? true,
			featureFlags: { 'embed-scan': over.feature ?? true },
		},
		app: { metadataCache: { getFirstLinkpathDest: (l: string) => (resolve(l) ? { path: FILE } : null) } },
	} as never;
}

/** A fake note store: applyNoteEdit runs the target's recompute against the live text, as the real one does at commit. */
function fakeStore(live: Record<string, string>, protectedPaths: string[] = []) {
	apply.mockImplementation(async (_p, target) => {
		if (protectedPaths.includes(target.filePath)) return err('protected-path');
		if (target.kind !== 'composite') return err('failed');
		const out = target.recompute(live[target.filePath]);
		if (!out.ok) return err(out.error);
		live[target.filePath] = out.value.content;
		return ok(undefined);
	});
}

describe('removeLinks', () => {
	beforeEach(() => { apply.mockReset(); });

	const planFor = (path: string, text: string): NotePlan => {
		const res = planLinkRemoval(text, FILE, path, resolve);
		if (res.status !== 'ok') throw new Error('no plan');
		return res.plan;
	};

	it('writes the approved plan through applyNoteEdit without a second review', async () => {
		const live = { 'Notes/a.md': 'x\n![[meeting.m4a]]\ny' };
		fakeStore(live);
		const res = await removeLinks(plugin(), FILE, [planFor('Notes/a.md', live['Notes/a.md'])]);
		expect(res).toEqual({ ok: true, value: { items: [{ notePath: 'Notes/a.md', status: 'written' }], errors: [], warnings: [], isPartial: false } });
		expect(live['Notes/a.md']).toBe('x\ny');
		expect(apply.mock.calls[0][2]).toEqual({ review: false });
	});

	it('refuses, writing nothing, when the capability is off (setting or feature)', async () => {
		fakeStore({});
		expect(await removeLinks(plugin({ allow: false }), FILE, [])).toEqual({ ok: false, error: 'link-removal-off' });
		expect(await removeLinks(plugin({ feature: false }), FILE, [planFor('N.md', '![[meeting.m4a]]')])).toEqual({ ok: false, error: 'link-removal-off' });
		expect(apply).not.toHaveBeenCalled();
	});

	it('writes nothing when a link was added after the preview (plan no longer equal)', async () => {
		const approved = '![[meeting.m4a]]\ntext';
		const live = { 'Notes/a.md': '![[meeting.m4a]]\ntext\nlater ![[meeting.m4a]]' };
		fakeStore(live);
		const res = await removeLinks(plugin(), FILE, [planFor('Notes/a.md', approved)]);
		expect(flat(res, ['Notes/a.md'])).toEqual(['Notes/a.md:stale']);
		expect(live['Notes/a.md']).toContain('later ![[meeting.m4a]]');
	});

	it('writes nothing when the link moved or was re-aliased after the preview', async () => {
		const approved = 'a\n![[meeting.m4a]]';
		const live = { 'Notes/a.md': '![[meeting.m4a]]\na' };
		fakeStore(live);
		const res = await removeLinks(plugin(), FILE, [planFor('Notes/a.md', approved)]);
		expect(flat(res, ['Notes/a.md'])).toEqual(['Notes/a.md:stale']);
		expect(live['Notes/a.md']).toBe('![[meeting.m4a]]\na');
	});

	it('writes nothing when the link is already gone', async () => {
		const live = { 'Notes/a.md': 'nothing here' };
		fakeStore(live);
		const res = await removeLinks(plugin(), FILE, [planFor('Notes/a.md', '![[meeting.m4a]]')]);
		expect(flat(res, ['Notes/a.md'])).toEqual(['Notes/a.md:stale']);
	});

	it('handles several notes, and stops at the first one that is not written without rolling back', async () => {
		const live = { 'A.md': '![[meeting.m4a]]', 'B.md': '![[meeting.m4a]]', 'C.md': '![[meeting.m4a]]' };
		fakeStore(live, ['B.md']);
		const plans = ['A.md', 'B.md', 'C.md'].map((p) => planFor(p, live[p as keyof typeof live]));
		const res = await removeLinks(plugin(), FILE, plans);
		expect(flat(res, ['A.md', 'B.md', 'C.md'])).toEqual(['A.md:written', 'B.md:refused-protected', 'C.md:skipped']);
		expect(res.ok && res.value.isPartial).toBe(true);
		expect(live['A.md']).toBe('');
		expect(live['C.md']).toBe('![[meeting.m4a]]');
	});

	it('stops before the next note when asked to (modal closed), after the one in flight', async () => {
		const live = { 'A.md': '![[meeting.m4a]]', 'B.md': '![[meeting.m4a]]' };
		fakeStore(live);
		let calls = 0;
		const res = await removeLinks(plugin(), FILE, ['A.md', 'B.md'].map((p) => planFor(p, live[p as keyof typeof live])), {
			shouldContinue: () => calls++ === 0,
		});
		expect(flat(res, ['A.md', 'B.md'])).toEqual(['A.md:written', 'B.md:skipped']);
		expect(live['B.md']).toBe('![[meeting.m4a]]');
	});

	it('checks the capability before EVERY note: switching it off mid-job stops the next write', async () => {
		const live = { 'A.md': '![[meeting.m4a]]', 'B.md': '![[meeting.m4a]]' };
		fakeStore(live);
		const p = plugin() as unknown as { settings: { attachmentAllowLinkRemoval: boolean } };
		apply.mockImplementationOnce(async (_p, target) => {
			p.settings.attachmentAllowLinkRemoval = false; // the user switches it off while note A is being written
			if (target.kind !== 'composite') return err('failed');
			const out = target.recompute(live['A.md']);
			if (!out.ok) return err(out.error);
			live['A.md'] = out.value.content;
			return ok(undefined);
		});
		const res = await removeLinks(p as never, FILE, ['A.md', 'B.md'].map((n) => planFor(n, live[n as keyof typeof live])));
		expect(flat(res, ['A.md', 'B.md'])).toEqual(['A.md:written', 'B.md:skipped']);
		expect(live['B.md']).toBe('![[meeting.m4a]]');
	});

	it('a callback that throws stops the job instead of escaping', async () => {
		const live = { 'A.md': '![[meeting.m4a]]' };
		fakeStore(live);
		const res = await removeLinks(plugin(), FILE, [planFor('A.md', live['A.md'])], { shouldContinue: () => { throw new Error('boom'); } });
		expect(flat(res, ['A.md'])).toEqual(['A.md:skipped']);
		expect(live['A.md']).toBe('![[meeting.m4a]]');
	});

	it('maps a thrown write to failed instead of rejecting', async () => {
		apply.mockRejectedValue(new Error('disk'));
		const res = await removeLinks(plugin(), FILE, [planFor('A.md', '![[meeting.m4a]]')]);
		expect(flat(res, ['A.md'])).toEqual(['A.md:failed']);
	});
});

describe('isLinkRemovalEnabled', () => {
	it('needs Find embeds on AND the setting on, and fails closed on anything else', () => {
		const on = { featureFlags: { 'embed-scan': true }, attachmentAllowLinkRemoval: true };
		expect(isLinkRemovalEnabled(on as never)).toBe(true);
		expect(isLinkRemovalEnabled({ ...on, attachmentAllowLinkRemoval: false } as never)).toBe(false);
		expect(isLinkRemovalEnabled({ ...on, attachmentAllowLinkRemoval: 'true' } as never)).toBe(false);
		expect(isLinkRemovalEnabled({ ...on, attachmentAllowLinkRemoval: undefined } as never)).toBe(false);
		expect(isLinkRemovalEnabled({ ...on, featureFlags: { 'embed-scan': false } } as never)).toBe(false);
	});
});
