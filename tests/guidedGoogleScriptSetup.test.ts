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
const typed: { onChange: (v: string) => void } = { onChange: () => undefined };

vi.mock('obsidian', async (original) => {
  const real = await original<Record<string, unknown>>();
  const button = (): Record<string, unknown> => {
    const b: Button = { label: '', cta: false, click: () => undefined };
    buttons.push(b);
    const api: Record<string, unknown> = {
      setButtonText: (l: string) => { b.label = l; return api; },
      setCta: () => { b.cta = true; return api; },
      setDisabled: () => api,
      onClick: (f: () => void) => { b.click = f; return api; },
    };
    return api;
  };
  class FakeSetting {
    setName(): this { return this; }
    setDesc(): this { return this; }
    addButton(f: (b: unknown) => void): this { f(button()); return this; }
    addText(f: (t: unknown) => void): this {
      const api: Record<string, unknown> = { setValue: () => api, onChange: (f: (v: string) => void) => { typed.onChange = f; return api; }, setPlaceholder: () => api, inputEl: { setAttribute: () => undefined } };
      f(api);
      return this;
    }
  }
  class FakeNotice { constructor(m: string) { notices.push(m); } }
  return { ...real, Setting: FakeSetting, Notice: FakeNotice };
});

interface Captured { steps: Array<{ id: string; render: (el: unknown) => void }> }
const captured: { current: Captured | null } = { current: null };
vi.mock('../src/ui/modals/GuidedSetupModal', () => ({
  GuidedSetupModal: class {
    constructor(_app: unknown, _t: unknown, opts: Captured) { captured.current = opts; }
    open(): void { /* driven through the captured options */ }
  },
}));

const ping = vi.fn();
vi.mock('../src/services/inboxSweep/tasksExportService', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  pingTasksScript: (...args: unknown[]) => ping(...args),
}));

import { openTasksSetup } from '../src/commands/inboxSweepCommands';
import { copyScriptForDeployment } from '../src/commands/googleScriptCommands';
import { registerProjectCommands } from '../src/commands/projectCommands';

const c = en.googleTasks;
const SECRET = 'S3CRET';
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
function draw(id: string): { lines: string[]; labels: string[]; press: (label: string) => void; cta: () => string | undefined } {
  const lines: string[] = [];
  buttons.length = 0;
  const el = {
    createEl: (_tag: string, o: { text: string }) => { lines.push(o.text); },
    createDiv: () => ({ setText: () => undefined }),
  };
  captured.current!.steps.find((s) => s.id === id)!.render(el);
  const drawn = [...buttons];
  return {
    lines,
    labels: drawn.map((b) => b.label),
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
  Platform.isMobile = false;
  vi.stubGlobal('navigator', { clipboard: { writeText } });
});

describe('project commands in the picker', () => {
  const leaves = (cats: CommandCategory[]): Array<PickerCommand & { category: string }> => cats.flatMap((cat) => {
    const walk = (cmd: PickerCommand): PickerCommand[] => (cmd.subCommands?.length ? cmd.subCommands.flatMap(walk) : [cmd]);
    return cat.commands.flatMap(walk).map((l) => ({ ...l, category: cat.id }));
  });

  it('adopt sits in Refine and open in Find, each running the command of that id', () => {
    const run = vi.fn();
    const all = leaves(buildCommandCategories(en, run));
    expect(all.find((l) => l.id === 'adopt-project')?.category).toBe('refine');
    expect(all.find((l) => l.id === 'open-project')?.category).toBe('find');
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
    expect(step.lines).toEqual([c.scriptIntro, c.combinedHint, c.step1, c.step2, c.step3, c.step4]);
    expect(step.labels).toEqual([c.copySetupScript, c.testConnection]);
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
  it('leads with the combined script, and that is the script it copies', async () => {
    openTasksSetup(pluginWith(settingsWith()));
    const step = draw('script');
    expect(step.cta()).toBe(c.copyCombinedScript);
    expect(step.labels).toEqual([c.copyCombinedScript, c.copyTasksOnly, c.testConnection]);
    step.press(c.copyCombinedScript);
    expect(await copied()).toBe(buildCombinedScript({ secret: SECRET, tasks: { approvedListId: null, approvedListIds: [] } }));
  });

  it('after copying it, the last step copies the combined script even if no test was run', async () => {
    const settings = settingsWith({ tasksListId: 'LIST', tasksListName: 'Main' });
    openTasksSetup(pluginWith(settings));
    draw('script').press(c.copyCombinedScript);
    await copied();
    await vi.waitFor(() => expect(draw('finish').labels[0]).toBe(c.copyFinalCombined));
    const finish = draw('finish');
    expect(finish.labels).not.toContain(c.copyCombinedInstead);
    expect(finish.lines).not.toContain(c.standaloneNote);
    finish.press(c.copyFinalCombined);
    expect(await copied()).toBe(buildCombinedScript({ secret: SECRET, tasks: { approvedListId: 'LIST', approvedListIds: ['LIST'] } }));
    expect(notices.at(-1)).toBe(en.googleScript.copiedRedeploy);
  });

  it('the Tasks-only choice stays reachable and stays standalone to the end', async () => {
    const settings = settingsWith({ tasksListId: 'LIST', tasksListName: 'Main' });
    openTasksSetup(pluginWith(settings));
    draw('script').press(c.copyTasksOnly);
    expect(await copied()).toBe(buildTasksScript({ secret: SECRET, approvedListId: null }));
    const finish = draw('finish');
    expect(finish.cta()).toBe(c.copyFinalScript);
    finish.press(c.copyFinalScript);
    expect(await copied()).toBe(selectTasksScript(settings, SECRET, 'LIST').text);
  });

  it('a test of what is deployed outranks what was copied: a standalone answer gives the standalone final script', async () => {
    ping.mockResolvedValue({ ok: true, value: { scriptVersion: 1, approvedListId: null, listHash: 'h' } });
    openTasksSetup(pluginWith(settingsWith({ tasksListId: 'LIST', tasksListName: 'Main' })));
    draw('script').press(c.copyCombinedScript);
    await copied();
    await vi.waitFor(() => expect(draw('finish').labels[0]).toBe(c.copyFinalCombined));
    draw('script');
    typed.onChange(URL_OK);
    draw('script').press(c.testConnection);
    await vi.waitFor(() => expect(draw('finish').labels[0]).toBe(c.copyFinalScript));
  });

  it('once a test found the combined script, the Tasks-only button cannot overwrite it', async () => {
    ping.mockResolvedValue({ ok: true, value: { scriptVersion: 2, approvedListId: null, listHash: 'h', combined: true } });
    openTasksSetup(pluginWith(settingsWith({ tasksListId: 'LIST', tasksListName: 'Main' })));
    draw('script');
    typed.onChange(URL_OK);
    draw('script').press(c.testConnection);
    await vi.waitFor(() => expect(draw('finish').labels[0]).toBe(c.copyFinalCombined));
    draw('script').press(c.copyTasksOnly);
    expect(await copied()).toBe(buildCombinedScript({ secret: SECRET, tasks: { approvedListId: 'LIST', approvedListIds: ['LIST'] } }));
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
