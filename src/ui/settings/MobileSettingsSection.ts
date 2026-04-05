import { Platform, Setting } from 'obsidian';
import { AdapterType } from '../../services/adapters';
import { buildProviderOptions, PROVIDER_DEFAULT_MODEL } from '../../services/adapters/providerRegistry';
import { BaseSettingSection } from './BaseSettingSection';

export class MobileSettingsSection extends BaseSettingSection {
    display(): void {
        const { containerEl, plugin } = this;
        const t = plugin.t;

        this.createSectionHeader(t.settings.mobile.title, 'smartphone', 2);
        containerEl.createEl('p', {
            text: t.settings.mobile.description,
            cls: 'setting-item-description'
        });

        if (!Platform.isMobile) {
            containerEl.createEl('p', {
                text: t.settings.mobile.desktopOnlyNote,
                cls: 'setting-item-description mod-warning'
            });
        }

        new Setting(containerEl)
            .setName(t.settings.mobile.providerMode)
            .setDesc(t.settings.mobile.providerModeDesc)
            .addDropdown(dropdown =>
                dropdown
                    .addOption('auto', t.settings.mobile.providerAuto)
                    .addOption('cloud-only', t.settings.mobile.providerCloudOnly)
                    .addOption('custom', t.settings.mobile.providerCustom)
                    .setValue(plugin.settings.mobileProviderMode)
                    .onChange((value) => {
                        plugin.settings.mobileProviderMode = value as 'auto' | 'cloud-only' | 'custom';
                        void plugin.saveSettings();
                        this.settingTab.display();
                    })
            );

        if (plugin.settings.mobileProviderMode !== 'custom') {
            new Setting(containerEl)
                .setName(t.settings.mobile.fallbackProvider)
                .setDesc(t.settings.mobile.fallbackProviderDesc)
                .addDropdown(dropdown =>
                    dropdown
                        .addOptions(buildProviderOptions(t.dropdowns))
                        .setValue(plugin.settings.mobileFallbackProvider)
                        .onChange((value) => {
                            plugin.settings.mobileFallbackProvider = value as AdapterType;
                            void plugin.saveSettings();
                        })
                );

            new Setting(containerEl)
                .setName(t.settings.mobile.fallbackModel)
                .setDesc(t.settings.mobile.fallbackModelDesc)
                .addText(text => text
                    .setPlaceholder(PROVIDER_DEFAULT_MODEL[plugin.settings.mobileFallbackProvider] || '')
                    .setValue(plugin.settings.mobileFallbackModel)
                    .onChange((value) => {
                        plugin.settings.mobileFallbackModel = value.trim();
                        void plugin.saveSettings();
                    }));
        } else {
            new Setting(containerEl)
                .setName(t.settings.mobile.customEndpoint)
                .setDesc(t.settings.mobile.customEndpointDesc)
                .addText(text => text
                    // eslint-disable-next-line obsidianmd/ui/sentence-case
                    .setPlaceholder('http://your-api-endpoint/v1/chat/completions')
                    .setValue(plugin.settings.mobileCustomEndpoint)
                    .onChange((value) => {
                        plugin.settings.mobileCustomEndpoint = value.trim();
                        void plugin.saveSettings();
                    }));

            new Setting(containerEl)
                .setName(t.settings.mobile.fallbackModel)
                .setDesc(t.settings.mobile.fallbackModelDesc)
                .addText(text => text
                    .setPlaceholder(plugin.settings.localModel || '')
                    .setValue(plugin.settings.mobileFallbackModel)
                    .onChange((value) => {
                        plugin.settings.mobileFallbackModel = value.trim();
                        void plugin.saveSettings();
                    }));
        }

        new Setting(containerEl)
            .setName(t.settings.mobile.indexMode)
            .setDesc(t.settings.mobile.indexModeDesc)
            .addDropdown(dropdown =>
                dropdown
                    .addOption('disabled', t.settings.mobile.indexDisabled)
                    .addOption('read-only', t.settings.mobile.indexReadOnly)
                    .addOption('full', t.settings.mobile.indexFull)
                    .setValue(plugin.settings.mobileIndexingMode)
                    .onChange((value) => {
                        plugin.settings.mobileIndexingMode = value as 'disabled' | 'read-only' | 'full';
                        void plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName(t.settings.mobile.indexSizeLimit)
            .setDesc(t.settings.mobile.indexSizeLimitDesc)
            .addText(text => text
                .setPlaceholder('50')
                .setValue(String(plugin.settings.mobileIndexSizeLimit))
                .onChange((value) => {
                    const parsed = Number.parseInt(value, 10);
                    if (!Number.isNaN(parsed) && parsed > 0) {
                        plugin.settings.mobileIndexSizeLimit = parsed;
                        void plugin.saveSettings();
                    }
                }));
    }

    // Provider options now sourced from providerRegistry
}
