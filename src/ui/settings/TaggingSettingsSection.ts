import { Setting } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import { BaseSettingSection } from './BaseSettingSection';
import { ExcludedFilesModal } from '../modals/ExcludedFilesModal';

export class TaggingSettingsSection extends BaseSettingSection {

    display(): void {
        this.createSectionHeader(this.plugin.t.settings.tagging.title, 'tag');

        // Max Tags Setting
        new Setting(this.containerEl)
            .setName(this.plugin.t.settings.tagging.maxTags || 'Maximum Tags')
            .setDesc(this.plugin.t.settings.tagging.maxTagsDesc || 'Maximum number of tags to generate per note (1-10)')
            .addSlider(slider => {
                const container = slider.sliderEl.parentElement;
                if (container) {
                    const numberDisplay = container.createSpan({ cls: 'ai-organiser-value-display' });
                    numberDisplay.style.marginLeft = '10px';
                    numberDisplay.setText(String(this.plugin.settings.maxTags));

                    slider.setLimits(1, 10, 1)
                        .setValue(this.plugin.settings.maxTags)
                        .setDynamicTooltip()
                        .onChange((value) => {
                            numberDisplay.setText(String(value));
                            this.plugin.settings.maxTags = value;
                            void this.plugin.saveSettings();
                        });
                }
                return slider;
            });

        // Ensure note structure after commands
        new Setting(this.containerEl)
            .setName(this.plugin.t.settings.tagging.autoEnsureNoteStructure.name)
            .setDesc(this.plugin.t.settings.tagging.autoEnsureNoteStructure.description)
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.autoEnsureNoteStructure)
                .onChange((value) => {
                    this.plugin.settings.autoEnsureNoteStructure = value;
                    void this.plugin.saveSettings();
                }));

        // Taxonomy Enforcement
        this.containerEl.createEl('h4', { text: this.plugin.t.settings.tagging.taxonomyEnforcement });

        new Setting(this.containerEl)
            .setName(this.plugin.t.settings.tagging.enableGuardrail)
            .setDesc(this.plugin.t.settings.tagging.enableGuardrailDesc)
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableTaxonomyGuardrail)
                .onChange((value) => {
                    this.plugin.settings.enableTaxonomyGuardrail = value;
                    void this.plugin.saveSettings();
                    autoAddSetting.settingEl.toggle(value);
                }));

        const autoAddSetting = new Setting(this.containerEl)
            .setName(this.plugin.t.settings.tagging.autoAddNovel)
            .setDesc(this.plugin.t.settings.tagging.autoAddNovelDesc)
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.autoAddNovelDisciplines)
                .onChange((value) => {
                    this.plugin.settings.autoAddNovelDisciplines = value;
                    void this.plugin.saveSettings();
                }));

        autoAddSetting.settingEl.toggle(this.plugin.settings.enableTaxonomyGuardrail);

        // File exclusion Setting
        this.containerEl.createEl('h3', { text: this.plugin.t.settings.tagging.fileExclusion });

        const excludedFoldersSetting = new Setting(this.containerEl)
            .setName(this.plugin.t.settings.tagging.excludedFiles)
            .setDesc(this.plugin.t.settings.tagging.excludedFilesDesc);

        const excludedInfo = excludedFoldersSetting.descEl.createDiv({
            cls: 'ai-organiser-excluded-info'
        });

        const updateExcludedInfo = () => {
            excludedInfo.empty();

            if (this.plugin.settings.excludedFolders.length === 0) {
                excludedInfo.createSpan({
                    text: this.plugin.t.settings.tagging.noExclusions,
                    cls: 'ai-organiser-excluded-info-text muted'
                });
            } else {
                excludedInfo.createSpan({
                    text: `${this.plugin.settings.excludedFolders.length} ${this.plugin.t.settings.tagging.patternsConfigured}`,
                    cls: 'ai-organiser-excluded-info-text'
                });
            }
        };

        updateExcludedInfo();

        excludedFoldersSetting.addButton(button =>
            button
                .setButtonText(this.plugin.t.settings.tagging.manage)
                .setCta()
                .onClick(() => {
                    const modal = new ExcludedFilesModal(
                        this.plugin.app,
                        this.plugin,
                        async (excludedFolders: string[]) => {
                            this.plugin.settings.excludedFolders = excludedFolders;
                            await this.plugin.saveSettings();
                            updateExcludedInfo();
                        }
                    );
                    modal.open();
                })
        );
    }
}
