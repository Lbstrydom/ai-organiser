/**
 * Audio Transcription Settings Section
 * Recording behavior settings only — provider/key config moved to Specialist Providers.
 */

import { Setting } from 'obsidian';
import { BaseSettingSection } from './BaseSettingSection';
import { getOutputSubfolderPath } from '../../core/settings';
import { DEFAULT_RECORDING_FOLDER } from '../../core/constants';

export class AudioTranscriptionSettingsSection extends BaseSettingSection {
    display(): void {
        const t = this.plugin.t.settings.audioTranscription;

        this.createSectionHeader(t?.title || 'Audio & Recording', 'mic', 2);

        // === Recording sub-section ===
        const tr = this.plugin.t.recording;

        new Setting(this.containerEl)
            .setName(tr?.settingsAutoTranscribe || 'Auto-transcribe recordings')
            .setDesc(tr?.settingsAutoTranscribeDesc || 'Automatically transcribe recordings under 25 MB')
            .addToggle(toggle => {
                toggle.setValue(this.plugin.settings.autoTranscribeRecordings !== false);
                toggle.onChange((value) => {
                    this.plugin.settings.autoTranscribeRecordings = value;
                    void this.plugin.saveSettings();
                });
            });

        new Setting(this.containerEl)
            .setName(tr?.settingsEmbed || 'Embed audio in note')
            .setDesc(tr?.settingsEmbedDesc || 'Include audio file link in note alongside transcript')
            .addToggle(toggle => {
                toggle.setValue(this.plugin.settings.embedAudioInNote !== false);
                toggle.onChange((value) => {
                    this.plugin.settings.embedAudioInNote = value;
                    void this.plugin.saveSettings();
                });
            });

        new Setting(this.containerEl)
            .setName(tr?.settingsQuality || 'Recording quality')
            .setDesc(tr?.settingsQualityDesc || 'Speech optimized saves space (~52 min). High quality for music or detailed audio (~26 min).')
            .addDropdown(dropdown => {
                dropdown
                    .addOption('speech', tr?.qualitySpeech || 'Speech optimized (64 kbps)')
                    .addOption('high', tr?.qualityHigh || 'High quality (128 kbps)')
                    .setValue(this.plugin.settings.recordingQuality || 'speech')
                    .onChange((value) => {
                        this.plugin.settings.recordingQuality = value as 'speech' | 'high';
                        void this.plugin.saveSettings();
                    });
            });

        new Setting(this.containerEl)
            .setName(tr?.settingsPostRecording || 'After transcription')
            .setDesc(tr?.settingsPostRecordingDesc || 'What to do with the raw audio file after successful transcription')
            .addDropdown(dropdown => {
                dropdown
                    .addOption('ask', tr?.postRecordingAsk || 'Ask each time')
                    .addOption('keep-original', tr?.postRecordingKeepOriginal || 'Keep original')
                    .addOption('keep-compressed', tr?.postRecordingKeepCompressed || 'Keep compressed (MP3)')
                    .addOption('delete', tr?.postRecordingDelete || 'Delete audio')
                    .setValue(this.plugin.settings.postRecordingStorage || 'ask')
                    .onChange((value) => {
                        this.plugin.settings.postRecordingStorage = value as 'ask' | 'keep-original' | 'keep-compressed' | 'delete';
                        void this.plugin.saveSettings();
                    });
            });

        const recordingInfoEl = this.containerEl.createDiv({ cls: 'ai-organiser-settings-info' });
        const recordingsPath = getOutputSubfolderPath(this.plugin.settings, DEFAULT_RECORDING_FOLDER);
        recordingInfoEl.textContent = tr?.settingsInfo || `Recordings saved to ${recordingsPath}/`;
    }
}
