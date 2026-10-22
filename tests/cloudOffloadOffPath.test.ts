/**
 * Drive offload: off by default and byte-identical when off. It depends on the Drive folder
 * inventory, registers nothing when disabled, is never offered on mobile, and the Find embeds
 * results show no offload action unless the feature, a desktop app and a local Drive folder exist.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { FEATURE_BY_ID } from '../src/core/features';
import { isFeatureEnabled } from '../src/services/featureService';
import { DEFAULT_SETTINGS } from '../src/core/settings';
import { REGISTER_BY_FEATURE } from '../src/commands/index';
import { registerOffloadCommands, promptUnfinishedOffload } from '../src/commands/offloadCommands';
import { isOffloadAvailable } from '../src/services/offload/offloadRuntime';
import { Platform } from './mocks/obsidian';

afterEach(() => { Platform.isDesktopApp = true; });

const settingsWith = (flags: Record<string, unknown>, pairs: unknown[] = []) => ({ ...structuredClone(DEFAULT_SETTINGS), featureFlags: flags, cloudInventoryPairs: pairs });

describe('cloud offload off path', () => {
	it('is a default-off row that needs the inventory', () => {
		const def = FEATURE_BY_ID['cloud-offload'];
		expect(def.defaultOn).toBe(false);
		expect(def.requires).toEqual(['cloud-inventory']);
		expect(isFeatureEnabled({ featureFlags: {} } as never, 'cloud-offload')).toBe(false);
		expect(isFeatureEnabled({ featureFlags: { 'cloud-offload': true } } as never, 'cloud-offload')).toBe(false); // inventory is off
		expect(isFeatureEnabled({ featureFlags: { 'cloud-offload': true, 'cloud-inventory': true } } as never, 'cloud-offload')).toBe(true);
		expect(isFeatureEnabled({ featureFlags: { 'cloud-offload': 'yes', 'cloud-inventory': true } } as never, 'cloud-offload')).toBe(false);
	});

	it('is registered through its feature only', () => {
		expect(REGISTER_BY_FEATURE['cloud-offload']).toEqual([registerOffloadCommands]);
	});

	it('registers its command on desktop and nothing on mobile', () => {
		const ids: string[] = [];
		const plugin = { addCommand: (c: { id: string }) => ids.push(c.id), t: { commands: { resumeOffload: 'Resume' } } };
		registerOffloadCommands(plugin as never);
		expect(ids).toEqual(['resume-offload']);
		ids.length = 0;
		Platform.isDesktopApp = false;
		registerOffloadCommands(plugin as never);
		expect(ids).toEqual([]);
	});

	it('is not available by default, without a local Drive folder, or on mobile', () => {
		const pair = { id: 'p1', vaultFolder: 'A', driveFolderId: 'DriveFolder_01', placement: 'beside' as const };
		expect(isOffloadAvailable({ settings: settingsWith({}, [pair]) } as never)).toBe(false);
		const on = { 'cloud-offload': true, 'cloud-inventory': true };
		// A pair without a local folder cannot receive a file.
		expect(isOffloadAvailable({ settings: settingsWith(on, [pair]) } as never)).toBe(false);
		Platform.isDesktopApp = false;
		expect(isOffloadAvailable({ settings: settingsWith(on, [{ ...pair, localMountFolder: '/mnt/drive' }]) } as never)).toBe(false);
	});

	it('does not look at the journal when the feature is off', () => {
		const onLayoutReady = vi.fn();
		promptUnfinishedOffload({ settings: settingsWith({}), app: { workspace: { onLayoutReady } } } as never);
		expect(onLayoutReady).not.toHaveBeenCalled();
	});

	it('ships no stored state of its own', () => {
		expect(Object.keys(DEFAULT_SETTINGS).filter((k) => /offload/i.test(k))).toEqual([]);
	});
});
