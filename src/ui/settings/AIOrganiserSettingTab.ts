import { App, PluginSettingTab, setIcon } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import { LLMSettingsSection } from './LLMSettingsSection';
import { SpecialistProvidersSettingsSection } from './SpecialistProvidersSettingsSection';
import { TaggingSettingsSection } from './TaggingSettingsSection';
import { InterfaceSettingsSection } from './InterfaceSettingsSection';
import { SummarizationSettingsSection } from './SummarizationSettingsSection';
import { MinutesSettingsSection } from './MinutesSettingsSection';
import { ConfigurationSettingsSection } from './ConfigurationSettingsSection';
import { SemanticSearchSettingsSection } from './SemanticSearchSettingsSection';
import { MobileSettingsSection } from './MobileSettingsSection';
import { BasesSettingsSection } from './BasesSettingsSection';
import { NotebookLMSettingsSection } from './NotebookLMSettingsSection';
import { AudioTranscriptionSettingsSection } from './AudioTranscriptionSettingsSection';
import { ExportSettingsSection } from './ExportSettingsSection';
import { NewsletterSettingsSection } from './NewsletterSettingsSection';
import { CanvasSettingsSection } from './CanvasSettingsSection';
import { KindleSettingsSection } from './KindleSettingsSection';
import { DigitisationSettingsSection } from './DigitisationSettingsSection';
import { SketchSettingsSection } from './SketchSettingsSection';
import { ResearchSettingsSection } from './ResearchSettingsSection';
import { MermaidChatSettingsSection } from './MermaidChatSettingsSection';
import { AIChatSettingsSection } from './AIChatSettingsSection';

export class AIOrganiserSettingTab extends PluginSettingTab {
    private plugin: AIOrganiserPlugin;
    private expandedSections = new Set<string>(['ai-provider']);

    constructor(app: App, plugin: AIOrganiserPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    private createSubCollapsibleSection(
        container: HTMLElement,
        id: string,
        title: string,
        icon: string
    ): HTMLElement {
        const details = container.createEl('details', {
            cls: 'ai-organiser-settings-sub-section'
        });
        details.open = this.expandedSections.has(id);
        details.addEventListener('toggle', () => {
            if (details.open) this.expandedSections.add(id);
            else this.expandedSections.delete(id);
        });
        const summary = details.createEl('summary', {
            cls: 'ai-organiser-settings-sub-section-summary'
        });
        const headerEl = summary.createDiv({ cls: 'ai-organiser-settings-sub-section-header' });
        const iconEl = headerEl.createSpan({ cls: 'ai-organiser-settings-header-icon' });
        setIcon(iconEl, icon);
        headerEl.createSpan({ text: title });
        return details.createDiv({ cls: 'ai-organiser-settings-sub-section-content' });
    }

    private createCollapsibleSection(
        id: string,
        title: string,
        icon: string,
        description: string
    ): HTMLElement {
        const details = this.containerEl.createEl('details', {
            cls: 'ai-organiser-settings-section'
        });
        details.open = this.expandedSections.has(id);
        details.addEventListener('toggle', () => {
            if (details.open) this.expandedSections.add(id);
            else this.expandedSections.delete(id);
        });
        const summary = details.createEl('summary', {
            cls: 'ai-organiser-settings-section-summary'
        });
        const headerEl = summary.createDiv({ cls: 'ai-organiser-settings-section-header' });
        const iconEl = headerEl.createSpan({ cls: 'ai-organiser-settings-header-icon' });
        setIcon(iconEl, icon);
        headerEl.createSpan({ text: title });
        summary.createEl('p', {
            text: description,
            cls: 'ai-organiser-settings-section-desc'
        });
        return details.createDiv({ cls: 'ai-organiser-settings-section-content' });
    }

    display(): void { void this.displayAsync(); }
    private async displayAsync(): Promise<void> {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.addClass('ai-organiser-settings');

        const t = this.plugin.t.settings;
        const d = t.sectionDescriptions;

        // 1. AI Provider (open by default)
        let content = this.createCollapsibleSection(
            'ai-provider',
            t.llm.title,
            'bot',
            d?.aiProvider || 'Configure your main LLM provider and API keys'
        );
        const llmSection = new LLMSettingsSection(this.plugin, content, this);
        llmSection.display();

        // 2. Specialist Providers
        content = this.createCollapsibleSection(
            'specialist-providers',
            t.specialistProviders?.title || 'Specialist Providers',
            'zap',
            d?.specialistProviders || 'Dedicated providers for YouTube, PDF, Audio, and Flashcards'
        );
        const specialistSection = new SpecialistProvidersSettingsSection(this.plugin, content, this);
        await specialistSection.display();

        // 3. Tagging
        content = this.createCollapsibleSection(
            'tagging',
            t.tagging.title,
            'tags',
            d?.tagging || 'AI-powered tag generation and management'
        );
        const taggingSection = new TaggingSettingsSection(this.plugin, content, this);
        taggingSection.display();

        // 4. Summarization
        content = this.createCollapsibleSection(
            'summarization',
            t.summarization.title,
            'file-text',
            d?.summarization || 'Summary styles, personas, and output options'
        );
        const summarizationSection = new SummarizationSettingsSection(this.plugin, content, this);
        await summarizationSection.display();

        // 5. Capture & Input (umbrella for Audio, Digitisation, Sketch, Kindle)
        content = this.createCollapsibleSection(
            'capture-input',
            t.captureInput?.title || 'Capture & Input',
            'microphone',
            d?.captureInput || 'Audio recording, image digitisation, and sketch pad settings'
        );
        let sub = this.createSubCollapsibleSection(content, 'sub-audio', t.audioTranscription?.title || 'Audio & Recording', 'mic');
        new AudioTranscriptionSettingsSection(this.plugin, sub, this).display();
        sub = this.createSubCollapsibleSection(content, 'sub-digitisation', t.digitisation?.title || 'Smart Digitisation', 'scan');
        await new DigitisationSettingsSection(this.plugin, sub, this).display();
        sub = this.createSubCollapsibleSection(content, 'sub-sketch', t.sketch?.title || 'Sketch Pad', 'pencil');
        await new SketchSettingsSection(this.plugin, sub, this).display();
        sub = this.createSubCollapsibleSection(content, 'sub-kindle', t.kindle?.title || 'Kindle Highlights', 'book-open');
        await new KindleSettingsSection(this.plugin, sub, this).display();

        // 6. Meeting Minutes
        content = this.createCollapsibleSection(
            'meeting-minutes',
            t.minutes?.title || 'Meeting Minutes',
            'calendar-clock',
            d?.meetingMinutes || 'Generate structured meeting minutes from transcripts'
        );
        const minutesSection = new MinutesSettingsSection(this.plugin, content, this);
        minutesSection.display();

        // 7. Vault Intelligence (umbrella for Semantic Search, Canvas, Mermaid, Research)
        content = this.createCollapsibleSection(
            'vault-intelligence',
            t.vaultIntelligence?.title || 'Vault Intelligence',
            'brain',
            d?.vaultIntelligence || 'Semantic search, RAG context, and canvas visualizations'
        );
        sub = this.createSubCollapsibleSection(content, 'sub-semantic-search', t.semanticSearch?.title || 'Semantic Search', 'brain-circuit');
        await new SemanticSearchSettingsSection(this.plugin, sub, this).display();
        sub = this.createSubCollapsibleSection(content, 'sub-canvas', this.plugin.t.canvas?.settingsTitle || 'Canvas Boards', 'layout-grid');
        new CanvasSettingsSection(this.plugin, sub, this).display();
        sub = this.createSubCollapsibleSection(content, 'sub-mermaid', this.plugin.t.modals?.mermaidChat?.settingsTitle || 'Mermaid Diagram Chat', 'share-2');
        new MermaidChatSettingsSection(this.plugin, sub, this).display();
        sub = this.createSubCollapsibleSection(content, 'sub-research', t.research?.title || 'Research Assistant', 'telescope');
        await new ResearchSettingsSection(this.plugin, sub, this).display();

        // 8. AI Chat (conversation persistence, projects, global memory)
        content = this.createCollapsibleSection(
            'ai-chat',
            t.aichat?.chatRootFolderTitle || 'AI Chat',
            'message-square',
            'Conversation persistence, projects, and global memory'
        );
        await new AIChatSettingsSection(this.plugin, content, this).display();

        // 9. Integrations (Bases, NotebookLM, Newsletter, Export)
        content = this.createCollapsibleSection(
            'integrations',
            t.integrations?.title || 'Integrations',
            'puzzle',
            d?.integrations || 'External tools and export options'
        );
        sub = this.createSubCollapsibleSection(content, 'sub-bases', t.bases?.title || 'Obsidian Bases', 'database');
        new BasesSettingsSection(this.plugin, sub, this).display();
        sub = this.createSubCollapsibleSection(content, 'sub-notebooklm', t.notebookLM?.title || 'NotebookLM', 'book-open');
        await new NotebookLMSettingsSection(this.plugin, sub, this).display();
        sub = this.createSubCollapsibleSection(content, 'sub-newsletter', t.newsletter?.title || 'Newsletter Digest', 'mail');
        new NewsletterSettingsSection(this.plugin, sub, this).display();
        sub = this.createSubCollapsibleSection(content, 'sub-export', t.export?.title || 'Document Export', 'file-output');
        new ExportSettingsSection(this.plugin, sub, this).display();

        // 10. Preferences (Interface, Mobile)
        content = this.createCollapsibleSection(
            'preferences',
            t.preferences?.title || 'Preferences',
            'settings',
            d?.preferences || 'Language, interface, and mobile platform settings'
        );
        sub = this.createSubCollapsibleSection(content, 'sub-interface', t.interface?.title || 'Language & Interface', 'languages');
        new InterfaceSettingsSection(this.plugin, sub, this).display();
        sub = this.createSubCollapsibleSection(content, 'sub-mobile', t.mobile?.title || 'Mobile', 'smartphone');
        new MobileSettingsSection(this.plugin, sub, this).display();

        // 10. Advanced (Configuration)
        content = this.createCollapsibleSection(
            'advanced',
            t.configuration?.title || 'Advanced',
            'wrench',
            d?.advanced || 'Configuration files and vault management'
        );
        const configurationSection = new ConfigurationSettingsSection(this.plugin, content, this);
        configurationSection.display();
    }
}
