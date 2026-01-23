import { Setting } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import { BaseSettingSection } from './BaseSettingSection';
import { getLanguageOptions, SupportedLanguage } from '../../i18n';
import { LanguageUtils } from '../../utils/languageUtils';
import { COMMON_LANGUAGES, getLanguageDisplayName } from '../../services/languages';

export class InterfaceSettingsSection extends BaseSettingSection {
    private initialLanguage!: SupportedLanguage;

    display(): void {
        // Store initial language to detect actual changes
        this.initialLanguage = this.plugin.settings.interfaceLanguage;

        // === Interface Language ===
        this.createSectionHeader(this.plugin.t.settings.interface.title, 'languages');

        new Setting(this.containerEl)
            .setName(this.plugin.t.settings.interface.language)
            .setDesc(this.plugin.t.settings.interface.languageDesc)
            .addDropdown(dropdown => {
                const options = getLanguageOptions();

                return dropdown
                    .addOptions(options)
                    .setValue(this.plugin.settings.interfaceLanguage)
                    .onChange(async (value) => {
                        this.plugin.settings.interfaceLanguage = value as SupportedLanguage;
                        await this.plugin.saveSettings();

                        // Only show restart notice if language actually changed from initial
                        if (value !== this.initialLanguage) {
                            this.showRestartNotice();
                        } else {
                            // Remove notice if reverted back to original
                            const existingNotice = this.containerEl.querySelector('.language-notice');
                            if (existingNotice) {
                                existingNotice.remove();
                            }
                        }
                    });
            });

        // === Output Language Settings ===
        this.containerEl.createEl('h2', { text: this.plugin.t.settings.interface.outputLanguage || 'Output Language' });

        const outputDesc = this.containerEl.createEl('p', {
            cls: 'setting-item-description',
            text: this.plugin.t.settings.interface.outputLanguageDesc || 'Language for AI-generated content. Each feature can use this or have its own override.'
        });

        // Tag output language
        new Setting(this.containerEl)
            .setName(this.plugin.t.settings.tagging.outputLanguage || 'Tag Generation Language')
            .setDesc(this.plugin.t.settings.tagging.outputLanguageDesc || 'Language for generated tags')
            .addDropdown(dropdown => {
                const options: Record<string, string> = LanguageUtils.getLanguageOptions();

                return dropdown
                    .addOptions(options)
                    .setValue(this.plugin.settings.language)
                    .onChange(async (value) => {
                        this.plugin.settings.language = value as any;
                        await this.plugin.saveSettings();
                    });
            });

        // Summary output language
        new Setting(this.containerEl)
            .setName(this.plugin.t.settings.summarization?.language || 'Summary Language')
            .setDesc(this.plugin.t.settings.summarization?.languageDesc || 'Language for generated summaries')
            .addDropdown(dropdown => {
                for (const lang of COMMON_LANGUAGES) {
                    dropdown.addOption(lang.code, getLanguageDisplayName(lang));
                }
                dropdown.setValue(this.plugin.settings.summaryLanguage || 'auto');
                dropdown.onChange(async value => {
                    this.plugin.settings.summaryLanguage = value === 'auto' ? '' : value;
                    await this.plugin.saveSettings();
                });
            });
    }

    private showRestartNotice(): void {
        // Remove any existing notice first
        const existingNotice = this.containerEl.querySelector('.language-notice');
        if (existingNotice) {
            existingNotice.remove();
        }

        const notice = document.createElement('div');
        notice.className = 'notice language-notice';
        notice.style.marginTop = '10px';
        notice.style.padding = '8px 12px';
        notice.style.backgroundColor = 'var(--background-modifier-info)';
        notice.style.border = '1px solid var(--background-modifier-border)';
        notice.style.borderRadius = '4px';
        notice.style.color = 'var(--text-normal)';
        notice.innerHTML = `
            <div style="display: flex; align-items: center;">
                <span style="margin-right: 8px;">💡</span>
                <span>${this.plugin.t.messages.languageChangeNotice}</span>
            </div>
        `;

        // Insert after the interface language setting, not at the end
        const firstSetting = this.containerEl.querySelector('.setting-item');
        if (firstSetting && firstSetting.nextSibling) {
            firstSetting.parentNode?.insertBefore(notice, firstSetting.nextSibling);
        } else {
            this.containerEl.appendChild(notice);
        }
    }
}
