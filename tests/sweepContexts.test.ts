/**
 * Customisable sweep contexts (GTD cluster A). The unconfigured path must be exactly what shipped before:
 * `sweepContexts: []` means the built-in set, and nothing about prompt, parser, report, record or wire changes.
 */
import { describe, it, expect } from 'vitest';
import { DEFAULT_SETTINGS, migrateOldSettings } from '../src/core/settings';
import { DEFAULT_SWEEP_CONTEXTS, MAX_SWEEP_CONTEXTS, contextProblems, isDefaultContextSet, isKnownContext, normaliseContexts, resolveSweepContexts } from '../src/services/inboxSweep/sweepContexts';
import { VALID_GTD_CONTEXTS } from '../src/services/validators/constants';
import { buildSweepPrompt, parseSweepResponse } from '../src/services/prompts/sweepPrompts';
import { renderSection, safeContext } from '../src/services/inboxSweep/sweepReport';
import { markReported, newApproval } from '../src/services/inboxSweep/sweepLedger';
import { exportApproved } from '../src/services/inboxSweep/tasksExportService';
import { runSweep, type SweepDeps } from '../src/services/inboxSweep/sweepService';
import { ok } from '../src/core/result';
import { en } from '../src/i18n/en';
import { buildSnapshot } from '../src/services/inboxSweep/noteSnapshot';
import { guardSnapshot, policyRevisionOf } from '../src/services/inboxSweep/sweepGuard';
import type { ScriptTransport } from '../src/services/appsScriptClient';

const policy = { excludedFolders: [], excludedTags: [], excludedProperties: [], excludedTerms: [], protectedFolders: [], maxNoteChars: 20_000 };
const guarded = async (text: string) => {
  const rev = await policyRevisionOf(policy);
  const res = guardSnapshot(await buildSnapshot('Inbox/a.md', text, rev), policy, rev);
  if (!res.allowed) throw new Error('setup');
  return res.snapshot;
};
const TASK_ID = 'aio-00000000-0000-4000-8000-000000000001';

describe('normaliseContexts', () => {
  it('trims, lower-cases, validates, de-duplicates and caps', () => {
    expect(normaliseContexts(['@Phone', ' @errands ', '@phone', 'home', '@', '@has space', '@ok_1-2', 5, null])).toEqual(['@phone', '@errands', '@ok_1-2']);
    expect(normaliseContexts('@a\n@b, @c')).toEqual(['@a', '@b', '@c']);
    expect(normaliseContexts(Array.from({ length: 20 }, (_, i) => `@c${i}`))).toHaveLength(MAX_SWEEP_CONTEXTS);
  });

  it('absent, empty or all-invalid input is [], never the defaults', () => {
    for (const raw of [undefined, null, [], '', ['nope'], 42, {}]) expect(normaliseContexts(raw)).toEqual([]);
  });

  it('reports what was dropped, and why', () => {
    expect(contextProblems('@ok\nbad\n@ok\n@fine')).toEqual([{ line: 'bad', reason: 'invalid' }, { line: '@ok', reason: 'duplicate' }]);
    expect(contextProblems(Array.from({ length: 14 }, (_, i) => `@c${i}`).join('\n'))).toEqual([{ line: '@c12', reason: 'too-many' }, { line: '@c13', reason: 'too-many' }]);
  });
});

describe('resolveSweepContexts', () => {
  it('[] inherits the built-in set (the minutes constant, imported not copied)', () => {
    expect(DEFAULT_SWEEP_CONTEXTS).toBe(VALID_GTD_CONTEXTS);
    expect(resolveSweepContexts({ sweepContexts: [] })).toEqual([...VALID_GTD_CONTEXTS]);
    expect(resolveSweepContexts({})).toEqual([...VALID_GTD_CONTEXTS]);
    expect(resolveSweepContexts({ sweepContexts: ['@phone'] })).toEqual(['@phone']);
    expect(isDefaultContextSet(resolveSweepContexts({ sweepContexts: [] }))).toBe(true);
    expect(isDefaultContextSet(['@phone'])).toBe(false);
    expect(isKnownContext(['@phone'], '@phone')).toBe(true);
  });

  it('the minutes constant is pinned: the sweep set never changes it', () => {
    expect([...VALID_GTD_CONTEXTS]).toEqual(['@office', '@home', '@call', '@computer', '@agenda', '@errand']);
  });
});

describe('settings migration', () => {
  it('defaults to [] and keeps [] after repeated migration; the built-in set is never written', () => {
    expect(DEFAULT_SETTINGS.sweepContexts).toEqual([]);
    const once = migrateOldSettings({}) as unknown as { sweepContexts: string[] };
    expect(once.sweepContexts).toEqual([]);
    const twice = migrateOldSettings(once as never) as unknown as { sweepContexts: string[] };
    expect(twice.sweepContexts).toEqual([]);
  });

  it('keeps a customised list, normalised and stable under repeated migration', () => {
    const first = migrateOldSettings({ sweepContexts: ['@Phone', 'bad', '@phone', '@errands'] } as never) as unknown as { sweepContexts: string[] };
    expect(first.sweepContexts).toEqual(['@phone', '@errands']);
    expect((migrateOldSettings(first as never) as unknown as { sweepContexts: string[] }).sweepContexts).toEqual(['@phone', '@errands']);
  });

  it('a garbage value becomes [] (the built-in set)', () => {
    expect((migrateOldSettings({ sweepContexts: 'x' } as never) as unknown as { sweepContexts: string[] }).sweepContexts).toEqual([]);
  });
});

describe('approval records survive migration with their context snapshot', () => {
  it('keeps a custom snapshot, normalised, and adds none for a built-in approval', () => {
    const task = (extra: Record<string, unknown>) => ({ id: 'aio-00000000-0000-4000-8000-000000000001', text: 'x', context: '@phone', sourcePath: 'a.md', sourceHash: 'h', state: 'reported', ...extra });
    const record = (tasks: unknown[]) => ({ runId: 'run-aaaaaa', createdAt: '2026-10-26', reportPath: 'R.md', tasks, dispositions: [], reportDone: true, ledgerDone: true });
    type Migrated = { sweepApprovals: Array<{ tasks: Array<{ contexts?: string[] }> }> };
    const migrated = migrateOldSettings({ sweepApprovals: [record([task({ contexts: ['@Phone', 'bad'] }), task({ id: 'aio-00000000-0000-4000-8000-000000000002' })])] } as never) as unknown as Migrated;
    expect(migrated.sweepApprovals[0].tasks[0].contexts).toEqual(['@phone']);
    expect(Object.hasOwn(migrated.sweepApprovals[0].tasks[1], 'contexts')).toBe(false);
    const again = migrateOldSettings(migrated as never) as unknown as Migrated;
    expect(again.sweepApprovals[0].tasks[0].contexts).toEqual(['@phone']);
  });
});

describe('prompt and parser', () => {
  it('the default prompt is unchanged: it names exactly the built-in contexts', async () => {
    const note = await guarded('Call Sam on Friday.');
    const prompt = buildSweepPrompt(note, 12_000);
    expect(prompt).toContain('- "context" must be one of: @office, @home, @call, @computer, @agenda, @errand, or an empty string.');
    expect(buildSweepPrompt(note, 12_000, DEFAULT_SWEEP_CONTEXTS)).toBe(prompt);
  });

  it('a custom set is what the prompt offers and the parser keeps', async () => {
    const note = await guarded('Call Sam on Friday.');
    expect(buildSweepPrompt(note, 12_000, ['@phone', '@errands'])).toContain('must be one of: @phone, @errands, or an empty string.');
    const raw = JSON.stringify({ gtd_processing: { next_actions: [
      { text: 'Call Sam', context: '@phone', evidence: 'Call Sam on Friday' },
      { text: 'Call Sam again', context: '@call', evidence: 'Call Sam on Friday' },
    ], waiting_for: [], projects: [], someday_maybe: [] } });
    const custom = parseSweepResponse(raw, 'Call Sam on Friday.', ['@phone']);
    expect(custom.items.map((i) => i.context)).toEqual(['@phone', '']);
    // default behaviour: @call known, @phone blanked
    expect(parseSweepResponse(raw, 'Call Sam on Friday.').items.map((i) => i.context)).toEqual(['', '@call']);
  });
});

describe('report and record', () => {
  const task = (over: Record<string, unknown> = {}) => ({ id: TASK_ID, text: 'Call Sam', context: '@phone', sourcePath: 'Inbox/a.md', ...over });

  it('safeContext follows the set it is given, the built-in one by default', () => {
    expect(safeContext('@home')).toBe('@home');
    expect(safeContext('@phone')).toBe('');
    expect(safeContext('@phone', ['@phone'])).toBe('@phone');
  });

  it('the report line keeps a custom context only under the snapshot the task was approved with', () => {
    const withSnapshot = renderSection('run-aaaaaa', '2026-10-26', [task({ contexts: ['@phone'] })]);
    const without = renderSection('run-aaaaaa', '2026-10-26', [task()]);
    if (!withSnapshot.ok || !without.ok) throw new Error('render');
    expect(withSnapshot.value).toContain('Call Sam @phone (');
    expect(without.value).not.toContain('@phone');
  });

  it('an approval made under the built-in set carries no snapshot key (byte-identical record)', () => {
    const plain = newApproval({ runId: 'run-1', now: 'T', reportPath: 'R.md', tasks: [{ id: TASK_ID, text: 'x', context: '@home', sourcePath: 'a.md', sourceHash: 'h' }], dispositions: [] });
    expect(Object.keys(plain.tasks[0]).sort()).toEqual(['context', 'id', 'sourceHash', 'sourcePath', 'state', 'text']);
    const custom = newApproval({ runId: 'run-1', now: 'T', reportPath: 'R.md', tasks: [{ id: TASK_ID, text: 'x', context: '@phone', sourcePath: 'a.md', sourceHash: 'h', contexts: ['@phone'] }], dispositions: [] });
    expect(custom.tasks[0].contexts).toEqual(['@phone']);
  });

  it('the Google title keeps the custom context under its snapshot, and blanks a stray one without it', async () => {
    const sent: Array<{ title: string }> = [];
    const transport: ScriptTransport = async ({ body }) => {
      const req = JSON.parse(body);
      sent.push(...req.tasks);
      return { status: 200, text: JSON.stringify({ ok: true, results: req.tasks.map((t: { exportId: string }) => ({ exportId: t.exportId, status: 'created' })) }) };
    };
    const id = (n: number) => `aio-0000000${n}-0000-4000-8000-000000000000`;
    const record = markReported(newApproval({ runId: 'run-1', now: 'T', reportPath: 'R.md', dispositions: [], tasks: [
      { id: id(1), text: 'Call Sam', context: '@phone', sourcePath: 'a.md', sourceHash: 'h', contexts: ['@phone'] },
      { id: id(2), text: 'Buy milk', context: '@phone', sourcePath: 'b.md', sourceHash: 'h' },
      { id: id(3), text: 'Pay rent', context: '@home', sourcePath: 'c.md', sourceHash: 'h' },
    ] }));
    await exportApproved(record, { url: 'https://script.google.com/macros/s/AKfycbxTEST/exec', secret: 'S', listId: 'L', checkSource: async () => 'ok', persist: async () => ok(undefined), transport });
    expect(sent.map((t) => t.title)).toEqual(['Call Sam @phone', 'Buy milk', 'Pay rent @home']);
  });
});

describe('one immutable set per run', () => {
  it('the run reads the set once; a change mid-run does not reach the prompt or the result', async () => {
    let live = ['@phone'];
    const prompts: string[] = [];
    const text = 'Call Sam on Friday.';
    const deps: SweepDeps = {
      candidates: () => ['Inbox/a.md', 'Inbox/b.md'],
      readText: async () => text,
      complete: async (prompt) => { prompts.push(prompt); live = ['@changed']; return ok(JSON.stringify({ gtd_processing: { next_actions: [{ text: 'Call Sam', context: '@phone', evidence: 'Call Sam on Friday' }], waiting_for: [], projects: [], someday_maybe: [] } })); },
      policy: () => policy,
      ledger: () => ({}),
      contexts: () => live,
    };
    const result = await runSweep(deps, { maxNotes: 5, maxChars: 12_000 });
    if (!result.ok) throw new Error('run');
    expect(result.value.contexts).toEqual(['@phone']);
    expect(prompts.every((p) => p.includes('must be one of: @phone,'))).toBe(true);
    expect(result.value.notes[0].items[0].context).toBe('@phone');
  });

  it('with no contexts dependency the run uses the built-in set', async () => {
    const deps: SweepDeps = { candidates: () => [], readText: async () => null, complete: async () => ok(''), policy: () => policy, ledger: () => ({}) };
    const result = await runSweep(deps, { maxNotes: 5, maxChars: 12_000 });
    if (!result.ok) throw new Error('run');
    expect(result.value.contexts).toEqual([...DEFAULT_SWEEP_CONTEXTS]);
  });
});

describe('strings', () => {
  it('the contexts setting copy is present and in sentence case', () => {
    const s = en.inboxSweep;
    expect(s.contextsName).toBe('Contexts');
    expect(s.contextsReset).toBe('Reset to the built-in set');
    expect(s.contextsDropped).toContain('{lines}');
  });
});
