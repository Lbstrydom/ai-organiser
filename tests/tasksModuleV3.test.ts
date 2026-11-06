/**
 * Tasks module v3 run against fake Google services, with the plugin's own client and `approveLists` talking to it through a fake
 * transport. Nothing here touches a real Apps Script deployment. The v1 and v2 script text stays pinned by stored copies.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { buildCombinedScript } from '../src/services/googleScript/combinedScript';
import { RECEIPT_STORE_HIGH, RECEIPT_STORE_LOW, tasksModuleV3Functions } from '../src/services/googleScript/tasksModuleV3';
import { normaliseModulePing } from '../src/services/googleScript/modulePing';
import { approvedBeyondConfigured, classifyTasksScript, pingTasksScript, setTasksLists } from '../src/services/inboxSweep/tasksExportService';
import { approveLists } from '../src/services/inboxSweep/tasksAutoLists';
import type { ScriptTransport } from '../src/services/appsScriptClient';
import { newWorld, run, type World } from './helpers/fakeGoogleScript';

const URL_OK = 'https://script.google.com/macros/s/AKfycbxTEST/exec';
const exportId = (n: number): string => `aio-${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;

const v3 = buildCombinedScript({ secret: 'S', tasks: { automatic: true } });
const call = (world: World, request: object, secret = 'S', script = v3) => JSON.parse(run(script, world, JSON.stringify({ secret, ...request })));
const transportFor = (world: World, script = v3): ScriptTransport => async ({ body }) => ({ status: 200, text: run(script, world, body) });
const task = (n: number, title = `Task ${n}`) => ({ exportId: exportId(n), title, notes: '' });
const pingOf = async (world: World) => { const p = await pingTasksScript({ url: URL_OK, secret: 'S', transport: transportFor(world) }); if (!p.ok) throw new Error(p.error); return p.value; };

describe('existing script text is unchanged (pinned by stored copies)', () => {
  it('the locked combined script matches byte for byte, and has no list operation or v3 code', () => {
    const locked = buildCombinedScript({ secret: 'S3CRET', tasks: { approvedListId: 'LA', approvedListIds: ['LA', 'LB'] }, inventory: { rootFolderIds: ['ROOT_A'] } });
    expect(locked).toBe(fs.readFileSync('tests/fixtures/combinedScriptV2.locked.txt', 'utf8'));
    for (const absent of ['setLists', 'cfg:lists', 'deleteProperty', 'list-config']) expect(locked).not.toContain(absent);
  });
});

describe('v3 text', () => {
  it('is valid JavaScript, holds the secret once, and differs between users only in the secret', () => {
    expect(() => new Function(v3)).not.toThrow();
    expect(v3.match(/"S"/g)).toHaveLength(1);
    const other = buildCombinedScript({ secret: 'OTHER', tasks: { automatic: true } });
    expect(v3.replace('"S"', '"X"')).toBe(other.replace('"OTHER"', '"X"'));
    expect(v3).not.toMatch(/"APPROVED_LIST_ID": "[^"]/);
  });

  it('never edits, completes or deletes a Google task, and cannot create or remove lists', () => {
    for (const forbidden of ['Tasks.Tasks.remove', 'Tasks.Tasks.update', 'Tasks.Tasks.patch', 'Tasks.Tasks.move', 'Tasks.Tasklists.insert', 'Tasks.Tasklists.remove', 'Tasks.Tasks.clear']) {
      expect(v3.includes(forbidden), forbidden).toBe(false);
    }
  });

  it('keeps Drive roots in the script text, with the inventory beside it', () => {
    const both = buildCombinedScript({ secret: 'S', tasks: { automatic: true }, inventory: { rootFolderIds: ['ROOT'] } });
    expect(() => new Function(both)).not.toThrow();
    expect(both).toContain('"ROOT_FOLDER_IDS"');
    expect(tasksModuleV3Functions()).not.toContain('ROOT_FOLDER_IDS');
  });
});

describe('v3 lists', () => {
  it('approves nothing until the lists are set: the existing setup state, no task can be created', async () => {
    const world = newWorld();
    const ping = await pingOf(world);
    expect(ping).toMatchObject({ scriptVersion: 3, approvedListId: null, approvedListIds: [], listsRevision: 0 });
    expect(await classifyTasksScript(ping, 'LA')).toBe('setup');
    expect(call(world, { op: 'upsert', listId: 'LA', tasks: [task(1)] }).error.code).toBe('not-approved');
    expect(world.lists.LA).toHaveLength(0);
  });

  it('after setLists it creates in approved lists only, and an older client reads the ping unchanged', async () => {
    const world = newWorld();
    expect(call(world, { op: 'setLists', main: 'LA', ids: ['LA', 'LB'], expectedRevision: 0 })).toEqual({ ok: true, revision: 1 });
    const ping = await pingOf(world);
    expect(ping).toMatchObject({ approvedListId: 'LA', approvedListIds: ['LA', 'LB'], listsRevision: 1, approvedListTitles: { LA: 'Title LA', LB: 'Title LB' } });
    expect(ping.capabilities).toEqual(expect.arrayContaining(['upsert', 'lists', 'multi-list', 'status', 'list-config']));
    expect(await classifyTasksScript(ping, 'LA', ['LA', 'LB'])).toBe('operational');
    expect(call(world, { op: 'upsert', listId: 'LB', tasks: [task(1)] }).results[0].status).toBe('created');
    expect(call(world, { op: 'upsert', listId: 'LC', tasks: [task(2)] }).error.code).toBe('not-approved');
    expect(world.lists.LC).toHaveLength(0);
  });

  it('refuses a forged list, a stale revision, too many lists, a main outside the set and a wrong secret', () => {
    const world = newWorld();
    expect(call(world, { op: 'setLists', main: 'NOPE', ids: ['NOPE'], expectedRevision: 0 }).error.code).toBe('unknown-list');
    expect(call(world, { op: 'setLists', main: 'LA', ids: ['LB'], expectedRevision: 0 }).error.code).toBe('bad-request');
    expect(call(world, { op: 'setLists', main: 'LA', ids: ['LA', 'LA'], expectedRevision: 0 }).error.code).toBe('bad-request');
    expect(call(world, { op: 'setLists', main: 'LA', ids: [], expectedRevision: 0 }).error.code).toBe('bad-request');
    expect(call(world, { op: 'setLists', main: 'L0', ids: Array.from({ length: 9 }, (_, i) => `L${i}`), expectedRevision: 0 }).error.code).toBe('bad-request');
    expect(call(world, { op: 'setLists', main: 'LA', ids: ['LA'] }).error.code).toBe('bad-request');
    expect(call(world, { op: 'setLists', main: 'LA', ids: ['LA'], expectedRevision: 5 }).error.code).toBe('stale-revision');
    expect(call(world, { op: 'setLists', main: 'LA', ids: ['LA'], expectedRevision: 0 }, 'WRONG').error.code).toBe('auth');
    expect(world.props['cfg:lists']).toBeUndefined();
  });

  it('a damaged property approves nothing, and its revision still guards a write', () => {
    const world = newWorld();
    world.props['cfg:lists'] = '{not json';
    expect(call(world, { op: 'upsert', listId: 'LA', tasks: [task(1)] }).error.code).toBe('not-approved');
    world.props['cfg:lists'] = JSON.stringify({ main: 'LZ', ids: ['LA'], revision: 4 });
    expect(call(world, { op: 'upsert', listId: 'LA', tasks: [task(1)] }).error.code).toBe('not-approved');
    expect(call(world, { op: 'setLists', main: 'LA', ids: ['LA'], expectedRevision: 0 }).error.code).toBe('stale-revision');
  });

  it('removing a list never frees an export id, and status answers only from receipts', () => {
    const world = newWorld();
    call(world, { op: 'setLists', main: 'LA', ids: ['LA', 'LB'], expectedRevision: 0 });
    call(world, { op: 'upsert', listId: 'LB', tasks: [task(1)] });
    call(world, { op: 'setLists', main: 'LA', ids: ['LA'], expectedRevision: 1 });
    const again = call(world, { op: 'upsert', listId: 'LA', tasks: [task(1)] });
    expect(again.results[0].status).toBe('target-conflict');
    expect(world.lists.LA).toHaveLength(0);
    world.lists.LA.push({ id: 'theirs', title: 'Private', notes: 'no marker' });
    expect(call(world, { op: 'status', listId: 'LA', items: [{ exportId: exportId(9) }] }).results[0].outcome).toBe('unknown-receipt');
  });

  it('pasting v2 back is a safe downgrade: receipts survive and the text is enforced again', () => {
    const world = newWorld();
    call(world, { op: 'setLists', main: 'LA', ids: ['LA', 'LB'], expectedRevision: 0 });
    call(world, { op: 'upsert', listId: 'LB', tasks: [task(1)] });
    const locked = buildCombinedScript({ secret: 'S', tasks: { approvedListId: 'LA', approvedListIds: ['LA'] } });
    expect(call(world, { op: 'upsert', listId: 'LB', tasks: [task(2)] }, 'S', locked).error.code).toBe('not-approved');
    expect(call(world, { op: 'setLists', main: 'LA', ids: ['LA', 'LC'], expectedRevision: 1 }, 'S', locked).error.code).toBe('bad-request');
    expect(call(world, { op: 'upsert', listId: 'LA', tasks: [task(1)] }, 'S', locked).results[0].status).toBe('target-conflict');
  });

  it('a v3 module reports its lists; a v2 module reports none', () => {
    const world = newWorld();
    call(world, { op: 'setLists', main: 'LA', ids: ['LA'], expectedRevision: 0 });
    expect(normaliseModulePing('tasks', call(world, { op: 'ping', module: 'tasks' }))?.approvedLists).toEqual([{ id: 'LA', title: 'Title LA' }]);
    const locked = buildCombinedScript({ secret: 'S', tasks: { approvedListId: 'LA', approvedListIds: ['LA'] } });
    const info = normaliseModulePing('tasks', call(newWorld(), { op: 'ping', module: 'tasks' }, 'S', locked));
    expect(info?.approvedLists).toBeUndefined();
  });
});

describe('v3 receipt store', () => {
  /** Old receipts for ids 1..n in LA, at increasing dates; `dated: false` are receipts from before v3. */
  const fill = (world: World, n: number, dated = true): void => {
    for (let i = 1; i <= n; i++) {
      world.props[`x:LA:${exportId(i)}`] = JSON.stringify({ taskId: `old${i}`, title: `An old task with a realistic title ${i}`, ...(dated ? { at: i } : {}) });
      world.props[`bind:${exportId(i)}`] = 'LA';
    }
  };
  const bytes = (world: World): number => Object.entries(world.props).reduce((n, [k, v]) => n + k.length + v.length, 0);
  const approveLA = (world: World): void => { call(world, { op: 'setLists', main: 'LA', ids: ['LA'], expectedRevision: 0 }); };

  it('below the limit nothing is removed, and new receipts carry their date', () => {
    const world = newWorld();
    approveLA(world);
    fill(world, 50);
    call(world, { op: 'upsert', listId: 'LA', tasks: [task(1000)] });
    expect(world.deletes).toBe(0);
    expect(JSON.parse(world.props[`x:LA:${exportId(1000)}`]).at).toBeGreaterThan(0);
  });

  it('above the limit the oldest receipts go first and keep their bindings, the list configuration is never removed, and exports keep working', () => {
    const world = newWorld();
    approveLA(world);
    const count = Math.ceil(RECEIPT_STORE_HIGH / 150) + 100;
    fill(world, count);
    expect(bytes(world)).toBeGreaterThan(RECEIPT_STORE_HIGH);
    const res = call(world, { op: 'upsert', listId: 'LA', tasks: [task(count + 1)] });
    expect(res.results[0].status).toBe('created');
    expect(world.props[`x:LA:${exportId(1)}`]).toBeUndefined();
    expect(world.props[`bind:${exportId(1)}`]).toBe('LA');
    expect(world.props[`x:LA:${exportId(count)}`]).toBeDefined();
    expect(world.props['cfg:lists']).toBeDefined();
    // One request removes a bounded number, far more than a full batch adds, so repeated exports bring the store back under the high mark and it stays there.
    expect(world.deletes).toBeLessThanOrEqual(502);
    for (let i = 0; i < 60; i++) call(world, { op: 'upsert', listId: 'LA', tasks: Array.from({ length: 25 }, (_, n) => task(count + 2 + i * 25 + n)) });
    expect(bytes(world)).toBeLessThanOrEqual(RECEIPT_STORE_HIGH + 25 * 300);
    expect(bytes(world)).toBeGreaterThan(RECEIPT_STORE_LOW);
  });

  it('an old id whose receipt was pruned still cannot be created on a different list', () => {
    const world = newWorld();
    call(world, { op: 'setLists', main: 'LA', ids: ['LA', 'LB'], expectedRevision: 0 });
    call(world, { op: 'upsert', listId: 'LA', tasks: [task(1)] });
    world.props[`x:LA:${exportId(1)}`] = JSON.stringify({ ...JSON.parse(world.props[`x:LA:${exportId(1)}`]), at: 1 });
    const count = Math.ceil(RECEIPT_STORE_HIGH / 150) + 100;
    for (let i = 2; i <= count; i++) {
      world.props[`x:LA:${exportId(i)}`] = JSON.stringify({ taskId: `old${i}`, title: `An old task with a realistic title ${i}`, at: i });
      world.props[`bind:${exportId(i)}`] = 'LA';
    }
    call(world, { op: 'upsert', listId: 'LA', tasks: [task(count + 1)] });
    expect(world.props[`x:LA:${exportId(1)}`]).toBeUndefined();
    expect(call(world, { op: 'upsert', listId: 'LB', tasks: [task(1)] }).results[0].status).toBe('target-conflict');
    expect(world.lists.LB).toHaveLength(0);
  });

  it('a pruned receipt from before v2 gets a binding, so its id stays tied to its list', () => {
    const world = newWorld();
    call(world, { op: 'setLists', main: 'LA', ids: ['LA', 'LB'], expectedRevision: 0 });
    const count = Math.ceil(RECEIPT_STORE_HIGH / 150) + 100;
    fill(world, count);
    delete world.props[`bind:${exportId(count)}`];
    world.props[`x:LA:${exportId(count)}`] = JSON.stringify({ taskId: 'v1', title: 'From a v1 script' });
    call(world, { op: 'upsert', listId: 'LA', tasks: [task(count + 1)] });
    expect(world.props[`x:LA:${exportId(count)}`]).toBeUndefined();
    expect(world.props[`bind:${exportId(count)}`]).toBe('LA');
  });

  it('past their cap only bindings whose receipt has gone are removed', () => {
    const world = newWorld();
    approveLA(world);
    const orphans = Math.ceil(RECEIPT_STORE_HIGH / 40);
    for (let i = 1; i <= orphans; i++) world.props[`bind:${exportId(i)}`] = 'LA';
    world.props[`x:LA:${exportId(orphans + 1)}`] = JSON.stringify({ taskId: 'kept', title: 'Recent', at: Date.now() });
    world.props[`bind:${exportId(orphans + 1)}`] = 'LA';
    expect(bytes(world)).toBeGreaterThan(RECEIPT_STORE_HIGH);
    call(world, { op: 'upsert', listId: 'LA', tasks: [task(orphans + 2)] });
    expect(world.deletes).toBeGreaterThan(0);
    expect(world.props[`bind:${exportId(orphans + 1)}`]).toBe('LA');
    expect(world.props['cfg:lists']).toBeDefined();
  });

  it('a receipt from before v3 counts as the oldest', () => {
    const world = newWorld();
    approveLA(world);
    const count = Math.ceil(RECEIPT_STORE_HIGH / 150) + 100;
    fill(world, count);
    world.props[`x:LA:${exportId(count)}`] = JSON.stringify({ taskId: 'undated', title: 'From a v2 script' });
    call(world, { op: 'upsert', listId: 'LA', tasks: [task(count + 1)] });
    expect(world.props[`x:LA:${exportId(count)}`]).toBeUndefined();
  });

  it('an id sent again after its receipt was removed finds its marker, so it is not created twice', () => {
    const world = newWorld();
    approveLA(world);
    call(world, { op: 'upsert', listId: 'LA', tasks: [task(1)] });
    delete world.props[`x:LA:${exportId(1)}`];
    delete world.props[`bind:${exportId(1)}`];
    expect(call(world, { op: 'upsert', listId: 'LA', tasks: [task(1)] }).results[0].status).toBe('exists');
    expect(world.lists.LA).toHaveLength(1);
  });
});

describe('approveLists', () => {
  const approve = (world: World, over: Partial<Parameters<typeof approveLists>[0]> = {}) => approveLists({ url: URL_OK, secret: 'S', transport: transportFor(world), main: 'LA', ids: ['LA', 'LB'], knownRevision: null, ...over });

  it('sets the lists and confirms with a ping', async () => {
    const world = newWorld();
    expect(await approve(world)).toEqual({ ok: true, value: 1 });
    expect((await pingOf(world)).approvedListIds).toEqual(['LA', 'LB']);
  });

  it('writes nothing when the script already approves exactly these lists, so a retry does not move the revision', async () => {
    const world = newWorld();
    await approve(world);
    expect(await approve(world, { knownRevision: 1, ids: ['LB', 'LA'] })).toEqual({ ok: true, value: 1 });
  });

  it('a change made elsewhere is not overwritten: told once, and the next approval knowing that goes through', async () => {
    const world = newWorld();
    await approve(world);
    call(world, { op: 'setLists', main: 'LA', ids: ['LA', 'LC'], expectedRevision: 1 });
    const seen: number[] = [];
    expect(await approve(world, { knownRevision: 1, onStale: (r) => { seen.push(r); } })).toEqual({ ok: false, error: 'tasks-lists-stale' });
    expect((await pingOf(world)).approvedListIds).toEqual(['LA', 'LC']);
    expect(seen).toEqual([2]);
    expect(await approve(world, { knownRevision: 2 })).toEqual({ ok: true, value: 3 });
  });

  it('a script that keeps its lists in its text is left alone', async () => {
    const world = newWorld();
    const locked = buildCombinedScript({ secret: 'S', tasks: { approvedListId: 'LA', approvedListIds: ['LA'] } });
    expect(await approve(world, { transport: transportFor(world, locked) })).toEqual({ ok: false, error: 'tasks-auto-not-deployed' });
    expect(world.props['cfg:lists']).toBeUndefined();
  });

  it('a list that is gone gets its own guidance code', async () => {
    const res = await setTasksLists({ url: URL_OK, secret: 'S', transport: transportFor(newWorld()) }, { main: 'NOPE', ids: ['NOPE'], expectedRevision: 0 });
    expect(res).toEqual({ ok: false, error: 'tasks-list-gone' });
  });
});

describe('the wider-than-configured warning', () => {
  it('names a list the script approves that the plugin did not configure', () => {
    expect(approvedBeyondConfigured({ capabilities: ['list-config'], approvedListIds: ['LA', 'THIEF'] }, ['LA'])).toEqual(['THIEF']);
    expect(approvedBeyondConfigured({ capabilities: ['list-config'], approvedListIds: ['LA'] }, ['LA', 'LB'])).toEqual([]);
  });

  it('never fires for a script with its lists in its text: a list removed here stays approved there until the next paste', () => {
    expect(approvedBeyondConfigured({ capabilities: ['multi-list'], approvedListIds: ['LA', 'OLD'] }, ['LA'])).toEqual([]);
    expect(approvedBeyondConfigured({ approvedListIds: ['LA', 'OLD'] }, ['LA'])).toEqual([]);
  });
});

describe('an export never sets the lists', () => {
  it('neither the send path nor the export service calls setLists', () => {
    expect(fs.readFileSync('src/services/inboxSweep/sweepCommit.ts', 'utf8')).not.toMatch(/setTasksLists|approveLists|approveConfiguredLists/);
    const exportCode = fs.readFileSync('src/services/inboxSweep/tasksExportService.ts', 'utf8');
    expect(exportCode.slice(exportCode.indexOf('export async function exportApproved'))).not.toMatch(/setLists|setTasksLists/);
    // The one wire call, and the only code that reaches it.
    const callers = ['src/commands/inboxSweepCommands.ts', 'src/commands/googleScriptCommands.ts', 'src/ui/settings/GoogleTasksListsEditor.ts'].filter((f) => fs.readFileSync(f, 'utf8').includes('setTasksLists('));
    expect(callers).toEqual([]);
  });
});
