/**
 * Output folders must stay disjoint from protected folders on every settings save, not only when the
 * protected list is edited: a save that introduces a collision is reverted.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { enforceOutputDisjointness, applyProtectedFolders, unregisterProtectedFolders } from '../src/commands/protectedFolderCommands';
import { DEFAULT_SETTINGS } from '../src/core/settings';
import { en } from '../src/i18n/en';
import { mockNotices, clearMockNotices } from './mocks/obsidian';

interface FakePlugin {
	settings: typeof DEFAULT_SETTINGS;
	t: typeof en;
	settingTab: { display: ReturnType<typeof vi.fn> };
	saveSettings: () => Promise<void>;
}

function makePlugin(over: Record<string, unknown> = {}): FakePlugin {
	const plugin: FakePlugin = {
		settings: { ...structuredClone(DEFAULT_SETTINGS), ...over } as typeof DEFAULT_SETTINGS,
		t: en,
		settingTab: { display: vi.fn() },
		saveSettings: async () => { enforceOutputDisjointness(plugin as never); },
	};
	return plugin;
}

let plugin: FakePlugin;

beforeEach(() => {
	unregisterProtectedFolders(); // resets the baseline
	clearMockNotices();
});

describe('enforceOutputDisjointness', () => {
	it('does nothing when no folder is protected', () => {
		plugin = makePlugin();
		expect(enforceOutputDisjointness(plugin as never)).toBe(false);
		plugin.settings.canvasOutputFolder = 'Anything';
		expect(enforceOutputDisjointness(plugin as never)).toBe(false);
	});

	it('reverts an output-folder edit that lands inside a protected folder', () => {
		plugin = makePlugin({ protectedFolders: ['Courses/Live'] });
		enforceOutputDisjointness(plugin as never); // baseline
		plugin.settings.outputRootFolder = 'Courses/Live';
		expect(enforceOutputDisjointness(plugin as never)).toBe(true);
		expect(plugin.settings.outputRootFolder).toBe('');
		expect(mockNotices.some((m) => m.includes('protected folder'))).toBe(true);
		expect(plugin.settingTab.display).toHaveBeenCalled();
	});

	it('accepts a harmless output-folder edit and reverts to the last GOOD state afterwards', () => {
		plugin = makePlugin({ protectedFolders: ['Courses/Live'] });
		enforceOutputDisjointness(plugin as never);
		plugin.settings.canvasOutputFolder = 'My Boards';
		expect(enforceOutputDisjointness(plugin as never)).toBe(false);
		plugin.settings.outputRootFolder = 'Courses/Live';
		enforceOutputDisjointness(plugin as never);
		expect(plugin.settings.canvasOutputFolder).toBe('My Boards');
		expect(plugin.settings.outputRootFolder).toBe('');
	});

	it('does not punish a collision that existed at load, but refuses a new one', () => {
		plugin = makePlugin({ protectedFolders: ['AI-Organiser'] });
		expect(enforceOutputDisjointness(plugin as never)).toBe(false); // baseline includes the existing overlap
		expect(enforceOutputDisjointness(plugin as never)).toBe(false);
		plugin.settings.sketchOutputFolder = 'Elsewhere/Sketches2';
		plugin.settings.outputRootFolder = 'AI-Organiser/New';
		expect(enforceOutputDisjointness(plugin as never)).toBe(true);
	});
});

describe('applyProtectedFolders', () => {
	it('refuses a protected folder that would contain an output root and changes nothing', async () => {
		plugin = makePlugin();
		const res = await applyProtectedFolders(plugin as never, ['AI-Organiser']);
		expect(res.ok).toBe(false);
		expect(plugin.settings.protectedFolders).toEqual([]);
	});

	it('lets an unrelated change through while an overlap that was already there stays, but still refuses a new one', async () => {
		plugin = makePlugin({ protectedFolders: ['AI-Organiser', 'Courses/Live'] }); // the first already contains an output root
		const removed = await applyProtectedFolders(plugin as never, ['AI-Organiser']); // unprotect an unrelated folder
		expect(removed.ok).toBe(true);
		expect(plugin.settings.protectedFolders).toEqual(['AI-Organiser']);
		plugin = makePlugin({ protectedFolders: ['Courses/Live'] });
		const added = await applyProtectedFolders(plugin as never, ['Courses/Live', 'AI-Organiser']); // a new overlap
		expect(added.ok).toBe(false);
	});

	it('saves a disjoint list', async () => {
		plugin = makePlugin();
		const res = await applyProtectedFolders(plugin as never, ['Courses/Live']);
		expect(res.ok).toBe(true);
		expect(plugin.settings.protectedFolders).toEqual(['Courses/Live']);
	});
});
