import { Setting } from 'obsidian';
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
        this.createSectionHeader(this.plugin.t.settings.interface.title, 'languages', 2);

        new Setting(this.containerEl)
            .setName(this.plugin.t.settings.interface.language)
            .setDesc(this.plugin.t.settings.interface.languageDesc)
            .addDropdown(dropdown => {
                const options = getLanguageOptions();

                return dropdown
                    .addOptions(options)
                    .setValue(this.plugin.settings.interfaceLanguage)
                    .onChange((value) => {
                        this.plugin.settings.interfaceLanguage = value as SupportedLanguage;
                        void this.plugin.saveSettings();

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

        this.containerEl.createEl('p', {
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
                    .onChange((value) => {
                        this.plugin.settings.language = value as any;
                        void this.plugin.saveSettings();
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
                dropdown.onChange(value => {
                    this.plugin.settings.summaryLanguage = value === 'auto' ? '' : value;
                    void this.plugin.saveSettings();
                });
            });

        // === Review Edits ===
        const re = this.plugin.t.modals.reviewEdits;
        new Setting(this.containerEl)
            .setName(re.settingName)
            .setDesc(re.settingDesc)
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableReviewedEdits)
                .onChange(value => {
                    this.plugin.settings.enableReviewedEdits = value;
                    void this.plugin.saveSettings();
                }));
    }

    private showRestartNotice(): void {
        // Remove any existing notice first
        const existingNotice = this.containerEl.querySelector('.language-notice');
        if (existingNotice) {
            existingNotice.remove();
        }

        const notice = document.createElement('div');
        notice.className = 'notice language-notice';
        notice.addClass('ai-organiser-mt-12');
        notice.setCssProps({ '--pad': '8px 12px' }); notice.addClass('ai-organiser-pad-custom');
        notice.setCssProps({ '--bg': 'var(--background-modifier-info)' }); notice.addClass('ai-organiser-bg-custom');
        notice.addClass('ai-organiser-border');
        notice.addClass('ai-organiser-rounded');
        notice.addClass('ai-organiser-text-normal');
        const row = notice.createDiv({ cls: 'ai-organiser-flex-row' });
        row.createSpan({ text: '\uD83D\uDCA1', cls: 'ai-organiser-icon-inline' });
        row.createSpan({ text: this.plugin.t.messages.languageChangeNotice });

        // Insert after the interface language setting, not at the end
        const firstSetting = this.containerEl.querySelector('.setting-item');
        if (firstSetting && firstSetting.nextSibling) {
            firstSetting.parentNode?.insertBefore(notice, firstSetting.nextSibling);
        } else {
            this.containerEl.appendChild(notice);
        }
    }
}
