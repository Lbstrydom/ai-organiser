import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Plugin } from 'obsidian';

vi.stubGlobal('window', globalThis);

import { CAPTURE_JOURNAL_DATA_KEY, CaptureJournalStore, LAZY_PERSIST_MS } from '../src/services/captureInbox/captureJournalStore';
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

  it('is not loaded until load() runs, and loads what was persisted (fail closed on garbage)', async () => {
    const f = fakePlugin({ [CAPTURE_JOURNAL_DATA_KEY]: 'garbage' });
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
    await store.mutate((j) => upsertEntry(j, entry('a.md')));
    (f.plugin as unknown as { saveData: (d: unknown) => Promise<void> }).saveData = real;
    await store.flush();
    expect((f.data[CAPTURE_JOURNAL_DATA_KEY] as { entries: Record<string, unknown> }).entries['a.md']).toBeDefined();
  });

  it('refuses to write before the stored journal was read (it would replace it with an empty one)', async () => {
    const f = fakePlugin({ [CAPTURE_JOURNAL_DATA_KEY]: { version: 1, entries: { 'x.md': entry('x.md') }, tombstones: {}, aliases: {}, counters: {} } });
    const store = new CaptureJournalStore(f.plugin);
    await expect(store.mutate((j) => j)).rejects.toThrow('capture-journal-not-loaded');
    expect(() => store.mutateLazy((j) => j)).toThrow('capture-journal-not-loaded');
    expect(f.saves).toHaveLength(0);
  });

  it('a durable write rejects when the save failed; a normal one only logs', async () => {
    const f = fakePlugin();
    const store = new CaptureJournalStore(f.plugin);
    await store.load();
    (f.plugin as unknown as { saveData: () => Promise<void> }).saveData = async () => { throw new Error('disk full'); };
    await expect(store.mutate((j) => upsertEntry(j, entry('a.md')), { durable: true })).rejects.toThrow('capture-journal-unsaved');
    await expect(store.mutate((j) => upsertEntry(j, entry('b.md')))).resolves.toBeDefined();
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
