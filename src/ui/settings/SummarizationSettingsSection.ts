/**
 * Summarization Settings Section
 */

import { Setting } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import { BaseSettingSection } from './BaseSettingSection';
import type { AIOrganiserSettingTab } from './AIOrganiserSettingTab';
import { BUILTIN_PERSONAS } from '../../services/prompts/summaryPersonas';
import { COMMON_LANGUAGES, getLanguageDisplayName } from '../../services/languages';

export class SummarizationSettingsSection extends BaseSettingSection {
  constructor(
    plugin: AIOrganiserPlugin,
    containerEl: HTMLElement,
    settingTab: AIOrganiserSettingTab
  ) {
    super(plugin, containerEl, settingTab);
  }

  display(): void {
    const { containerEl, plugin } = this;
    const t = plugin.t.settings.summarization;

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
        for (const persona of BUILTIN_PERSONAS) {
          dropdown.addOption(persona.id, `${persona.name} - ${persona.description}`);
        }
        dropdown.setValue(plugin.settings.defaultSummaryPersona || 'student');
        dropdown.onChange(async value => {
          plugin.settings.defaultSummaryPersona = value;
          await plugin.saveSettings();
        });
      });

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

    // Summary language
    new Setting(containerEl)
      .setName(t.language)
      .setDesc(t.languageDesc)
      .addDropdown(dropdown => {
        for (const lang of COMMON_LANGUAGES) {
          dropdown.addOption(lang.code, getLanguageDisplayName(lang));
        }
        dropdown.setValue(plugin.settings.summaryLanguage || 'auto');
        dropdown.onChange(async value => {
          plugin.settings.summaryLanguage = value === 'auto' ? '' : value;
          await plugin.saveSettings();
        });
      });

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
  }
}
