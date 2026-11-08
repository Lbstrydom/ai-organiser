/**
 * The friendlier surfaces: Adopt note as project and Open project in the command picker, the setup window offering the combined
 * script on a first-time setup, and "Copy script" under Your lists matching what is deployed. Someone with a standalone deployment
 * sees the window, the buttons and the script bytes they always did: that is pinned here against the same strings and builders.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Platform } from 'obsidian';
import { DEFAULT_SETTINGS } from '../src/core/settings';
import { en } from '../src/i18n/en';
import { buildCommandCategories, type CommandCategory, type PickerCommand } from '../src/ui/modals/CommandPickerModal';
import { filterCategoriesByFeature } from '../src/ui/modals/commandPickerViewModel';
import { buildCombinedScript } from '../src/services/googleScript/combinedScript';
import { selectTasksScript } from '../src/services/inboxSweep/tasksScriptSelect';
import { buildTasksScript } from '../src/services/inboxSweep/tasksScriptTemplate';

const notices: string[] = [];
interface Button { label: string; cta: boolean; click: () => void }
const buttons: Button[] = [];
/** The link field of the step drawn last, as the person types into it. */
const typed: { onChange: (v: string) => void; code: (v: string) => void; count: number } = { onChange: () => undefined, code: () => undefined, count: 0 };
/** Confirm of the warning modal, once it was opened. */
const confirmed: { run: (() => void) | null } = { run: null };

vi.mock('obsidian', async (original) => {
  const real = await original<Record<string, unknown>>();
  const button = (): Record<string, unknown> => {
    const b: Button = { label: '', cta: false, click: () => undefined };
    buttons.push(b);
    const api: Record<string, unknown> = {
      setButtonText: (l: string) => { b.label = l; return api; },
      setCta: () => { b.cta = true; return api; },
      setDisabled: () => api,
      setWarning: () => api,
      onClick: (f: () => void) => { b.click = f; return api; },
    };
    return api;
  };
  class FakeSetting {
    setName(): this { return this; }
    setDesc(): this { return this; }
    addButton(f: (b: unknown) => void): this { f(button()); return this; }
    addToggle(f: (t: unknown) => void): this {
      const api: Record<string, unknown> = { setValue: () => api, onChange: () => api };
      f(api);
      return this;
    }
    addText(f: (t: unknown) => void): this {
      const api: Record<string, unknown> = { setValue: () => api, onChange: (f: (v: string) => void) => { if (typed.count++ === 0) typed.onChange = f; else typed.code = f; return api; }, setPlaceholder: () => api, inputEl: { setAttribute: () => undefined } };
      f(api);
      return this;
    }
  }
  class FakeNotice { constructor(m: string) { notices.push(m); } }
  return { ...real, Setting: FakeSetting, Notice: FakeNotice };
});

interface Captured { steps: Array<{ id: string; render: (el: unknown) => void; validate?: () => unknown }>; onFinish: () => Promise<unknown> }
const captured: { current: Captured | null } = { current: null };
vi.mock('../src/ui/modals/GuidedSetupModal', () => ({
  GuidedSetupModal: class {
    constructor(_app: unknown, _t: unknown, opts: Captured) { captured.current = opts; }
    open(): void { /* driven through the captured options */ }
  },
}));

vi.mock('../src/ui/modals/ConfirmationModal', () => ({
  ConfirmationModal: class {
    constructor(_app: unknown, _title: string, _message: string, onConfirm: () => void) { this.run = onConfirm; }
    run: () => void;
    open(): void { confirmed.run = this.run; }
  },
}));

const ping = vi.fn();
const setLists = vi.fn();
vi.mock('../src/services/inboxSweep/tasksExportService', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  pingTasksScript: (...args: unknown[]) => ping(...args),
  setTasksLists: (...args: unknown[]) => setLists(...args),
}));

import { openTasksSetup } from '../src/commands/inboxSweepCommands';
import { copyCombinedScript, copyScriptForDeployment } from '../src/commands/googleScriptCommands';
import { describeError } from '../src/core/friendlyErrors';
import { encodeConnectionCode, parseConnectionInput } from '../src/services/inboxSweep/tasksConnection';
import { registerProjectCommands } from '../src/commands/projectCommands';

const c = en.googleTasks;
const SECRET = 'S3CRET';
/** The buttons of Connect this device, which close every first step. */
const CONNECT = [c.connectButton, c.connectCopyButton, c.connectReplaceButton];
const URL_OK = 'https://script.google.com/macros/s/AKfycbxTEST/exec';
const writeText = vi.fn(async (_text: string) => undefined);

function settingsWith(over: Record<string, unknown> = {}): typeof DEFAULT_SETTINGS {
  return { ...JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), ...over };
}
const pluginWith = (settings: unknown): never => ({
  settings, t: en, app: {}, saveSettings: async () => undefined,
  secretStorageService: { getSecret: async () => SECRET, setSecret: async () => undefined },
}) as never;

/** Draw a step and report its text lines and buttons, in order. */
function draw(id: string): { lines: string[]; labels: string[]; texts: string[]; sections: Array<{ open?: boolean }>; press: (label: string) => void; cta: () => string | undefined } {
  const lines: string[] = [];
  const texts: string[] = [];
  const sections: Array<{ open?: boolean }> = [];
  buttons.length = 0;
  typed.count = 0;
  const el: Record<string, unknown> = {
    setText: (text: string) => { texts.push(text); },
    createEl: (tag: string, o?: { text?: string }) => { if (o?.text) lines.push(o.text); if (tag === 'details') { const box = { ...el }; sections.push(box); return box; } return el; },
    createDiv: () => el,
  };
  captured.current!.steps.find((s) => s.id === id)!.render(el);
  const drawn = [...buttons];
  return {
    lines,
    labels: drawn.map((b) => b.label),
    texts,
    sections,
    press: (label) => drawn.find((b) => b.label === label)!.click(),
    cta: () => drawn.find((b) => b.cta)?.label,
  };
}
const copied = async (): Promise<string> => {
  await vi.waitFor(() => expect(writeText).toHaveBeenCalled());
  const text = writeText.mock.calls.at(-1)![0];
  writeText.mockClear();
  return text;
};

beforeEach(() => {
  captured.current = null;
  notices.length = 0;
  writeText.mockClear();
  ping.mockReset();
  setLists.mockReset();
  Platform.isMobile = false;
  vi.stubGlobal('navigator', { clipboard: { writeText } });
});

describe('project commands in the picker', () => {
  const leaves = (cats: CommandCategory[]): Array<PickerCommand & { category: string }> => cats.flatMap((cat) => {
    const walk = (cmd: PickerCommand): PickerCommand[] => (cmd.subCommands?.length ? cmd.subCommands.flatMap(walk) : [cmd]);
    return cat.commands.flatMap(walk).map((l) => ({ ...l, category: cat.id }));
  });

  it('adopt (Refine) and open (Find) are in All actions with their stage, each running the command of that id', () => {
    const run = vi.fn();
    const all = leaves(buildCommandCategories(en, run));
    expect(all.find((l) => l.id === 'adopt-project')?.category).toBe('all');
    expect(all.find((l) => l.id === 'open-project')?.category).toBe('all');
    expect(all.find((l) => l.id === 'adopt-project')?.stage).toBe('refine');
    expect(all.find((l) => l.id === 'open-project')?.stage).toBe('find');
    const registered: string[] = [];
    registerProjectCommands({ addCommand: (cmd: { id: string }) => registered.push(cmd.id), t: en } as never);
    expect(registered).toEqual(['adopt-project', 'open-project']);
    all.find((l) => l.id === 'adopt-project')!.callback!();
    expect(run).toHaveBeenCalledWith('ai-organiser:adopt-project');
  });

  it('they are gated on the feature that registers the commands, so the picker never offers one that is not registered', () => {
    const cats = buildCommandCategories(en, () => undefined);
    const ids = (on: (f: string) => boolean): string[] => leaves(filterCategoriesByFeature(cats, on)).map((l) => l.id);
    expect(ids(() => true)).toEqual(expect.arrayContaining(['adopt-project', 'open-project']));
    const off = ids((f) => f !== 'google-tasks-export');
    expect(off).not.toContain('adopt-project');
    expect(off).not.toContain('open-project');
  });
});

describe('setup window with a saved link (standalone users see no change)', () => {
  const standalone = (): ReturnType<typeof settingsWith> => settingsWith({ tasksScriptUrl: URL_OK, tasksListId: 'LIST', tasksListName: 'Main' });

  it('the first step is exactly what it was, and copies the standalone setup script byte for byte', async () => {
    openTasksSetup(pluginWith(standalone()));
    const step = draw('script');
    expect(step.lines).toEqual([c.scriptIntro, c.combinedHint, c.step1, c.step2, c.step3, c.step4, c.connectTitle, c.connectIntro]);
    expect(step.labels).toEqual([c.copySetupScript, c.testConnection, ...CONNECT]);
    expect(step.cta()).toBe(c.copySetupScript);
    step.press(c.copySetupScript);
    const text = await copied();
    expect(text).toBe(buildTasksScript({ secret: SECRET, approvedListId: null }));
    expect(notices).toEqual([c.scriptCopied]);
  });

  it('the last step is exactly what it was, and copies the standalone final script byte for byte', async () => {
    const settings = standalone();
    openTasksSetup(pluginWith(settings));
    const step = draw('finish');
    expect(step.lines).toEqual([c.finishIntro.replace('{list}', 'Main'), c.standaloneNote]);
    expect(step.labels).toEqual([c.copyFinalScript, c.copyCombinedInstead, c.testAgain]);
    step.press(c.copyFinalScript);
    expect(await copied()).toBe(selectTasksScript(settings, SECRET, 'LIST').text);
  });
});

describe('setup window on a first-time setup', () => {
  const LOCKED = { secret: SECRET, tasks: { approvedListId: 'LIST', approvedListIds: ['LIST'] } };
  const withList = (): ReturnType<typeof settingsWith> => settingsWith({ tasksListId: 'LIST', tasksListName: 'Main' });

  it('leads with the automatic script, says what it gives up, and keeps the locked scripts reachable', async () => {
    openTasksSetup(pluginWith(settingsWith()));
    const step = draw('script');
    expect(step.cta()).toBe(c.copyAutomaticScript);
    expect(step.labels).toEqual([c.copyAutomaticScript, c.keepLockedCombined, c.keepLockedTasksOnly, c.testConnection, ...CONNECT]);
    expect(step.lines).toContain(c.automaticTradeoff);
    step.press(c.copyAutomaticScript);
    expect(await copied()).toBe(buildCombinedScript({ secret: SECRET, tasks: { automatic: true } }));
  });

  it('after copying it there is nothing more to paste: the last step has no copy button', async () => {
    openTasksSetup(pluginWith(withList()));
    draw('script').press(c.copyAutomaticScript);
    await copied();
    await vi.waitFor(() => expect(draw('finish').labels).toEqual([]));
    expect(draw('finish').lines[0]).toContain('Main');
    expect(captured.current!.steps.find((s) => s.id === 'finish')!.validate!()).toEqual({ ok: true, value: undefined });
  });

  it('Finish approves the lists, confirms with a ping, and only then saves', async () => {
    const settings = withList();
    ping.mockResolvedValueOnce({ ok: true, value: { scriptVersion: 3, approvedListId: null, listHash: 'h', approvedListIds: [], capabilities: ['list-config'], listsRevision: 0 } });
    ping.mockResolvedValueOnce({ ok: true, value: { scriptVersion: 3, approvedListId: 'LIST', listHash: 'h', approvedListIds: ['LIST'], capabilities: ['list-config'], listsRevision: 1 } });
    setLists.mockResolvedValue({ ok: true, value: 1 });
    openTasksSetup(pluginWith(settings));
    draw('script');
    typed.onChange(URL_OK);
    draw('script').press(c.copyAutomaticScript);
    await copied();
    await vi.waitFor(() => expect(draw('finish').labels).toEqual([]));
    expect(await captured.current!.onFinish()).toEqual({ ok: true, value: undefined });
    expect(setLists).toHaveBeenCalledWith(expect.anything(), { main: 'LIST', ids: ['LIST'], expectedRevision: 0 });
    expect(settings).toMatchObject({ tasksAutoLists: true, tasksListsRevision: 1, tasksScriptUrl: URL_OK, tasksListId: 'LIST' });
  });

  it('Finish saves nothing if the deployed script cannot take its lists, and says what to do', async () => {
    const settings = withList();
    ping.mockResolvedValue({ ok: true, value: { scriptVersion: 2, approvedListId: null, listHash: 'h', capabilities: ['multi-list'] } });
    openTasksSetup(pluginWith(settings));
    draw('script');
    typed.onChange(URL_OK);
    draw('script').press(c.copyAutomaticScript);
    await copied();
    await vi.waitFor(() => expect(draw('finish').labels).toEqual([]));
    expect(await captured.current!.onFinish()).toEqual({ ok: false, error: 'tasks-auto-not-deployed' });
    expect(setLists).not.toHaveBeenCalled();
    expect(settings).toMatchObject({ tasksAutoLists: false, tasksScriptUrl: '' });
  });

  it('keeping the lists locked in a combined script carries through to the last step, as before', async () => {
    openTasksSetup(pluginWith(withList()));
    draw('script').press(c.keepLockedCombined);
    expect(await copied()).toBe(buildCombinedScript({ secret: SECRET, tasks: { approvedListId: 'LIST', approvedListIds: ['LIST'] } }));
    await vi.waitFor(() => expect(draw('finish').labels[0]).toBe(c.copyFinalCombined));
    const finish = draw('finish');
    expect(finish.labels).not.toContain(c.copyCombinedInstead);
    finish.press(c.copyFinalCombined);
    expect(await copied()).toBe(buildCombinedScript(LOCKED));
    expect(notices.at(-1)).toBe(en.googleScript.copiedRedeploy);
  });

  it('the locked Tasks-only choice stays reachable and stays standalone to the end', async () => {
    const settings = withList();
    openTasksSetup(pluginWith(settings));
    draw('script').press(c.keepLockedTasksOnly);
    expect(await copied()).toBe(buildTasksScript({ secret: SECRET, approvedListId: null }));
    const finish = draw('finish');
    expect(finish.cta()).toBe(c.copyFinalScript);
    finish.press(c.copyFinalScript);
    expect(await copied()).toBe(selectTasksScript(settings, SECRET, 'LIST').text);
  });

  it('a test of what is deployed outranks what was copied: a standalone answer gives the standalone final script', async () => {
    ping.mockResolvedValue({ ok: true, value: { scriptVersion: 1, approvedListId: null, listHash: 'h' } });
    openTasksSetup(pluginWith(withList()));
    draw('script').press(c.copyAutomaticScript);
    await copied();
    await vi.waitFor(() => expect(draw('finish').labels).toEqual([]));
    draw('script');
    typed.onChange(URL_OK);
    draw('script').press(c.testConnection);
    await vi.waitFor(() => expect(draw('finish').labels[0]).toBe(c.copyFinalScript));
  });

  it('once a test found the combined script, the Tasks-only button cannot overwrite it', async () => {
    ping.mockResolvedValue({ ok: true, value: { scriptVersion: 2, approvedListId: null, listHash: 'h', combined: true } });
    openTasksSetup(pluginWith(withList()));
    draw('script');
    typed.onChange(URL_OK);
    draw('script').press(c.testConnection);
    await vi.waitFor(() => expect(draw('finish').labels[0]).toBe(c.copyFinalCombined));
    draw('script').press(c.keepLockedTasksOnly);
    expect(await copied()).toBe(buildCombinedScript(LOCKED));
  });

  it('a person already on automatic lists never gets a locked script from the setup window', async () => {
    openTasksSetup(pluginWith(settingsWith({ tasksScriptUrl: URL_OK, tasksListId: 'LIST', tasksListName: 'Main', tasksAutoLists: true, tasksListsRevision: 2 })));
    expect(draw('finish').labels).toEqual([]);
    draw('script').press(c.copySetupScript);
    expect(await copied()).toBe(buildCombinedScript({ secret: SECRET, tasks: { automatic: true } }));
  });
});

describe('a device with a script link and no secret of its own', () => {
  const stored: { secret: string | null } = { secret: null };
  const setSecret = vi.fn(async (_id: string, value: string) => { stored.secret = value; });
  const noSecretPlugin = (settings: unknown): never => ({
    settings, t: en, app: {}, saveSettings: async () => undefined,
    secretStorageService: { getSecret: async () => stored.secret, setSecret },
  }) as never;
  const linked = (over: Record<string, unknown> = {}): ReturnType<typeof settingsWith> => settingsWith({ tasksScriptUrl: URL_OK, tasksListId: 'LIST', tasksListName: 'Main', ...over });
  const NOT_CONNECTED = describeError(en, 'tasks-no-secret').message;

  beforeEach(() => { stored.secret = null; setSecret.mockClear(); confirmed.run = null; });

  it('the window says to connect, opens that section, and its copy button makes no secret and copies nothing', async () => {
    openTasksSetup(noSecretPlugin(linked()));
    const step = draw('script');
    await vi.waitFor(() => expect(step.sections[0]?.open).toBe(true));
    expect(step.texts.some((text) => text.startsWith(NOT_CONNECTED))).toBe(true);
    step.press(c.copySetupScript);
    await vi.waitFor(() => expect(notices.at(-1)).toContain(NOT_CONNECTED));
    expect(setSecret).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
  });

  it('a link typed into a first-time window counts too: the automatic script is not copied with a new secret', async () => {
    openTasksSetup(noSecretPlugin(settingsWith()));
    draw('script');
    typed.onChange(URL_OK);
    draw('script').press(c.copyAutomaticScript);
    await vi.waitFor(() => expect(notices.at(-1)).toContain(NOT_CONNECTED));
    expect(setSecret).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
  });

  it('the palette command and Copy script make no secret either', async () => {
    await copyCombinedScript(noSecretPlugin(linked()));
    await copyCombinedScript(noSecretPlugin(linked({ tasksAutoLists: true })));
    await copyScriptForDeployment(noSecretPlugin(linked()), 'LIST');
    expect(setSecret).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
    expect(notices.filter((n) => n.includes(NOT_CONNECTED))).toHaveLength(3);
  });

  it('a first-time setup with no link still creates the secret, as it always did', async () => {
    openTasksSetup(noSecretPlugin(settingsWith()));
    draw('script').press(c.copyAutomaticScript);
    const script = await copied();
    expect(setSecret).toHaveBeenCalledTimes(1);
    expect(script).toBe(buildCombinedScript({ secret: stored.secret!, tasks: { automatic: true } }));
  });

  it('Replace secret does nothing until the warning is confirmed, then copies a script with the new secret', async () => {
    openTasksSetup(noSecretPlugin(linked()));
    draw('script').press(c.connectReplaceButton);
    expect(setSecret).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
    confirmed.run!();
    const script = await copied();
    expect(setSecret).toHaveBeenCalledTimes(1);
    expect(script).toContain(JSON.stringify(stored.secret));
  });

  it('a pasted code that the script accepts connects the window, and the next steps know what is deployed', async () => {
    ping.mockResolvedValue({ ok: true, value: { scriptVersion: 3, approvedListId: 'LIST', listHash: 'h', approvedListIds: ['LIST'], capabilities: ['list-config'], listsRevision: 4, combined: true } });
    const settings = settingsWith();
    openTasksSetup(noSecretPlugin(settings));
    const step = draw('script');
    typed.code(encodeConnectionCode(URL_OK, 'a'.repeat(48)));
    step.press(c.connectButton);
    await vi.waitFor(() => expect(stored.secret).toBe('a'.repeat(48)));
    await vi.waitFor(() => expect(settings).toMatchObject({ tasksScriptUrl: URL_OK, tasksAutoLists: true, tasksListsRevision: 4, tasksListId: 'LIST' }));
    expect(draw('finish').labels).toEqual([]);
  });

  it('Copy connection code copies a code that parses back to this device\'s link and secret', async () => {
    stored.secret = 'b'.repeat(48);
    openTasksSetup(noSecretPlugin(linked()));
    draw('script').press(c.connectCopyButton);
    expect(parseConnectionInput(await copied(), '')).toEqual({ ok: true, value: { url: URL_OK, secret: 'b'.repeat(48) } });
    expect(notices.at(-1)).toBe(c.connectCopied);
  });
});

describe('the palette copy before a list is chosen', () => {
  it('says plainly that the script has no list yet', async () => {
    await copyCombinedScript(pluginWith(settingsWith()));
    expect(writeText.mock.calls[0][0]).toContain('"APPROVED_LIST_ID": ""');
    expect(notices[0].startsWith(en.googleScript.noListYet)).toBe(true);
  });

  it('says nothing extra once a list is chosen', async () => {
    await copyCombinedScript(pluginWith(settingsWith({ tasksListId: 'LIST' })));
    expect(notices).toEqual([en.googleScript.copiedTasks]);
  });

  it('on automatic lists it copies the automatic script, so a redeploy cannot undo the switch', async () => {
    await copyCombinedScript(pluginWith(settingsWith({ tasksListId: 'LIST', tasksAutoLists: true })));
    expect(writeText.mock.calls[0][0]).toBe(buildCombinedScript({ secret: SECRET, tasks: { automatic: true } }));
  });

  it('the status text no longer reads as a failed deploy', () => {
    expect(c.stillSetup).not.toMatch(/old script|still live/i);
    expect(describeError(en, 'tasks-wizard-setup').message).toMatch(/deployed, but it has no list yet/);
  });
});

describe('Copy script under Your lists', () => {
  const lists = (): ReturnType<typeof settingsWith> => settingsWith({ tasksScriptUrl: URL_OK, tasksListId: 'LIST', tasksListName: 'Main' });

  it('a combined deployment gets the combined script, with the redeploy notice', async () => {
    ping.mockResolvedValue({ ok: true, value: { scriptVersion: 2, approvedListId: 'LIST', listHash: 'h', combined: true } });
    await copyScriptForDeployment(pluginWith(lists()), 'LIST');
    expect(writeText.mock.calls[0][0]).toBe(buildCombinedScript({ secret: SECRET, tasks: { approvedListId: 'LIST', approvedListIds: ['LIST'] } }));
    expect(notices).toEqual([en.googleScript.copiedRedeploy]);
  });

  it('a deployment already on the automatic script gets the automatic script, never a locked one over it', async () => {
    ping.mockResolvedValue({ ok: true, value: { scriptVersion: 3, approvedListId: 'LIST', listHash: 'h', combined: true, capabilities: ['list-config'] } });
    await copyScriptForDeployment(pluginWith(lists()), 'LIST');
    expect(writeText.mock.calls[0][0]).toBe(buildCombinedScript({ secret: SECRET, tasks: { automatic: true } }));
  });

  it('a standalone deployment gets the same bytes and the same notice as before', async () => {
    ping.mockResolvedValue({ ok: true, value: { scriptVersion: 1, approvedListId: 'LIST', listHash: 'h' } });
    const settings = lists();
    await copyScriptForDeployment(pluginWith(settings), 'LIST');
    expect(writeText.mock.calls[0][0]).toBe(selectTasksScript(settings, SECRET, 'LIST').text);
    expect(notices).toEqual([c.scriptCopied]);
  });

  it('a check that fails still copies the standalone script and says what to do if the deployment is combined', async () => {
    ping.mockResolvedValue({ ok: false, error: 'script-network' });
    const settings = lists();
    await copyScriptForDeployment(pluginWith(settings), 'LIST');
    expect(writeText.mock.calls[0][0]).toBe(selectTasksScript(settings, SECRET, 'LIST').text);
    expect(notices).toEqual([c.scriptCopiedUnchecked]);
  });

  it('no saved link means nothing is asked and nothing changes', async () => {
    const settings = settingsWith({ tasksListId: 'LIST' });
    await copyScriptForDeployment(pluginWith(settings), 'LIST');
    expect(ping).not.toHaveBeenCalled();
    expect(writeText.mock.calls[0][0]).toBe(selectTasksScript(settings, SECRET, 'LIST').text);
    expect(notices).toEqual([c.scriptCopied]);
  });

  it('on mobile it does not wait on the network before the clipboard write, and warns instead', async () => {
    Platform.isMobile = true;
    await copyScriptForDeployment(pluginWith(lists()), 'LIST');
    expect(ping).not.toHaveBeenCalled();
    expect(notices).toEqual([c.scriptCopiedUnchecked]);
  });
});
