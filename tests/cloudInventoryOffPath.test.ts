/**
 * Drive folder inventory: off by default and byte-identical when off. A disabled feature registers
 * no command, makes no request and never touches the vault.
 */
import { describe, it, expect, vi } from 'vitest';
import { FEATURE_BY_ID } from '../src/core/features';
import { isFeatureEnabled } from '../src/services/featureService';
import { DEFAULT_SETTINGS, migrateOldSettings } from '../src/core/settings';
import { REGISTER_BY_FEATURE, registerCommands } from '../src/commands/index';
import { registerCloudInventoryCommands } from '../src/commands/cloudInventoryCommands';
import { evaluateSetup } from '../src/core/setupState';

describe('cloud inventory off path', () => {
	it('is a default-off external-account row', () => {
		const def = FEATURE_BY_ID['cloud-inventory'];
		expect(def).toBeDefined();
		expect(def.defaultOn).toBe(false);
		expect(def.boundary).toEqual(['external-account']);
		expect(isFeatureEnabled({ featureFlags: {} } as never, 'cloud-inventory')).toBe(false);
		expect(isFeatureEnabled({ featureFlags: { 'cloud-inventory': 1 } } as never, 'cloud-inventory')).toBe(false);
		expect(isFeatureEnabled({ featureFlags: { 'cloud-inventory': true } } as never, 'cloud-inventory')).toBe(true);
	});

	it('is registered only through its feature, and registers nothing when off', () => {
		expect(REGISTER_BY_FEATURE['cloud-inventory']).toEqual([registerCloudInventoryCommands]);
		const addCommand = vi.fn();
		const plugin = {
			settings: { ...structuredClone(DEFAULT_SETTINGS), featureFlags: {} },
			addCommand,
			registerEvent: vi.fn(),
			register: vi.fn(),
			registerDomEvent: vi.fn(),
			app: { vault: { on: vi.fn() } },
			t: {},
		};
		try { registerCommands(plugin as never); } catch { /* context menu needs a full app */ }
		const ids = addCommand.mock.calls.map((c) => (c[0] as { id: string }).id);
		expect(ids.filter((id) => /cloud-inventor/.test(id))).toEqual([]);
	});

	it('registers its commands when on', () => {
		const ids: string[] = [];
		const plugin = {
			addCommand: (c: { id: string }) => ids.push(c.id),
			t: { commands: {}, cloudInventory: {} },
		};
		registerCloudInventoryCommands(plugin as never);
		expect(ids).toEqual(expect.arrayContaining(['refresh-cloud-inventories', 'check-cloud-inventories']));
	});

	it('ships an empty configuration that reads as not set up', () => {
		expect(DEFAULT_SETTINGS.cloudInventoryScriptUrl).toBe('');
		expect(DEFAULT_SETTINGS.cloudInventoryPairs).toEqual([]);
		expect(DEFAULT_SETTINGS.cloudInventoryLastTest).toBeNull();
		expect(evaluateSetup('cloud-inventory', DEFAULT_SETTINGS as never).state).toBe('not-set-up');
		const migrated = migrateOldSettings(structuredClone(DEFAULT_SETTINGS) as never) as Record<string, unknown>;
		for (const key of Object.keys(DEFAULT_SETTINGS).filter((k) => k.startsWith('cloudInventory'))) {
			expect(migrated[key], key).toEqual((DEFAULT_SETTINGS as unknown as Record<string, unknown>)[key]);
		}
	});
});
