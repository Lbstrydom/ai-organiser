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
    this.createSectionHeader(t.title, 'file-text');

    // Enable summarization feature toggle
    new Setting(containerEl)
      .setName(t.enableFeature || 'Enable summarization')
      .setDesc(t.enableFeatureDesc || 'Enable URL and PDF summarization commands')
      .addToggle(toggle =>
        toggle
          .setValue(plugin.settings.enableWebSummarization)
          .onChange(value => {
            plugin.settings.enableWebSummarization = value;
            void plugin.saveSettings();
          })
      );

    // Summary Output Options subheader
    containerEl.createEl('h4', { text: t.outputOptions || 'Output options' });

    // Default Summary Persona
    new Setting(containerEl)
      .setName(t.defaultPersona || 'Default summary style')
      .setDesc(t.defaultPersonaDesc || 'Choose the default note-taking style for summaries. You can override this when summarizing.')
      .addDropdown(dropdown => {
        for (const persona of this.personas) {
          dropdown.addOption(persona.id, `${persona.name} - ${persona.description}`);
        }
        dropdown.setValue(plugin.settings.defaultSummaryPersona || 'student');
        dropdown.onChange(value => {
          plugin.settings.defaultSummaryPersona = value;
          void plugin.saveSettings();
        });
      });

    // Edit summary personas button
    new Setting(containerEl)
      .setName(t.editPersonas || 'Edit summary personas')
      .setDesc(t.editPersonasDesc || 'Customize how summaries are formatted by editing the personas file')
      .addButton(button =>
        button
          .setButtonText(t.openPersonasFile || 'Open personas file')
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
          .addOption('standard', t.standard)
          .addOption('detailed', t.detailed)
          .setValue(plugin.settings.summaryLength)
          .onChange(value => {
            plugin.settings.summaryLength = value as 'brief' | 'standard' | 'detailed';
            void plugin.saveSettings();
          })
      );

    // Include metadata
    new Setting(containerEl)
      .setName(t.includeMetadata)
      .setDesc(t.includeMetadataDesc)
      .addToggle(toggle =>
        toggle
          .setValue(plugin.settings.includeSummaryMetadata)
          .onChange(value => {
            plugin.settings.includeSummaryMetadata = value;
            void plugin.saveSettings();
          })
      );

    // Multi-source Documents subheader
    containerEl.createEl('h4', { text: t.multiSourceDocuments || 'Multi-source documents' });

    // Multi-source max document characters
    new Setting(containerEl)
      .setName(t.multiSourceMaxDocumentChars || 'Maximum document size (multi-source)')
      .setDesc(t.multiSourceMaxDocumentCharsDesc || 'Documents larger than this will be truncated or handled per setting')
      .addText(text =>
        text
          .setPlaceholder('100000')
          .setValue(String(plugin.settings.multiSourceMaxDocumentChars))
          .onChange(value => {
            const num = parseInt(value, 10);
            if (!isNaN(num) && num >= 1000) {
              plugin.settings.multiSourceMaxDocumentChars = num;
              void plugin.saveSettings();
            }
          })
      );

    // Multi-source oversized behavior
    new Setting(containerEl)
      .setName(t.multiSourceOversizedBehavior || 'Oversized document handling (multi-source)')
      .setDesc(t.multiSourceOversizedBehaviorDesc || 'What to do when a document exceeds the size limit')
      .addDropdown(dropdown =>
        dropdown
          .addOption('ask', t.multiSourceOversizedAsk || 'Ask for each document')
          .addOption('truncate', t.multiSourceOversizedTruncate || 'Always truncate')
          .addOption('full', t.multiSourceOversizedFull || 'Always use full content')
          .setValue(plugin.settings.multiSourceOversizedBehavior)
          .onChange(value => {
            plugin.settings.multiSourceOversizedBehavior = value as 'truncate' | 'full' | 'ask';
            void plugin.saveSettings();
          })
      );

    // Transcript Settings subheader
    containerEl.createEl('h4', { text: t.transcriptOptions || 'Transcript options' });

    // Save transcripts setting
    new Setting(containerEl)
      .setName(t.saveTranscripts || 'Save transcripts')
      .setDesc(t.saveTranscriptsDesc || 'Save full transcripts from audio and YouTube for later reference')
      .addDropdown(dropdown =>
        dropdown
          .addOption('none', t.transcriptNone || 'Do not save')
          .addOption('file', t.transcriptFile || 'Save to separate file')
          .setValue(plugin.settings.saveTranscripts)
          .onChange(value => {
            plugin.settings.saveTranscripts = value as 'none' | 'file';
            void plugin.saveSettings();
          })
      );

    // Transcript folder
    new Setting(containerEl)
      .setName(t.transcriptFolder || 'Transcript folder')
      .setDesc(t.transcriptFolderDesc || 'Folder where transcript files will be saved')
      .addText(text =>
        text
          .setPlaceholder('Transcripts')
          .setValue(plugin.settings.transcriptFolder)
          .onChange(value => {
            plugin.settings.transcriptFolder = value || 'Transcripts';
            void plugin.saveSettings();
          })
      );

    // Advanced Options subheader
    containerEl.createEl('h4', { text: t.advancedOptions || 'Advanced options' });

    // Summarization timeout (power user setting)
    new Setting(containerEl)
      .setName(t.timeout || 'Request timeout')
      .setDesc(t.timeoutDesc || 'Seconds to wait for AI response. Increase for slow models or large content (30-900 seconds).')
      .addSlider(slider =>
        slider
          .setLimits(30, 900, 30)
          .setValue(plugin.settings.summarizeTimeoutSeconds)
          .setDynamicTooltip()
          .onChange(value => {
            plugin.settings.summarizeTimeoutSeconds = value;
            void plugin.saveSettings();
            // Update LLM service timeout if available
            if (plugin.llmService) {
              plugin.llmService.setSummarizeTimeout(value);
            }
          })
      )
      .addExtraButton(button =>
        button
          .setIcon('reset')
          .setTooltip(t.resetToDefault || 'Reset to default (120s)')
          .onClick(async () => {
            plugin.settings.summarizeTimeoutSeconds = 120;
            await plugin.saveSettings();
            if (plugin.llmService) {
              plugin.llmService.setSummarizeTimeout(120);
            }
            // Refresh the settings display
            this.settingTab.display();
          })
      );
  }
}
