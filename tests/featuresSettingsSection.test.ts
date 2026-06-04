import { describe, it, expect, vi } from 'vitest';

vi.mock('obsidian', async () => await import('./mocks/obsidian'));

import { FeaturesSettingsSection } from '../src/ui/settings/FeaturesSettingsSection';
import { en } from '../src/i18n/en';

/** Minimal plugin double — the section's decision logic only touches settings + t +
 *  applyFeatureFlags. (display() rendering is exercised separately at integration level.) */
function makeSection(featureFlags: Record<string, boolean>) {
    const applyFeatureFlags = vi.fn().mockResolvedValue(undefined);
    const plugin = { settings: { featureFlags }, t: en, applyFeatureFlags } as never;
    const section = new FeaturesSettingsSection(plugin, {} as never, {} as never);
    return { section: section as unknown as Record<string, (...a: never[]) => unknown>, applyFeatureFlags };
}

describe('FeaturesSettingsSection — toggle logic (FT-8)', () => {
    it('enabling a feature applies a flag set with it turned on', () => {
        const { section, applyFeatureFlags } = makeSection({ canvas: false });
        section.handleEnable('canvas' as never);
        expect(applyFeatureFlags).toHaveBeenCalledTimes(1);
        expect(applyFeatureFlags.mock.calls[0][0]).toMatchObject({ canvas: true });
    });

    it('disabling a feature with no enabled dependents applies it off directly (no modal)', () => {
        const { section, applyFeatureFlags } = makeSection({ summarize: true });
        const toggle = { setValue: vi.fn() };
        section.handleDisable('summarize' as never, toggle as never);
        expect(applyFeatureFlags).toHaveBeenCalledTimes(1);
        expect(applyFeatureFlags.mock.calls[0][0]).toMatchObject({ summarize: false });
        expect(toggle.setValue).not.toHaveBeenCalled(); // no revert — it went straight through
    });

    it('resolveCopy resolves a registry i18n path, falling back to the raw path on a miss', () => {
        const { section } = makeSection({});
        expect(section.resolveCopy('features.canvas.label' as never)).toBe('Canvas boards');
        expect(section.resolveCopy('features.semantic-search.label' as never)).toBe('Semantic search');
        expect(section.resolveCopy('features.does-not-exist.label' as never)).toBe('features.does-not-exist.label');
    });
});
