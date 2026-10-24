/**
 * Characterisation of the inbox sweep setup wizard, written BEFORE its keep-out and inbox-folder steps
 * were shared with the capture inbox. It pins what the wizard decides (step ids, validation, the
 * mapping from the draft to settings, the rollback when saving fails) so the extraction cannot change
 * the sweep's behaviour.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/core/settings';
import { en } from '../src/i18n/en';

interface Captured {
  steps: Array<{ id: string; title: string; validate?: () => { ok: boolean; error?: string } }>;
  onFinish: () => Promise<{ ok: boolean; error?: string }>;
}
const captured: { current: Captured | null } = { current: null };

vi.mock('../src/ui/modals/GuidedSetupModal', () => ({
  GuidedSetupModal: class {
    constructor(_app: unknown, _t: unknown, opts: Captured) { captured.current = opts; }
    open(): void { /* the wizard is driven through its captured options */ }
  },
}));

import { openInboxSweepSetup } from '../src/commands/inboxSweepCommands';

function makePlugin(over: Record<string, unknown> = {}, save: () => Promise<void> = async () => undefined) {
  const settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as Record<string, unknown>;
  Object.assign(settings, over);
  return {
    settings,
    t: en,
    app: { vault: { getMarkdownFiles: () => [], cachedRead: async () => '' } },
    saveSettings: vi.fn(save),
  };
}

function open(over: Record<string, unknown> = {}, save?: () => Promise<void>) {
  const plugin = makePlugin(over, save);
  openInboxSweepSetup(plugin as never);
  const wizard = captured.current!;
  const step = (id: string) => wizard.steps.find((s) => s.id === id)!;
  return { plugin, wizard, step };
}

beforeEach(() => { captured.current = null; });

describe('inbox sweep wizard (characterisation)', () => {
  it('has the three steps in order, titled from the sweep strings', () => {
    const { wizard } = open();
    expect(wizard.steps.map((s) => s.id)).toEqual(['folders', 'keepout', 'preview']);
    expect(wizard.steps.map((s) => s.title)).toEqual([en.inboxSweep.stepFolders, en.inboxSweep.stepKeepOut, en.inboxSweep.stepPreview]);
  });

  it('the folders step needs an inbox folder and a usable report path', () => {
    expect(open({ sweepInboxFolders: [] }).step('folders').validate!()).toEqual({ ok: false, error: 'sweep-no-folders' });
    expect(open({ sweepInboxFolders: ['Inbox'], sweepReportPath: 'Inbox sweep report.md' }).step('folders').validate!().ok).toBe(true);
    expect(open({ sweepInboxFolders: ['Inbox'], sweepReportPath: 'Protected/report.md', protectedFolders: ['Protected'] }).step('folders').validate!()).toEqual({ ok: false, error: 'sweep-report-invalid' });
  });

  it('the keep-out step needs a rule or the explicit "nothing to keep out"', () => {
    expect(open().step('keepout').validate!()).toEqual({ ok: false, error: 'sweep-keepout-required' });
    expect(open({ sweepExcludedTerms: ['acme'] }).step('keepout').validate!().ok).toBe(true);
    expect(open({ sweepExcludedFolders: ['Private'] }).step('keepout').validate!().ok).toBe(true);
    expect(open({ sweepNothingToExclude: true }).step('keepout').validate!().ok).toBe(true);
  });

  it('the keep-out step refuses a property rule that cannot be read', () => {
    expect(open({ sweepExcludedProperties: ['no colon here'] }).step('keepout').validate!()).toEqual({ ok: false, error: 'sweep-property-invalid' });
    expect(open({ sweepExcludedProperties: ['client: acme'] }).step('keepout').validate!().ok).toBe(true);
  });

  it('finishing writes the draft to the settings, marks the setup done, and saves once', async () => {
    const { plugin, wizard } = open({
      sweepInboxFolders: ['Inbox'], sweepExcludedFolders: ['Private'], sweepExcludedTags: ['#work'], sweepExcludedTerms: ['acme'],
      sweepExcludedProperties: ['client: acme'], sweepReportPath: 'Reports/sweep.md',
    });
    const r = await wizard.onFinish();
    expect(r.ok).toBe(true);
    const s = plugin.settings as Record<string, unknown> & { featureSetupCompletedAt: Record<string, string> };
    expect(s.sweepInboxFolders).toEqual(['Inbox']);
    expect(s.sweepExcludedFolders).toEqual(['Private']);
    expect(s.sweepExcludedTags).toEqual(['work']);
    expect(s.sweepExcludedTerms).toEqual(['acme']);
    expect(s.sweepExcludedProperties).toEqual(['client: acme']);
    expect(s.sweepNothingToExclude).toBe(false);
    expect(s.sweepReportPath).toBe('Reports/sweep.md');
    expect(typeof s.featureSetupCompletedAt['inbox-sweep']).toBe('string');
    expect(plugin.saveSettings).toHaveBeenCalledTimes(1);
  });

  it('"nothing to keep out" is kept only when there really are no rules', async () => {
    const a = open({ sweepInboxFolders: ['Inbox'], sweepNothingToExclude: true });
    await a.wizard.onFinish();
    expect(a.plugin.settings.sweepNothingToExclude).toBe(true);
    const b = open({ sweepInboxFolders: ['Inbox'], sweepNothingToExclude: true, sweepExcludedTerms: ['acme'] });
    await b.wizard.onFinish();
    expect(b.plugin.settings.sweepNothingToExclude).toBe(false);
  });

  it('puts everything back when saving fails, and reports a write failure', async () => {
    const { plugin, wizard } = open(
      { sweepInboxFolders: ['Inbox'], sweepExcludedTerms: ['acme'], sweepReportPath: 'Reports/sweep.md' },
      async () => { throw new Error('disk full'); },
    );
    const s = plugin.settings as Record<string, unknown> & { featureSetupCompletedAt: Record<string, string> };
    const before = { inbox: s.sweepInboxFolders, terms: s.sweepExcludedTerms, report: s.sweepReportPath };
    const r = await wizard.onFinish();
    expect(r).toEqual({ ok: false, error: 'write-failed' });
    expect(s.sweepInboxFolders).toBe(before.inbox);
    expect(s.sweepExcludedTerms).toBe(before.terms);
    expect(s.sweepReportPath).toBe(before.report);
    expect(s.featureSetupCompletedAt['inbox-sweep']).toBeUndefined();
  });

  it('refuses to finish with an unusable report path, changing nothing', async () => {
    const { plugin, wizard } = open({ sweepInboxFolders: ['Inbox'], sweepReportPath: '' });
    const r = await wizard.onFinish();
    expect(r.ok).toBe(false);
    expect(plugin.saveSettings).not.toHaveBeenCalled();
    expect(plugin.settings.sweepExcludedTerms).toEqual([]);
  });
});
