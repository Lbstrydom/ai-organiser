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
import { PDFSettingsSection } from './PDFSettingsSection';
import { AudioTranscriptionSettingsSection } from './AudioTranscriptionSettingsSection';
import { ExportSettingsSection } from './ExportSettingsSection';
import { CanvasSettingsSection } from './CanvasSettingsSection';

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
    private pdfSection?: PDFSettingsSection;
    private audioTranscriptionSection?: AudioTranscriptionSettingsSection;
    private exportSection?: ExportSettingsSection;
    private canvasSection?: CanvasSettingsSection;

    constructor(app: App, plugin: AIOrganiserPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    async display(): Promise<void> {
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

        // 3. Summarization (core feature) - async, must await
        this.summarizationSection = new SummarizationSettingsSection(this.plugin, containerEl, this);
        await this.summarizationSection.display();

        // 3a. YouTube (input source for summarization)
        this.youtubeSection = new YouTubeSettingsSection(this.plugin, containerEl, this);
        this.youtubeSection.display();

        // 3b. PDF Processing (requires multimodal models)
        this.pdfSection = new PDFSettingsSection(this.plugin, containerEl, this);
        this.pdfSection.display();

        // 3c. Audio Transcription (input source for summarization)
        this.audioTranscriptionSection = new AudioTranscriptionSettingsSection(this.plugin, containerEl, this);
        this.audioTranscriptionSection.display();

        // 4. Meeting Minutes (separate workflow)
        this.minutesSection = new MinutesSettingsSection(this.plugin, containerEl, this);
        this.minutesSection.display();

        // 5. Vault Context / RAG (advanced feature - enhances core features)
        this.semanticSearchSection = new SemanticSearchSettingsSection(this.plugin, containerEl, this);
        this.semanticSearchSection.display();

        // 5b. Canvas boards (builds on semantic search)
        this.canvasSection = new CanvasSettingsSection(this.plugin, containerEl, this);
        this.canvasSection.display();

        // 6. Integrations (external tools - Bases + NotebookLM)
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

        // 6c. Document Export (DOCX/PPTX)
        this.exportSection = new ExportSettingsSection(this.plugin, containerEl, this);
        this.exportSection.display();

        // 7. Interface (preferences - language settings)
        this.interfaceSection = new InterfaceSettingsSection(this.plugin, containerEl, this);
        this.interfaceSection.display();

        // 8. Mobile (platform-specific preferences)
        this.mobileSection = new MobileSettingsSection(this.plugin, containerEl, this);
        this.mobileSection.display();

        // 9. Configuration (advanced - config files)
        this.configurationSection = new ConfigurationSettingsSection(this.plugin, containerEl, this);
        this.configurationSection.display();
    }
}
