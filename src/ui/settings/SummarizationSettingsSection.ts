/**
 * Summarization Settings Section
 */

import { Setting } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import { BaseSettingSection } from './BaseSettingSection';
import type { AIOrganiserSettingTab } from './AIOrganiserSettingTab';
import type { Persona } from '../../services/configurationService';

export class SummarizationSettingsSection extends BaseSettingSection {
  private personas: Persona[] = [];

  constructor(
    plugin: AIOrganiserPlugin,
    containerEl: HTMLElement,
    settingTab: AIOrganiserSettingTab
  ) {
    super(plugin, containerEl, settingTab);
  }

  async display(): Promise<void> {
    const { containerEl, plugin } = this;
    const t = plugin.t.settings.summarization;

    // Load personas from config service
    this.personas = await plugin.configService.getSummaryPersonas();

    // Main section header
    containerEl.createEl('h3', { text: t.title });

    // Enable summarization feature toggle
    new Setting(containerEl)
      .setName(t.enableFeature || 'Enable Summarization')
      .setDesc(t.enableFeatureDesc || 'Enable URL and PDF summarization commands')
      .addToggle(toggle =>
        toggle
          .setValue(plugin.settings.enableWebSummarization)
          .onChange(async value => {
            plugin.settings.enableWebSummarization = value;
            await plugin.saveSettings();
          })
      );

    // Summary Output Options subheader
    containerEl.createEl('h4', { text: t.outputOptions || 'Output Options' });

    // Default Summary Persona
    new Setting(containerEl)
      .setName(t.defaultPersona || 'Default Summary Style')
      .setDesc(t.defaultPersonaDesc || 'Choose the default note-taking style for summaries. You can override this when summarizing.')
      .addDropdown(dropdown => {
        for (const persona of this.personas) {
          dropdown.addOption(persona.id, `${persona.name} - ${persona.description}`);
        }
        dropdown.setValue(plugin.settings.defaultSummaryPersona || 'student');
        dropdown.onChange(async value => {
          plugin.settings.defaultSummaryPersona = value;
          await plugin.saveSettings();
        });
      });

    // Edit summary personas button
    new Setting(containerEl)
      .setName(t.editPersonas || 'Edit Summary Personas')
      .setDesc(t.editPersonasDesc || 'Customize how summaries are formatted by editing the personas file')
      .addButton(button =>
        button
          .setButtonText(t.openPersonasFile || 'Open Personas File')
          .onClick(async () => {
            await plugin.configService.openConfigFile('summaryPersonas');
          })
      );

    // Summary length
    new Setting(containerEl)
      .setName(t.length)
      .setDesc(t.lengthDesc)
      .addDropdown(dropdown =>
        dropdown
          .addOption('brief', t.brief)
          .addOption('detailed', t.detailed)
          .addOption('comprehensive', t.comprehensive)
          .setValue(plugin.settings.summaryLength)
          .onChange(async value => {
            plugin.settings.summaryLength = value as 'brief' | 'detailed' | 'comprehensive';
            await plugin.saveSettings();
          })
      );

    // Include metadata
    new Setting(containerEl)
      .setName(t.includeMetadata)
      .setDesc(t.includeMetadataDesc)
      .addToggle(toggle =>
        toggle
          .setValue(plugin.settings.includeSummaryMetadata)
          .onChange(async value => {
            plugin.settings.includeSummaryMetadata = value;
            await plugin.saveSettings();
          })
      );

    // Transcript Settings subheader
    containerEl.createEl('h4', { text: t.transcriptOptions || 'Transcript Options' });

    // Save transcripts setting
    new Setting(containerEl)
      .setName(t.saveTranscripts || 'Save Transcripts')
      .setDesc(t.saveTranscriptsDesc || 'Save full transcripts from audio and YouTube for later reference')
      .addDropdown(dropdown =>
        dropdown
          .addOption('none', t.transcriptNone || 'Do not save')
          .addOption('file', t.transcriptFile || 'Save to separate file')
          .setValue(plugin.settings.saveTranscripts)
          .onChange(async value => {
            plugin.settings.saveTranscripts = value as 'none' | 'file';
            await plugin.saveSettings();
          })
      );

    // Transcript folder
    new Setting(containerEl)
      .setName(t.transcriptFolder || 'Transcript Folder')
      .setDesc(t.transcriptFolderDesc || 'Folder where transcript files will be saved')
      .addText(text =>
        text
          .setPlaceholder('Transcripts')
          .setValue(plugin.settings.transcriptFolder)
          .onChange(async value => {
            plugin.settings.transcriptFolder = value || 'Transcripts';
            await plugin.saveSettings();
          })
      );
  }
}
