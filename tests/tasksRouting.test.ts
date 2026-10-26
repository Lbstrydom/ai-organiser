/**
 * Google Tasks lists, routing rules and the export decision (GTD cluster B): the pure parts.
 */
import { describe, it, expect } from 'vitest';
import {
  MAX_ROUTING_RULES, MAX_TASKS_LISTS, allLists, decideExport, isValidDue, isoDateInText, kindOfText, listById, normaliseRoutingRules, normaliseTasksLists,
  resolveDestination, resolveTasksLists, updateTasksLists, type ExportContext, type RoutingRule, type TasksListConfig,
} from '../src/services/inboxSweep/tasksRouting';
import { approvalFields, changeDestination, checkRow, defaultRowRouting, needsDate, reviewRoutingFor, type ReviewRouting } from '../src/services/inboxSweep/reviewRouting';
import { classifyTasksScript, type TasksPing } from '../src/services/inboxSweep/tasksExportService';
import { approvedListHashOf } from '../src/services/inboxSweep/tasksScriptTemplate';
import { configuredListIds, selectTasksScript } from '../src/services/inboxSweep/tasksScriptSelect';
import { DEFAULT_SETTINGS, migrateOldSettings } from '../src/core/settings';
import { describeError } from '../src/core/friendlyErrors';
import { en } from '../src/i18n/en';

const L = (id: string, title = id, needsDate = false): TasksListConfig => ({ id, title, needsDate });

describe('list registry: tasksListId is the one authority for which list is main', () => {
  it('normalises: drops empty and duplicate ids, coerces needsDate, caps the list', () => {
    expect(normaliseTasksLists(undefined)).toEqual([]);
    expect(normaliseTasksLists([{ id: ' a ', title: ' T ', needsDate: true }, { id: 'a' }, { id: '' }, null, { id: 'b', needsDate: 'yes' }])).toEqual([L('a', 'T', true), L('b', '', false)]);
    expect(normaliseTasksLists(Array.from({ length: 20 }, (_, i) => ({ id: `l${i}` })))).toHaveLength(MAX_TASKS_LISTS);
  });

  it('reconciles on every read: the entry whose id equals tasksListId is main', () => {
    expect(resolveTasksLists({ tasksListId: 'a', tasksLists: [L('b'), L('a', 'Main', true)] })).toEqual({ main: L('a', 'Main', true), others: [L('b')] });
  });

  it('seeds a main list that has no entry, and an empty tasksListId means no main list at all', () => {
    expect(resolveTasksLists({ tasksListId: 'a', tasksLists: [] }).main).toEqual(L('a', '', false));
    expect(resolveTasksLists({ tasksListId: '', tasksLists: [L('b')] })).toEqual({ main: null, others: [L('b')] });
  });

  it('an older plugin changing tasksListId simply makes another list main; the former main stays among the others when configured', () => {
    const host = { tasksListId: 'a', tasksLists: [L('a', 'A'), L('b', 'B', true)] };
    expect(resolveTasksLists(host).main?.id).toBe('a');
    host.tasksListId = 'b';
    expect(resolveTasksLists(host)).toEqual({ main: L('b', 'B', true), others: [L('a', 'A')] });
  });

  it('duplicate ids collapse and entries beyond the cap are dropped', () => {
    expect(allLists({ tasksListId: 'a', tasksLists: [L('a'), L('a'), L('b')] }).map((l) => l.id)).toEqual(['a', 'b']);
    expect(allLists({ tasksListId: 'a', tasksLists: Array.from({ length: 12 }, (_, i) => L(`l${i}`)) })).toHaveLength(MAX_TASKS_LISTS + 1);
    expect(listById({ tasksListId: 'a', tasksLists: [L('b')] }, 'b')?.id).toBe('b');
    expect(listById({ tasksListId: 'a', tasksLists: [] }, 'zz')).toBeNull();
  });

  it('the one writer saves the main id and the lists together; removing the main list leaves no main', () => {
    const host = { tasksListId: 'a', tasksLists: [L('b')] };
    updateTasksLists(host, (lists, mainId) => ({ lists: [...lists, L('c', 'C', true)], mainId }));
    expect(host).toEqual({ tasksListId: 'a', tasksLists: [L('a', ''), L('b'), L('c', 'C', true)] });
    updateTasksLists(host, (lists) => ({ lists: lists.filter((l) => l.id !== 'a'), mainId: 'a' }));
    expect(host.tasksListId).toBe('');
    expect(host.tasksLists.map((l) => l.id)).toEqual(['b', 'c']);
  });
});

describe('routing rules', () => {
  const host = { tasksListId: 'main', tasksLists: [L('main'), L('waiting', 'Waiting', true), L('home')] };
  const rules: RoutingRule[] = [
    { kind: 'waiting_for', destination: { type: 'list', listId: 'waiting' } },
    { kind: 'next_action', context: '@home', destination: { type: 'list', listId: 'home' } },
    { kind: 'someday_maybe', destination: { type: 'report-only' } },
    { kind: 'project', destination: { type: 'list', listId: 'gone' } },
  ];

  it('first match wins, a context rule matches only that context, and the last implicit rule is the main list', () => {
    expect(resolveDestination(rules, { kind: 'waiting_for', context: '' }, host)).toEqual({ type: 'list', listId: 'waiting' });
    expect(resolveDestination(rules, { kind: 'next_action', context: '@home' }, host)).toEqual({ type: 'list', listId: 'home' });
    expect(resolveDestination(rules, { kind: 'next_action', context: '@office' }, host)).toEqual({ type: 'list', listId: 'main' });
    expect(resolveDestination(rules, { kind: 'someday_maybe', context: '' }, host)).toEqual({ type: 'report-only' });
  });

  it('with no rules every item goes to the main list; a rule pointing at a list that is gone is skipped; no main list means report only', () => {
    expect(resolveDestination([], { kind: 'waiting_for', context: '' }, host)).toEqual({ type: 'list', listId: 'main' });
    expect(resolveDestination(rules, { kind: 'project', context: '' }, host)).toEqual({ type: 'list', listId: 'main' });
    expect(resolveDestination([], { kind: 'next_action', context: '' }, { tasksListId: '', tasksLists: [] })).toEqual({ type: 'report-only' });
  });

  it('normalises stored rules: bad kinds, empty list ids and the agenda destination (not offered yet) are dropped; the cap holds', () => {
    const raw = [
      { kind: 'next_action', context: ' @home ', destination: { type: 'list', listId: ' L ' } },
      { kind: 'nope', destination: { type: 'report-only' } },
      { kind: 'project', destination: { type: 'list', listId: '' } },
      { kind: 'project', destination: { type: 'agenda' } },
      { kind: 'project', context: 'bad context', destination: { type: 'report-only' } },
      null,
    ];
    expect(normaliseRoutingRules(raw)).toEqual([
      { kind: 'next_action', context: '@home', destination: { type: 'list', listId: 'L' } },
      { kind: 'project', destination: { type: 'report-only' } },
    ]);
    expect(normaliseRoutingRules(Array.from({ length: 40 }, () => ({ kind: 'project', destination: { type: 'report-only' } })))).toHaveLength(MAX_ROUTING_RULES);
    expect(normaliseRoutingRules('x')).toEqual([]);
  });

  it('classifies a record written before `kind` existed by its text prefix', () => {
    expect(kindOfText('Waiting: Sam (Sam)')).toBe('waiting_for');
    expect(kindOfText('Project: Launch')).toBe('project');
    expect(kindOfText('Someday: learn')).toBe('someday_maybe');
    expect(kindOfText('Call Dana')).toBe('next_action');
  });
});

describe('dates', () => {
  it('accepts only a real calendar date', () => {
    expect(isValidDue('2026-11-03')).toBe(true);
    for (const bad of ['2026-02-30', '2026-13-01', '2026-1-1', '26-11-03', 'tomorrow', '', null, undefined, 20261103]) expect(isValidDue(bad)).toBe(false);
    expect(isValidDue('2028-02-29')).toBe(true);
    expect(isValidDue('2026-02-29')).toBe(false);
  });

  it('pre-fills only from exactly one ISO date in the text, never from natural language', () => {
    expect(isoDateInText('Send the invoice by 2026-11-03')).toBe('2026-11-03');
    expect(isoDateInText('between 2026-11-03 and 2026-11-05')).toBeNull();
    expect(isoDateInText('see you on 2026-11-03, yes 2026-11-03')).toBe('2026-11-03');
    expect(isoDateInText('next Friday')).toBeNull();
    expect(isoDateInText('2026-02-30')).toBeNull();
  });
});

describe('decideExport precedence', () => {
  const lists = [L('main'), L('dated', 'Dated', true), L('other')];
  const ctx = (over: Partial<ExportContext> = {}): ExportContext => ({ tasksListId: 'main', tasksLists: lists, approvedListIds: ['main', 'dated', 'other'], scriptHasMultiList: true, ...over });

  it('1: exported, or failed with conflict, is complete', () => {
    expect(decideExport({ state: 'exported' }, ctx())).toEqual({ kind: 'complete' });
    expect(decideExport({ state: 'failed', error: 'conflict' }, ctx())).toEqual({ kind: 'complete' });
    expect(decideExport({ state: 'failed', error: 'export-failed' }, ctx())).toMatchObject({ kind: 'send' });
  });

  it('2: a frozen target beats the current lists and rules, even a list that was removed since', () => {
    expect(decideExport({ state: 'routed', target: { listId: 'other' }, destination: { type: 'list', listId: 'dated' } }, ctx())).toEqual({ kind: 'send', listId: 'other', frozen: true });
    expect(decideExport({ state: 'routed', target: { listId: 'removed' } }, ctx({ tasksLists: [L('main')] }))).toEqual({ kind: 'hold', reason: 'tasks-list-not-approved' });
  });

  it('3: report-only is not sent, agenda is not a Google item, no destination means the main list (today)', () => {
    expect(decideExport({ state: 'kept', destination: { type: 'report-only' } }, ctx())).toEqual({ kind: 'not-sent' });
    expect(decideExport({ state: 'routed', destination: { type: 'agenda' } }, ctx())).toEqual({ kind: 'agenda' });
    expect(decideExport({ state: 'reported' }, ctx())).toEqual({ kind: 'send', listId: 'main', frozen: false });
    expect(decideExport({ state: 'reported' }, ctx({ tasksListId: '', tasksLists: [] }))).toEqual({ kind: 'hold', reason: 'tasks-no-list' });
  });

  it('a list that needs a date holds a task without a valid one, and sends one with it', () => {
    const dest = { type: 'list' as const, listId: 'dated' };
    expect(decideExport({ state: 'routed', destination: dest }, ctx())).toEqual({ kind: 'hold', reason: 'tasks-due-missing' });
    expect(decideExport({ state: 'routed', destination: dest, due: '2026-02-30' }, ctx())).toEqual({ kind: 'hold', reason: 'tasks-due-missing' });
    expect(decideExport({ state: 'routed', destination: dest, due: '2026-11-03' }, ctx())).toEqual({ kind: 'send', listId: 'dated', frozen: false });
  });

  it('a list the script does not approve is held, never replaced: an older script asks for a redeploy, a newer one says not approved', () => {
    const dest = { type: 'list' as const, listId: 'other' };
    const old = ctx({ approvedListIds: ['main'], scriptHasMultiList: false });
    expect(decideExport({ state: 'routed', destination: dest }, old)).toEqual({ kind: 'hold', reason: 'tasks-script-lists-outdated' });
    expect(decideExport({ state: 'reported' }, old)).toEqual({ kind: 'send', listId: 'main', frozen: false });
    expect(decideExport({ state: 'routed', destination: dest }, ctx({ approvedListIds: ['main'] }))).toEqual({ kind: 'hold', reason: 'tasks-list-not-approved' });
    // a ping that has not been read says nothing against a list
    expect(decideExport({ state: 'routed', destination: dest }, ctx({ approvedListIds: null }))).toMatchObject({ kind: 'send' });
  });

  it('a hold reason always has guidance with a next step', () => {
    for (const code of ['tasks-no-list', 'tasks-due-missing', 'tasks-list-not-approved', 'tasks-script-lists-outdated', 'tasks-readback-off']) {
      expect(describeError(en, code).nextStep.length).toBeGreaterThan(10);
    }
  });
});

describe('the review: routing only when there is something to choose', () => {
  const plain = { tasksListId: 'main', tasksLists: [] as TasksListConfig[], tasksRoutingRules: [] as RoutingRule[] };

  it('a plain one-list setup offers no controls; another list, a dated main list or any rule does', () => {
    expect(reviewRoutingFor(plain)).toBeNull();
    expect(reviewRoutingFor({ ...plain, tasksListId: '' })).toBeNull();
    expect(reviewRoutingFor({ ...plain, tasksLists: [L('b')] })?.lists.map((l) => l.id)).toEqual(['main', 'b']);
    expect(reviewRoutingFor({ ...plain, tasksLists: [L('main', 'M', true)] })).not.toBeNull();
    expect(reviewRoutingFor({ ...plain, tasksRoutingRules: [{ kind: 'project', destination: { type: 'report-only' } }] })).not.toBeNull();
  });

  const routing: ReviewRouting = { mainId: 'main', lists: [L('main', 'Main'), L('dated', 'Dated', true)], rules: [{ kind: 'waiting_for', destination: { type: 'list', listId: 'dated' } }] };

  it('rules pre-select, an ISO date in the text pre-fills (marked), and a dated list blocks approval until a date is picked', () => {
    const row = defaultRowRouting({ kind: 'waiting_for', context: '', text: 'Hear back from Sam by 2026-11-10' }, routing);
    expect(row).toEqual({ destination: { type: 'list', listId: 'dated' }, due: '2026-11-10', dueFromText: true });
    const blank = defaultRowRouting({ kind: 'waiting_for', context: '', text: 'Hear back from Sam' }, routing);
    expect(blank).toMatchObject({ due: '', dueFromText: false });
    expect(checkRow(blank, routing)).toEqual({ ok: false, reason: 'date-needed', listTitle: 'Dated' });
    expect(checkRow({ ...blank, due: '2026-11-12' }, routing)).toEqual({ ok: true });
    expect(checkRow(defaultRowRouting({ kind: 'next_action', context: '', text: 'x' }, routing), routing)).toEqual({ ok: true });
  });

  it('changing the destination drops a date the new list does not need', () => {
    const dated = { destination: { type: 'list' as const, listId: 'dated' }, due: '2026-11-12', dueFromText: false };
    expect(changeDestination(dated, { type: 'list', listId: 'main' }, routing)).toEqual({ destination: { type: 'list', listId: 'main' }, due: '', dueFromText: false });
    expect(changeDestination(dated, { type: 'report-only' }, routing).due).toBe('');
    expect(changeDestination({ ...dated, due: '' }, { type: 'list', listId: 'dated' }, routing).destination).toEqual({ type: 'list', listId: 'dated' });
    expect(needsDate({ type: 'report-only' }, routing)).toBe(false);
  });

  it('an approval stamps the routing fields: `due` only when the list needed one, a report-only item is not dated', () => {
    expect(approvalFields('waiting_for', { destination: { type: 'list', listId: 'dated' }, due: '2026-11-12', dueFromText: false }, routing)).toEqual({ routingMode: 'routed', kind: 'waiting_for', destination: { type: 'list', listId: 'dated' }, needsDateAtApproval: true, due: '2026-11-12' });
    expect(approvalFields('next_action', { destination: { type: 'list', listId: 'main' }, due: '2026-11-12', dueFromText: false }, routing)).toEqual({ routingMode: 'routed', kind: 'next_action', destination: { type: 'list', listId: 'main' }, needsDateAtApproval: false });
    expect(approvalFields('project', { destination: { type: 'report-only' }, due: '', dueFromText: false }, routing).due).toBeUndefined();
  });
});

describe('script classification and selection', () => {
  const ping = async (over: Partial<TasksPing> & { approvedListId: string | null }): Promise<TasksPing> => ({ scriptVersion: 1, listHash: await approvedListHashOf(over.approvedListId), ...over });

  it('a v1 script approves only the main list: configuring another list makes the script outdated for lists, not broken', async () => {
    expect(await classifyTasksScript(await ping({ approvedListId: 'main' }), 'main', [])).toBe('operational');
    expect(await classifyTasksScript(await ping({ approvedListId: 'main' }), 'main', ['main'])).toBe('operational');
    expect(await classifyTasksScript(await ping({ approvedListId: 'main' }), 'main', ['main', 'b'])).toBe('lists-outdated');
    expect(await classifyTasksScript(await ping({ approvedListId: 'main', scriptVersion: 2, approvedListIds: ['main', 'b'] }), 'main', ['main', 'b'])).toBe('operational');
    expect(await classifyTasksScript(await ping({ approvedListId: 'main', scriptVersion: 2, approvedListIds: ['main'] }), 'main', ['main', 'b'])).toBe('lists-outdated');
    expect(await classifyTasksScript(await ping({ approvedListId: 'other' }), 'main', ['main', 'b'])).toBe('list-mismatch');
    expect(await classifyTasksScript(await ping({ approvedListId: null }), 'main', ['main', 'b'])).toBe('setup');
  });

  it('emits the exact v1 text unless a v2 capability is wanted', () => {
    const host = { tasksListId: 'main', tasksLists: [] as TasksListConfig[], tasksReadBack: false };
    expect(selectTasksScript(host, 'S', 'main').version).toBe(1);
    expect(selectTasksScript({ ...host, tasksLists: [L('main', 'M', true)] }, 'S', 'main').version).toBe(1);
    expect(selectTasksScript({ ...host, tasksLists: [L('b')] }, 'S', 'main').version).toBe(2);
    expect(selectTasksScript({ ...host, tasksReadBack: true }, 'S', 'main').version).toBe(2);
    const v2 = selectTasksScript({ ...host, tasksLists: [L('b')] }, 'S', 'main').text;
    expect(v2).toContain('"APPROVED_LIST_IDS": [\n    "main",\n    "b"\n  ]');
    // the setup deployment cannot create anything and needs no list set: it stays v1 unless read-back is on, when it is v2 with no list
    expect(selectTasksScript({ ...host, tasksLists: [L('b')] }, 'S', null).version).toBe(1);
    expect(selectTasksScript({ ...host, tasksReadBack: true }, 'S', null).text).toContain('"APPROVED_LIST_IDS": []');
    expect(configuredListIds({ tasksListId: 'main', tasksLists: [L('b'), L('c')] })).toEqual(['main', 'b', 'c']);
  });
});

describe('settings', () => {
  it('ships inert defaults, and the lists, rules and opt-ins survive repeated migration', () => {
    expect(DEFAULT_SETTINGS.tasksLists).toEqual([]);
    expect(DEFAULT_SETTINGS.tasksRoutingRules).toEqual([]);
    expect(DEFAULT_SETTINGS.tasksReadBack).toBe(false);
    expect(DEFAULT_SETTINGS.tasksIncludeNoteLink).toBe(false);
    type M = { tasksLists: unknown; tasksRoutingRules: unknown; tasksReadBack: boolean; tasksIncludeNoteLink: boolean };
    const once = migrateOldSettings({ tasksLists: [{ id: 'b', title: 'B', needsDate: true }, { id: '' }], tasksRoutingRules: [{ kind: 'project', destination: { type: 'report-only' } }, { kind: 'x' }], tasksReadBack: true, tasksIncludeNoteLink: 'yes' } as never) as unknown as M;
    expect(once).toMatchObject({ tasksLists: [{ id: 'b', title: 'B', needsDate: true }], tasksRoutingRules: [{ kind: 'project', destination: { type: 'report-only' } }], tasksReadBack: true, tasksIncludeNoteLink: false });
    expect(migrateOldSettings(once as never)).toMatchObject({ tasksLists: once.tasksLists, tasksRoutingRules: once.tasksRoutingRules, tasksReadBack: true });
  });
});
