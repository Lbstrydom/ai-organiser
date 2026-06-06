import { Setting, Notice } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import type { AIOrganiserSettingTab } from './AIOrganiserSettingTab';
import { BaseSettingSection } from './BaseSettingSection';
import { ALL_ADAPTERS, buildProviderOptions } from '../../services/adapters/providerRegistry';
import type { AdapterType } from '../../services/adapters';

/**
 * Per-role model selection for the consultant pipeline (plan Cluster B / Phase 4).
 * Two dropdowns (the 5 logical roles collapse onto 2 settings, M8): the storyboard
 * generator and the independent critic. Each defaults to "Main" (the configured
 * provider). A chosen provider with no key surfaces an inline warning; the resolver
 * also falls back to Main at runtime so a missing key never hard-fails.
 */
export class PresentationModelsSettingsSection extends BaseSettingSection {
    constructor(plugin: AIOrganiserPlugin, containerEl: HTMLElement, settingTab: AIOrganiserSettingTab) {
        super(plugin, containerEl, settingTab);
    }

    private providerHasKey(provider: string): boolean {
        const s = this.plugin.settings;
        return !!(s.providerSettings?.[provider as AdapterType]?.apiKey || (s.cloudServiceType === provider && s.cloudApiKey));
    }

    private roleDropdown(
        name: string, desc: string,
        get: () => string | null,
        set: (v: string | null) => void,
        options: Record<string, string>,
        noKeyWarning: string,
    ): void {
        new Setting(this.containerEl)
            .setName(name)
            .setDesc(desc)
            .addDropdown((dd) => {
                for (const [value, label] of Object.entries(options)) dd.addOption(value, label);
                dd.setValue(get() ?? 'main');
                dd.onChange((value) => {
                    const provider = value === 'main' ? null : value;
                    set(provider);
                    if (provider && !this.providerHasKey(provider)) {
                        new Notice(noKeyWarning.replace('{provider}', options[provider] ?? provider));
                    }
                    void this.plugin.saveSettings();
                });
            });
    }

    display(): void {
        const t = this.plugin.t;
        this.createSectionHeader(t.presentationModels.settingsTitle, 'sparkles', 2);
        this.containerEl.createEl('p', { text: t.presentationModels.settingsDescription, cls: 'setting-item-description' });

        // Consultant-quality master toggle (opt-in). When off, the per-role model
        // choices + storyline gate below have no effect (one-shot deck flow runs).
        new Setting(this.containerEl)
            .setName(t.presentationModels.consultantModeName)
            .setDesc(t.presentationModels.consultantModeDesc)
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.presentationConsultantMode)
                .onChange(value => {
                    this.plugin.settings.presentationConsultantMode = value;
                    void this.plugin.saveSettings();
                }));

        // Storyline review gate (applies only when consultant mode is on).
        new Setting(this.containerEl)
            .setName(t.presentationModels.storylineGateName)
            .setDesc(t.presentationModels.storylineGateDesc)
            .addDropdown(dd => dd
                .addOption('review', t.presentationModels.storylineGateReview)
                .addOption('auto-build', t.presentationModels.storylineGateAutoBuild)
                .setValue(this.plugin.settings.presentationStorylineGate)
                .onChange(value => {
                    this.plugin.settings.presentationStorylineGate = value as 'review' | 'auto-build';
                    void this.plugin.saveSettings();
                }));

        const providerLabels = buildProviderOptions(t.dropdowns);
        const options: Record<string, string> = { main: t.presentationModels.mainOption };
        for (const p of ALL_ADAPTERS) options[p] = providerLabels[p] ?? p;

        // Defensive: a settings object that predates this field (or a partial test
        // fixture) gets a fresh default so the dropdowns can't crash.
        if (!this.plugin.settings.presentationModelRoles) {
            this.plugin.settings.presentationModelRoles = { storyboardGenerator: null, independentCritic: null };
        }
        const roles = this.plugin.settings.presentationModelRoles;
        this.roleDropdown(
            t.presentationModels.generatorName, t.presentationModels.generatorDesc,
            () => roles.storyboardGenerator, (v) => { roles.storyboardGenerator = v; },
            options, t.presentationModels.noKeyWarning,
        );
        this.roleDropdown(
            t.presentationModels.criticName, t.presentationModels.criticDesc,
            () => roles.independentCritic, (v) => { roles.independentCritic = v; },
            options, t.presentationModels.noKeyWarning,
        );
    }
}
