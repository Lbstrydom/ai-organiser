/**
 * Audio narration settings section.
 * Lives under Capture & Input umbrella between Audio & Recording and Smart Digitisation.
 */

import { Setting } from 'obsidian';
import { BaseSettingSection } from './BaseSettingSection';
import { NARRATION_PROVIDERS } from '../../services/tts/ttsProviderRegistry';

export class AudioNarrationSettingsSection extends BaseSettingSection {
    display(): void {
        const t = this.plugin.t.settings.audioNarration;
        const newsletterT = this.plugin.t.settings.newsletter;
        this.createSectionHeader(t.title, 'audio-lines', 2);

        // Voice
        new Setting(this.containerEl)
            .setName(t.voice)
            .setDesc(t.voiceDesc)
            .addDropdown(dropdown => {
                const provider = NARRATION_PROVIDERS.gemini;
                for (const v of provider.voices) {
                    // Voice labels live under settings.newsletter.podcastVoice* — shared with newsletter audio.
                    const label = (newsletterT as unknown as Record<string, string>)[v.labelKey.split('.').pop() || ''] || v.id;
                    dropdown.addOption(v.id, label);
                }
                dropdown
                    .setValue(this.plugin.settings.audioNarrationVoice || provider.defaultVoice)
                    .onChange(value => {
                        this.plugin.settings.audioNarrationVoice = value;
                        void this.plugin.saveSettings();
                    });
            });

        // Output folder
        new Setting(this.containerEl)
            .setName(t.outputFolder)
            .setDesc(t.outputFolderDesc)
            .addText(text => text
                .setPlaceholder('Narrations')
                .setValue(this.plugin.settings.audioNarrationOutputFolder)
                .onChange(value => {
                    this.plugin.settings.audioNarrationOutputFolder = value.trim() || 'Narrations';
                    void this.plugin.saveSettings();
                }));

        // Embed in note
        new Setting(this.containerEl)
            .setName(t.embedInNote)
            .setDesc(t.embedInNoteDesc)
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.audioNarrationEmbedInNote)
                .onChange(value => {
                    this.plugin.settings.audioNarrationEmbedInNote = value;
                    void this.plugin.saveSettings();
                }));

        // Info box
        const info = this.containerEl.createDiv({ cls: 'ai-organiser-settings-info' });
        info.createEl('p', { text: t.infoBox });
    }
}
