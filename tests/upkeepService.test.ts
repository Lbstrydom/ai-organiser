import { describe, it, expect, vi } from 'vitest';
import {
	deriveStatus, executeTasks, makeContext, proposalFingerprint, reviewCount, selectedTasks, shouldNotify, toStored,
	type ExecutionPolicy, type UpkeepConfigSnapshot,
} from '../src/services/upkeep/upkeepService';
import type { IndexCheck, TaskOutcome, UpkeepEnv } from '../src/services/upkeep/upkeepTasks';
import { ok, err } from '../src/core/result';

vi.stubGlobal('window', globalThis);

const stale: IndexCheck = { added: 1, removed: 0, changed: 0, unreadable: 0, unstable: false, scopeChanged: false, missing: false, fresh: false };
const all = { agentIndex: true, inventories: true, attachments: true };
const config = (over: Partial<UpkeepConfigSnapshot> = {}): UpkeepConfigSnapshot => ({
	tasks: all, available: all, task: { autoRefreshIndex: false, includeDuplicates: false, largeBytes: 1000 }, ...over,
});
const policy: ExecutionPolicy = { allowIndexPublish: false, retainResult: true, notify: true };

function env(over: Partial<UpkeepEnv> = {}): UpkeepEnv {
	return {
		checkIndex: async () => ok(stale),
		refreshIndex: async () => ok({ path: 'idx.jsonl' }),
		checkInventories: async () => ok([{ pairId: 'p1', hubPath: 'Hub.md', changed: true }]),
		scanAttachments: async () => ok({ attachments: [{ path: 'A/o.pdf', sizeBytes: 5000, referenceCount: 0, unreferenced: true }], notes: ['N/o.md'], duplicates: [] }),
		...over,
	};
}
const ctxFor = (cap = 60_000) => makeContext(cap, () => Date.now(), new AbortController().signal);

describe('executeTasks', () => {
	it('runs the selected tasks in order and gathers proposals with exact totals', async () => {
		const run = await executeTasks(config(), policy, 'manual', env(), ctxFor());
		expect(run.summary.status).toBe('ok');
		expect(run.summary.outcomes.map((o) => [o.task, o.status])).toEqual([['agentIndex', 'ok'], ['inventories', 'ok'], ['attachments', 'ok']]);
		expect(run.summary.totals).toEqual({ 'agent-index-stale': 1, 'inventory-differs': 1, 'attachment-unreferenced': 1, 'attachment-large': 1 });
		expect(run.proposals).toHaveLength(4);
		expect(reviewCount(run.summary)).toBe(4);
	});

	it('runs only the tasks that are selected', async () => {
		const checkInventories = vi.fn(async () => ok([]));
		const run = await executeTasks(config({ tasks: { agentIndex: true, inventories: false, attachments: false } }), policy, 'manual', env({ checkInventories }), ctxFor());
		expect(selectedTasks(config({ tasks: { agentIndex: false, inventories: false, attachments: true } }))).toEqual(['attachments']);
		expect(run.summary.outcomes.map((o) => o.task)).toEqual(['agentIndex']);
		expect(checkInventories).not.toHaveBeenCalled(); // no network call unless the Drive check is selected
	});

	it('skips a task whose feature is off, and says so', async () => {
		const run = await executeTasks(config({ available: { agentIndex: true, inventories: false, attachments: true } }), policy, 'manual', env(), ctxFor());
		expect(run.summary.outcomes[1]).toMatchObject({ task: 'inventories', status: 'skipped', reason: 'upkeep-task-unavailable' });
		expect(run.summary.status).toBe('partial');
	});

	it('a thrown error is a failed task, and the others still run', async () => {
		const run = await executeTasks(config(), policy, 'manual', env({ checkInventories: async () => { throw new Error('boom'); } }), ctxFor());
		expect(run.summary.outcomes.map((o) => o.status)).toEqual(['ok', 'failed', 'ok']);
		expect(run.summary.outcomes[1].reason).toBe('upkeep-task-failed');
		expect(run.summary.status).toBe('partial');
	});

	it('is failed when every selected task failed, even with zero proposals', async () => {
		const fail = async () => err('script-network');
		const run = await executeTasks(config(), policy, 'manual', env({ checkIndex: fail as never, checkInventories: fail as never, scanAttachments: fail as never }), ctxFor());
		expect(run.summary.status).toBe('failed');
		expect(reviewCount(run.summary)).toBe(0);
	});

	it('marks tasks it never reached as cancelled when the cap has passed', async () => {
		const run = await executeTasks(config(), policy, 'manual', env(), ctxFor(-1));
		expect(run.summary.outcomes.every((o) => o.status === 'cancelled')).toBe(true);
		expect(run.summary.status).toBe('partial');
	});

	it('ends a task cancelled when the operation reports cancellation', async () => {
		const ctl = new AbortController();
		const run = await executeTasks(config(), policy, 'manual', env({ checkInventories: async () => { ctl.abort(); return err('cancelled'); } }), makeContext(60_000, () => Date.now(), ctl.signal));
		expect(run.summary.outcomes.map((o) => o.status)).toEqual(['ok', 'cancelled', 'cancelled']);
	});

	it('the index is refreshed only when the opt-in and the policy both allow it', async () => {
		const refresh = vi.fn(async () => ok({ path: 'idx.jsonl' }));
		const e = env({ refreshIndex: refresh });
		const on = config({ task: { autoRefreshIndex: true, includeDuplicates: false, largeBytes: 1000 } });
		const preview = await executeTasks(on, { allowIndexPublish: false, retainResult: false, notify: false }, 'preview', e, ctxFor());
		expect(refresh).not.toHaveBeenCalled();
		expect(preview.proposals.some((p) => p.kind === 'agent-index-stale')).toBe(true);
		const real = await executeTasks(on, { ...policy, allowIndexPublish: true }, 'manual', e, ctxFor());
		expect(refresh).toHaveBeenCalledTimes(1);
		expect(real.proposals.some((p) => p.kind === 'agent-index-refreshed')).toBe(true);
	});
});

describe('status and announcements', () => {
	const outcome = (status: TaskOutcome['status']): TaskOutcome => ({ task: 'agentIndex', status, counts: {}, omitted: 0 });

	it('derives the overall status', () => {
		expect(deriveStatus([outcome('ok'), outcome('ok')])).toBe('ok');
		expect(deriveStatus([outcome('ok'), outcome('failed')])).toBe('partial');
		expect(deriveStatus([outcome('failed'), outcome('failed')])).toBe('failed');
		expect(deriveStatus([outcome('ok'), outcome('skipped')])).toBe('partial');
		expect(deriveStatus([outcome('cancelled')])).toBe('partial');
		expect(deriveStatus([])).toBe('failed');
	});

	it('announces a scheduled run with new proposals once, stays quiet for an unchanged backlog, and flags a failure', async () => {
		const run = await executeTasks(config(), policy, 'scheduled', env(), ctxFor());
		const key = proposalFingerprint(run.summary, run.proposals);
		expect(shouldNotify(run.summary, '', policy, run.proposals)).toEqual({ notify: true, kind: 'proposals' });
		expect(shouldNotify(run.summary, key, policy, run.proposals)).toEqual({ notify: false, kind: 'none' });
		expect(shouldNotify(run.summary, '', { ...policy, notify: false }, run.proposals)).toEqual({ notify: false, kind: 'none' });
		// Different proposals with the same counts are a change.
		const swapped = run.proposals.map((p) => (p.kind === 'attachment-unreferenced' ? { ...p, path: 'A/other.pdf' } : p));
		expect(proposalFingerprint(run.summary, swapped)).not.toBe(key);
		expect(proposalFingerprint(run.summary, [...run.proposals].reverse())).toBe(key); // order does not matter
		const failed = await executeTasks(config(), policy, 'scheduled', env({ checkIndex: async () => err('scan-incomplete'), checkInventories: async () => err('script-network'), scanAttachments: async () => err('scan-incomplete') }), ctxFor());
		expect(shouldNotify(failed.summary, '', policy)).toEqual({ notify: true, kind: 'failure' });
	});

	it('stays quiet when a run found nothing', async () => {
		const run = await executeTasks(config(), policy, 'scheduled', env({ checkIndex: async () => ok({ ...stale, fresh: true }), checkInventories: async () => ok([]), scanAttachments: async () => ok({ attachments: [], notes: [], duplicates: [] }) }), ctxFor());
		expect(run.summary.status).toBe('ok');
		expect(shouldNotify(run.summary, '', policy).notify).toBe(false);
	});

	it('stores at most 200 items and says how many were left out', () => {
		const proposals = Array.from({ length: 300 }, (_, i) => ({ kind: 'attachment-unreferenced' as const, path: `A/${i}.pdf`, sizeBytes: 1 }));
		const stored = toStored({ summary: { startedAt: '', durationMs: 0, trigger: 'manual', outcomes: [], totals: {}, status: 'ok' }, proposals });
		expect(stored.items).toHaveLength(200);
		expect(stored.omitted).toBe(100);
		// What a task already left out is carried along, so the report never under-counts.
		const outcomes = [{ task: 'attachments' as const, status: 'ok' as const, counts: {}, omitted: 7 }];
		const withTask = toStored({ summary: { startedAt: '', durationMs: 0, trigger: 'manual', outcomes, totals: {}, status: 'ok' }, proposals: proposals.slice(0, 250) });
		expect(withTask.omitted).toBe(50 + 7);
	});
});
