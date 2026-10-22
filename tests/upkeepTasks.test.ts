import { describe, it, expect, vi } from 'vitest';
import {
	clip, collect, MAX_DETAIL_CHARS, runAgentIndexTask, runAttachmentsTask, runInventoriesTask, suggestLinks, tokensOf,
	type AttachmentFinding, type IndexCheck, type InventoryCheck, type Proposal, type RunContext, type TaskConfig, type UpkeepEnv,
} from '../src/services/upkeep/upkeepTasks';
import { ok, err } from '../src/core/result';

vi.stubGlobal('window', globalThis);

const ctx = (over: Partial<RunContext> = {}): RunContext => ({ signal: new AbortController().signal, deadline: Infinity, now: () => 0, ...over });
const config: TaskConfig = { autoRefreshIndex: false, includeDuplicates: false, largeBytes: 1000 };
const stale: IndexCheck = { added: 1, removed: 0, changed: 2, unreadable: 0, unstable: false, scopeChanged: false, missing: false, fresh: false };

function env(over: Partial<UpkeepEnv> = {}): UpkeepEnv {
	return {
		checkIndex: async () => ok({ ...stale, fresh: true, added: 0, changed: 0 }),
		refreshIndex: async () => ok({ path: '.ai-organiser/agent-index.jsonl' }),
		checkInventories: async () => ok([]),
		scanAttachments: async () => ok({ attachments: [], notes: [], duplicates: [] }),
		...over,
	};
}

describe('collect (bounded results)', () => {
	const many: Proposal[] = Array.from({ length: 250 }, (_, i) => ({ kind: 'attachment-unreferenced', path: `A/${String(i).padStart(3, '0')}.pdf`, sizeBytes: i }));

	it('keeps exact totals and an omitted count when it truncates, in a deterministic order', () => {
		const out = collect([...many].reverse(), 100);
		expect(out.proposals).toHaveLength(100);
		expect(out.omitted).toBe(150);
		expect(out.totals['attachment-unreferenced']).toBe(250);
		expect(out.proposals[0]).toMatchObject({ path: 'A/000.pdf' });
		expect(collect(many, 100).proposals).toEqual(out.proposals);
	});

	it('groups by kind and counts each', () => {
		const out = collect([{ kind: 'inventory-differs', pairId: 'p', hubPath: 'H.md' }, ...many.slice(0, 3)]);
		expect(out.totals).toEqual({ 'inventory-differs': 1, 'attachment-unreferenced': 3 });
		expect(out.omitted).toBe(0);
	});

	it('limits free-text detail', () => {
		expect(clip('x'.repeat(500))).toHaveLength(MAX_DETAIL_CHARS);
		expect(clip('short')).toBe('short');
	});
});

describe('agent index task', () => {
	it('proposes nothing for a fresh index', async () => {
		const res = await runAgentIndexTask(env(), config, true, ctx());
		expect(res).toMatchObject({ ok: true, value: { proposals: [], omitted: 0 } });
	});

	it('proposes a stale index with the counts, and does not publish by default', async () => {
		const refresh = vi.fn();
		const res = await runAgentIndexTask(env({ checkIndex: async () => ok(stale), refreshIndex: refresh }), config, true, ctx());
		expect(res.ok && res.value.proposals).toEqual([{ kind: 'agent-index-stale', added: 1, removed: 0, changed: 2, unreadable: 0, unstable: false }]);
		expect(refresh).not.toHaveBeenCalled();
	});

	it('refreshes the index only when the opt-in, the policy and the clock all allow it', async () => {
		const refresh = vi.fn(async () => ok({ path: 'idx.jsonl' }));
		const e = env({ checkIndex: async () => ok(stale), refreshIndex: refresh });
		const on = { ...config, autoRefreshIndex: true };
		const done = await runAgentIndexTask(e, on, true, ctx());
		expect(done.ok && done.value.proposals).toEqual([{ kind: 'agent-index-refreshed', path: 'idx.jsonl' }]);
		expect(refresh).toHaveBeenCalledTimes(1);
		await runAgentIndexTask(e, on, false, ctx()); // the policy forbids it (a setup dry run)
		await runAgentIndexTask(e, on, true, ctx({ deadline: -1 })); // the cap has passed
		expect(refresh).toHaveBeenCalledTimes(1);
	});

	it('passes a failed check through as a failure', async () => {
		expect(await runAgentIndexTask(env({ checkIndex: async () => err('scan-incomplete') }), config, true, ctx())).toEqual({ ok: false, error: 'scan-incomplete' });
	});
});

describe('inventories task', () => {
	const pair = (id: string, changed: boolean, failed?: string): InventoryCheck => ({ pairId: id, hubPath: `${id}.md`, changed, failed });

	it('proposes only the pairs that differ', async () => {
		const res = await runInventoriesTask(env({ checkInventories: async () => ok([pair('a', false), pair('b', true)]) }), ctx());
		expect(res.ok && res.value.proposals).toEqual([{ kind: 'inventory-differs', pairId: 'b', hubPath: 'b.md' }]);
	});

	it('a pair that could not be read fails the task: it never reads as unchanged', async () => {
		const res = await runInventoriesTask(env({ checkInventories: async () => ok([pair('a', false), pair('b', false, 'script-network')]) }), ctx());
		expect(res).toEqual({ ok: false, error: 'script-network' });
	});
});

describe('attachments task', () => {
	const att = (path: string, sizeBytes: number, referenceCount: number, unreferenced: boolean): AttachmentFinding => ({ path, sizeBytes, referenceCount, unreferenced });

	it('proposes unreferenced and large files, never duplicates unless asked', async () => {
		const scan = async () => ok({ attachments: [att('A/big.pdf', 5000, 2, false), att('A/old.png', 10, 0, true), att('A/huge-orphan.pdf', 9000, 0, true)], notes: [], duplicates: [['A/x.png', 'A/y.png']] });
		const res = await runAttachmentsTask(env({ scanAttachments: scan }), config, ctx());
		const kinds = res.ok ? res.value.proposals.map((p) => p.kind).sort() : [];
		expect(kinds).toEqual(['attachment-large', 'attachment-large', 'attachment-unreferenced', 'attachment-unreferenced']);
		const withDup = await runAttachmentsTask(env({ scanAttachments: scan }), { ...config, includeDuplicates: true }, ctx());
		expect(withDup.ok && withDup.value.proposals.some((p) => p.kind === 'attachment-duplicate')).toBe(true);
	});

	it('reports the true number of link suggestions even though only 50 are kept', async () => {
		const attachments = Array.from({ length: 80 }, (_, i) => ({ path: `F/alpha-beta-${String(i).padStart(3, '0')}.pdf`, sizeBytes: 1, referenceCount: 0, unreferenced: true }));
		const res = await runAttachmentsTask(env({ scanAttachments: async () => ok({ attachments, notes: ['N/Alpha beta.md'], duplicates: [] }) }), config, ctx());
		expect(res.ok && res.value.totals['link-suggestion']).toBe(80);
		expect(res.ok && res.value.totals['attachment-unreferenced']).toBe(80);
		// 80 unreferenced + 50 kept suggestions are cut to 100 items by the per-check cap; every cut is counted.
		expect(res.ok && res.value.proposals).toHaveLength(100);
		expect(res.ok && res.value.omitted).toBe(30 + 30);
	});

	it('ends cancelled, not ok, when the run is stopped during the link pass', async () => {
		let polls = 0;
		// Not stopped when the link pass starts; stopped by the time it has run.
		const stoppedLater = ctx({ now: () => (polls++ < 1 ? 0 : 1e12), deadline: 1e6 });
		const attachments = [{ path: 'F/alpha-beta.pdf', sizeBytes: 1, referenceCount: 0, unreferenced: true }];
		const res = await runAttachmentsTask(env({ scanAttachments: async () => ok({ attachments, notes: ['N/Alpha beta.md'], duplicates: [] }) }), config, stoppedLater);
		expect(res).toEqual({ ok: false, error: 'cancelled' });
	});

	it('passes a failed scan through', async () => {
		expect(await runAttachmentsTask(env({ scanAttachments: async () => err('scan-incomplete') }), config, ctx())).toEqual({ ok: false, error: 'scan-incomplete' });
	});
});

describe('the basic title-word matcher', () => {
	it('tokenises names: lower-case words, no tiny tokens, no stop words, no extension', () => {
		expect(tokensOf('Garden Plan (final) 2026.pdf')).toEqual(['garden', 'plan', '2026']);
		expect(tokensOf('IMG_0001.png')).toEqual(['0001']);
	});

	it('needs two shared tokens, or the only token when it is long', async () => {
		const { items: out } = await suggestLinks(
			['Files/garden-plan.pdf', 'Files/budget.pdf', 'Files/xy.pdf', 'Files/notes.pdf'],
			['Projects/Garden plan 2026.md', 'Projects/Budget overview.md', 'Misc/Plan.md'],
			ctx(),
		);
		expect(out).toEqual([
			{ kind: 'link-suggestion', attachmentPath: 'Files/garden-plan.pdf', notePath: 'Projects/Garden plan 2026.md', evidence: ['garden', 'plan'] },
			{ kind: 'link-suggestion', attachmentPath: 'Files/budget.pdf', notePath: 'Projects/Budget overview.md', evidence: ['budget'] },
		]);
	});

	it('picks the best note, then the smallest path, and proposes one note per attachment', async () => {
		const { items: out } = await suggestLinks(['F/garden-plan-2026.pdf'], ['B/Garden plan.md', 'A/Garden plan.md', 'C/Garden plan 2026.md'], ctx());
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({ notePath: 'C/Garden plan 2026.md' });
		const tie = (await suggestLinks(['F/garden-plan.pdf'], ['B/Garden plan.md', 'A/Garden plan.md'], ctx())).items;
		expect(tie[0]).toMatchObject({ notePath: 'A/Garden plan.md' });
	});

	it('caps the suggestions at 50 and stops when the run is stopped', async () => {
		const attachments = Array.from({ length: 80 }, (_, i) => `F/alpha-beta-${String(i).padStart(3, '0')}.pdf`);
		const notes = ['N/Alpha beta.md'];
		const full = await suggestLinks(attachments, notes, ctx());
		expect(full.items).toHaveLength(50);
		expect(full.total).toBe(80); // the totals count every match, not just the kept ones
		const ctl = new AbortController();
		ctl.abort();
		const many = Array.from({ length: 1000 }, (_, i) => `N/Alpha beta ${i}.md`);
		expect(await suggestLinks(attachments, many, ctx({ signal: ctl.signal }))).toEqual({ items: [], total: 0 });
		expect(await suggestLinks(['F/alpha-beta.pdf'], notes, ctx({ signal: ctl.signal }))).toEqual({ items: [], total: 0 }); // checked at entry, even for tiny input
	});

	it('works from an inverted index: many notes and attachments finish quickly', async () => {
		const notes = Array.from({ length: 3000 }, (_, i) => `N/note-${i}-topic${i % 50}.md`);
		const attachments = Array.from({ length: 500 }, (_, i) => `F/file-${i}-topic${i % 50}.pdf`);
		const start = Date.now();
		await suggestLinks(attachments, notes, ctx());
		expect(Date.now() - start).toBeLessThan(5000);
	});
});
