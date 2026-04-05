import { Setting } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import type { AIOrganiserSettingTab } from './AIOrganiserSettingTab';
import { BaseSettingSection } from './BaseSettingSection';
import type { MinutesStyle } from '../../core/constants';

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
                .onChange((value) => {
                    this.plugin.settings.minutesOutputFolder = value.trim() || 'Meetings';
                    void this.plugin.saveSettings();
                }));

        new Setting(this.containerEl)
            .setName(t.settings.minutes?.defaultTimezone || 'Default timezone')
            .setDesc(t.settings.minutes?.defaultTimezoneDesc || 'IANA timezone (e.g., America/New_York)')
            .addText(text => {
                const tzPlaceholder = 'America/New_York';
                return text
                    .setPlaceholder(tzPlaceholder)
                    .setValue(this.plugin.settings.minutesDefaultTimezone)
                    .onChange((value) => {
                        this.plugin.settings.minutesDefaultTimezone = value.trim() || this.plugin.settings.minutesDefaultTimezone;
                        void this.plugin.saveSettings();
                    });
            });

        new Setting(this.containerEl)
            .setName(t.settings.minutes?.style || 'Minutes style')
            .setDesc(t.settings.minutes?.styleDesc || 'Default output format for meeting minutes')
            .addDropdown(dropdown => dropdown
                .addOption('smart-brevity', t.settings.minutes?.styleSmartBrevity || 'Smart Brevity \u2014 fast executive scan')
                .addOption('standard', t.settings.minutes?.styleStandard || 'Standard \u2014 key points, decisions, actions')
                .addOption('detailed', t.settings.minutes?.styleDetailed || 'Detailed \u2014 formal governance minutes')
                .setValue(this.plugin.settings.minutesStyle)
                .onChange((value) => {
                    this.plugin.settings.minutesStyle = value as MinutesStyle;
                    void this.plugin.saveSettings();
                }));

        new Setting(this.containerEl)
            .setName(t.settings.minutes?.obsidianTasks || 'Obsidian Tasks format')
            .setDesc(t.settings.minutes?.obsidianTasksDesc || 'Add actions as - [ ] tasks below the minutes')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.minutesObsidianTasksFormat)
                .onChange((value) => {
                    this.plugin.settings.minutesObsidianTasksFormat = value;
                    void this.plugin.saveSettings();
                }));

        new Setting(this.containerEl)
            .setName(t.settings.minutes?.gtdOverlay || 'GTD action classification')
            .setDesc(t.settings.minutes?.gtdOverlayDesc || 'Classify actions by GTD context (@office, @home, @call, etc.)')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.minutesGTDOverlay)
                .onChange(async (value) => {
                    this.plugin.settings.minutesGTDOverlay = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(this.containerEl)
            .setName(t.settings.minutes?.maxDocumentChars || 'Maximum document size')
            .setDesc(t.settings.minutes?.maxDocumentCharsDesc || 'Documents larger than this will trigger truncation options (default: 50000)')
            .addText(text => text
                .setPlaceholder('50000')
                .setValue(String(this.plugin.settings.maxDocumentChars))
                .onChange((value) => {
                    const num = parseInt(value, 10);
                    if (!isNaN(num) && num >= 1000) {
                        this.plugin.settings.maxDocumentChars = num;
                        void this.plugin.saveSettings();
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
                .onChange((value) => {
                    this.plugin.settings.oversizedDocumentBehavior = value as 'truncate' | 'full' | 'ask';
                    void this.plugin.saveSettings();
                }));

        // Phase 4 TRA: Speaker labelling
        new Setting(this.containerEl)
            .setName(t.settings.minutes?.speakerLabelling || 'Speaker labelling')
            .setDesc(t.settings.minutes?.speakerLabellingDesc || 'Use an LLM pre-pass to label unlabelled transcripts with speaker names')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableSpeakerLabelling)
                .onChange(async (value) => {
                    this.plugin.settings.enableSpeakerLabelling = value;
                    await this.plugin.saveSettings();
                }));

        // Phase 4 TRA: Diarisation provider placeholder
        new Setting(this.containerEl)
            .setName(t.settings.minutes?.diarisationProvider || 'Diarisation provider')
            .setDesc(t.settings.minutes?.diarisationProviderDesc || 'External speaker diarisation service (coming soon)')
            .addDropdown(dropdown => dropdown
                .addOption('none', t.settings.minutes?.diarisationNone || 'None')
                .addOption('assemblyai', t.settings.minutes?.diarisationAssemblyAI || 'AssemblyAI')
                .addOption('deepgram', t.settings.minutes?.diarisationDeepgram || 'Deepgram')
                .setValue(this.plugin.settings.audioDiarisationProvider)
                .setDisabled(true)
                .onChange(async (value) => {
                    this.plugin.settings.audioDiarisationProvider = value as 'none' | 'assemblyai' | 'deepgram';
                    await this.plugin.saveSettings();
                }));
    }
}
