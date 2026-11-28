// @vitest-environment happy-dom
/**
 * The AI provider settings screen: opening it writes nothing.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

vi.mock('obsidian', async () => ({
    ...await import('./mocks/obsidian'),
    ...(await import('./helpers/settingsHarness')).settingsObsidianOverrides(),
    requestUrl: vi.fn(),
}));

import { requestUrl } from 'obsidian';
import { setupSettingsDom, makeSettingsPlugin, flushRender, recordedSettings } from './helpers/settingsHarness';
import { SETTINGS_FIXTURES } from './helpers/settingsFixtures';
import AIOrganiserPlugin from '../src/main';
import { DEFAULT_SETTINGS } from '../src/core/settings';
import { en } from '../src/i18n/en';
import { LLMSettingsSection } from '../src/ui/settings/LLMSettingsSection';

const mockRequestUrl = requestUrl as unknown as ReturnType<typeof vi.fn>;
const DEPS = { Plugin: AIOrganiserPlugin, defaults: DEFAULT_SETTINGS, t: en };

beforeAll(setupSettingsDom);
beforeEach(() => {
    vi.clearAllMocks();
    recordedSettings.length = 0;
    mockRequestUrl.mockResolvedValue({ status: 200, headers: {}, text: '', json: {} });
});

async function render(fixture: Record<string, unknown>) {
    const { plugin } = await makeSettingsPlugin(DEPS, structuredClone(fixture));
    const container = document.createElement('div');
    const settingTab = { display: vi.fn() };
    new LLMSettingsSection(plugin as never, container, settingTab as never).display();
    await flushRender();
    return { plugin, container };
}

describe('opening the AI provider settings', () => {
    for (const [name, fixture] of Object.entries(SETTINGS_FIXTURES)) {
        it(`writes nothing: ${name}`, async () => {
            const { plugin: before } = await makeSettingsPlugin(DEPS, structuredClone(fixture));
            const expected = JSON.stringify(before.settings);

            const { plugin } = await render(fixture);

            expect(JSON.stringify(plugin.settings)).toBe(expected);
            expect(plugin.saveSettings).not.toHaveBeenCalled();
        });
    }
});
