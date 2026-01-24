import { Setting } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import type { AIOrganiserSettingTab } from './AIOrganiserSettingTab';
import { BaseSettingSection } from './BaseSettingSection';

export class MinutesSettingsSection extends BaseSettingSection {
    constructor(plugin: AIOrganiserPlugin, containerEl: HTMLElement, settingTab: AIOrganiserSettingTab) {
        super(plugin, containerEl, settingTab);
    }

    display(): void {
        const t = this.plugin.t;
        this.createSectionHeader(t.settings.minutes?.title || 'Meeting Minutes', 'clipboard-check');

        if (t.settings.minutes?.description) {
            this.containerEl.createEl('p', {
                text: t.settings.minutes.description,
                cls: 'setting-item-description'
            });
        }

        new Setting(this.containerEl)
            .setName(t.settings.minutes?.outputFolder || 'Output folder')
            .setDesc(t.settings.minutes?.outputFolderDesc || 'Where to save generated meeting minutes')
            .addText(text => text
                .setPlaceholder('Meetings')
                .setValue(this.plugin.settings.minutesOutputFolder)
                .onChange(async (value) => {
                    this.plugin.settings.minutesOutputFolder = value.trim() || 'Meetings';
                    await this.plugin.saveSettings();
                }));

        new Setting(this.containerEl)
            .setName(t.settings.minutes?.defaultTimezone || 'Default timezone')
            .setDesc(t.settings.minutes?.defaultTimezoneDesc || 'IANA timezone (e.g., America/New_York)')
            .addText(text => text
                .setPlaceholder('America/New_York')
                .setValue(this.plugin.settings.minutesDefaultTimezone)
                .onChange(async (value) => {
                    this.plugin.settings.minutesDefaultTimezone = value.trim() || this.plugin.settings.minutesDefaultTimezone;
                    await this.plugin.saveSettings();
                }));

        new Setting(this.containerEl)
            .setName(t.settings.minutes?.defaultPersona || 'Default minutes persona')
            .setDesc(t.settings.minutes?.defaultPersonaDesc || 'Default persona from minutes-personas.md')
            .addDropdown(dropdown => {
                dropdown.addOption(this.plugin.settings.minutesDefaultPersona, this.plugin.settings.minutesDefaultPersona);
                dropdown.setValue(this.plugin.settings.minutesDefaultPersona);
                void this.plugin.configService.getMinutesPersonas().then(personas => {
                    dropdown.selectEl.empty();
                    personas.forEach(persona => dropdown.addOption(persona.id, persona.name));
                    dropdown.setValue(this.plugin.settings.minutesDefaultPersona || personas[0]?.id || '');
                });
                dropdown.onChange(async (value) => {
                    this.plugin.settings.minutesDefaultPersona = value;
                    await this.plugin.saveSettings();
                });
            });

        new Setting(this.containerEl)
            .setName(t.settings.minutes?.obsidianTasks || 'Obsidian Tasks format')
            .setDesc(t.settings.minutes?.obsidianTasksDesc || 'Add actions as - [ ] tasks below the minutes')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.minutesObsidianTasksFormat)
                .onChange(async (value) => {
                    this.plugin.settings.minutesObsidianTasksFormat = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(this.containerEl)
            .setName(t.settings.minutes?.maxDocumentChars || 'Maximum document size')
            .setDesc(t.settings.minutes?.maxDocumentCharsDesc || 'Documents larger than this will trigger truncation options (default: 50000)')
            .addText(text => text
                .setPlaceholder('50000')
                .setValue(String(this.plugin.settings.maxDocumentChars))
                .onChange(async (value) => {
                    const num = parseInt(value, 10);
                    if (!isNaN(num) && num >= 1000) {
                        this.plugin.settings.maxDocumentChars = num;
                        await this.plugin.saveSettings();
                    }
                }));

        new Setting(this.containerEl)
            .setName(t.settings.minutes?.oversizedBehavior || 'Oversized document handling')
            .setDesc(t.settings.minutes?.oversizedBehaviorDesc || 'What to do when a document exceeds the size limit')
            .addDropdown(dropdown => dropdown
                .addOption('ask', t.settings.minutes?.oversizedAsk || 'Ask for each document')
                .addOption('truncate', t.settings.minutes?.oversizedTruncate || 'Always truncate')
                .addOption('full', t.settings.minutes?.oversizedFull || 'Always use full content')
                .setValue(this.plugin.settings.oversizedDocumentBehavior)
                .onChange(async (value) => {
                    this.plugin.settings.oversizedDocumentBehavior = value as 'truncate' | 'full' | 'ask';
                    await this.plugin.saveSettings();
                }));
    }
}
