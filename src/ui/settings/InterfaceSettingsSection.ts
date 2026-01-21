import { Setting } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import { BaseSettingSection } from './BaseSettingSection';
import { getLanguageOptions, SupportedLanguage } from '../../i18n';

export class InterfaceSettingsSection extends BaseSettingSection {
    private initialLanguage!: SupportedLanguage;

    display(): void {
        // Store initial language to detect actual changes
        this.initialLanguage = this.plugin.settings.interfaceLanguage;

        this.containerEl.createEl('h1', { text: this.plugin.t.settings.interface.title });

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
        this.containerEl.appendChild(notice);
    }
}