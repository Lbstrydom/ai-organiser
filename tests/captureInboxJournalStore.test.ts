import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Plugin } from 'obsidian';

vi.stubGlobal('window', globalThis);

import { CAPTURE_JOURNAL_BACKUP_DATA_KEY, CAPTURE_JOURNAL_DATA_KEY, CaptureJournalStore, LAZY_PERSIST_MS } from '../src/services/captureInbox/captureJournalStore';
import { DATA_ONLY_KEYS, __resetChainForTests, saveSettingsData } from '../src/core/pluginDataStore';
import { upsertEntry } from '../src/services/captureInbox/captureJournal';
import type { CaptureEntry } from '../src/services/captureInbox/captureTypes';

function fakePlugin(initial: Record<string, unknown> = {}) {
  let data: Record<string, unknown> = JSON.parse(JSON.stringify(initial));
  const saves: Array<Record<string, unknown>> = [];
  const plugin = {
    loadData: async () => JSON.parse(JSON.stringify(data)),
    saveData: async (d: Record<string, unknown>) => { data = JSON.parse(JSON.stringify(d)); saves.push(data); },
  } as unknown as Plugin;
  return { plugin, saves, get data() { return data; } };
}
const entry = (id: string): CaptureEntry => ({ id, state: 'ready', fingerprint: 'f', processingVersion: 1, attempts: 0, createdAt: 1, updatedAt: 1 });

describe('CaptureJournalStore', () => {
  beforeEach(() => { __resetChainForTests(); });

  it('registers its key as data-only, so a settings save cannot erase the journal', async () => {
    expect(DATA_ONLY_KEYS).toContain(CAPTURE_JOURNAL_DATA_KEY);
    const f = fakePlugin();
    const store = new CaptureJournalStore(f.plugin);
    await store.load();
    await store.mutate((j) => upsertEntry(j, entry('Inbox/a.md')));
    await saveSettingsData(f.plugin, { someSetting: true });
    expect((f.data[CAPTURE_JOURNAL_DATA_KEY] as { entries: Record<string, unknown> }).entries['Inbox/a.md']).toBeDefined();
    expect(f.data.someSetting).toBe(true);
  });

  it('a corrupt stored journal stops the store: not loaded, every write refused, nothing overwritten', async () => {
    const f = fakePlugin({ [CAPTURE_JOURNAL_DATA_KEY]: { version: 1, entries: { 'a.md': null } } });
    const store = new CaptureJournalStore(f.plugin);
    expect(await store.load()).toEqual({ ok: false, error: 'capture-journal-corrupt' });
    expect(store.corruption()).toMatch(/malformed/);
    expect(store.isLoaded()).toBe(false);
    expect(await store.mutate((j) => upsertEntry(j, entry('x.md')))).toEqual({ ok: false, error: 'capture-journal-not-loaded' });
    expect(store.mutateLazy((j) => j)).toEqual({ ok: false, error: 'capture-journal-not-loaded' });
    expect(await store.flush()).toEqual({ ok: true, value: undefined });
    expect(f.saves).toHaveLength(0);
    expect(f.data[CAPTURE_JOURNAL_DATA_KEY]).toEqual({ version: 1, entries: { 'a.md': null } });
  });

  it('a data file that cannot be read is corrupt, never a fresh start (nothing is decoded, nothing is written)', async () => {
    const f = fakePlugin();
    (f.plugin as unknown as { loadData: () => Promise<unknown> }).loadData = async () => { throw new Error('EBUSY'); };
    const store = new CaptureJournalStore(f.plugin);
    expect((await store.load()).ok).toBe(false);
    expect(store.corruption()).toMatch(/could not be read/);
    expect(store.isLoaded()).toBe(false);
    expect(await store.mutate((j) => j)).toEqual({ ok: false, error: 'capture-journal-not-loaded' });
    const arr = fakePlugin();
    (arr.plugin as unknown as { loadData: () => Promise<unknown> }).loadData = async () => [];
    const s2 = new CaptureJournalStore(arr.plugin);
    await s2.load();
    expect(s2.corruption()).toMatch(/not an object/);
  });

  it('a second reset does not overwrite the first copy', async () => {
    const f = fakePlugin({ [CAPTURE_JOURNAL_DATA_KEY]: { version: 1, entries: { a: 'one' } } });
    const s1 = new CaptureJournalStore(f.plugin);
    await s1.load();
    await s1.resetCorrupt();
    (f.data as Record<string, unknown>)[CAPTURE_JOURNAL_DATA_KEY] = { version: 1, entries: { b: 'two' } };
    const s2 = new CaptureJournalStore(f.plugin);
    await s2.load();
    await s2.resetCorrupt();
    const kept = f.data[CAPTURE_JOURNAL_BACKUP_DATA_KEY] as Array<{ journal: { entries: Record<string, string> } }>;
    expect(kept.map((k) => Object.keys(k.journal.entries)[0])).toEqual(['a', 'b']);
  });

  it('a reset tells the subscribers', async () => {
    const f = fakePlugin({ [CAPTURE_JOURNAL_DATA_KEY]: 'garbage' });
    const store = new CaptureJournalStore(f.plugin);
    let calls = 0;
    store.subscribe(() => { calls++; });
    await store.load();
    await store.resetCorrupt();
    expect(calls).toBeGreaterThan(0);
  });

  it('an explicit reset keeps a copy of the unreadable data, then starts empty', async () => {
    const stored = { version: 1, entries: { 'a.md': 'broken' } };
    const f = fakePlugin({ [CAPTURE_JOURNAL_DATA_KEY]: stored });
    const store = new CaptureJournalStore(f.plugin);
    await store.load();
    expect((await store.resetCorrupt()).ok).toBe(true);
    expect(f.data[CAPTURE_JOURNAL_BACKUP_DATA_KEY]).toEqual([expect.objectContaining({ journal: stored })]);
    expect(store.corruption()).toBeNull();
    expect(store.isLoaded()).toBe(true);
    expect(Object.keys(store.get().entries)).toEqual([]);
    expect(await store.resetCorrupt()).toEqual({ ok: false, error: 'capture-journal-not-corrupt' });
  });

  it('is not loaded until load() runs, and loads what was persisted', async () => {
    const f = fakePlugin();
    const store = new CaptureJournalStore(f.plugin);
    expect(store.isLoaded()).toBe(false);
    await store.load();
    expect(store.isLoaded()).toBe(true);
    expect(store.get().entries).toEqual({});
    const g = fakePlugin();
    const s2 = new CaptureJournalStore(g.plugin);
    await s2.load();
    await s2.mutate((j) => upsertEntry(j, entry('x.md')));
    const s3 = new CaptureJournalStore(g.plugin);
    await s3.load();
    expect(Object.keys(s3.get().entries)).toEqual(['x.md']);
  });

  it('writes the latest in-memory journal even when saves overlap', async () => {
    const f = fakePlugin();
    const store = new CaptureJournalStore(f.plugin);
    await store.load();
    await Promise.all([
      store.mutate((j) => upsertEntry(j, entry('a.md'))),
      store.mutate((j) => upsertEntry(j, entry('b.md'))),
      store.mutate((j) => upsertEntry(j, entry('c.md'))),
    ]);
    const saved = f.data[CAPTURE_JOURNAL_DATA_KEY] as { entries: Record<string, unknown> };
    expect(Object.keys(saved.entries).sort()).toEqual(['a.md', 'b.md', 'c.md']);
  });

  it('persists observation churn lazily and flushes on dispose', async () => {
    vi.useFakeTimers();
    try {
      const f = fakePlugin();
      const store = new CaptureJournalStore(f.plugin);
      await store.load();
      store.mutateLazy((j) => upsertEntry(j, entry('a.md')));
      store.mutateLazy((j) => upsertEntry(j, entry('b.md')));
      expect(f.saves).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(LAZY_PERSIST_MS + 10);
      expect(f.saves).toHaveLength(1);
      store.mutateLazy((j) => upsertEntry(j, entry('c.md')));
      await store.dispose();
      expect(f.saves).toHaveLength(2);
    } finally { vi.useRealTimers(); }
  });

  it('a transform that changes nothing is not a write', async () => {
    const f = fakePlugin();
    const store = new CaptureJournalStore(f.plugin);
    await store.load();
    await store.mutate((j) => upsertEntry(j, entry('a.md')));
    const before = f.saves.length;
    await store.mutate((j) => j);
    expect(f.saves.length).toBe(before);
  });

  it('a failed save leaves the journal dirty so a later flush retries it', async () => {
    const f = fakePlugin();
    const store = new CaptureJournalStore(f.plugin);
    await store.load();
    const real = (f.plugin as unknown as { saveData: (d: unknown) => Promise<void> }).saveData;
    (f.plugin as unknown as { saveData: () => Promise<void> }).saveData = async () => { throw new Error('disk full'); };
    expect((await store.mutate((j) => upsertEntry(j, entry('a.md')))).ok).toBe(true);
    expect(await store.flush()).toEqual({ ok: false, error: 'capture-journal-unsaved' });
    (f.plugin as unknown as { saveData: (d: unknown) => Promise<void> }).saveData = real;
    expect((await store.flush()).ok).toBe(true);
    expect((f.data[CAPTURE_JOURNAL_DATA_KEY] as { entries: Record<string, unknown> }).entries['a.md']).toBeDefined();
  });

  it('refuses to write before the stored journal was read (it would replace it with an empty one)', async () => {
    const f = fakePlugin({ [CAPTURE_JOURNAL_DATA_KEY]: { version: 1, entries: { 'x.md': entry('x.md') }, tombstones: {}, aliases: {}, counters: {} } });
    const store = new CaptureJournalStore(f.plugin);
    expect(await store.mutate((j) => j)).toEqual({ ok: false, error: 'capture-journal-not-loaded' });
    expect(store.mutateLazy((j) => j)).toEqual({ ok: false, error: 'capture-journal-not-loaded' });
    expect(f.saves).toHaveLength(0);
  });

  it('a transform that throws is an error and changes nothing', async () => {
    const f = fakePlugin();
    const store = new CaptureJournalStore(f.plugin);
    await store.load();
    const boom = () => { throw new Error('bad transform'); };
    expect(await store.mutate(boom)).toEqual({ ok: false, error: 'capture-journal-transform-failed' });
    expect(store.mutateLazy(boom)).toEqual({ ok: false, error: 'capture-journal-transform-failed' });
    expect(f.saves).toHaveLength(0);
  });

  it('a failed load cancels anything scheduled before it: the unreadable journal is never overwritten', async () => {
    vi.useFakeTimers();
    try {
      const f = fakePlugin();
      const store = new CaptureJournalStore(f.plugin);
      await store.load();
      store.mutateLazy((j) => upsertEntry(j, entry('a.md')));
      (f.plugin as unknown as { loadData: () => Promise<unknown> }).loadData = async () => { throw new Error('EBUSY'); };
      expect((await store.load()).ok).toBe(false);
      await vi.advanceTimersByTimeAsync(LAZY_PERSIST_MS * 2);
      expect(f.saves).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a save queued before a failed load does not write over the unreadable journal', async () => {
    const stored = { version: 1, entries: { 'a.md': 'broken-later' } };
    const f = fakePlugin();
    const store = new CaptureJournalStore(f.plugin);
    await store.load();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const real = (f.plugin as unknown as { saveData: (d: unknown) => Promise<void> }).saveData;
    (f.plugin as unknown as { saveData: (d: unknown) => Promise<void> }).saveData = async (d) => { await gate; return real(d); };
    const first = store.mutate((j) => upsertEntry(j, entry('a.md')));
    const second = store.mutate((j) => upsertEntry(j, entry('b.md')));
    (f.plugin as unknown as { loadData: () => Promise<unknown> }).loadData = async () => ({ [CAPTURE_JOURNAL_DATA_KEY]: stored });
    expect((await store.load()).ok).toBe(false);
    release!();
    // non-durable writes never fail the caller; the refused write stays unsaved (checked below)
    expect((await first).ok).toBe(true);
    expect((await second).ok).toBe(true);
    const written = f.data[CAPTURE_JOURNAL_DATA_KEY] as { entries: Record<string, unknown> } | undefined;
    expect(written?.entries?.['b.md']).toBeUndefined();
  });

  it('flush reports a failed save that was already in flight', async () => {
    const f = fakePlugin();
    const store = new CaptureJournalStore(f.plugin);
    await store.load();
    let fail: (() => void) | undefined;
    (f.plugin as unknown as { saveData: () => Promise<void> }).saveData = () => new Promise<void>((_, reject) => { fail = () => reject(new Error('disk full')); });
    const writing = store.mutate((j) => upsertEntry(j, entry('a.md')));
    for (let i = 0; i < 50 && !fail; i++) await new Promise((r) => setTimeout(r, 5));
    const flushing = store.flush();
    fail!();
    await writing;
    expect(await flushing).toEqual({ ok: false, error: 'capture-journal-unsaved' });
  });

  it('flush waits for a save that is already in flight', async () => {
    const f = fakePlugin();
    const store = new CaptureJournalStore(f.plugin);
    await store.load();
    let release: (() => void) | undefined;
    (f.plugin as unknown as { saveData: () => Promise<void> }).saveData = () => new Promise<void>((resolve) => { release = resolve; });
    const writing = store.mutate((j) => upsertEntry(j, entry('a.md')));
    for (let i = 0; i < 50 && !release; i++) await new Promise((r) => setTimeout(r, 5));
    let flushed = false;
    const flushing = store.flush().then(() => { flushed = true; });
    await new Promise((r) => setTimeout(r, 20));
    expect(flushed).toBe(false);
    release!();
    await writing;
    await flushing;
    expect(flushed).toBe(true);
  });

  it('a durable write is an error when the save failed; a normal one only logs', async () => {
    const f = fakePlugin();
    const store = new CaptureJournalStore(f.plugin);
    await store.load();
    (f.plugin as unknown as { saveData: () => Promise<void> }).saveData = async () => { throw new Error('disk full'); };
    expect(await store.mutate((j) => upsertEntry(j, entry('a.md')), { durable: true })).toEqual({ ok: false, error: 'capture-journal-unsaved' });
    expect((await store.mutate((j) => upsertEntry(j, entry('b.md')))).ok).toBe(true);
  });

  it('notifies subscribers and survives a throwing listener', async () => {
    const f = fakePlugin();
    const store = new CaptureJournalStore(f.plugin);
    const seen: number[] = [];
    store.subscribe(() => { throw new Error('boom'); });
    store.subscribe((j) => seen.push(Object.keys(j.entries).length));
    await store.load();
    await store.mutate((j) => upsertEntry(j, entry('a.md')));
    expect(seen).toEqual([0, 1]);
  });
});
