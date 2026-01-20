import { App, PluginSettingTab } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import { LLMSettingsSection } from './LLMSettingsSection';
import { TaggingSettingsSection } from './TaggingSettingsSection';
import { SupportSection } from './SupportSection';
import { InterfaceSettingsSection } from './InterfaceSettingsSection';
import { SummarizationSettingsSection } from './SummarizationSettingsSection';
import { ConfigurationSettingsSection } from './ConfigurationSettingsSection';

export class AIOrganiserSettingTab extends PluginSettingTab {
    private plugin: AIOrganiserPlugin;
    private llmSection?: LLMSettingsSection;
    private taggingSection?: TaggingSettingsSection;
    private supportSection?: SupportSection;
    private interfaceSection?: InterfaceSettingsSection;
    private summarizationSection?: SummarizationSettingsSection;
    private configurationSection?: ConfigurationSettingsSection;

    constructor(app: App, plugin: AIOrganiserPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        // Initialize all sections
        this.llmSection = new LLMSettingsSection(this.plugin, containerEl, this);
        this.taggingSection = new TaggingSettingsSection(this.plugin, containerEl, this);
        this.configurationSection = new ConfigurationSettingsSection(this.plugin, containerEl, this);
        this.interfaceSection = new InterfaceSettingsSection(this.plugin, containerEl, this);
        this.summarizationSection = new SummarizationSettingsSection(this.plugin, containerEl, this);
        this.supportSection = new SupportSection(this.plugin, containerEl, this);

        // Display all sections
        this.llmSection.display();
        this.taggingSection.display();
        this.configurationSection.display();
        this.interfaceSection.display();
        this.summarizationSection.display();
        this.supportSection.display();
    }
}
