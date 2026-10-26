/**
 * The Google script builder: the v1 Tasks script is pinned byte for byte, and the v2 tasks module (several lists, the export
 * binding, read-only status) is run against a fake Tasks service.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { buildTasksScript } from '../src/services/inboxSweep/tasksScriptTemplate';
import { MAX_STATUS_ITEMS, TASKS_V2_CAPABILITIES, approvedListsHashOf, buildTasksScriptV2, tasksModuleConfig, tasksScriptChoice } from '../src/services/googleScript/googleScriptBuilder';

describe('standalone v1 text is unchanged (pinned by a stored copy)', () => {
  it('matches the stored operational and setup scripts byte for byte', () => {
    expect(buildTasksScript({ secret: 'S3CRET', approvedListId: 'LIST_ONE' })).toBe(fs.readFileSync('tests/fixtures/tasksScriptV1.operational.txt', 'utf8'));
    expect(buildTasksScript({ secret: 'S3CRET', approvedListId: null })).toBe(fs.readFileSync('tests/fixtures/tasksScriptV1.setup.txt', 'utf8'));
  });
});

describe('tasksScriptChoice: v2 only when a v2 capability is wanted', () => {
  it('one list with no read-back stays v1 (a list that needs a date works on v1: its upsert already writes `due`)', () => {
    expect(tasksScriptChoice({ mainListId: 'A', otherListIds: [], readBack: false })).toEqual({ needsV2: false, approvedListIds: ['A'] });
    expect(tasksScriptChoice({ mainListId: '', otherListIds: [], readBack: false })).toEqual({ needsV2: false, approvedListIds: [] });
  });

  it('several lists, or read-back, need v2; the main list is always in the set, once', () => {
    expect(tasksScriptChoice({ mainListId: 'A', otherListIds: ['B', 'A'], readBack: false })).toEqual({ needsV2: true, approvedListIds: ['A', 'B'] });
    expect(tasksScriptChoice({ mainListId: 'A', otherListIds: [], readBack: true })).toEqual({ needsV2: true, approvedListIds: ['A'] });
  });
});

describe('buildTasksScriptV2 text', () => {
  const v2 = buildTasksScriptV2({ secret: 'abc123secret', approvedListId: 'LA', approvedListIds: ['LA', 'LB'] });
  const setup = buildTasksScriptV2({ secret: 'abc123secret', approvedListId: null, approvedListIds: [] });

  it('is valid JavaScript, holds the secret once, and differs between deployments only in the config block', () => {
    expect(() => new Function(v2)).not.toThrow();
    expect(() => new Function(setup)).not.toThrow();
    expect(v2.match(/abc123secret/g)).toHaveLength(1);
    const strip = (s: string): string => s.replace(/var TASKS_CONFIG = \{[\s\S]*?\n\};/, '');
    expect(strip(v2)).toBe(strip(setup));
  });

  it('never edits, completes or deletes a Google task, and cannot create or remove lists', () => {
    for (const forbidden of ['Tasks.Tasks.remove', 'Tasks.Tasks.update', 'Tasks.Tasks.patch', 'Tasks.Tasks.move', 'Tasks.Tasklists.insert', 'Tasks.Tasklists.remove', 'Tasks.Tasks.clear']) {
      expect(v2.includes(forbidden), forbidden).toBe(false);
    }
  });

  it('keeps every safety rule of v1: lock, caps, budget, secret check, list check before Google', () => {
    for (const must of ['LockService.getScriptLock()', 'tryLock(20000)', 'TASKS_MAX_ITEMS = 25', 'TASKS_BUDGET_MS = 240000', 'showCompleted: true', 'req.secret !== TASKS_CONFIG.SECRET', '!TASKS_CONFIG.SECRET ||', 'tasks_approved_(req.listId)']) {
      expect(v2, must).toContain(must);
    }
    expect(MAX_STATUS_ITEMS).toBe(100);
  });

  it('escapes hostile values so config cannot break out of its string', () => {
    const evil = buildTasksScriptV2({ secret: 'a"b\\c\n// x', approvedListId: 'id"]);alert(1);//', approvedListIds: ['x"y'] });
    expect(() => new Function(evil)).not.toThrow();
    const config = JSON.parse(/var TASKS_CONFIG = (\{[\s\S]*?\n\});/.exec(evil)![1]);
    expect(config.SECRET).toBe('a"b\\c\n// x');
    expect(config.APPROVED_LIST_IDS).toEqual(['id"]);alert(1);//', 'x"y']);
  });

  it('refuses to build a script with no secret', () => {
    expect(() => buildTasksScriptV2({ secret: '  ', approvedListId: null, approvedListIds: [] })).toThrow();
  });

  it('the list set always holds the main list, so the two config fields cannot disagree', () => {
    expect(tasksModuleConfig({ secret: 's', approvedListId: 'M', approvedListIds: ['X'] }).APPROVED_LIST_IDS).toEqual(['M', 'X']);
    expect(tasksModuleConfig({ secret: 's', approvedListId: null, approvedListIds: [] })).toMatchObject({ APPROVED_LIST_ID: '', APPROVED_LIST_IDS: [] });
  });
});

// ─── The v2 module run against a fake Tasks service ─────────────────────────

type FakeTask = { id: string; title: string; notes?: string; status?: string; completed?: string; deleted?: boolean; due?: string };
interface World { lists: Record<string, FakeTask[]>; props: Record<string, string>; calls: string[]; seq: number; failGet?: (listId: string, taskId: string) => Error | null }
const newWorld = (): World => ({ lists: { LA: [], LB: [] }, props: {}, calls: [], seq: 0 });
const id = (n: number): string => `aio-${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;

function run(world: World, request: unknown, config: { main: string | null; ids: string[] } = { main: 'LA', ids: ['LA', 'LB'] }) {
  const script = buildTasksScriptV2({ secret: 'S', approvedListId: config.main, approvedListIds: config.ids });
  const sandbox = {
    ContentService: { createTextOutput: (s: string) => ({ s, setMimeType() { return this; } }), MimeType: { JSON: 'json' } },
    Utilities: { computeDigest: (_a: unknown, input: string) => [...input].map((c) => c.charCodeAt(0) & 0xff), DigestAlgorithm: { SHA_256: 'x' } },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() { /* test lock */ } }) },
    PropertiesService: { getScriptProperties: () => ({ getProperties: () => ({ ...world.props }), setProperty: (k: string, v: string) => { world.props[k] = v; } }) },
    Tasks: {
      Tasklists: { list: () => ({ items: Object.keys(world.lists).map((k) => ({ id: k, title: `Title ${k}` })) }) },
      Tasks: {
        list: (listId: string) => { world.calls.push(`list:${listId}`); return { items: world.lists[listId] ?? [] }; },
        insert: (body: { title: string; notes: string; due?: string }, listId: string) => { world.calls.push(`insert:${listId}`); const t: FakeTask = { id: `t${++world.seq}`, title: body.title, notes: body.notes, due: body.due, status: 'needsAction' }; (world.lists[listId] ??= []).push(t); return t; },
        get: (listId: string, taskId: string) => {
          world.calls.push(`get:${listId}:${taskId}`);
          const failure = world.failGet?.(listId, taskId);
          if (failure) throw failure;
          const found = (world.lists[listId] ?? []).find((t) => t.id === taskId);
          if (!found) throw new Error('Not Found 404');
          return found;
        },
      },
    },
  };
  const fn = new Function('sandbox', `with (sandbox) { ${script}; return doPost; }`);
  const doPost = fn(sandbox) as (e: unknown) => { s: string };
  return JSON.parse(doPost({ postData: { contents: JSON.stringify({ secret: 'S', ...(request as object) }) } }).s);
}
const upsert = (listId: string, tasks: unknown[]) => ({ op: 'upsert', listId, tasks });

describe('v2: ping keeps the v1 fields and adds the list set and capabilities', () => {
  it('answers both shapes', async () => {
    const out = run(newWorld(), { op: 'ping' });
    expect(out).toMatchObject({ ok: true, scriptVersion: 2, approvedListId: 'LA', approvedListIds: ['LA', 'LB'], capabilities: [...TASKS_V2_CAPABILITIES] });
    expect(typeof out.listHash).toBe('string');
    expect(typeof out.listsHash).toBe('string');
    expect(await approvedListsHashOf(['LB', 'LA'])).toBe(await approvedListsHashOf(['LA', 'LB']));
  });

  it('a setup deployment answers ping and lists but never creates', () => {
    const w = newWorld();
    const cfg = { main: null, ids: [] as string[] };
    expect(run(w, { op: 'ping' }, cfg)).toMatchObject({ ok: true, approvedListId: null, approvedListIds: [] });
    expect(run(w, { op: 'lists' }, cfg).lists).toHaveLength(2);
    expect(run(w, upsert('LA', [{ exportId: id(1), title: 'X' }]), cfg).error.code).toBe('not-approved');
    expect(w.lists.LA).toHaveLength(0);
  });
});

describe('v2: several lists', () => {
  it('creates in the named approved list, writes `due` as a date, and refuses an unlisted list before touching Google', () => {
    const w = newWorld();
    const out = run(w, upsert('LB', [{ exportId: id(1), title: 'Dated', due: '2026-11-03' }]));
    expect(out.results).toEqual([{ exportId: id(1), status: 'created', taskId: 't1' }]);
    expect(w.lists.LB[0].due).toBe('2026-11-03T00:00:00.000Z');
    expect(w.lists.LA).toHaveLength(0);
    const calls = w.calls.length;
    expect(run(w, upsert('Other', [{ exportId: id(2), title: 'X' }])).error.code).toBe('not-approved');
    expect(w.calls).toHaveLength(calls);
  });

  it('a retry to the same list is `exists`, and the same id with another title is `conflict`', () => {
    const w = newWorld();
    run(w, upsert('LA', [{ exportId: id(1), title: 'One' }]));
    expect(run(w, upsert('LA', [{ exportId: id(1), title: 'One' }])).results[0].status).toBe('exists');
    expect(run(w, upsert('LA', [{ exportId: id(1), title: 'Changed' }])).results[0].status).toBe('conflict');
    expect(w.lists.LA).toHaveLength(1);
  });

  it('two devices that froze different lists cannot both create the task: the second gets target-conflict with the original receipt', () => {
    const w = newWorld();
    run(w, upsert('LA', [{ exportId: id(1), title: 'One' }]));
    const second = run(w, upsert('LB', [{ exportId: id(1), title: 'One' }]));
    expect(second.results).toEqual([{ exportId: id(1), status: 'target-conflict', taskId: 't1' }]);
    expect(w.lists.LB).toHaveLength(0);
    expect(w.props['bind:' + id(1)]).toBe('LA');
  });

  it('a v1 receipt (an `x:` key only) counts as the binding', () => {
    const w = newWorld();
    w.props[`x:LA:${id(1)}`] = JSON.stringify({ taskId: 'old1', title: 'Old' });
    expect(run(w, upsert('LB', [{ exportId: id(1), title: 'Old' }])).results[0]).toMatchObject({ status: 'target-conflict', taskId: 'old1' });
    expect(run(w, upsert('LA', [{ exportId: id(1), title: 'Old' }])).results[0]).toMatchObject({ status: 'exists', taskId: 'old1' });
  });

  it('keeps the request validation of v1', () => {
    const w = newWorld();
    expect(run(w, upsert('LA', [])).error.code).toBe('bad-request');
    expect(run(w, upsert('LA', [{ exportId: 'nope', title: 'X' }])).error.code).toBe('bad-request');
    expect(run(w, upsert('LA', [{ exportId: id(1), title: 'X' }, { exportId: id(1), title: 'Y' }])).error.code).toBe('bad-request');
    expect(run(w, upsert('LA', Array.from({ length: 26 }, (_, i) => ({ exportId: id(i), title: 'x' })))).error.code).toBe('bad-request');
    expect(run(w, { op: 'upsert', tasks: [{ exportId: id(1), title: 'X' }] }).error.code).toBe('not-approved');
    expect(w.lists.LA).toHaveLength(0);
  });

  it('a wrong secret and an unknown op are refused', () => {
    const w = newWorld();
    const script = buildTasksScriptV2({ secret: 'S', approvedListId: 'LA', approvedListIds: ['LA'] });
    expect(script).toContain('"auth"');
    expect(run(w, { op: 'nope' }).error.code).toBe('bad-request');
  });
});

describe('v2: status is read-only and only for tasks this script created', () => {
  const create = (w: World, listId: string, n: number) => run(w, upsert(listId, [{ exportId: id(n), title: `T${n}` }]));

  it('reports completion and the open state from the script\'s own receipt', () => {
    const w = newWorld();
    create(w, 'LA', 1); create(w, 'LA', 2);
    w.lists.LA[0].status = 'completed';
    w.lists.LA[0].completed = '2026-11-02T10:00:00.000Z';
    const out = run(w, { op: 'status', listId: 'LA', items: [{ exportId: id(1), taskId: 'ignored' }, { exportId: id(2), taskId: 'ignored' }] });
    expect(out.results).toEqual([
      { exportId: id(1), outcome: 'ok', status: 'completed', completed: '2026-11-02T10:00:00.000Z' },
      { exportId: id(2), outcome: 'ok', status: 'needsAction' },
    ]);
  });

  it('a supplied task id is ignored: a forged tuple reads nothing it should not', () => {
    const w = newWorld();
    create(w, 'LA', 1);
    run(w, { op: 'status', listId: 'LA', items: [{ exportId: id(1), taskId: 'someone-elses-task' }] });
    expect(w.calls.filter((c) => c.startsWith('get:'))).toEqual(['get:LA:t1']);
  });

  it('an id with no receipt, or bound to another list, is `unknown-receipt` and nothing is read', () => {
    const w = newWorld();
    create(w, 'LB', 1);
    const out = run(w, { op: 'status', listId: 'LA', items: [{ exportId: id(1) }, { exportId: id(9) }, { exportId: 'bad' }] });
    expect(out.results.map((r: { outcome: string }) => r.outcome)).toEqual(['unknown-receipt', 'unknown-receipt', 'unknown-receipt']);
    expect(w.calls.filter((c) => c.startsWith('get:'))).toEqual([]);
  });

  it('legacy v1 receipts are valid', () => {
    const w = newWorld();
    w.lists.LA.push({ id: 'old1', title: 'Old', status: 'completed' });
    w.props[`x:LA:${id(1)}`] = JSON.stringify({ taskId: 'old1', title: 'Old' });
    expect(run(w, { op: 'status', listId: 'LA', items: [{ exportId: id(1) }] }).results[0]).toMatchObject({ outcome: 'ok', status: 'completed' });
  });

  it('a deleted task is `not-found`, other failures are `error`, an unapproved list is refused, oversized batches are refused', () => {
    const w = newWorld();
    create(w, 'LA', 1); create(w, 'LA', 2);
    w.lists.LA[0].deleted = true;
    w.failGet = (_l, taskId) => (taskId === 't2' ? new Error('Service unavailable') : null);
    const out = run(w, { op: 'status', listId: 'LA', items: [{ exportId: id(1) }, { exportId: id(2) }] });
    expect(out.results.map((r: { outcome: string }) => r.outcome)).toEqual(['not-found', 'error']);
    expect(run(w, { op: 'status', listId: 'Other', items: [{ exportId: id(1) }] }).error.code).toBe('not-approved');
    expect(run(w, { op: 'status', listId: 'LA', items: Array.from({ length: 101 }, (_, i) => ({ exportId: id(i) })) }).error.code).toBe('bad-request');
    expect(run(w, { op: 'status', listId: 'LA', items: [] }).error.code).toBe('bad-request');
  });

  it('never writes: a status request changes no property and creates nothing', () => {
    const w = newWorld();
    create(w, 'LA', 1);
    const before = JSON.stringify(w.props);
    const tasksBefore = JSON.stringify(w.lists);
    run(w, { op: 'status', listId: 'LA', items: [{ exportId: id(1) }] });
    expect(JSON.stringify(w.props)).toBe(before);
    expect(JSON.stringify(w.lists)).toBe(tasksBefore);
  });
});
