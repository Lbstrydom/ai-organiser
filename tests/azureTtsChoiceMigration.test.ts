/**
 * A text-to-speech "bring your own" the user chose must survive the one-time
 * flip of old auto-seeded rows, so audio never moves to Azure on its own.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('obsidian', async () => await import('./mocks/obsidian'));

import { DEFAULT_SETTINGS, migrateOldSettings } from '../src/core/settings';
import { applyAzureConfigImport } from '../src/services/azure/azureConfigTransfer';
import { AzureCapabilitiesSettingsSection } from '../src/ui/settings/AzureCapabilitiesSettingsSection';

type Stored = Record<string, any>;

/** First load as a non-Azure user, then a switch to Azure within the session. */
const switchedToAzure = (): Stored => {
    const stored = migrateOldSettings({ ...structuredClone(DEFAULT_SETTINGS), cloudServiceType: 'claude', azureCapabilities: {} } as Stored)!;
    stored.cloudServiceType = 'azure-claude';
    stored.azureFirstMode = true;
    return stored;
};
const nextLoad = (s: Stored): Stored => migrateOldSettings(structuredClone(s))!;

describe('a chosen TTS source survives the next load', () => {
    it('chosen on the settings screen', () => {
        const settings = switchedToAzure();
        const section = new AzureCapabilitiesSettingsSection({ settings } as never, {} as never, {} as never);
        (section as unknown as { setMode(id: string, mode: string): void }).setMode('tts', 'byo');
        expect(nextLoad(settings).azureCapabilities.tts.mode).toBe('byo');
    });

    it('brought in by a setup import', () => {
        const settings = switchedToAzure();
        applyAzureConfigImport(settings as never, { azureCapabilities: { tts: { mode: 'byo' } } });
        expect(nextLoad(settings).azureCapabilities.tts.mode).toBe('byo');
    });

    it('choosing another capability does not consume the flip', () => {
        const settings = switchedToAzure();
        const section = new AzureCapabilitiesSettingsSection({ settings } as never, {} as never, {} as never);
        (section as unknown as { setMode(id: string, mode: string): void }).setMode('youtube', 'off');
        expect(settings.azureTtsSeedV2).toBe(false);
    });
});
