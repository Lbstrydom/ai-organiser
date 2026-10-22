/**
 * Vault upkeep: default off and byte-identical when off. No command, no timer, no listener, no
 * stored state beyond inert defaults; the setup health is not set up; settings migrate safely.
 */
import { describe, it, expect, vi } from 'vitest';
import { FEATURE_BY_ID } from '../src/core/features';
import { isFeatureEnabled } from '../src/services/featureService';
import { DEFAULT_SETTINGS, migrateOldSettings } from '../src/core/settings';
import { REGISTER_BY_FEATURE, registerCommands } from '../src/commands/index';
import { registerUpkeepCommands } from '../src/commands/upkeepCommands';
import { evaluateSetup, toFolderSet } from '../src/core/setupState';
import { en } from '../src/i18n/en';

describe('vault upkeep off path', () => {
	it('is a default-off maintain row with no dependencies', () => {
		const def = FEATURE_BY_ID['vault-upkeep'];
		expect(def).toMatchObject({ defaultOn: false, stage: 'maintain', requires: [] });
		expect(def.boundary).toBeUndefined();
		expect(isFeatureEnabled({ featureFlags: {} } as never, 'vault-upkeep')).toBe(false);
		expect(isFeatureEnabled({ featureFlags: { 'vault-upkeep': 'yes' } } as never, 'vault-upkeep')).toBe(false);
		expect(isFeatureEnabled({ featureFlags: { 'vault-upkeep': true } } as never, 'vault-upkeep')).toBe(true);
	});

	it('registers through its feature only, and nothing at all when off', () => {
		expect(REGISTER_BY_FEATURE['vault-upkeep']).toEqual([registerUpkeepCommands]);
		const addCommand = vi.fn();
		const plugin = {
			settings: { ...structuredClone(DEFAULT_SETTINGS), featureFlags: {} },
			addCommand, registerEvent: vi.fn(), register: vi.fn(), registerInterval: vi.fn(), registerDomEvent: vi.fn(),
			app: { vault: { on: vi.fn() } },
			t: {},
		};
		try { registerCommands(plugin as never); } catch { /* context menu needs a full app */ }
		const ids = addCommand.mock.calls.map((c) => (c[0] as { id: string }).id);
		expect(ids.filter((i) => /upkeep/.test(i))).toEqual([]);
		expect(plugin.registerInterval).not.toHaveBeenCalled();
		expect(plugin.app.vault.on).not.toHaveBeenCalled();
	});

	it('registers its three commands when on', () => {
		const ids: string[] = [];
		registerUpkeepCommands({ addCommand: (c: { id: string }) => ids.push(c.id), t: en } as never);
		expect(ids).toEqual(['run-vault-upkeep', 'setup-vault-upkeep', 'open-upkeep-review']);
	});

	it('ships inert defaults that a migration leaves unchanged', () => {
		expect(DEFAULT_SETTINGS.upkeepInterval).toBe('off');
		expect(DEFAULT_SETTINGS.upkeepTasks).toEqual({ agentIndex: false, inventories: false, attachments: false });
		expect(DEFAULT_SETTINGS.upkeepAutoRefreshIndex).toBe(false);
		expect(DEFAULT_SETTINGS.upkeepRunOnMobile).toBe(false);
		expect(DEFAULT_SETTINGS.upkeepLastRun).toBeNull();
		expect(DEFAULT_SETTINGS.upkeepLastProposals).toBeNull();
		const migrated = migrateOldSettings(structuredClone(DEFAULT_SETTINGS) as never) as Record<string, unknown>;
		for (const key of Object.keys(DEFAULT_SETTINGS).filter((k) => k.startsWith('upkeep'))) {
			expect(migrated[key], key).toEqual((DEFAULT_SETTINGS as unknown as Record<string, unknown>)[key]);
		}
	});

	it('reads as not set up by default, and ready after the wizard with an existing report folder', () => {
		expect(evaluateSetup('vault-upkeep', DEFAULT_SETTINGS as never).state).toBe('not-set-up');
		const done = { ...structuredClone(DEFAULT_SETTINGS), featureSetupCompletedAt: { 'vault-upkeep': 'T' } } as never;
		expect(evaluateSetup('vault-upkeep', done).state).toBe('ready');
		const withFolder = { ...(done as object), upkeepReportFolder: 'Reports' } as never;
		expect(evaluateSetup('vault-upkeep', withFolder, { existingFolders: toFolderSet(['Other']) })).toEqual({ state: 'needs-attention', reason: 'missing-folder' });
		expect(evaluateSetup('vault-upkeep', withFolder, { existingFolders: toFolderSet(['reports']) }).state).toBe('ready');
	});
});

describe('settings migration', () => {
	it('repairs corrupt values to the defaults and clamps numbers', () => {
		const out = migrateOldSettings({
			upkeepInterval: 'sometimes', upkeepCustomMinutes: 1, upkeepTasks: { agentIndex: 'yes', inventories: true },
			upkeepAutoRefreshIndex: 'on', upkeepRunCapSeconds: 99999, upkeepFailures: -4, upkeepLastRun: { startedAt: 1 },
			upkeepLastProposals: { items: [{ kind: 'x' }, 5, null], omitted: -3 }, upkeepReportFolder: 42,
		}) as Record<string, unknown>;
		expect(out.upkeepInterval).toBe('off');
		expect(out.upkeepCustomMinutes).toBe(15);
		expect(out.upkeepTasks).toEqual({ agentIndex: false, inventories: true, attachments: false });
		expect(out.upkeepAutoRefreshIndex).toBe(false);
		expect(out.upkeepRunCapSeconds).toBe(900);
		expect(out.upkeepFailures).toBe(0);
		expect(out.upkeepLastRun).toBeNull();
		expect(out.upkeepLastProposals).toEqual({ items: [{ kind: 'x' }], omitted: 0 });
		expect(out.upkeepReportFolder).toBe('');
	});

	it('keeps valid values and is idempotent', () => {
		const once = migrateOldSettings({ upkeepInterval: 'weekly', upkeepCustomMinutes: 90, upkeepTasks: { agentIndex: true, inventories: false, attachments: true }, upkeepRunOnMobile: true }) as Record<string, unknown>;
		expect(once).toMatchObject({ upkeepInterval: 'weekly', upkeepCustomMinutes: 90, upkeepRunOnMobile: true });
		expect(migrateOldSettings(structuredClone(once))).toEqual(once);
	});
});
