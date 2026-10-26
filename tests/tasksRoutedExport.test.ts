/**
 * Routed export (GTD cluster B): the record's new states, grouped export with frozen targets and payloads, held items, and the
 * read-only status read-back. Legacy records and the legacy wire stay exactly as they were.
 */
import { describe, it, expect, vi } from 'vitest';
import { ok, err, type Result } from '../src/core/result';
import {
  applyExportResults, exportable, initialTaskState, isComplete, markReported, newApproval, pendingApprovals, type ApprovalRecord, type ApprovedTask,
} from '../src/services/inboxSweep/sweepLedger';
import { exportApproved, toWire, type ExportDeps } from '../src/services/inboxSweep/tasksExportService';
import { refreshTaskStatus, effectiveRemoteStatus, statusTargets, STATUS_STALE_AFTER_MS } from '../src/services/inboxSweep/tasksStatusService';
import { mergeExportStates, mergeStatusFields } from '../src/services/inboxSweep/sweepCommit';
import { exportStatusOf, exportResources, probeSweep } from '../src/services/inboxSweep/sweepOperations';
import { migrateOldSettings } from '../src/core/settings';
import type { ExportContext, TasksListConfig } from '../src/services/inboxSweep/tasksRouting';
import type { ScriptTransport } from '../src/services/appsScriptClient';

const URL_OK = 'https://script.google.com/macros/s/AKfycbxTEST/exec';
const id = (n: number): string => `aio-${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
const L = (listId: string, title = listId, needsDate = false): TasksListConfig => ({ id: listId, title, needsDate });

type Base = Omit<ApprovedTask, 'state'>;
const base = (n: number, over: Partial<Base> = {}): Base => ({ id: id(n), text: `Task ${n}`, context: '', sourcePath: `Inbox/n${n}.md`, sourceHash: `h${n}`, ...over });
const routed = (n: number, listId: string, over: Partial<Base> = {}): Base => base(n, { routingMode: 'routed', kind: 'next_action', destination: { type: 'list', listId }, ...over });
const record = (tasks: Base[]): ApprovalRecord => markReported(newApproval({ runId: 'run-aaaaaa', now: '2026-10-26T08:00:00Z', reportPath: 'R.md', tasks, dispositions: [] }));

describe('the record: legacy is untouched, routed tasks are born where an older plugin never acts', () => {
  it('a legacy task is created, serialised and promoted exactly as before (no new key anywhere)', () => {
    const r = newApproval({ runId: 'run-aaaaaa', now: 'T', reportPath: 'R.md', tasks: [base(1, { keys: ['k|w'] })], dispositions: [] });
    expect(JSON.parse(JSON.stringify(r.tasks[0]))).toEqual({ id: id(1), text: 'Task 1', context: '', sourcePath: 'Inbox/n1.md', sourceHash: 'h1', keys: ['k|w'], state: 'approved' });
    expect(markReported(r).tasks[0].state).toBe('reported');
  });

  it('routed tasks start routed (kept for report-only) and stay there when the report is written', () => {
    expect(initialTaskState({})).toBe('approved');
    expect(initialTaskState({ routingMode: 'routed', destination: { type: 'list', listId: 'L' } })).toBe('routed');
    expect(initialTaskState({ routingMode: 'routed', destination: { type: 'report-only' } })).toBe('kept');
    const r = record([routed(1, 'L'), routed(2, 'L', { destination: { type: 'report-only' } }), base(3)]);
    expect(r.tasks.map((t) => t.state)).toEqual(['routed', 'kept', 'reported']);
  });

  it('the previous plugin sends nothing for a routed record at any checkpoint (its own exportable, copied here)', () => {
    const previousExportable = (rec: ApprovalRecord): ApprovedTask[] => rec.tasks.filter((t) => t.state === 'reported' || (t.state === 'failed' && t.error !== 'conflict'));
    const justApproved = newApproval({ runId: 'run-aaaaaa', now: 'T', reportPath: 'R.md', tasks: [routed(1, 'L', { due: '2026-11-03' }), routed(2, 'L', { destination: { type: 'report-only' } })], dispositions: [] });
    const reported = markReported(justApproved);
    const retried = applyExportResults(reported, [{ exportId: id(1), status: 'error' }]);
    const frozen = { ...reported, tasks: reported.tasks.map((t) => ({ ...t, target: { listId: 'L' }, wire: { title: 'x', notes: 'y' } })) };
    for (const checkpoint of [justApproved, reported, retried, frozen]) expect(previousExportable(checkpoint)).toEqual([]);
    // this plugin does export the routed one, and never the kept one
    expect(exportable(reported).map((t) => t.id)).toEqual([id(1)]);
  });

  it('a routed task stays routed through every retryable outcome; only a confirmed result moves it; conflict is terminal', () => {
    const r = record([routed(1, 'L'), routed(2, 'L'), routed(3, 'L'), routed(4, 'L'), routed(5, 'L')]);
    const out = applyExportResults(r, [
      { exportId: id(1), status: 'created' }, { exportId: id(2), status: 'error' }, { exportId: id(3), status: 'retry' },
      { exportId: id(4), status: 'conflict' }, { exportId: id(5), status: 'target-conflict' },
    ]);
    expect(out.tasks.map((t) => [t.state, t.error])).toEqual([['exported', undefined], ['routed', 'export-failed'], ['routed', undefined], ['failed', 'conflict'], ['failed', 'conflict']]);
    expect(exportable(out).map((t) => t.id)).toEqual([id(2), id(3)]);
  });

  it('kept tasks count as finished; routed ones do not; pending approvals follow exportable', () => {
    const done = { ...record([routed(1, 'L', { destination: { type: 'report-only' } })]), ledgerDone: true };
    expect(isComplete(done)).toBe(true);
    const open = { ...record([routed(1, 'L')]), ledgerDone: true };
    expect(isComplete(open)).toBe(false);
    expect(pendingApprovals([done, open], true)).toEqual([open]);
  });

  it('merging an export into the live record carries the frozen target and payload of a routed task that stayed routed', () => {
    const live = record([routed(1, 'L')]);
    const incoming = { ...live, tasks: live.tasks.map((t) => ({ ...t, error: 'export-failed', target: { listId: 'L' }, wire: { title: 'T', notes: 'N' } })) };
    const merged = mergeExportStates(live, incoming);
    expect(merged.tasks[0]).toMatchObject({ state: 'routed', error: 'export-failed', target: { listId: 'L' }, wire: { title: 'T', notes: 'N' } });
    // a task the export did not reach keeps what it has now
    expect(mergeExportStates(live, { ...live }).tasks[0]).toEqual(live.tasks[0]);
  });

  it('the new task fields survive the settings migration, validated one by one', () => {
    const task = { id: id(1), text: 'x', context: '', sourcePath: 'a.md', sourceHash: 'h', state: 'routed', routingMode: 'routed', kind: 'waiting_for', destination: { type: 'list', listId: 'L' }, due: '2026-11-03', needsDateAtApproval: true, target: { listId: 'L' }, wire: { title: 'T', notes: 'N', due: '2026-11-03' }, projectId: 'p1', remoteStatus: 'completed', checkedAt: 5 };
    const rec = (t: unknown) => ({ runId: 'run-aaaaaa', createdAt: '2026-10-26', reportPath: 'R.md', tasks: [t], dispositions: [], reportDone: true, ledgerDone: true });
    const once = migrateOldSettings({ sweepApprovals: [rec(task)] } as never) as unknown as { sweepApprovals: Array<{ tasks: ApprovedTask[] }> };
    expect(once.sweepApprovals[0].tasks[0]).toMatchObject({ routingMode: 'routed', kind: 'waiting_for', destination: { type: 'list', listId: 'L' }, due: '2026-11-03', target: { listId: 'L' }, wire: { title: 'T', notes: 'N', due: '2026-11-03' }, projectId: 'p1', remoteStatus: 'completed', checkedAt: 5 });
    expect((migrateOldSettings(once as never) as unknown as typeof once).sweepApprovals[0].tasks[0]).toEqual(once.sweepApprovals[0].tasks[0]);
    const bad = migrateOldSettings({ sweepApprovals: [rec({ ...task, kind: 'nope', due: '2026-02-30', destination: { type: 'list', listId: '' }, target: { listId: '' }, wire: { title: 1 }, remoteStatus: 'x', checkedAt: -1 })] } as never) as unknown as typeof once;
    const t = bad.sweepApprovals[0].tasks[0] as Partial<ApprovedTask>;
    expect([t.kind, t.due, t.destination, t.target, t.wire, t.remoteStatus, t.checkedAt]).toEqual([undefined, undefined, undefined, undefined, undefined, undefined, undefined]);
    // a legacy task gains no key
    const legacy = migrateOldSettings({ sweepApprovals: [rec({ id: id(2), text: 'x', context: '', sourcePath: 'a.md', sourceHash: 'h', state: 'reported' })] } as never) as unknown as typeof once;
    expect(Object.keys(legacy.sweepApprovals[0].tasks[0]).sort()).toEqual(['context', 'error', 'id', 'sourceHash', 'sourcePath', 'state', 'text']);
  });
});

// ─── The export ─────────────────────────────────────────────────────────────

interface Sent { listId: string; tasks: Array<{ exportId: string; title: string; notes: string; due?: string }> }

function harness(over: Partial<ExportDeps> = {}, statusFor: (t: Sent['tasks'][number], listId: string) => string = () => 'created') {
  const sent: Sent[] = [];
  const events: string[] = [];
  const saved: ApprovalRecord[] = [];
  const transport: ScriptTransport = async ({ body }) => {
    const req = JSON.parse(body);
    sent.push({ listId: req.listId, tasks: req.tasks });
    events.push(`send:${req.listId}`);
    return { status: 200, text: JSON.stringify({ ok: true, results: req.tasks.map((t: Sent['tasks'][number]) => ({ exportId: t.exportId, status: statusFor(t, req.listId) })) }) };
  };
  const deps: ExportDeps = {
    url: URL_OK, secret: 'S', listId: 'main', transport, checkSource: async () => 'ok',
    persist: async (r) => { saved.push(r); events.push('persist'); return ok(undefined); }, ...over,
  };
  return { deps, sent, events, saved };
}
const routing = (over: Partial<ExportContext> = {}): ExportContext => ({ tasksListId: 'main', tasksLists: [L('main'), L('dated', 'Dated', true), L('home')], approvedListIds: ['main', 'dated', 'home'], scriptHasMultiList: true, ...over });

describe('exportApproved with routing', () => {
  it('groups by target list, in batches per list, with `due` only for a list that needs a date', async () => {
    const h = harness({ routing: routing() });
    const out = await exportApproved(record([routed(1, 'main'), routed(2, 'dated', { due: '2026-11-03' }), routed(3, 'home'), routed(4, 'main')]), h.deps);
    expect(h.sent.map((s) => [s.listId, s.tasks.map((t) => t.exportId)])).toEqual([['main', [id(1), id(4)]], ['dated', [id(2)]], ['home', [id(3)]]]);
    expect(h.sent[1].tasks[0].due).toBe('2026-11-03');
    expect(h.sent.flatMap((s) => s.tasks).filter((t) => t.due !== undefined)).toHaveLength(1);
    expect(out.summary).toMatchObject({ exported: 4, failed: 0, pending: 0 });
    expect(out.summary.held).toBeUndefined();
  });

  it('freezes the target and the payload and saves them BEFORE the first request', async () => {
    const h = harness({ routing: routing() });
    const out = await exportApproved(record([routed(1, 'dated', { due: '2026-11-03' })]), h.deps);
    expect(h.events[0]).toBe('persist');
    expect(h.events.indexOf('persist')).toBeLessThan(h.events.indexOf('send:dated'));
    expect(h.saved[0].tasks[0]).toMatchObject({ target: { listId: 'dated' }, wire: { title: 'Task 1', notes: 'From note: Inbox/n1.md', due: '2026-11-03' } });
    expect(out.record.tasks[0].state).toBe('exported');
  });

  it('replays the frozen payload unchanged, even after the list stopped needing a date', async () => {
    const frozen = record([routed(1, 'dated', { due: '2026-11-03' })]);
    const first = harness({ routing: routing() }, () => 'error');
    const afterFailure = (await exportApproved(frozen, first.deps)).record;
    expect(afterFailure.tasks[0]).toMatchObject({ state: 'routed', error: 'export-failed', wire: { due: '2026-11-03' } });
    // the user switches off "needs a date" and edits nothing else: the same bytes are sent
    const second = harness({ routing: routing({ tasksLists: [L('main'), L('dated', 'Dated', false), L('home')] }) });
    await exportApproved(afterFailure, second.deps);
    expect(second.sent[0].tasks[0]).toEqual({ exportId: id(1), title: 'Task 1', notes: 'From note: Inbox/n1.md', due: '2026-11-03' });
  });

  it('an older script approves only the main list: other lists are held (named, with a redeploy as the fix), the main list still flows, nothing is misfiled', async () => {
    const h = harness({ routing: routing({ approvedListIds: ['main'], scriptHasMultiList: false }) });
    const out = await exportApproved(record([routed(1, 'main'), routed(2, 'home'), base(3)]), h.deps);
    expect(h.sent.map((s) => s.listId)).toEqual(['main']);
    expect(h.sent[0].tasks.map((t) => t.exportId)).toEqual([id(1), id(3)]);
    expect(out.summary.held).toEqual([{ id: id(2), reason: 'tasks-script-lists-outdated' }]);
    expect(out.record.tasks[1]).toMatchObject({ state: 'routed' });
    expect(out.record.tasks[1].target).toBeUndefined();
    expect(out.summary.pending).toBe(1);
    // after the redeploy the held item goes to its own list, once
    const later = harness({ routing: routing() });
    const done = await exportApproved(out.record, later.deps);
    expect(later.sent.map((s) => [s.listId, s.tasks.map((t) => t.exportId)])).toEqual([['home', [id(2)]]]);
    expect(done.summary.pending).toBe(0);
  });

  it('a dated list holds a task without a date and sends nothing for it', async () => {
    const h = harness({ routing: routing() });
    const out = await exportApproved(record([routed(1, 'dated')]), h.deps);
    expect(h.sent).toEqual([]);
    expect(out.summary.held).toEqual([{ id: id(1), reason: 'tasks-due-missing' }]);
  });

  it('a report-only task is never sent, and a script that answers target-conflict makes the task a terminal conflict', async () => {
    const h = harness({ routing: routing() }, (t) => (t.exportId === id(2) ? 'target-conflict' : 'created'));
    const out = await exportApproved(record([routed(1, 'main', { destination: { type: 'report-only' } }), routed(2, 'main'), routed(3, 'main')]), h.deps);
    expect(h.sent[0].tasks.map((t) => t.exportId)).toEqual([id(2), id(3)]);
    expect(out.record.tasks.map((t) => [t.state, t.error])).toEqual([['kept', undefined], ['failed', 'conflict'], ['exported', undefined]]);
    expect(isComplete({ ...out.record, ledgerDone: true })).toBe(true);
  });

  it('the optional note link adds one obsidian:// line to the notes, and nothing when off', async () => {
    const on = harness({ routing: routing(), noteLink: (p) => `obsidian://open?vault=V&file=${encodeURIComponent(p)}` });
    await exportApproved(record([routed(1, 'main')]), on.deps);
    expect(on.sent[0].tasks[0].notes).toBe('From note: Inbox/n1.md\nobsidian://open?vault=V&file=Inbox%2Fn1.md');
    const off = harness({ routing: routing() });
    await exportApproved(record([routed(1, 'main')]), off.deps);
    expect(off.sent[0].tasks[0].notes).toBe('From note: Inbox/n1.md');
  });

  it('a persist failure before the first request stops the export with nothing sent', async () => {
    const h = harness({ routing: routing(), persist: async () => err<void>('write-failed') });
    const out = await exportApproved(record([routed(1, 'main')]), h.deps);
    expect(out.summary.error).toBe('write-failed');
    expect(h.sent).toEqual([]);
  });

  it('without routing the legacy path is untouched: one list, no due, today\'s wire bytes', async () => {
    const h = harness();
    await exportApproved(record([base(1, { context: '@home' }), base(2, { due: '2026-11-03' })]), h.deps);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].listId).toBe('main');
    expect(h.sent[0].tasks[0]).toEqual({ exportId: id(1), title: 'Task 1 @home', notes: 'From note: Inbox/n1.md' });
    // a stray `due` on a legacy task is not sent: the list never asked for one
    expect(h.sent[0].tasks[1]).toEqual({ exportId: id(2), title: 'Task 2', notes: 'From note: Inbox/n2.md' });
    expect(toWire(base(1, { context: '@home' }) as ApprovedTask)).toEqual({ exportId: id(1), title: 'Task 1 @home', notes: 'From note: Inbox/n1.md' });
  });
});

// ─── Completion read-back ───────────────────────────────────────────────────

describe('audit round 1 guards', () => {
  it('a routed task is exportable only after the report section is written', () => {
    const born = newApproval({ runId: 'run-aaaaaa', now: 'T', reportPath: 'R.md', tasks: [routed(1, 'L')], dispositions: [] });
    expect(born.reportDone).toBe(false);
    expect(exportable(born)).toEqual([]);
    expect(exportable(markReported(born)).map((t) => t.id)).toEqual([id(1)]);
  });

  it('without routing a routed task is never sent to the fallback list', async () => {
    const h = harness();
    const out = await exportApproved(record([routed(1, 'home'), base(2)]), h.deps);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].tasks.map((t) => t.exportId)).toEqual([id(2)]);
    expect(out.record.tasks[0].state).toBe('routed');
  });

  it('the approval-time date policy holds: a date that was required then is still sent, and a list that needs one now holds a task without it', async () => {
    const stillSent = harness({ routing: routing({ tasksLists: [L('main'), L('dated', 'Dated', false)] }) });
    await exportApproved(record([routed(1, 'dated', { due: '2026-11-03', needsDateAtApproval: true })]), stillSent.deps);
    expect(stillSent.sent[0].tasks[0].due).toBe('2026-11-03');
    // no date was needed at approval and none is invented now
    const noDate = harness({ routing: routing({ tasksLists: [L('main'), L('dated', 'Dated', false)] }) });
    await exportApproved(record([routed(2, 'dated', { needsDateAtApproval: false })]), noDate.deps);
    expect(noDate.sent[0].tasks[0].due).toBeUndefined();
    const nowNeeded = harness({ routing: routing() });
    const out = await exportApproved(record([routed(3, 'dated', { needsDateAtApproval: false })]), nowNeeded.deps);
    expect(nowNeeded.sent).toEqual([]);
    expect(out.summary.held).toEqual([{ id: id(3), reason: 'tasks-due-missing' }]);
  });

  it('a routed task whose attempt failed is counted as failed, not as waiting', async () => {
    const h = harness({ routing: routing() }, () => 'error');
    const out = await exportApproved(record([routed(1, 'main')]), h.deps);
    expect(out.summary).toMatchObject({ failed: 1, pending: 0, exported: 0 });
    expect(out.record.tasks[0]).toMatchObject({ state: 'routed', error: 'export-failed' });
  });

  it('a failed freeze checkpoint returns the record as it was durably, with nothing sent', async () => {
    const h = harness({ routing: routing(), persist: async () => err<void>('write-failed') });
    const start = record([routed(1, 'main')]);
    const out = await exportApproved(start, h.deps);
    expect(out.record).toBe(start);
    expect(out.record.tasks[0].target).toBeUndefined();
  });

  it('status goes to the list the tasks really went to: the frozen target, else the list stamped on the approval, else the main list', () => {
    const rec = { ...record([base(1), routed(2, 'home', { target: { listId: 'home' } })]), listId: 'oldmain' };
    const exportedRec = { ...rec, tasks: rec.tasks.map((t) => ({ ...t, state: 'exported' as const })) };
    expect([...statusTargets(exportedRec, 'newmain').keys()]).toEqual(['oldmain', 'home']);
    expect([...statusTargets({ ...exportedRec, listId: undefined }, 'newmain').keys()]).toEqual(['newmain', 'home']);
  });

  it('a frozen payload with an unusable date is dropped whole by the migration (and frozen again from the task), never half kept', () => {
    const rec = (wire: unknown) => ({ runId: 'run-aaaaaa', createdAt: '2026-10-26', reportPath: 'R.md', tasks: [{ id: id(1), text: 'x', context: '', sourcePath: 'a.md', sourceHash: 'h', state: 'routed', routingMode: 'routed', wire }], dispositions: [], reportDone: true, ledgerDone: true });
    type M = { sweepApprovals: Array<{ tasks: ApprovedTask[] }> };
    const bad = migrateOldSettings({ sweepApprovals: [rec({ title: 'T', notes: 'N', due: '2026-02-30' })] } as never) as unknown as M;
    expect(bad.sweepApprovals[0].tasks[0].wire).toBeUndefined();
    const good = migrateOldSettings({ sweepApprovals: [rec({ title: 'T', notes: 'N', due: '2026-11-03' })] } as never) as unknown as M;
    expect(good.sweepApprovals[0].tasks[0].wire).toEqual({ title: 'T', notes: 'N', due: '2026-11-03' });
    const noDue = migrateOldSettings({ sweepApprovals: [rec({ title: 'T', notes: 'N' })] } as never) as unknown as M;
    expect(noDue.sweepApprovals[0].tasks[0].wire).toEqual({ title: 'T', notes: 'N' });
  });
});

describe('refreshTaskStatus', () => {
  const exported = (tasks: Base[]): ApprovalRecord => ({ ...record(tasks), tasks: record(tasks).tasks.map((t) => ({ ...t, state: 'exported' as const })), ledgerDone: true });
  const NOW = 1_800_000_000_000;

  function statusHarness(answer: (req: { listId: string; items: Array<{ exportId: string }> }) => unknown) {
    const requests: Array<{ listId: string; items: Array<{ exportId: string }> }> = [];
    const saved: ApprovalRecord[] = [];
    const transport: ScriptTransport = async ({ body }) => {
      const req = JSON.parse(body);
      requests.push({ listId: req.listId, items: req.items });
      return { status: 200, text: JSON.stringify(answer(req)) };
    };
    const deps = { url: URL_OK, secret: 'S', transport, mainListId: 'main', now: () => NOW, persist: async (r: ApprovalRecord): Promise<Result<void>> => { saved.push(r); return ok(undefined); } };
    return { deps, requests, saved };
  }

  it('records completion, deletion and "still open", and changes nothing on a failure or an unknown receipt', async () => {
    const h = statusHarness((req) => ({ ok: true, results: req.items.map((i, n) => ({ exportId: i.exportId, ...[{ outcome: 'ok', status: 'completed' }, { outcome: 'ok', status: 'needsAction' }, { outcome: 'not-found' }, { outcome: 'error' }, { outcome: 'retry' }, { outcome: 'unknown-receipt' }][n] })) }));
    const prior = { remoteStatus: 'needsAction' as const, checkedAt: NOW - 1000 };
    const start = exported([base(1), base(2), base(3), base(4, prior), base(5, prior), base(6, prior)]);
    const out = await refreshTaskStatus(start, h.deps);
    if (!out.ok) throw new Error(out.error);
    expect(out.value.record.tasks.map((t) => [t.remoteStatus, t.checkedAt])).toEqual([
      ['completed', NOW], ['needsAction', NOW], ['deleted', NOW], ['needsAction', NOW - 1000], ['needsAction', NOW - 1000], ['needsAction', NOW - 1000],
    ]);
    expect(out.value.batch.items.map((i) => i.outcome)).toEqual(['ok', 'ok', 'not-found', 'error', 'retry', 'unknown-receipt']);
    expect(out.value.batch.errors.map((e) => e.source)).toEqual([id(4), id(5), id(6)]);
    expect(out.value.batch.isPartial).toBe(true);
    // only exportIds travel: the script finds the task from its own receipt
    expect(h.requests[0].items.every((i) => Object.keys(i).join() === 'exportId')).toBe(true);
  });

  it('asks per list in batches of 100, and only for exported tasks', async () => {
    const h = statusHarness((req) => ({ ok: true, results: req.items.map((i) => ({ exportId: i.exportId, outcome: 'ok', status: 'needsAction' })) }));
    const tasks = [...Array.from({ length: 250 }, (_, i) => base(i)), ...Array.from({ length: 3 }, (_, i) => routed(1000 + i, 'home', { target: { listId: 'home' } }))];
    const rec = exported(tasks);
    rec.tasks.push({ ...record([base(2000)]).tasks[0] }); // still reported: never asked about
    const out = await refreshTaskStatus(rec, h.deps);
    expect(out.ok).toBe(true);
    expect(h.requests.map((r) => [r.listId, r.items.length])).toEqual([['main', 100], ['main', 100], ['main', 50], ['home', 3]]);
    expect(h.saved).toHaveLength(4);
    expect([...statusTargets(rec, 'main').keys()]).toEqual(['main', 'home']);
  });

  it('a request-level failure is a typed error with what was already read kept; a bad answer is a bad response', async () => {
    const failing = statusHarness(() => ({ ok: false, error: { code: 'not-approved' } }));
    expect(await refreshTaskStatus(exported([base(1)]), failing.deps)).toEqual({ ok: false, error: 'script-not-approved' });
    const answers = [{ ok: true, results: [{ exportId: id(99), outcome: 'ok', status: 'completed' }] }, { ok: true, results: [{ exportId: id(1), outcome: 'ok' }] }, { ok: true, results: [{ exportId: id(1), outcome: 'weird' }] }, { ok: true, results: [] }, { ok: true }];
    for (const a of answers) expect(await refreshTaskStatus(exported([base(1)]), statusHarness(() => a).deps)).toEqual({ ok: false, error: 'script-bad-response' });
    const throwing = { ...statusHarness(() => ({})).deps, transport: (async () => { throw new Error('offline'); }) as ScriptTransport };
    expect((await refreshTaskStatus(exported([base(1)]), throwing)).ok).toBe(false);
  });

  it('a persist failure stops the refresh; a cancelled one is cancelled', async () => {
    const h = statusHarness((req) => ({ ok: true, results: req.items.map((i) => ({ exportId: i.exportId, outcome: 'ok', status: 'completed' })) }));
    expect(await refreshTaskStatus(exported([base(1)]), { ...h.deps, persist: async () => err<void>('write-failed') })).toEqual({ ok: false, error: 'write-failed' });
    const ctl = new AbortController();
    ctl.abort();
    expect(await refreshTaskStatus(exported([base(1)]), { ...h.deps, signal: ctl.signal })).toEqual({ ok: false, error: 'cancelled' });
  });

  it('an observation older than 7 days, or none, is unknown', () => {
    expect(effectiveRemoteStatus({ remoteStatus: 'completed', checkedAt: NOW - 1000 }, NOW)).toBe('completed');
    expect(effectiveRemoteStatus({ remoteStatus: 'completed', checkedAt: NOW - STATUS_STALE_AFTER_MS - 1 }, NOW)).toBe('unknown');
    expect(effectiveRemoteStatus({}, NOW)).toBe('unknown');
    expect(effectiveRemoteStatus({ remoteStatus: 'needsAction' }, NOW)).toBe('unknown');
  });

  it('merging a status read into the live record touches only the status fields of exported tasks', () => {
    const live = exported([base(1), base(2)]);
    const read = { ...live, tasks: live.tasks.map((t, i) => ({ ...t, text: 'CHANGED', remoteStatus: 'completed' as const, checkedAt: 5 + i })) };
    const merged = mergeStatusFields(live, read);
    expect(merged.tasks.map((t) => [t.text, t.remoteStatus, t.checkedAt])).toEqual([['Task 1', 'completed', 5], ['Task 2', 'completed', 6]]);
    expect(mergeStatusFields(undefined, read)).toBe(read);
  });
});

// ─── The operation summary of an export ─────────────────────────────────────

describe('sweep export operation summaries', () => {
  it('the approval record decides the status: done, needs attention for a failed or stuck task, else running', () => {
    expect(exportStatusOf({ ...record([base(1)]), ledgerDone: true, tasks: record([base(1)]).tasks.map((t) => ({ ...t, state: 'exported' as const })) })).toBe('done');
    expect(exportStatusOf(record([base(1)]))).toBe('running');
    expect(exportStatusOf(applyExportResults(record([base(1)]), [{ exportId: id(1), status: 'error' }]))).toBe('needs-attention');
    expect(exportStatusOf(applyExportResults(record([routed(1, 'L')]), [{ exportId: id(1), status: 'error' }]))).toBe('needs-attention');
    expect(exportResources({ ...record([base(1, { projectId: 'p1' }), base(2)]) })).toEqual(['sweep-record', 'project:p1']);
  });

  it('the probe reads the record: missing is orphaned, present reports its status', async () => {
    const rec = record([base(1)]);
    const probe = probeSweep({ settings: { sweepApprovals: [rec] } } as never);
    const summary = { opId: 'op-run-aaaaaa', kind: 'sweep-export', status: 'running', createdAt: 1, updatedAt: 1, device: 'd', recovery: { journal: 'sweep', key: 'run-aaaaaa' } } as never;
    expect(await probe(summary)).toMatchObject({ state: 'found', status: 'running' });
    expect(await probeSweep({ settings: { sweepApprovals: [] } } as never)(summary)).toEqual({ state: 'missing' });
  });
});

void vi;
