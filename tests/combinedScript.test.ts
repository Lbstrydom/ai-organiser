/**
 * The combined Google script: both modules behind one doPost, run against fake Google services. The standalone scripts are
 * pinned byte for byte so combining never changes what a user who does not combine gets.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { buildCombinedScript } from '../src/services/googleScript/combinedScript';
import { approvedListsHashOf, buildTasksScriptV2, TASKS_V2_CAPABILITIES } from '../src/services/googleScript/googleScriptBuilder';
import { buildInventoryScript, rootsHashOf } from '../src/services/cloudInventory/scriptTemplate';
import { normaliseModulePing } from '../src/services/googleScript/modulePing';

describe('standalone scripts are unchanged (pinned by stored copies)', () => {
  it('inventory v1 and tasks v2 standalone match byte for byte', () => {
    expect(buildInventoryScript({ secret: 'S3CRET', rootFolderIds: ['ROOT_A', 'ROOT_B'] })).toBe(fs.readFileSync('tests/fixtures/inventoryScriptV1.txt', 'utf8'));
    expect(buildTasksScriptV2({ secret: 'S3CRET', approvedListId: 'LA', approvedListIds: ['LA', 'LB'] })).toBe(fs.readFileSync('tests/fixtures/tasksScriptV2.operational.txt', 'utf8'));
  });
});

type FakeTask = { id: string; title: string; notes?: string; status?: string; due?: string };
interface World { lists: Record<string, FakeTask[]>; props: Record<string, string>; cache: Record<string, string>; parents: Record<string, string[]>; seq: number; driveCalls: number; taskCalls: number }
const newWorld = (): World => ({ lists: { LA: [], LB: [] }, props: {}, cache: {}, parents: { ROOT: [], CHILD: ['ROOT'], GRAND: ['CHILD'], OUTSIDE: ['ELSEWHERE'], ELSEWHERE: [] }, seq: 0, driveCalls: 0, taskCalls: 0 });
const exportId = (n: number): string => `aio-${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;

function call(script: string, world: World, request: unknown, secret = 'S') {
  const sandbox = {
    ContentService: { createTextOutput: (s: string) => ({ s, setMimeType() { return this; } }), MimeType: { JSON: 'json' } },
    Utilities: { computeDigest: (_a: unknown, input: string) => [...crypto.createHash('sha256').update(input).digest()].map((b) => (b > 127 ? b - 256 : b)), DigestAlgorithm: { SHA_256: 'x' } },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() { /* test lock */ } }) },
    PropertiesService: { getScriptProperties: () => ({ getProperties: () => ({ ...world.props }), setProperty: (k: string, v: string) => { world.props[k] = v; } }) },
    CacheService: { getScriptCache: () => ({ get: (k: string) => world.cache[k] ?? null, put: (k: string, v: string) => { world.cache[k] = v; } }) },
    Drive: {
      Files: {
        get: (id: string) => { world.driveCalls++; return { id, name: `Name ${id}`, parents: world.parents[id] ?? [] }; },
        list: (opts: { q: string }) => {
          world.driveCalls++;
          const parent = /'([^']+)' in parents/.exec(opts.q)?.[1] ?? '';
          const kids = Object.entries(world.parents).filter(([, ps]) => ps.includes(parent)).map(([id]) => ({ id, name: `Name ${id}`, mimeType: 'application/vnd.google-apps.folder' }));
          return { files: [...kids, { id: 'f1', name: 'a.pdf', mimeType: 'application/pdf', size: '5' }], nextPageToken: null };
        },
      },
    },
    Tasks: {
      Tasklists: { list: () => { world.taskCalls++; return ({ items: Object.keys(world.lists).map((k) => ({ id: k, title: `Title ${k}` })) }); } },
      Tasks: {
        list: (listId: string) => { world.taskCalls++; return ({ items: world.lists[listId] ?? [] }); },
        insert: (body: { title: string; notes: string; due?: string }, listId: string) => { world.taskCalls++; const t: FakeTask = { id: `t${++world.seq}`, title: body.title, notes: body.notes, due: body.due, status: 'needsAction' }; (world.lists[listId] ??= []).push(t); return t; },
        get: (listId: string, taskId: string) => { world.taskCalls++; const found = (world.lists[listId] ?? []).find((t) => t.id === taskId); if (!found) throw new Error('Not Found 404'); return found; },
      },
    },
  };
  const fn = new Function('sandbox', `with (sandbox) { ${script}; return doPost; }`);
  const doPost = fn(sandbox) as (e: unknown) => { s: string };
  return JSON.parse(doPost({ postData: { contents: JSON.stringify({ secret, ...(request as object) }) } }).s);
}

const both = buildCombinedScript({ secret: 'S', tasks: { approvedListId: 'LA', approvedListIds: ['LA', 'LB'] }, inventory: { rootFolderIds: ['ROOT'] } });
const tasksOnly = buildCombinedScript({ secret: 'S', tasks: { approvedListId: 'LA', approvedListIds: ['LA'] } });
const inventoryOnly = buildCombinedScript({ secret: 'S', inventory: { rootFolderIds: ['ROOT'] } });

describe('combined script text', () => {
  it('is valid JavaScript for every module mix, with the secret written once', () => {
    for (const s of [both, tasksOnly, inventoryOnly]) {
      expect(() => new Function(s)).not.toThrow();
      expect(s.match(/"S"/g)).toHaveLength(1);
    }
    expect(both).not.toContain('TASKS_CONFIG.SECRET');
  });

  it('refuses no secret and no module; escapes hostile values', () => {
    expect(() => buildCombinedScript({ secret: ' ', tasks: { approvedListId: 'A', approvedListIds: [] } })).toThrow();
    expect(() => buildCombinedScript({ secret: 's' })).toThrow();
    const evil = buildCombinedScript({ secret: 'a"b\\c\n// x', tasks: { approvedListId: 'id"]);alert(1);//', approvedListIds: [] }, inventory: { rootFolderIds: ['rOOt_ok-1'] } });
    expect(() => new Function(evil)).not.toThrow();
    expect(call(evil, newWorld(), { op: 'ping' }, 'a"b\\c\n// x').ok).toBe(true);
  });

  it('keeps the read-only promises: no task edit or delete, no Drive write, no list creation', () => {
    for (const forbidden of ['Tasks.Tasks.remove', 'Tasks.Tasks.update', 'Tasks.Tasks.patch', 'Tasks.Tasklists.insert', 'Drive.Files.create', 'Drive.Files.update', 'Drive.Files.remove', 'Drive.Files.copy', 'Drive.Permissions', 'setSharing', 'DriveApp']) {
      expect(both.includes(forbidden), forbidden).toBe(false);
    }
  });
});

describe('ping: shared, per-module, and understood by the plugin', () => {
  it('no module: only the module map, with versions and capabilities', () => {
    const out = call(both, newWorld(), { op: 'ping' });
    expect(out).toEqual({ ok: true, modules: { tasks: { version: 2, capabilities: [...TASKS_V2_CAPABILITIES] }, inventory: { version: 1, capabilities: ['list'] } } });
    expect(normaliseModulePing('tasks', out)).toMatchObject({ version: 2, capabilities: [...TASKS_V2_CAPABILITIES], legacy: false });
    expect(normaliseModulePing('inventory', out)).toMatchObject({ version: 1, capabilities: ['list'], legacy: false });
  });

  it('a module the script lacks has no capabilities', () => {
    expect(normaliseModulePing('inventory', call(tasksOnly, newWorld(), { op: 'ping' }))).toBeNull();
    expect(normaliseModulePing('tasks', call(inventoryOnly, newWorld(), { op: 'ping' }))).toBeNull();
  });

  it('module tasks also carries the standalone tasks fields, so the existing client reads it unchanged', async () => {
    const out = call(both, newWorld(), { op: 'ping', module: 'tasks' });
    expect(out).toMatchObject({ ok: true, scriptVersion: 2, approvedListId: 'LA', approvedListIds: ['LA', 'LB'], capabilities: [...TASKS_V2_CAPABILITIES] });
    expect(out.listHash).toBe(crypto.createHash('sha256').update('LA').digest('hex'));
    expect(out.listsHash).toBe(await approvedListsHashOf(['LA', 'LB']));
    expect(out.modules.inventory).toBeDefined();
  });

  it('module inventory carries the standalone inventory fields, including the folder check and the roots hash', async () => {
    const out = call(both, newWorld(), { op: 'ping', module: 'inventory', folderId: 'GRAND' });
    expect(out).toMatchObject({ ok: true, scriptVersion: 1, folder: { id: 'GRAND' } });
    expect(out.rootsHash).toBe(await rootsHashOf(['ROOT']));
    expect(call(both, newWorld(), { op: 'ping', module: 'inventory', folderId: 'OUTSIDE' }).folder).toBeNull();
  });
});

describe('ping naming a module the script lacks', () => {
  it('is a module-missing failure, not a generic success; an unknown module is a bad request', () => {
    expect(call(tasksOnly, newWorld(), { op: 'ping', module: 'inventory' }).error.code).toBe('module-missing');
    expect(call(inventoryOnly, newWorld(), { op: 'ping', module: 'tasks' }).error.code).toBe('module-missing');
    expect(call(both, newWorld(), { op: 'ping', module: 'structure' }).error.code).toBe('bad-request');
    expect(call(tasksOnly, newWorld(), { op: 'ping', module: 'tasks' }).ok).toBe(true);
  });
});

describe('Drive ids and the inventory query', () => {
  it('refuses a root id with characters a Drive id never has', () => {
    for (const bad of ["x' or name contains '", 'a b', 'a/b', '', "x\\"]) {
      expect(() => buildCombinedScript({ secret: 's', inventory: { rootFolderIds: [bad] } }), bad).toThrow();
    }
    expect(() => buildCombinedScript({ secret: 's', inventory: { rootFolderIds: ['1AbC_d-Ef'] } })).not.toThrow();
  });

  it('a hostile folder id in a request is refused by approval before any query, and is escaped in the query', () => {
    const w = newWorld();
    expect(call(both, w, { op: 'list', folderId: "ROOT' or 'x' in parents or '" }).error.code).toBeDefined();
    expect(both).toContain(".replace(/'/g, \"\\\\'\")");
  });
});

describe('the combined inventory behaves like the standalone one', () => {
  it('lists the same files and folders and approves the same ids', () => {
    const standalone = buildInventoryScript({ secret: 'S', rootFolderIds: ['ROOT'] });
    for (const folderId of ['ROOT', 'CHILD', 'GRAND', 'OUTSIDE']) {
      const a = call(standalone, newWorld(), { op: 'list', folderId });
      const b = call(both, newWorld(), { op: 'list', folderId });
      expect(b, folderId).toEqual(a);
    }
  });
});

describe('tasks through the combined script', () => {
  it('creates in an approved list, never in another, and answers lists', () => {
    const w = newWorld();
    const ok = call(both, w, { op: 'upsert', listId: 'LB', tasks: [{ exportId: exportId(1), title: 'X' }] });
    expect(ok.ok).toBe(true);
    expect(w.lists.LB).toHaveLength(1);
    expect(call(both, w, { op: 'upsert', listId: 'LZ', tasks: [{ exportId: exportId(2), title: 'Y' }] }).error.code).toBe('not-approved');
    expect(call(both, w, { op: 'lists' }).lists).toHaveLength(2);
  });
});

describe('inventory through the combined script', () => {
  it('lists an approved root and a descendant, refuses an outside folder, and lists files', () => {
    const w = newWorld();
    expect(call(both, w, { op: 'list', folderId: 'ROOT' })).toMatchObject({ ok: true, files: [{ id: 'f1' }] });
    expect(call(both, w, { op: 'list', folderId: 'GRAND' }).ok).toBe(true);
    expect(call(both, w, { op: 'list', folderId: 'OUTSIDE' }).error.code).toBe('not-approved');
    expect(call(both, w, { op: 'list' }).error.code).toBe('bad-request');
  });

  it('cached approvals do not collide with the tasks module (own key prefix)', () => {
    const w = newWorld();
    call(both, w, { op: 'list', folderId: 'ROOT' });
    expect(Object.keys(w.cache).every((k) => k.startsWith('inv:ok:'))).toBe(true);
  });
});

describe('safety: auth, missing modules, unknown operations', () => {
  it('rejects a wrong or missing secret for every operation, before any Google call', () => {
    for (const op of ['ping', 'lists', 'upsert', 'status', 'list']) {
      const w = newWorld();
      expect(call(both, w, { op }, 'wrong').error.code).toBe('auth');
      expect(call(both, w, { op }, '').error.code).toBe('auth');
      expect(w.driveCalls).toBe(0);
      expect(w.taskCalls).toBe(0);
      expect(Object.keys(w.props)).toEqual([]);
    }
  });

  it('an operation of a module the script lacks says so; an unknown one is a bad request', () => {
    expect(call(tasksOnly, newWorld(), { op: 'list', folderId: 'ROOT' }).error.code).toBe('module-missing');
    expect(call(inventoryOnly, newWorld(), { op: 'upsert', listId: 'LA', tasks: [] }).error.code).toBe('module-missing');
    expect(call(both, newWorld(), { op: 'nope' }).error.code).toBe('bad-request');
  });
});

describe('which secret the inventory uses', () => {
  const plugin = (over: { inv: string; tasks: string }, secrets: Record<string, string | undefined>) => ({
    settings: { cloudInventoryScriptUrl: over.inv, tasksScriptUrl: over.tasks },
    secretStorageService: { getSecret: async (id: string) => secrets[id] ?? null },
  }) as never;
  const T = 'ai-organiser-google-tasks-secret';
  const I = 'ai-organiser-cloud-inventory-secret';

  it('its own secret while it has its own deployment; the shared one only when both URLs are the same deployment', async () => {
    const { inventorySecretFor } = await import('../src/services/googleScript/sharedSecret');
    const url = 'https://script.google.com/macros/s/AKfycbxTEST/exec';
    expect(await inventorySecretFor(plugin({ inv: 'https://script.google.com/macros/s/OTHER/exec', tasks: url }, { [T]: 't', [I]: 'i' }))).toEqual({ ok: true, value: 'i' });
    expect(await inventorySecretFor(plugin({ inv: url + '/', tasks: url }, { [T]: 't', [I]: 'i' }))).toEqual({ ok: true, value: 't' });
    // same deployment but no Tasks secret: the standalone inventory secret belongs to another deployment and is never tried
    expect(await inventorySecretFor(plugin({ inv: url, tasks: url }, { [I]: 'i' }))).toEqual({ ok: true, value: null });
    expect(await inventorySecretFor(plugin({ inv: '', tasks: '' }, { [I]: 'i' }))).toEqual({ ok: true, value: 'i' });
    expect(await inventorySecretFor(plugin({ inv: '', tasks: '' }, {}))).toEqual({ ok: true, value: null });
    // a storage failure is a failure, not "no secret"
    const broken = { settings: { cloudInventoryScriptUrl: '', tasksScriptUrl: '' }, secretStorageService: { getSecret: async () => { throw new Error('locked'); } } } as never;
    expect(await inventorySecretFor(broken)).toEqual({ ok: false, error: 'secret-storage-failed' });
    // the deployment id in the path is case-sensitive; the host is not
    const { sameDeployment } = await import('../src/services/googleScript/sharedSecret');
    expect(sameDeployment('https://Script.Google.com/macros/s/AbC/exec', 'https://script.google.com/macros/s/AbC/exec/')).toBe(true);
    expect(sameDeployment('https://script.google.com/macros/s/AbC/exec', 'https://script.google.com/macros/s/abc/exec')).toBe(false);
    expect(sameDeployment('', '')).toBe(false);
  });
});
