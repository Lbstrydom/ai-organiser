/**
 * Inbox sweep and Google Tasks export: default off and byte-identical when off. Neither registers a
 * command or a listener, the export needs the sweep, and the stored state is inert.
 */
import { describe, it, expect, vi } from 'vitest';
import { FEATURE_BY_ID } from '../src/core/features';
import { isFeatureEnabled } from '../src/services/featureService';
import { DEFAULT_SETTINGS, migrateOldSettings } from '../src/core/settings';
import { REGISTER_BY_FEATURE, registerCommands } from '../src/commands/index';
import { registerGoogleTasksCommands, registerInboxSweepCommands } from '../src/commands/inboxSweepCommands';
import { evaluateSetup } from '../src/core/setupState';
import { en } from '../src/i18n/en';

describe('inbox sweep off path', () => {
	it('is a default-off refine row that needs a provider', () => {
		const def = FEATURE_BY_ID['inbox-sweep'];
		expect(def).toMatchObject({ defaultOn: false, stage: 'refine', requires: ['provider'] });
		expect(isFeatureEnabled({ featureFlags: {} } as never, 'inbox-sweep')).toBe(false);
		expect(isFeatureEnabled({ featureFlags: { 'inbox-sweep': 'yes' } } as never, 'inbox-sweep')).toBe(false);
		expect(isFeatureEnabled({ featureFlags: { 'inbox-sweep': true } } as never, 'inbox-sweep')).toBe(true);
	});

	it('the Google Tasks export is an external-account row that needs the sweep', () => {
		const def = FEATURE_BY_ID['google-tasks-export'];
		expect(def).toMatchObject({ defaultOn: false, boundary: ['external-account'], requires: ['inbox-sweep'] });
		expect(isFeatureEnabled({ featureFlags: { 'google-tasks-export': true } } as never, 'google-tasks-export')).toBe(false); // sweep is off
		expect(isFeatureEnabled({ featureFlags: { 'google-tasks-export': true, 'inbox-sweep': true } } as never, 'google-tasks-export')).toBe(true);
	});

	it('registers through its features only, and nothing when off', () => {
		expect(REGISTER_BY_FEATURE['inbox-sweep']).toEqual([registerInboxSweepCommands]);
		expect(REGISTER_BY_FEATURE['google-tasks-export']).toEqual([registerGoogleTasksCommands]);
		const addCommand = vi.fn();
		const registerEvent = vi.fn();
		const plugin = {
			settings: { ...structuredClone(DEFAULT_SETTINGS), featureFlags: {} },
			addCommand, registerEvent, register: vi.fn(), registerDomEvent: vi.fn(),
			app: { vault: { on: vi.fn() } },
			t: {},
		};
		try { registerCommands(plugin as never); } catch { /* context menu needs a full app */ }
		const ids = addCommand.mock.calls.map((c) => (c[0] as { id: string }).id);
		expect(ids.filter((i) => /sweep|google|tasks/.test(i))).toEqual([]);
		expect(plugin.app.vault.on).not.toHaveBeenCalled();
	});

	it('registers its commands and the rename tracking when on', () => {
		const ids: string[] = [];
		const registerEvent = vi.fn();
		const plugin = { addCommand: (c: { id: string }) => ids.push(c.id), registerEvent, app: { vault: { on: vi.fn() } }, t: en };
		registerInboxSweepCommands(plugin as never);
		registerGoogleTasksCommands(plugin as never);
		expect(ids).toEqual(['sweep-inbox', 'setup-inbox-sweep', 'send-tasks-to-google', 'setup-google-tasks']);
		expect(registerEvent).toHaveBeenCalledTimes(1);
	});

	it('ships inert defaults that a migration leaves unchanged', () => {
		expect(DEFAULT_SETTINGS.sweepInboxFolders).toEqual([]);
		expect(DEFAULT_SETTINGS.sweepNothingToExclude).toBe(false);
		expect(DEFAULT_SETTINGS.sweepLedger).toEqual({});
		expect(DEFAULT_SETTINGS.sweepApprovals).toEqual([]);
		expect(DEFAULT_SETTINGS.tasksScriptUrl).toBe('');
		expect(DEFAULT_SETTINGS.tasksLastTest).toBeNull();
		const migrated = migrateOldSettings(structuredClone(DEFAULT_SETTINGS) as never) as Record<string, unknown>;
		for (const key of Object.keys(DEFAULT_SETTINGS).filter((k) => /^(sweep|tasks)/.test(k))) {
			expect(migrated[key], key).toEqual((DEFAULT_SETTINGS as unknown as Record<string, unknown>)[key]);
		}
	});

	it('both read as not set up by default', () => {
		expect(evaluateSetup('inbox-sweep', DEFAULT_SETTINGS as never).state).toBe('not-set-up');
		expect(evaluateSetup('google-tasks', DEFAULT_SETTINGS as never).state).toBe('not-set-up');
	});
});
