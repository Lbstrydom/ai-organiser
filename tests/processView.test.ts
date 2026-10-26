import { describe, it, expect } from 'vitest';
import { capRows, handbackItems, heldItems, projectProcess, MAX_ROWS_PER_GROUP, type ProcessAdapter, type ProcessItem } from '../src/services/process/processProjection';
import { processViewActive } from '../src/services/process/processGate';
import { DEFAULT_SETTINGS } from '../src/core/settings';
import { REGISTER_BY_FEATURE, registerCommands } from '../src/commands';
import { ok, err } from '../src/core/result';
import { freeze, setState } from '../src/services/aiWorkspaces/handbackJournal';
import type { ApprovalRecord } from '../src/services/inboxSweep/sweepLedger';

const rec = (id: string, states: Array<[string, 'pending' | 'applied' | 'failed', 'decisions' | 'deliverables']>) => {
  let r = freeze(undefined, id, `Inbox/${id}.md`, '2026-10-26', states.map(([i, , s]) => ({ id: i, section: s })));
  for (const [i, st] of states) r = setState(r, i, st);
  return r;
};

describe('Process projection', () => {
  it('lists a hand-back with work left, hides a finished one, a missing note and one that only has deliverables', () => {
    const items = handbackItems({
      a: rec('a', [['1', 'pending', 'decisions'], ['2', 'applied', 'decisions']]),
      b: rec('b', [['1', 'applied', 'decisions']]),
      c: rec('c', [['1', 'pending', 'decisions']]),
      d: rec('d', [['1', 'pending', 'deliverables']]),
      e: rec('e', [['1', 'failed', 'decisions']]),
    }, (p) => p !== 'Inbox/c.md');
    expect(items.map((i) => i.sourceId)).toEqual(['a', 'e']);
    expect(items[0]).toMatchObject({ group: 'handbacks', detail: '1', actions: ['review', 'open'], route: { type: 'handback', path: 'Inbox/a.md' } });
    expect(items[1]).toMatchObject({ heldReason: 'handback-item-failed', actions: ['retry', 'open'] });
  });

  it('lists tasks the export is holding, not the terminal conflict and not healthy ones', () => {
    const task = (id: string, state: string, error?: string) => ({ id, text: `Task ${id}`, context: '', sourcePath: 'a.md', sourceHash: 'h', state, ...(error ? { error } : {}) });
    const approvals = [{ runId: 'r', createdAt: '', reportPath: '', tasks: [task('1', 'failed', 'export-failed'), task('2', 'failed', 'conflict'), task('3', 'routed', 'tasks-due-missing'), task('4', 'routed'), task('5', 'exported')], dispositions: [], reportDone: true, ledgerDone: true }] as unknown as ApprovalRecord[];
    expect(heldItems(approvals).map((i) => [i.sourceId, i.heldReason])).toEqual([['1', 'export-failed'], ['3', 'tasks-due-missing']]);
  });

  it('one failing adapter is its own group\'s error and nothing else\'s', async () => {
    const item: ProcessItem = { sourceId: 'x', group: 'captures', title: 't', actions: ['review'], route: { type: 'command', id: 'review-captures' } };
    const adapters: ProcessAdapter[] = [
      { group: 'captures', read: () => ok([item]) },
      { group: 'handbacks', read: () => err('storage-failed') },
      { group: 'held', read: () => { throw new Error('boom'); } },
    ];
    const out = await projectProcess(adapters);
    expect(out[0]).toEqual({ group: 'captures', items: [item] });
    expect(out[1]).toEqual({ group: 'handbacks', items: [], error: 'storage-failed' });
    expect(out[2]).toEqual({ group: 'held', items: [], error: 'unknown' });
  });

  it('rows beyond the cap are counted, never dropped silently', () => {
    const many = Array.from({ length: MAX_ROWS_PER_GROUP + 7 }, (_, i): ProcessItem => ({ sourceId: String(i), group: 'held', title: 't', actions: ['retry'], route: { type: 'command', id: 'send-tasks-to-google' } }));
    const { shown, more } = capRows(many);
    expect(shown).toHaveLength(MAX_ROWS_PER_GROUP);
    expect(more).toBe(7);
  });
});

describe('Process view gate (off path)', () => {
  it('exists only while a feeding feature is on; default settings have none', () => {
    expect(processViewActive(DEFAULT_SETTINGS)).toBe(false);
    for (const id of ['capture-inbox', 'inbox-sweep', 'ai-workspaces'] as const) {
      expect(processViewActive({ ...DEFAULT_SETTINGS, featureFlags: { [id]: true, provider: true, 'agent-index': true } })).toBe(true);
    }
  });

  it('registerCommands adds the Process command only while a feeding feature is on', () => {
    const run = (settings: typeof DEFAULT_SETTINGS) => {
      const added: string[] = [];
      const plugin = { settings, t: { commands: { openProcess: 'Open Process' } }, app: { workspace: { on: () => ({}) }, vault: { on: () => ({}) } }, addCommand: (c: { id: string }) => { added.push(c.id); }, registerEvent: () => undefined, register: () => undefined };
      try { registerCommands(plugin as never); } catch { /* an unrelated registrar needing more of the plugin: the Process step runs before it */ }
      return added;
    };
    expect(run(DEFAULT_SETTINGS)).not.toContain('open-process');
    expect(run({ ...DEFAULT_SETTINGS, featureFlags: { 'inbox-sweep': true, provider: true } })).toContain('open-process');
    expect(Object.values(REGISTER_BY_FEATURE).flat().map((f) => f?.name)).not.toContain('registerProcessCommands');
  });
});
