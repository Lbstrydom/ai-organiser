import { describe, it, expect, vi } from 'vitest';
import { classifyTasksScript, exportApproved, fetchTaskLists, pingTasksScript, type ExportDeps, type SourceCheck } from '../src/services/inboxSweep/tasksExportService';
import { ok as okResult, err as errResult } from '../src/core/result';
import { markReported, newApproval, type ApprovalRecord } from '../src/services/inboxSweep/sweepLedger';
import { approvedListHashOf } from '../src/services/inboxSweep/tasksScriptTemplate';
import type { ScriptTransport } from '../src/services/appsScriptClient';

const URL_OK = 'https://script.google.com/macros/s/AKfycbxTEST/exec';
const id = (n: number): string => `aio-${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
const reply = (body: unknown): ScriptTransport => async () => ({ status: 200, text: JSON.stringify(body) });

function record(count: number): ApprovalRecord {
	const tasks = Array.from({ length: count }, (_, i) => ({ id: id(i), text: `Task ${i}`, context: i % 2 ? '@home' : '', sourcePath: `Inbox/n${i}.md`, sourceHash: `h${i}` }));
	return markReported(newApproval({ runId: 'run-1', now: 'T', reportPath: 'R.md', tasks, dispositions: [] }));
}

function deps(over: Partial<ExportDeps> = {}): ExportDeps & { saved: ApprovalRecord[] } {
	const saved: ApprovalRecord[] = [];
	return {
		url: URL_OK,
		secret: 'S',
		listId: 'ListId_42',
		checkSource: async () => 'ok',
		persist: async (r) => { saved.push(r); return okResult(undefined); },
		saved,
		...over,
	};
}

describe('ping, lists and script state', () => {
	it('reads a ping and a list answer, and rejects malformed ones', async () => {
		const ping = await pingTasksScript({ url: URL_OK, secret: 'S', transport: reply({ ok: true, scriptVersion: 1, approvedListId: 'L', listHash: 'h' }) });
		expect(ping).toEqual({ ok: true, value: { scriptVersion: 1, approvedListId: 'L', listHash: 'h' } });
		const setup = await pingTasksScript({ url: URL_OK, secret: 'S', transport: reply({ ok: true, scriptVersion: 1, approvedListId: null, listHash: 'h' }) });
		expect(setup.ok && setup.value.approvedListId).toBeNull();
		expect(await pingTasksScript({ url: URL_OK, secret: 'S', transport: reply({ ok: true }) })).toEqual({ ok: false, error: 'script-bad-response' });
		const lists = await fetchTaskLists({ url: URL_OK, secret: 'S', transport: reply({ ok: true, lists: [{ id: 'a', title: 'Inbox' }] }) });
		expect(lists).toEqual({ ok: true, value: [{ id: 'a', title: 'Inbox' }] });
		expect(await fetchTaskLists({ url: URL_OK, secret: 'S', transport: reply({ ok: true, lists: [{ id: 5 }] }) })).toEqual({ ok: false, error: 'script-bad-response' });
		expect(await fetchTaskLists({ url: URL_OK, secret: 'S', transport: reply({ ok: false, error: { code: 'tasks-service-off' } }) })).toEqual({ ok: false, error: 'script-tasks-off' });
	});

	it('stays "setup" until the operational script is live for the chosen list', async () => {
		const ping = async (approvedListId: string | null, version = 1, hash?: string) => ({ scriptVersion: version, approvedListId, listHash: hash ?? (await approvedListHashOf(approvedListId)) });
		expect(await classifyTasksScript(await ping(null), 'L')).toBe('setup');
		expect(await classifyTasksScript(await ping('L'), 'L')).toBe('operational');
		expect(await classifyTasksScript(await ping('L'), 'Other')).toBe('list-mismatch');
		expect(await classifyTasksScript(await ping('L'), null)).toBe('list-mismatch');
		expect(await classifyTasksScript(await ping('L', 0), 'L')).toBe('outdated');
		expect(await classifyTasksScript(await ping('L', 1, 'wrong'), 'L')).toBe('outdated');
	});
});

describe('exportApproved', () => {
	it('sends reported items in order with their ids, marks them exported and saves after each batch', async () => {
		const sent: unknown[] = [];
		const transport: ScriptTransport = async ({ body }) => {
			const req = JSON.parse(body);
			sent.push(req);
			return { status: 200, text: JSON.stringify({ ok: true, results: req.tasks.map((t: { exportId: string }) => ({ exportId: t.exportId, status: 'created' })) }) };
		};
		const d = deps({ transport });
		const out = await exportApproved(record(3), d);
		expect(out.summary).toMatchObject({ exported: 3, failed: 0, pending: 0, blocked: [] });
		expect(out.record.tasks.every((t) => t.state === 'exported')).toBe(true);
		const req = sent[0] as { op: string; listId: string; secret: string; tasks: Array<{ exportId: string; title: string; notes: string }> };
		expect(req).toMatchObject({ op: 'upsert', listId: 'ListId_42', secret: 'S' });
		expect(req.tasks[1]).toEqual({ exportId: id(1), title: 'Task 1 @home', notes: 'From note: Inbox/n1.md' });
		expect(d.saved).toHaveLength(1);
	});

	it('splits into batches of 25', async () => {
		const sizes: number[] = [];
		const transport: ScriptTransport = async ({ body }) => {
			const req = JSON.parse(body);
			sizes.push(req.tasks.length);
			return { status: 200, text: JSON.stringify({ ok: true, results: req.tasks.map((t: { exportId: string }) => ({ exportId: t.exportId, status: 'created' })) }) };
		};
		const d = deps({ transport });
		const out = await exportApproved(record(60), d);
		expect(sizes).toEqual([25, 25, 10]);
		expect(out.summary.exported).toBe(60);
		expect(d.saved).toHaveLength(3);
	});

	it('resends only the items the script asked to retry', async () => {
		const calls: string[][] = [];
		let first = true;
		const transport: ScriptTransport = async ({ body }) => {
			const req = JSON.parse(body);
			calls.push(req.tasks.map((t: { exportId: string }) => t.exportId));
			const results = req.tasks.map((t: { exportId: string }, i: number) => ({ exportId: t.exportId, status: first && i === 1 ? 'retry' : 'created' }));
			first = false;
			return { status: 200, text: JSON.stringify({ ok: true, results }) };
		};
		const out = await exportApproved(record(3), deps({ transport }));
		expect(calls).toEqual([[id(0), id(1), id(2)], [id(1)]]);
		expect(out.summary).toMatchObject({ exported: 3, pending: 0 });
	});

	it('keeps unfinished items reported when a request fails, and says why', async () => {
		const transport: ScriptTransport = async () => ({ status: 200, text: JSON.stringify({ ok: false, error: { code: 'auth' } }) });
		const out = await exportApproved(record(2), deps({ transport }));
		expect(out.summary).toMatchObject({ error: 'script-auth', exported: 0, pending: 2 });
		expect(out.record.tasks.map((t) => t.state)).toEqual(['reported', 'reported']);
	});

	it('rejects an answer it cannot read instead of assuming success', async () => {
		const out = await exportApproved(record(1), deps({ transport: reply({ ok: true, results: [{ exportId: id(0), status: 'weird' }] }) }));
		expect(out.summary.error).toBe('script-bad-response');
		expect(out.record.tasks[0].state).toBe('reported');
	});

	it('blocks an item whose source is now excluded, missing or changed, and sends the rest', async () => {
		const checks: Record<string, SourceCheck> = { 'Inbox/n0.md': 'excluded', 'Inbox/n1.md': 'ok', 'Inbox/n2.md': 'missing', 'Inbox/n3.md': 'changed' };
		const sent: string[][] = [];
		const transport: ScriptTransport = async ({ body }) => {
			const req = JSON.parse(body);
			sent.push(req.tasks.map((t: { exportId: string }) => t.exportId));
			return { status: 200, text: JSON.stringify({ ok: true, results: req.tasks.map((t: { exportId: string }) => ({ exportId: t.exportId, status: 'created' })) }) };
		};
		const out = await exportApproved(record(4), deps({ transport, checkSource: async (t) => checks[t.sourcePath] }));
		expect(sent).toEqual([[id(1)]]);
		expect(out.summary.blocked).toEqual([{ id: id(0), reason: 'excluded' }, { id: id(2), reason: 'missing' }, { id: id(3), reason: 'changed' }]);
		expect(out.summary.exported).toBe(1);
		expect(out.record.tasks[0].state).toBe('reported'); // blocked items stay waiting
	});

	it('treats a conflict as final and an error as retryable on the next run', async () => {
		const transport = reply({ ok: true, results: [{ exportId: id(0), status: 'conflict' }, { exportId: id(1), status: 'error' }] });
		const out = await exportApproved(record(2), deps({ transport }));
		expect(out.record.tasks.map((t) => [t.state, t.error])).toEqual([['failed', 'conflict'], ['failed', 'export-failed']]);
		expect(out.summary.failed).toBe(2);
	});

	it('stops, and says why, when the record cannot be saved', async () => {
		const transport: ScriptTransport = async ({ body }) => {
			const req = JSON.parse(body);
			return { status: 200, text: JSON.stringify({ ok: true, results: req.tasks.map((t: { exportId: string }) => ({ exportId: t.exportId, status: 'created' })) }) };
		};
		const out = await exportApproved(record(60), deps({ transport, persist: async () => errResult('write-failed') }));
		expect(out.summary.error).toBe('write-failed');
		expect(out.record.tasks.filter((t) => t.state === 'exported')).toHaveLength(25); // no batch after the failed save
	});

	it('sends nothing when nothing is exportable, and stops when cancelled', async () => {
		const transport = vi.fn<ScriptTransport>();
		const empty = await exportApproved(markReported(newApproval({ runId: 'r', now: 'T', reportPath: 'R.md', tasks: [], dispositions: [] })), deps({ transport }));
		expect(transport).not.toHaveBeenCalled();
		expect(empty.summary.exported).toBe(0);
		const ctl = new AbortController();
		ctl.abort();
		const cancelled = await exportApproved(record(2), deps({ transport, signal: ctl.signal }));
		expect(cancelled.summary.error).toBe('cancelled');
		expect(transport).not.toHaveBeenCalled();
	});
});
