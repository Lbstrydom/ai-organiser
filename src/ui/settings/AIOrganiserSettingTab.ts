import { App, PluginSettingTab, setIcon } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import { LLMSettingsSection } from './LLMSettingsSection';
import { TaggingSettingsSection } from './TaggingSettingsSection';
import { InterfaceSettingsSection } from './InterfaceSettingsSection';
import { SummarizationSettingsSection } from './SummarizationSettingsSection';
import { MinutesSettingsSection } from './MinutesSettingsSection';
import { ConfigurationSettingsSection } from './ConfigurationSettingsSection';
import { SemanticSearchSettingsSection } from './SemanticSearchSettingsSection';
import { MobileSettingsSection } from './MobileSettingsSection';
import { BasesSettingsSection } from './BasesSettingsSection';
import { NotebookLMSettingsSection } from './NotebookLMSettingsSection';
import { YouTubeSettingsSection } from './YouTubeSettingsSection';
import { AudioTranscriptionSettingsSection } from './AudioTranscriptionSettingsSection';

export class AIOrganiserSettingTab extends PluginSettingTab {
    private plugin: AIOrganiserPlugin;
    private llmSection?: LLMSettingsSection;
    private taggingSection?: TaggingSettingsSection;
    private interfaceSection?: InterfaceSettingsSection;
    private summarizationSection?: SummarizationSettingsSection;
    private minutesSection?: MinutesSettingsSection;
    private configurationSection?: ConfigurationSettingsSection;
    private semanticSearchSection?: SemanticSearchSettingsSection;
    private mobileSection?: MobileSettingsSection;
    private basesSection?: BasesSettingsSection;
    private notebookLMSection?: NotebookLMSettingsSection;
    private youtubeSection?: YouTubeSettingsSection;
    private audioTranscriptionSection?: AudioTranscriptionSettingsSection;

    constructor(app: App, plugin: AIOrganiserPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.addClass('ai-organiser-settings');

        // Settings order: Essential → Core Features → Advanced Features → Integrations → Preferences → Advanced Config

        // 1. AI Provider (essential - must configure first)
        this.llmSection = new LLMSettingsSection(this.plugin, containerEl, this);
        this.llmSection.display();

        // 2. Tagging (core feature)
        this.taggingSection = new TaggingSettingsSection(this.plugin, containerEl, this);
        this.taggingSection.display();

        // 3. Summarization (core feature)
        this.summarizationSection = new SummarizationSettingsSection(this.plugin, containerEl, this);
        this.summarizationSection.display();

        // 3b. Meeting Minutes (corporate workflow)
        this.minutesSection = new MinutesSettingsSection(this.plugin, containerEl, this);
        this.minutesSection.display();

        // 3c. YouTube (Gemini-native processing for YouTube videos)
        this.youtubeSection = new YouTubeSettingsSection(this.plugin, containerEl, this);
        this.youtubeSection.display();

        // 3d. Audio Transcription (Whisper API for audio files)
        this.audioTranscriptionSection = new AudioTranscriptionSettingsSection(this.plugin, containerEl, this);
        this.audioTranscriptionSection.display();

        // 4. Vault Context / RAG (advanced feature - enhances core features)
        this.semanticSearchSection = new SemanticSearchSettingsSection(this.plugin, containerEl, this);
        this.semanticSearchSection.display();

        // 5. Integrations (external tools - Bases + NotebookLM)
        const integrationsHeader = containerEl.createEl('h1', { cls: 'ai-organiser-settings-header' });
        const integrationsIcon = integrationsHeader.createSpan({ cls: 'ai-organiser-settings-header-icon' });
        setIcon(integrationsIcon, 'puzzle');
        integrationsHeader.createSpan({ text: this.plugin.t.settings.integrations?.title || 'Integrations' });
        containerEl.createEl('p', {
            text: this.plugin.t.settings.integrations?.description || 'Configure integrations with external tools and plugins.',
            cls: 'setting-item-description'
        });

        this.basesSection = new BasesSettingsSection(this.plugin, containerEl, this);
        this.basesSection.display();

        this.notebookLMSection = new NotebookLMSettingsSection(this.plugin, containerEl, this);
        this.notebookLMSection.display();

        // 6. Interface (preferences - language settings)
        this.interfaceSection = new InterfaceSettingsSection(this.plugin, containerEl, this);
        this.interfaceSection.display();

        // 7. Mobile (platform-specific preferences)
        this.mobileSection = new MobileSettingsSection(this.plugin, containerEl, this);
        this.mobileSection.display();

        // 8. Configuration (advanced - config files)
        this.configurationSection = new ConfigurationSettingsSection(this.plugin, containerEl, this);
        this.configurationSection.display();
    }
}
