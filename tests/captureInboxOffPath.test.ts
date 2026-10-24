/**
 * Capture inbox: default off and byte-identical when off. No command, event, timer, status-bar item or
 * stored key; inert defaults a migration leaves alone; the inbox sweep behaves exactly as before.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { FEATURE_BY_ID } from '../src/core/features';
import { isFeatureEnabled } from '../src/services/featureService';
import { DEFAULT_SETTINGS, migrateOldSettings } from '../src/core/settings';
import { REGISTER_BY_FEATURE, registerCommands } from '../src/commands/index';
import { registerCaptureInboxCommands } from '../src/commands/captureInboxCommands';
import { sweepBlocker } from '../src/commands/inboxSweepCommands';
import { sweepPolicy, sweepRunPolicy } from '../src/services/inboxSweep/sweepCommit';
import { clearHeldMirror, setCaptureActive, setHeldMirror } from '../src/services/captureInbox/heldMirror';
import { evaluateSetup } from '../src/core/setupState';
import { DATA_ONLY_KEYS } from '../src/core/pluginDataStore';
import { en } from '../src/i18n/en';

afterEach(() => { setCaptureActive(false); clearHeldMirror(); });

const CAPTURE_KEYS = Object.keys(DEFAULT_SETTINGS).filter((k) => k.startsWith('capture'));

describe('capture inbox off path', () => {
  it('is a default-off refine row that needs a provider and has no account boundary', () => {
    const def = FEATURE_BY_ID['capture-inbox'];
    expect(def).toMatchObject({ defaultOn: false, stage: 'refine', requires: ['provider'] });
    expect(def.boundary).toBeUndefined();
    expect(isFeatureEnabled({ featureFlags: {} } as never, 'capture-inbox')).toBe(false);
    expect(isFeatureEnabled({ featureFlags: { 'capture-inbox': 'yes' } } as never, 'capture-inbox')).toBe(false);
    expect(isFeatureEnabled({ featureFlags: { 'capture-inbox': true } } as never, 'capture-inbox')).toBe(true);
  });

  it('registers through its feature only, and nothing at all when off', () => {
    expect(REGISTER_BY_FEATURE['capture-inbox']).toEqual([registerCaptureInboxCommands]);
    const addCommand = vi.fn();
    const plugin = {
      settings: { ...structuredClone(DEFAULT_SETTINGS), featureFlags: {} },
      addCommand, registerEvent: vi.fn(), register: vi.fn(), registerInterval: vi.fn(), registerDomEvent: vi.fn(), addStatusBarItem: vi.fn(),
      app: { vault: { on: vi.fn() }, workspace: { onLayoutReady: vi.fn() } },
      t: {},
    };
    try { registerCommands(plugin as never); } catch { /* other registrars need a fuller app */ }
    const ids = addCommand.mock.calls.map((c) => (c[0] as { id: string }).id);
    expect(ids.filter((i) => /capture/.test(i))).toEqual([]);
    expect(plugin.registerInterval).not.toHaveBeenCalled();
    expect(plugin.registerDomEvent).not.toHaveBeenCalled();
    expect(plugin.addStatusBarItem).not.toHaveBeenCalled();
    expect(plugin.app.vault.on).not.toHaveBeenCalled();
  });

  it('registers its three commands when on', () => {
    const ids: string[] = [];
    const plugin = {
      addCommand: (c: { id: string }) => ids.push(c.id), t: en, register: vi.fn(),
      loadData: async () => { throw new Error('stub'); }, // the runtime start-up fails quietly here; the commands are already registered
      settings: structuredClone(DEFAULT_SETTINGS),
    };
    registerCaptureInboxCommands(plugin as never);
    expect(ids).toEqual(['process-capture-inbox', 'review-captures', 'setup-capture-inbox']);
  });

  it('ships inert defaults that a migration leaves unchanged', () => {
    expect(CAPTURE_KEYS.length).toBeGreaterThan(8);
    expect(DEFAULT_SETTINGS.captureOnOpen).toBe(false);
    expect(DEFAULT_SETTINGS.captureDigitiseImages).toBe(false);
    expect(DEFAULT_SETTINGS.captureRequireMarker).toBe(false);
    expect(DEFAULT_SETTINGS.captureConfirmedAt).toBe('');
    expect(DEFAULT_SETTINGS.captureSince).toBe(0);
    expect(DEFAULT_SETTINGS.captureDestinationRoot).toBe('');
    const migrated = migrateOldSettings(structuredClone(DEFAULT_SETTINGS) as never) as Record<string, unknown>;
    for (const key of CAPTURE_KEYS) expect(migrated[key], key).toEqual((DEFAULT_SETTINGS as unknown as Record<string, unknown>)[key]);
  });

  it('repairs corrupt values and clamps numbers; valid values survive and the migration is idempotent', () => {
    const out = migrateOldSettings({
      captureOnOpen: 'yes', captureOnOpenMaxPerRun: 999, captureMaxPerRun: -1, captureMaxAttachmentMB: 500, captureMinWords: 0,
      captureStabilitySeconds: 'x', captureDestinationRoot: 42, captureConfirmedAt: 7, captureSince: -5,
    }) as Record<string, unknown>;
    expect(out).toMatchObject({
      captureOnOpen: false, captureOnOpenMaxPerRun: 10, captureMaxPerRun: 1, captureMaxAttachmentMB: 25, captureMinWords: 1,
      captureStabilitySeconds: 8, captureDestinationRoot: '', captureConfirmedAt: '', captureSince: 0,
    });
    const once = migrateOldSettings({ captureOnOpen: true, captureMaxPerRun: 20, captureSince: 1234 }) as Record<string, unknown>;
    expect(once).toMatchObject({ captureOnOpen: true, captureMaxPerRun: 20, captureSince: 1234 });
    expect(migrateOldSettings(structuredClone(once))).toEqual(once);
  });

  it('reads as not set up by default; the journal key is data-only and survives a settings save', () => {
    expect(evaluateSetup('capture-inbox', DEFAULT_SETTINGS as never).state).toBe('not-set-up');
    expect(DATA_ONLY_KEYS).toContain('capture-inbox-journal');
    expect(Object.keys(DEFAULT_SETTINGS)).not.toContain('capture-inbox-journal');
  });

  describe('the inbox sweep is unchanged while the feature is off', () => {
    const plugin = (flags: Record<string, boolean>) => ({
      settings: { ...structuredClone(DEFAULT_SETTINGS), sweepInboxFolders: ['Inbox'], sweepExcludedTerms: ['acme'], featureFlags: flags },
    });

    it('sweepRunPolicy is exactly sweepPolicy', () => {
      clearHeldMirror();
      setHeldMirror(['Inbox/held.md']); // even a populated mirror is ignored while the feature is off
      const p = plugin({});
      expect(sweepRunPolicy(p as never)).toEqual(sweepPolicy(p as never));
      clearHeldMirror();
    });

    it('sweepBlocker never mentions the capture inbox', () => {
      clearHeldMirror();
      const p = { ...plugin({ 'inbox-sweep': true }), llmService: {} };
      expect(sweepBlocker(p as never)).not.toBe('sweep-capture-loading');
    });
  });
});
