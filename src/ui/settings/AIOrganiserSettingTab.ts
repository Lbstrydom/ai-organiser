import { App, PluginSettingTab } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import { LLMSettingsSection } from './LLMSettingsSection';
import { TaggingSettingsSection } from './TaggingSettingsSection';
import { InterfaceSettingsSection } from './InterfaceSettingsSection';
import { SummarizationSettingsSection } from './SummarizationSettingsSection';
import { ConfigurationSettingsSection } from './ConfigurationSettingsSection';
import { SemanticSearchSettingsSection } from './SemanticSearchSettingsSection';

export class AIOrganiserSettingTab extends PluginSettingTab {
    private plugin: AIOrganiserPlugin;
    private llmSection?: LLMSettingsSection;
    private taggingSection?: TaggingSettingsSection;
    private interfaceSection?: InterfaceSettingsSection;
    private summarizationSection?: SummarizationSettingsSection;
    private configurationSection?: ConfigurationSettingsSection;
    private semanticSearchSection?: SemanticSearchSettingsSection;

    constructor(app: App, plugin: AIOrganiserPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        // Initialize and display all sections in logical order
        // 1. Core setup (LLM provider, API keys)
        this.llmSection = new LLMSettingsSection(this.plugin, containerEl, this);
        this.llmSection.display();

        // 2. Interface (language settings - affects all features)
        this.interfaceSection = new InterfaceSettingsSection(this.plugin, containerEl, this);
        this.interfaceSection.display();

        // 3. Feature settings (tagging, summarization)
        this.taggingSection = new TaggingSettingsSection(this.plugin, containerEl, this);
        this.taggingSection.display();

        this.summarizationSection = new SummarizationSettingsSection(this.plugin, containerEl, this);
        this.summarizationSection.display();

        // 4. Advanced features (semantic search)
        this.semanticSearchSection = new SemanticSearchSettingsSection(this.plugin, containerEl, this);
        this.semanticSearchSection.display();

        // 5. Configuration (advanced - config files)
        this.configurationSection = new ConfigurationSettingsSection(this.plugin, containerEl, this);
        this.configurationSection.display();
    }
}
