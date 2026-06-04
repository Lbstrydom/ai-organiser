import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('obsidian', async () => await import('./mocks/obsidian'));

import { App } from 'obsidian';
import AIOrganiserPlugin from '../src/main';
import { DEFAULT_SETTINGS } from '../src/core/settings';

function makePlugin(): AIOrganiserPlugin {
    const app = new App();
    const plugin = new AIOrganiserPlugin(app as never, {
        id: 'test', version: '1.0.0', name: 'Test', author: 'Test', minAppVersion: '0.0.0', description: 'Test',
    } as never);
    plugin.settings = { ...DEFAULT_SETTINGS };
    plugin.settingTab = { render: vi.fn().mockResolvedValue(undefined) } as never;
    return plugin;
}

describe('AIOrganiserPlugin.applyFeatureFlags (FT-5/FT-12)', () => {
    beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); });

    it('persists via saveSettings, tears down a feature turned OFF, and awaits a re-render', async () => {
        const plugin = makePlugin();
        plugin.settings.featureFlags = { 'semantic-search': true, canvas: false };
        const saveSpy = vi.spyOn(plugin, 'saveSettings').mockResolvedValue(undefined);
        const teardownSpy = vi.spyOn(plugin as never as { teardownFeature: (id: string) => void }, 'teardownFeature')
            .mockImplementation(() => {});

        await plugin.applyFeatureFlags({ 'semantic-search': false, canvas: false });

        expect(saveSpy).toHaveBeenCalledTimes(1);
        expect(teardownSpy).toHaveBeenCalledWith('semantic-search');
        expect(plugin.settings.featureFlags['semantic-search']).toBe(false);
        expect((plugin.settingTab as unknown as { render: ReturnType<typeof vi.fn> }).render).toHaveBeenCalled();
    });

    it('does NOT tear down a feature turned ON', async () => {
        const plugin = makePlugin();
        plugin.settings.featureFlags = { canvas: false };
        vi.spyOn(plugin, 'saveSettings').mockResolvedValue(undefined);
        const teardownSpy = vi.spyOn(plugin as never as { teardownFeature: (id: string) => void }, 'teardownFeature')
            .mockImplementation(() => {});

        await plugin.applyFeatureFlags({ canvas: true });

        expect(teardownSpy).not.toHaveBeenCalled();
        expect(plugin.settings.featureFlags.canvas).toBe(true);
    });

    it('restores the FULL pre-mutation snapshot when saveSettings rejects (cascade-safe)', async () => {
        const plugin = makePlugin();
        const prev = { 'semantic-search': true, canvas: true, research: true };
        plugin.settings.featureFlags = { ...prev };
        vi.spyOn(plugin, 'saveSettings').mockRejectedValue(new Error('disk full'));
        const teardownSpy = vi.spyOn(plugin as never as { teardownFeature: (id: string) => void }, 'teardownFeature')
            .mockImplementation(() => {});

        // A multi-flag change (as a cascade would produce) that fails to persist.
        await plugin.applyFeatureFlags({ 'semantic-search': false, canvas: false, research: false });

        expect(plugin.settings.featureFlags).toEqual(prev); // full revert, not just one flag
        expect(teardownSpy).not.toHaveBeenCalled();          // no teardown after a failed persist
        expect((plugin.settingTab as unknown as { render: ReturnType<typeof vi.fn> }).render).toHaveBeenCalled();
    });

    it('a throwing teardown is caught and does not block the flow', async () => {
        const plugin = makePlugin();
        plugin.settings.featureFlags = { newsletter: true };
        vi.spyOn(plugin, 'saveSettings').mockResolvedValue(undefined);
        vi.spyOn(plugin as never as { teardownFeature: (id: string) => void }, 'teardownFeature')
            .mockImplementation(() => { throw new Error('teardown boom'); });

        await expect(plugin.applyFeatureFlags({ newsletter: false })).resolves.toBeUndefined();
        expect((plugin.settingTab as unknown as { render: ReturnType<typeof vi.fn> }).render).toHaveBeenCalled();
    });
});
