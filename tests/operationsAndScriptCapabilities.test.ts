/**
 * Layer 0: the operation index (summaries, reconciliation with domain journals, cross-device rules) and the Google script
 * capability checks (ping normalisation, the status row). Pure parts plus the index over a faked store.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('obsidian', async () => await import('./mocks/obsidian'));

import {
  PRUNE_FINISHED_AFTER_MS, TAKEOVER_AFTER_MS, blockedBy, otherDeviceRecentlyActive, ownsOperation, parseSummary, pruneSummaries, reconcileWithJournal, takeOver, viewOf,
  type OperationSummary, type ViewContext,
} from '../src/services/operations/operationSummary';
import { OperationIndex, adapterOperationStore, getOperationIndex, operationIndexActive, type OperationStore } from '../src/services/operations/operationIndex';
import { LEGACY_CAPABILITIES, capabilityGap, hasCapability, normaliseModulePing } from '../src/services/googleScript/modulePing';
import { integrationRowVisible, missingCapabilities, renderIntegrationStatusRow } from '../src/ui/settings/IntegrationStatusRow';
import { describeError } from '../src/core/friendlyErrors';
import { en } from '../src/i18n/en';
import { ok, err, type Result } from '../src/core/result';

const T0 = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const sum = (over: Partial<OperationSummary> = {}): OperationSummary => ({
  opId: 'op-aaaaaa', kind: 'sweep-export', status: 'running', createdAt: T0, updatedAt: T0, device: 'dev-1', recovery: { journal: 'sweep', key: 'run-1' }, ...over,
});
const ctx = (over: Partial<ViewContext> = {}): ViewContext => ({ device: 'dev-1', now: T0 + 1000, live: new Set(), ...over });

describe('operation summary: decoding and pruning', () => {
  it('round-trips a valid summary and rejects every malformed one', () => {
    const good = sum({ projectId: 'p1', resources: ['project:p1', 'path:a.md'] });
    expect(parseSummary(JSON.parse(JSON.stringify(good)))).toEqual(good);
    for (const bad of [null, 'x', {}, { ...good, opId: 'x' }, { ...good, kind: 'nope' }, { ...good, status: 'nope' }, { ...good, createdAt: -1 }, { ...good, updatedAt: 'x' }, { ...good, device: '' }, { ...good, recovery: null }, { ...good, recovery: { journal: 1, key: 'k' } }]) {
      expect(parseSummary(bad)).toBeNull();
    }
    // resources are never truncated or filtered: an unrepresentable list is refused whole
    expect(parseSummary({ ...good, resources: [1, 'a'] })).toBeNull();
    expect(parseSummary({ ...good, resources: Array.from({ length: 33 }, (_, i) => `r${i}`) })).toBeNull();
    expect(parseSummary({ ...good, resources: Array.from({ length: 32 }, (_, i) => `r${i}`) })?.resources).toHaveLength(32);
  });

  it('prunes finished entries past 30 days and never an unfinished one', () => {
    const old = T0 - PRUNE_FINISHED_AFTER_MS - 1;
    const list = [sum({ opId: 'op-done01', status: 'done', updatedAt: old }), sum({ opId: 'op-roll01', status: 'rolled-back', updatedAt: old }), sum({ opId: 'op-run001', status: 'running', updatedAt: old }), sum({ opId: 'op-bad001', status: 'failed', updatedAt: old }), sum({ opId: 'op-new001', status: 'done', updatedAt: T0 })];
    expect(pruneSummaries(list, T0).map((s) => s.opId)).toEqual(['op-run001', 'op-bad001', 'op-new001']);
  });
});

describe('reconciliation with the domain journal', () => {
  it('a journal step newer than the summary repairs it; the reverse never does', () => {
    const s = sum({ status: 'running', updatedAt: T0 });
    expect(reconcileWithJournal(s, { state: 'found', status: 'done', updatedAt: T0 + 5 })).toEqual({ kind: 'repaired', summary: { ...s, status: 'done', updatedAt: T0 + 5 } });
    expect(reconcileWithJournal(s, { state: 'found', status: 'done', updatedAt: T0 - 5 }).kind).toBe('ok');
    // newer activity within the same status is adopted too
    expect(reconcileWithJournal(s, { state: 'found', status: 'running', updatedAt: T0 + 5 })).toEqual({ kind: 'repaired', summary: { ...s, updatedAt: T0 + 5 } });
    expect(reconcileWithJournal(s, { state: 'found', status: 'running', updatedAt: T0 }).kind).toBe('ok');
  });

  it('a summary without a journal is orphaned, an unreadable journal is surfaced; neither is trusted', () => {
    const s = sum();
    expect(reconcileWithJournal(s, { state: 'missing' })).toEqual({ kind: 'orphaned', summary: s });
    expect(reconcileWithJournal(s, { state: 'unreadable' })).toEqual({ kind: 'unreadable', summary: s });
  });
});

describe('who owns what, across devices', () => {
  it('classifies mine live, interrupted, another device, take-over eligible and finished', () => {
    const live = new Set(['op-aaaaaa']);
    expect(viewOf(sum(), ctx({ live }))).toBe('mine-live');
    expect(viewOf(sum(), ctx())).toBe('interrupted');
    expect(viewOf(sum({ device: 'dev-2' }), ctx())).toBe('other-device');
    expect(viewOf(sum({ device: 'dev-2', updatedAt: T0 - TAKEOVER_AFTER_MS }), ctx())).toBe('takeover-eligible');
    expect(viewOf(sum({ status: 'done' }), ctx())).toBe('finished');
    expect(viewOf(sum({ status: 'needs-attention' }), ctx())).toBe('interrupted');
  });

  it('another device\'s unfinished operation blocks an overlapping one, and only an overlapping one', () => {
    const other = sum({ opId: 'op-other01', device: 'dev-2', resources: ['project:p1', 'path:a.md'] });
    expect(blockedBy([other], ['path:a.md'], ctx()).map((s) => s.opId)).toEqual(['op-other01']);
    expect(blockedBy([other], ['path:b.md'], ctx())).toEqual([]);
    expect(blockedBy([other], [], ctx())).toEqual([]);
    expect(blockedBy([{ ...other, resources: undefined }], ['path:a.md'], ctx())).toEqual([]);
    expect(blockedBy([{ ...other, status: 'done' }], ['path:a.md'], ctx())).toEqual([]);
    expect(blockedBy([sum({ resources: ['path:a.md'] })], ['path:a.md'], ctx())).toEqual([]);
  });

  it('the Process view warns when another device acted in the last hour', () => {
    expect(otherDeviceRecentlyActive([sum({ device: 'dev-2', updatedAt: T0 })], ctx())).toBe(true);
    expect(otherDeviceRecentlyActive([sum({ device: 'dev-2', updatedAt: T0 - 2 * 60 * 60 * 1000 })], ctx())).toBe(false);
    expect(otherDeviceRecentlyActive([sum({ device: 'dev-2', status: 'done' })], ctx())).toBe(false);
  });

  it('take over needs 24 h without an update and an explicit confirmation; the old owner then stops', () => {
    const other = sum({ device: 'dev-2', updatedAt: T0 - DAY - 1 });
    const c = ctx({ now: T0 });
    expect(takeOver(sum({ device: 'dev-2', updatedAt: T0 - 1000 }), c, true)).toEqual({ ok: false, error: 'operation-takeover-too-soon' });
    expect(takeOver(other, c, false)).toEqual({ ok: false, error: 'operation-takeover-unconfirmed' });
    expect(takeOver(sum(), c, true)).toEqual({ ok: false, error: 'operation-not-takeover' });
    expect(takeOver(sum({ device: 'dev-2', status: 'done' }), c, true)).toEqual({ ok: false, error: 'operation-not-takeover' });
    const taken = takeOver(other, c, true);
    expect(taken).toEqual({ ok: true, summary: { ...other, device: 'dev-1', updatedAt: T0 } });
    expect(ownsOperation(taken.ok ? taken.summary : null, 'dev-2')).toBe(false);
    expect(ownsOperation(taken.ok ? taken.summary : null, 'dev-1')).toBe(true);
    expect(ownsOperation(null, 'dev-1')).toBe(false);
  });
});

function fakeStore(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  const calls = { list: 0, write: 0, remove: 0 };
  const store: OperationStore = {
    list: async () => { calls.list++; return ok([...files.keys()]); },
    read: async (f) => (files.has(f) ? ok(files.get(f)!) : err('operation-store-unreadable')),
    write: async (f, t) => { calls.write++; files.set(f, t); return ok(undefined); },
    remove: async (f) => { calls.remove++; files.delete(f); return ok(undefined); },
  };
  return { store, files, calls };
}
const fileOf = (s: OperationSummary): [string, string] => [`${s.opId}.json`, JSON.stringify(s)];

describe('OperationIndex', () => {
  it('writes nothing until the first operation is published (lazy storage)', async () => {
    const f = fakeStore();
    const index = new OperationIndex({ store: f.store, device: 'dev-1', now: () => T0 });
    expect((await index.load()).ok).toBe(true);
    expect(f.calls.write).toBe(0);
    expect(index.list()).toEqual([]);
    expect((await index.publish(sum())).ok).toBe(true);
    expect(f.calls.write).toBe(1);
    expect([...f.files.keys()]).toEqual(['op-aaaaaa.json']);
  });

  it('loads valid files, ignores malformed ones and files whose name disagrees with their id', async () => {
    const a = sum();
    const f = fakeStore({ ...Object.fromEntries([fileOf(a)]), 'junk.json': '{not json', 'op-wrong1.json': JSON.stringify(sum({ opId: 'op-other9' })), 'readme.txt': 'x' });
    const index = new OperationIndex({ store: f.store, device: 'dev-1', now: () => T0 });
    await index.load();
    expect(index.list().map((s) => s.opId)).toEqual(['op-aaaaaa']);
  });

  it('prunes finished entries past retention on load and removes their files; unfinished ones stay', async () => {
    const old = T0 - PRUNE_FINISHED_AFTER_MS - 1;
    const f = fakeStore(Object.fromEntries([fileOf(sum({ opId: 'op-done01', status: 'done', updatedAt: old })), fileOf(sum({ opId: 'op-run001', updatedAt: old }))]));
    const index = new OperationIndex({ store: f.store, device: 'dev-1', now: () => T0 });
    await index.load();
    expect(index.list().map((s) => s.opId)).toEqual(['op-run001']);
    expect([...f.files.keys()]).toEqual(['op-run001.json']);
  });

  it('repairs a summary from its journal, and flags orphaned and unreadable ones', async () => {
    const f = fakeStore(Object.fromEntries([fileOf(sum({ opId: 'op-fix001' })), fileOf(sum({ opId: 'op-orph01' })), fileOf(sum({ opId: 'op-bad001' }))]));
    const index = new OperationIndex({
      store: f.store, device: 'dev-1', now: () => T0 + 10,
      probe: async (s) => (s.opId === 'op-fix001' ? { state: 'found', status: 'done', updatedAt: T0 + 5 } : s.opId === 'op-orph01' ? { state: 'missing' } : { state: 'unreadable' }),
    });
    await index.load();
    expect(index.get('op-fix001')).toMatchObject({ status: 'done', updatedAt: T0 + 5 });
    expect(JSON.parse(f.files.get('op-fix001.json')!)).toMatchObject({ status: 'done' });
    expect(index.problemOf('op-fix001')).toBe('repaired');
    expect(index.problemOf('op-orph01')).toBe('orphaned');
    expect(index.problemOf('op-bad001')).toBe('unreadable');
    expect(index.get('op-orph01')).toBeTruthy();
  });

  it('an unreadable store is a typed error, never a throw', async () => {
    const broken: OperationStore = { list: async () => err('operation-store-unreadable'), read: async () => err('x'), write: async () => err('x'), remove: async () => err('x') };
    expect(await new OperationIndex({ store: broken, device: 'd' }).load()).toEqual({ ok: false, error: 'operation-store-unreadable' });
    const throwing: OperationStore = { ...broken, list: async () => { throw new Error('boom'); } };
    expect(await new OperationIndex({ store: throwing, device: 'd' }).load()).toEqual({ ok: false, error: 'operation-store-unreadable' });
    const unwritable: OperationStore = { ...broken, list: async () => ok([]) };
    const index = new OperationIndex({ store: unwritable, device: 'dev-1' });
    await index.load();
    expect(await index.publish(sum())).toEqual({ ok: false, error: 'operation-store-unwritable' });
    const throwingWrite: OperationStore = { ...unwritable, write: async () => { throw new Error('boom'); } };
    const index2 = new OperationIndex({ store: throwingWrite, device: 'dev-1' });
    await index2.load();
    expect(await index2.publish(sum())).toEqual({ ok: false, error: 'operation-store-unreadable' });
  });

  it('only the owner updates an operation, and live tracking follows its status', async () => {
    const f = fakeStore(Object.fromEntries([fileOf(sum({ opId: 'op-theirs', device: 'dev-2' }))]));
    const index = new OperationIndex({ store: f.store, device: 'dev-1', now: () => T0 + 1000 });
    await index.load();
    expect(await index.publish(sum({ opId: 'op-theirs', device: 'dev-1' }))).toEqual({ ok: false, error: 'operation-not-owner' });
    expect(await index.publish(sum({ opId: 'op-mine001', device: 'dev-2' }))).toEqual({ ok: false, error: 'operation-not-owner' });
    expect((await index.publish(sum({ opId: 'op-mine001' }))).ok).toBe(true);
    expect(index.viewOf('op-mine001')).toBe('mine-live');
    expect(index.interrupted()).toEqual([]);
    await index.publish(sum({ opId: 'op-mine001', status: 'done', updatedAt: T0 + 2 }));
    expect(index.viewOf('op-mine001')).toBe('finished');
    expect(index.viewOf('op-theirs')).toBe('other-device');
    expect(index.stillOwner('op-theirs')).toBe(false);
  });

  it('a restart shows this device\'s unfinished operation as interrupted', async () => {
    const f = fakeStore(Object.fromEntries([fileOf(sum({ opId: 'op-run001' }))]));
    const index = new OperationIndex({ store: f.store, device: 'dev-1', now: () => T0 + 1000 });
    await index.load();
    expect(index.interrupted().map((s) => s.opId)).toEqual(['op-run001']);
  });

  it('take over works through the index only after 24 h and a confirmation, and notifies subscribers', async () => {
    let now = T0;
    const f = fakeStore(Object.fromEntries([fileOf(sum({ opId: 'op-theirs', device: 'dev-2' }))]));
    const index = new OperationIndex({ store: f.store, device: 'dev-1', now: () => now });
    await index.load();
    const changes = vi.fn();
    index.subscribe(changes);
    expect(await index.takeOver('op-theirs', true)).toEqual({ ok: false, error: 'operation-takeover-too-soon' });
    expect(await index.takeOver('nope', true)).toEqual({ ok: false, error: 'operation-not-found' });
    now = T0 + DAY + 1;
    expect(await index.takeOver('op-theirs', false)).toEqual({ ok: false, error: 'operation-takeover-unconfirmed' });
    const taken = await index.takeOver('op-theirs', true);
    expect(taken.ok && taken.value.device).toBe('dev-1');
    expect(index.stillOwner('op-theirs')).toBe(true);
    expect(JSON.parse(f.files.get('op-theirs.json')!).device).toBe('dev-1');
    expect(changes).toHaveBeenCalled();
    expect(index.blockedBy(['path:a.md'])).toEqual([]);
  });

  it('is gated: with the consumer off there is no index and no folder', () => {
    const off = { settings: { featureFlags: {} }, manifest: { dir: '.obsidian/plugins/x' }, app: {} } as never;
    expect(operationIndexActive((off as { settings: never }).settings)).toBe(false);
    expect(getOperationIndex(off)).toBeNull();
  });

  it('the adapter store never creates the folder to look, and creates it on the first write only', async () => {
    const dirs = new Set<string>();
    const files = new Map<string, string>();
    const adapter = {
      exists: async (p: string) => dirs.has(p) || files.has(p),
      mkdir: async (p: string) => { dirs.add(p); },
      list: async (p: string) => ({ files: [...files.keys()].filter((f) => f.startsWith(`${p}/`)), folders: [] as string[] }),
      read: async (p: string) => files.get(p) ?? '',
      write: async (p: string, t: string) => { files.set(p, t); },
      remove: async (p: string) => { files.delete(p); },
    };
    const store = adapterOperationStore({ manifest: { dir: '.obsidian/plugins/ai' }, app: { vault: { adapter } } } as never)!;
    expect(await store.list()).toEqual({ ok: true, value: [] });
    expect(dirs.size).toBe(0);
    expect((await store.write('op-aaaaaa.json', '{}')).ok).toBe(true);
    expect([...dirs]).toEqual(['.obsidian/plugins/ai/operations']);
    expect(await store.list()).toEqual({ ok: true, value: ['op-aaaaaa.json'] });
    expect(await store.read('op-aaaaaa.json')).toEqual({ ok: true, value: '{}' });
    expect(adapterOperationStore({ app: { vault: { adapter } } } as never)).toBeNull();
  });
});

describe('OperationIndex: integrity', () => {
  it('needs a load first, and validates what it writes the way a load does', async () => {
    const f = fakeStore();
    const index = new OperationIndex({ store: f.store, device: 'dev-1', now: () => T0 });
    expect(await index.publish(sum())).toEqual({ ok: false, error: 'operation-not-loaded' });
    expect(await index.takeOver('op-aaaaaa', true)).toEqual({ ok: false, error: 'operation-not-loaded' });
    await index.load();
    expect(await index.publish(sum({ opId: 'x' }))).toEqual({ ok: false, error: 'operation-invalid' });
    expect(await index.publish(sum({ resources: Array.from({ length: 40 }, (_, i) => `r${i}`) }))).toEqual({ ok: false, error: 'operation-invalid' });
    expect(f.calls.write).toBe(0);
  });

  it('checks the owner against the store, not the cache: a take-over that synced in is respected', async () => {
    const f = fakeStore(Object.fromEntries([fileOf(sum({ opId: 'op-mine001' }))]));
    const index = new OperationIndex({ store: f.store, device: 'dev-1', now: () => T0 + 1000 });
    await index.load();
    expect(index.stillOwner('op-mine001')).toBe(true);
    // another device takes it over; the file synced in after this index was read
    f.files.set('op-mine001.json', JSON.stringify(sum({ opId: 'op-mine001', device: 'dev-2', updatedAt: T0 + 500 })));
    expect(await index.publish(sum({ opId: 'op-mine001', updatedAt: T0 + 900 }))).toEqual({ ok: false, error: 'operation-not-owner' });
    expect(JSON.parse(f.files.get('op-mine001.json')!).device).toBe('dev-2');
    expect(index.stillOwner('op-mine001')).toBe(false);
  });

  it('writes run one at a time, so a slow older write cannot land after a newer one', async () => {
    const files = new Map<string, string>();
    const order: string[] = [];
    const gate: { release: () => void } = { release: () => undefined };
    const store: OperationStore = {
      list: async () => ok([...files.keys()]),
      read: async (f) => ok(files.get(f) ?? ''),
      write: async (f, t) => {
        const status = JSON.parse(t).status as string;
        if (status === 'running') await new Promise<void>((r) => { gate.release = r; });
        files.set(f, t); order.push(status); return ok(undefined);
      },
      remove: async () => ok(undefined),
    };
    const index = new OperationIndex({ store, device: 'dev-1', now: () => T0 });
    await index.load();
    const first = index.publish(sum({ status: 'running' }));
    const second = index.publish(sum({ status: 'done', updatedAt: T0 + 5 }));
    await new Promise((r) => setTimeout(r, 10));
    gate.release();
    await Promise.all([first, second]);
    expect(order).toEqual(['running', 'done']);
    expect(JSON.parse(files.get('op-aaaaaa.json')!).status).toBe('done');
  });

  it('an unreadable summary fails the load and keeps the last trustworthy index', async () => {
    const f = fakeStore(Object.fromEntries([fileOf(sum({ opId: 'op-good001' }))]));
    const index = new OperationIndex({ store: f.store, device: 'dev-1', now: () => T0 });
    await index.load();
    expect(index.list().map((s) => s.opId)).toEqual(['op-good001']);
    f.files.set('op-bad0001.json', JSON.stringify(sum({ opId: 'op-bad0001' })));
    const flaky: OperationStore = { ...f.store, read: async (file) => (file === 'op-bad0001.json' ? err('operation-store-unreadable') : f.store.read(file)) };
    const again = new OperationIndex({ store: flaky, device: 'dev-1', now: () => T0 });
    expect(await again.load()).toEqual({ ok: false, error: 'operation-store-unreadable' });
    expect(again.isLoaded()).toBe(false);
    expect(again.list()).toEqual([]);
    // the first index kept its state
    expect(index.list().map((s) => s.opId)).toEqual(['op-good001']);
  });

  it('hands out copies only: mutating what it returns changes nothing inside', async () => {
    const f = fakeStore();
    const index = new OperationIndex({ store: f.store, device: 'dev-1', now: () => T0 });
    await index.load();
    const mine = sum({ resources: ['a'] });
    await index.publish(mine);
    mine.status = 'failed';
    index.get('op-aaaaaa')!.status = 'failed';
    index.list()[0].resources!.push('b');
    expect(index.get('op-aaaaaa')).toMatchObject({ status: 'running', resources: ['a'] });
  });
});

describe('ping normalisation', () => {
  it('gives a validated legacy v1 answer exactly the capabilities v1 had', () => {
    expect(normaliseModulePing('tasks', { ok: true, scriptVersion: 1, approvedListId: 'L', listHash: 'h' })).toEqual({ module: 'tasks', version: 1, capabilities: ['upsert', 'lists'], legacy: true });
    expect(normaliseModulePing('tasks', { ok: true, scriptVersion: 1, approvedListId: null, listHash: 'h' })?.capabilities).toEqual(['upsert', 'lists']);
    expect(normaliseModulePing('inventory', { ok: true, scriptVersion: 1, rootsHash: 'r' })).toEqual({ module: 'inventory', version: 1, capabilities: ['list'], legacy: true });
    expect(LEGACY_CAPABILITIES.tasks).toEqual(['upsert', 'lists']);
  });

  it('reads reported capabilities from the standalone v2 and the combined forms', () => {
    expect(normaliseModulePing('tasks', { ok: true, scriptVersion: 2, capabilities: ['upsert', 'lists', 'status', 'multi-list'] })).toEqual({ module: 'tasks', version: 2, capabilities: ['upsert', 'lists', 'status', 'multi-list'], legacy: false });
    const combined = { ok: true, modules: { tasks: { version: 2, capabilities: ['upsert', 'lists', 'status'] }, inventory: { version: 1, capabilities: ['list'] } } };
    expect(normaliseModulePing('tasks', combined)).toEqual({ module: 'tasks', version: 2, capabilities: ['upsert', 'lists', 'status'], legacy: false });
    expect(normaliseModulePing('inventory', combined)?.capabilities).toEqual(['list']);
    // a module the combined script does not carry has no capabilities
    expect(normaliseModulePing('inventory', { ok: true, modules: { tasks: { version: 2, capabilities: [] } } })).toBeNull();
  });

  it('a malformed answer gives no capabilities (the setup state)', () => {
    for (const bad of [null, 'x', [], { ok: false }, { ok: true }, { ok: true, scriptVersion: 0 }, { ok: true, scriptVersion: 'a' }, { ok: true, scriptVersion: 1 }, { ok: true, scriptVersion: 2, approvedListId: 'L', listHash: 'h' }, { ok: true, scriptVersion: 2, capabilities: 'upsert' }, { ok: true, modules: { tasks: { version: 'x', capabilities: [] } } }, { ok: true, scriptVersion: 1, capabilities: [1] }]) {
      expect(normaliseModulePing('tasks', bad)).toBeNull();
    }
    expect(normaliseModulePing('inventory', { ok: true, scriptVersion: 1, approvedListId: 'L', listHash: 'h' })).toBeNull();
  });

  it('a missing capability disables only that feature: tasks without status still lists and upserts', () => {
    const v1 = normaliseModulePing('tasks', { ok: true, scriptVersion: 1, approvedListId: 'L', listHash: 'h' });
    expect(hasCapability(v1, 'upsert')).toBe(true);
    expect(hasCapability(v1, 'status')).toBe(false);
    expect(capabilityGap(v1, 'status')).toBe('script-capability-missing');
    expect(capabilityGap(v1, 'upsert')).toBeNull();
    // an unreachable script says nothing about capabilities
    expect(capabilityGap(null, 'status')).toBeNull();
    expect(hasCapability(null, 'upsert')).toBe(false);
    expect(describeError(en, 'script-capability-missing').nextStep).toMatch(/deploy/i);
  });
});

describe('integration status row', () => {
  it('is visible only while Google Tasks export or Drive inventory is on', () => {
    expect(integrationRowVisible({ featureFlags: {} })).toBe(false);
    expect(integrationRowVisible({ featureFlags: { 'inbox-sweep': true, 'google-tasks-export': true } })).toBe(true);
    expect(integrationRowVisible({ featureFlags: { 'cloud-inventory': true } })).toBe(true);
    const container = { createDiv: vi.fn() } as never;
    renderIntegrationStatusRow(container, { settings: { featureFlags: {} }, t: en } as never, () => undefined);
    expect((container as { createDiv: ReturnType<typeof vi.fn> }).createDiv).not.toHaveBeenCalled();
  });

  it('lists what a module still lacks, in a fixed order', () => {
    const v1 = normaliseModulePing('tasks', { ok: true, scriptVersion: 1, approvedListId: 'L', listHash: 'h' })!;
    expect(missingCapabilities('tasks', v1)).toEqual(['multi-list', 'status']);
    const v2 = normaliseModulePing('tasks', { ok: true, scriptVersion: 2, capabilities: ['upsert', 'lists', 'multi-list', 'status'] })!;
    expect(missingCapabilities('tasks', v2)).toEqual([]);
  });

  it('the copy states the real Google access and never promises more', () => {
    expect(en.integrationStatus.access).toMatch(/never deletes, shares or reads file contents/);
  });
});

describe('helpers stay typed', () => {
  it('Result shape', () => {
    const r: Result<number> = ok(1);
    expect(r).toEqual({ ok: true, value: 1 });
  });
});
