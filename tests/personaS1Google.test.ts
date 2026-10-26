/**
 * Persona S1 fixes, Google side: the combined script is recognised from a ping, the main list shows its saved name instead
 * of its raw id, the Tasks wizard says why Finish is blocked, and the status row never claims Drive access a Tasks-only
 * setup does not have.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/core/settings';
import { en } from '../src/i18n/en';
import { pingTasksScript } from '../src/services/inboxSweep/tasksExportService';
import { resolveTasksLists, allLists } from '../src/services/inboxSweep/tasksRouting';
import { describeError } from '../src/core/friendlyErrors';
import type { ScriptTransport } from '../src/services/appsScriptClient';

interface Captured { steps: Array<{ id: string; validate?: () => { ok: boolean; error?: string } }>; }
const captured: { current: Captured | null } = { current: null };
vi.mock('../src/ui/modals/GuidedSetupModal', () => ({
  GuidedSetupModal: class {
    constructor(_app: unknown, _t: unknown, opts: Captured) { captured.current = opts; }
    open(): void { /* driven through the captured options */ }
  },
}));
import { openTasksSetup } from '../src/commands/inboxSweepCommands';

const URL_OK = 'https://script.google.com/macros/s/AKfycbxTEST/exec';
const reply = (body: unknown): ScriptTransport => async () => ({ status: 200, text: JSON.stringify(body) });

beforeEach(() => { captured.current = null; });

describe('combined script detection', () => {
  it('a ping that carries a modules block is the combined script', async () => {
    const combined = await pingTasksScript({ url: URL_OK, secret: 'S', transport: reply({ ok: true, scriptVersion: 2, approvedListId: 'L', listHash: 'h', modules: { tasks: { version: 2, capabilities: ['upsert'] } } }) });
    expect(combined.ok && combined.value.combined).toBe(true);
    const standalone = await pingTasksScript({ url: URL_OK, secret: 'S', transport: reply({ ok: true, scriptVersion: 2, approvedListId: 'L', listHash: 'h' }) });
    expect(standalone.ok && standalone.value.combined).toBeUndefined();
  });
});

describe('list names', () => {
  it('the main list shows its saved name, not its raw id', () => {
    const host = { tasksListId: 'L_MAIN', tasksLists: [], tasksListName: 'My Tasks' };
    expect(resolveTasksLists(host).main?.title).toBe('My Tasks');
    expect(allLists(host)[0].title).toBe('My Tasks');
  });
  it('a title already on the list entry wins, and no saved name leaves it empty', () => {
    expect(resolveTasksLists({ tasksListId: 'a', tasksLists: [{ id: 'a', title: 'Work', needsDate: false }], tasksListName: 'My Tasks' }).main?.title).toBe('Work');
    expect(resolveTasksLists({ tasksListId: 'a', tasksLists: [] }).main?.title).toBe('');
  });
});

describe('Tasks wizard Finish', () => {
  it('says the script has not been checked, in the wizard\'s own words, until a check passed', () => {
    const settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    openTasksSetup({ settings, t: en, app: {}, saveSettings: async () => undefined, secretStorageService: { getSecret: async () => null } } as never);
    const finish = captured.current!.steps.find((s) => s.id === 'finish')!;
    const res = finish.validate!() as { ok: boolean; error?: string };
    expect(res).toEqual({ ok: false, error: 'tasks-wizard-unchecked' });
    const guidance = describeError(en, res.error!);
    expect(guidance.message).toMatch(/not been checked/);
    expect(guidance.nextStep).not.toMatch(/Open the Google Tasks setup/);
  });
});
