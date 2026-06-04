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
import { AudioNarrationSettingsSection } from './AudioNarrationSettingsSection';
import { ExportSettingsSection } from './ExportSettingsSection';
import { NewsletterSettingsSection } from './NewsletterSettingsSection';
import { CanvasSettingsSection } from './CanvasSettingsSection';
import { KindleSettingsSection } from './KindleSettingsSection';
import { DigitisationSettingsSection } from './DigitisationSettingsSection';
import { SketchSettingsSection } from './SketchSettingsSection';
import { ResearchSettingsSection } from './ResearchSettingsSection';
import { MermaidChatSettingsSection } from './MermaidChatSettingsSection';
import { AIChatSettingsSection } from './AIChatSettingsSection';
import { BrandSettingsSection } from './BrandSettingsSection';
import { SECTION_FEATURE, INFRA_SECTIONS } from '../../core/features';
import { isFeatureEnabled } from '../../services/featureService';

export class AIOrganiserSettingTab extends PluginSettingTab {
    private plugin: AIOrganiserPlugin;
    private expandedSections = new Set<string>(['ai-provider']);

    /** Sub-section id to scroll into view after the next display() — set
     *  by `revealSubSection()` and consumed once. */
    private pendingScrollToSubSection: string | null = null;

    /**
     * Test seam (FT-4 render-spy): records every section id passed to
     * `renderIfEnabled` across one full render, regardless of whether it was
     * shown. The completeness test asserts the captured set equals
     * `SECTION_FEATURE` keys ∪ `INFRA_SECTIONS` — keeping the procedural tab
     * verified-live with NO parallel hand-authored shadow (the guard IS the
     * consumer — Gemini-G2).
     */
    sectionRenderSpy?: (sectionId: string) => void;

    constructor(app: App, plugin: AIOrganiserPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    /**
     * Is a feature-owned (or infra) settings section enabled? Infra sections
     * (Interface/Mobile/Configuration) always render; a feature-owned section
     * gates on its `SECTION_FEATURE` feature. Fail-closed (FT-4): a section id
     * in neither map is hidden — the completeness test catches the drift.
     */
    private isSectionEnabled(sectionId: string): boolean {
        if (INFRA_SECTIONS.includes(sectionId)) return true;
        const feature = SECTION_FEATURE[sectionId];
        if (!feature) return false;
        return isFeatureEnabled(this.plugin.settings, feature);
    }

    /**
     * Render a feature-owned/infra child section only when enabled (FT-4). The
     * single guard ALL sections pass through — it both records the id (render-spy)
     * and gates the (possibly async) render. The render closure owns the
     * collapsible/sub-collapsible creation, so a disabled section produces no
     * DOM at all (top-level → no collapsible; sub → no sub-collapsible →
     * contributes to empty-umbrella suppression).
     */
    private async renderIfEnabled(sectionId: string, render: () => void | Promise<void>): Promise<void> {
        this.sectionRenderSpy?.(sectionId);
        if (!this.isSectionEnabled(sectionId)) return;
        await render();
    }

    /**
     * Empty-umbrella suppression by post-block removal (FT-10i, async-aware).
     * Called AFTER all of an umbrella's children have rendered + awaited: if the
     * umbrella's content holds zero rendered sub-sections, remove the whole
     * `<details>`. Pure DOM derivation of the gated child set — no pre-computed
     * child-count shadow.
     */
    private removeUmbrellaIfEmpty(content: HTMLElement): void {
        if (content.querySelectorAll('.ai-organiser-settings-sub-section').length === 0) {
            content.closest('details')?.remove();
        }
    }

    /**
     * Deep-link entry point: ensure the parent + sub-section are expanded
     * and scroll the sub-section into view on the next render. Safe to
     * call before display(); the scroll happens after the DOM is built.
     */
    revealSubSection(parentId: string, subId: string): void {
        this.expandedSections.add(parentId);
        this.expandedSections.add(subId);
        this.pendingScrollToSubSection = subId;
    }

    private createSubCollapsibleSection(
        container: HTMLElement,
        id: string,
        title: string,
        icon: string
    ): HTMLElement {
        const details = container.createEl('details', {
            cls: 'ai-organiser-settings-sub-section',
            attr: { 'data-section-id': id },
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

        // NOTE (Cluster A): every feature-owned child section is wrapped in
        // `renderIfEnabled` (the FT-4 guard / render-spy). The Features-toggle
        // UI itself (`FeaturesSettingsSection`, rendered first) lands in Cluster B
        // (Phase 3) — Cluster A is the read-side gating; flags are seeded by
        // `migrateOldSettings` so the gating is live even before the toggle UI exists.

        // 1. AI Provider (open by default) — provider (core)
        await this.renderIfEnabled('ai-provider', () => {
            const content = this.createCollapsibleSection(
                'ai-provider', t.llm.title, 'bot',
                d?.aiProvider || 'Configure your main LLM provider and API keys',
            );
            new LLMSettingsSection(this.plugin, content, this).display();
        });

        // 2. Specialist Providers — provider (core)
        await this.renderIfEnabled('specialist-providers', async () => {
            const content = this.createCollapsibleSection(
                'specialist-providers', t.specialistProviders?.title || 'Specialist Providers', 'zap',
                d?.specialistProviders || 'Dedicated providers for YouTube, PDF, Audio, and Flashcards',
            );
            await new SpecialistProvidersSettingsSection(this.plugin, content, this).display();
        });

        // 3. Tagging — tagging (core)
        await this.renderIfEnabled('tagging', () => {
            const content = this.createCollapsibleSection(
                'tagging', t.tagging.title, 'tags',
                d?.tagging || 'AI-powered tag generation and management',
            );
            new TaggingSettingsSection(this.plugin, content, this).display();
        });

        // 4. Summarization — summarize
        await this.renderIfEnabled('summarization', async () => {
            const content = this.createCollapsibleSection(
                'summarization', t.summarization.title, 'file-text',
                d?.summarization || 'Summary styles, personas, and output options',
            );
            await new SummarizationSettingsSection(this.plugin, content, this).display();
        });

        // 5. Capture & Input (umbrella for Audio, Digitisation, Sketch, Kindle)
        {
            const content = this.createCollapsibleSection(
                'capture-input', t.captureInput?.title || 'Capture & Input', 'microphone',
                d?.captureInput || 'Audio recording, image digitisation, and sketch pad settings',
            );
            await this.renderIfEnabled('sub-audio', () => {
                const sub = this.createSubCollapsibleSection(content, 'sub-audio', t.audioTranscription?.title || 'Audio & Recording', 'mic');
                new AudioTranscriptionSettingsSection(this.plugin, sub, this).display();
            });
            await this.renderIfEnabled('sub-audio-narration', () => {
                const sub = this.createSubCollapsibleSection(content, 'sub-audio-narration', t.audioNarration?.title || 'Audio narration', 'audio-lines');
                new AudioNarrationSettingsSection(this.plugin, sub, this).display();
            });
            await this.renderIfEnabled('sub-digitisation', () => {
                const sub = this.createSubCollapsibleSection(content, 'sub-digitisation', t.digitisation?.title || 'Smart Digitisation', 'scan');
                new DigitisationSettingsSection(this.plugin, sub, this).display();
            });
            await this.renderIfEnabled('sub-sketch', () => {
                const sub = this.createSubCollapsibleSection(content, 'sub-sketch', t.sketch?.title || 'Sketch Pad', 'pencil');
                new SketchSettingsSection(this.plugin, sub, this).display();
            });
            await this.renderIfEnabled('sub-kindle', async () => {
                const sub = this.createSubCollapsibleSection(content, 'sub-kindle', t.kindle?.title || 'Kindle Highlights', 'book-open');
                await new KindleSettingsSection(this.plugin, sub, this).display();
            });
            this.removeUmbrellaIfEmpty(content);
        }

        // 6. Meeting Minutes — minutes
        await this.renderIfEnabled('meeting-minutes', () => {
            const content = this.createCollapsibleSection(
                'meeting-minutes', t.minutes?.title || 'Meeting Minutes', 'calendar-clock',
                d?.meetingMinutes || 'Generate structured meeting minutes from transcripts',
            );
            new MinutesSettingsSection(this.plugin, content, this).display();
        });

        // 7. Vault Intelligence (umbrella for Semantic Search, Canvas, Mermaid, Research)
        {
            const content = this.createCollapsibleSection(
                'vault-intelligence', t.vaultIntelligence?.title || 'Vault Intelligence', 'brain',
                d?.vaultIntelligence || 'Semantic search, RAG context, and canvas visualizations',
            );
            await this.renderIfEnabled('sub-semantic-search', async () => {
                const sub = this.createSubCollapsibleSection(content, 'sub-semantic-search', t.semanticSearch?.title || 'Semantic Search', 'brain-circuit');
                await new SemanticSearchSettingsSection(this.plugin, sub, this).display();
            });
            await this.renderIfEnabled('sub-canvas', () => {
                const sub = this.createSubCollapsibleSection(content, 'sub-canvas', this.plugin.t.canvas?.settingsTitle || 'Canvas Boards', 'layout-grid');
                new CanvasSettingsSection(this.plugin, sub, this).display();
            });
            await this.renderIfEnabled('sub-mermaid', () => {
                const sub = this.createSubCollapsibleSection(content, 'sub-mermaid', this.plugin.t.modals?.mermaidChat?.settingsTitle || 'Mermaid Diagram Chat', 'share-2');
                new MermaidChatSettingsSection(this.plugin, sub, this).display();
            });
            await this.renderIfEnabled('sub-research', async () => {
                const sub = this.createSubCollapsibleSection(content, 'sub-research', t.research?.title || 'Research Assistant', 'telescope');
                await new ResearchSettingsSection(this.plugin, sub, this).display();
            });
            this.removeUmbrellaIfEmpty(content);
        }

        // 8. AI Chat — chat (core)
        await this.renderIfEnabled('ai-chat', async () => {
            const content = this.createCollapsibleSection(
                'ai-chat', t.aichat?.chatRootFolderTitle || 'AI Chat', 'message-square',
                'Conversation persistence, projects, and global memory',
            );
            await new AIChatSettingsSection(this.plugin, content, this).display();
        });

        // 9. Integrations (Bases, NotebookLM, Newsletter, Export, Brand)
        {
            const content = this.createCollapsibleSection(
                'integrations', t.integrations?.title || 'Integrations', 'puzzle',
                d?.integrations || 'External tools and export options',
            );
            await this.renderIfEnabled('sub-bases', () => {
                const sub = this.createSubCollapsibleSection(content, 'sub-bases', t.bases?.title || 'Obsidian Bases', 'database');
                new BasesSettingsSection(this.plugin, sub, this).display();
            });
            await this.renderIfEnabled('sub-notebooklm', () => {
                const sub = this.createSubCollapsibleSection(content, 'sub-notebooklm', t.notebookLM?.title || 'NotebookLM', 'book-open');
                new NotebookLMSettingsSection(this.plugin, sub, this).display();
            });
            await this.renderIfEnabled('sub-newsletter', () => {
                const sub = this.createSubCollapsibleSection(content, 'sub-newsletter', t.newsletter?.title || 'Newsletter Digest', 'mail');
                new NewsletterSettingsSection(this.plugin, sub, this).display();
            });
            await this.renderIfEnabled('sub-export', () => {
                const sub = this.createSubCollapsibleSection(content, 'sub-export', t.export?.title || 'Document Export', 'file-output');
                new ExportSettingsSection(this.plugin, sub, this).display();
            });
            await this.renderIfEnabled('sub-brand', () => {
                const sub = this.createSubCollapsibleSection(content, 'sub-brand', t.brand?.title || 'Brand', 'palette');
                new BrandSettingsSection(this.plugin, sub, this).display();
            });
            this.removeUmbrellaIfEmpty(content);
        }

        // 10. Preferences (Interface, Mobile) — infra children, always rendered
        {
            const content = this.createCollapsibleSection(
                'preferences', t.preferences?.title || 'Preferences', 'settings',
                d?.preferences || 'Language, interface, and mobile platform settings',
            );
            await this.renderIfEnabled('sub-interface', () => {
                const sub = this.createSubCollapsibleSection(content, 'sub-interface', t.interface?.title || 'Language & Interface', 'languages');
                new InterfaceSettingsSection(this.plugin, sub, this).display();
            });
            await this.renderIfEnabled('sub-mobile', () => {
                const sub = this.createSubCollapsibleSection(content, 'sub-mobile', t.mobile?.title || 'Mobile', 'smartphone');
                new MobileSettingsSection(this.plugin, sub, this).display();
            });
            this.removeUmbrellaIfEmpty(content);
        }

        // 11. Advanced (Configuration) — infra
        await this.renderIfEnabled('advanced', () => {
            const content = this.createCollapsibleSection(
                'advanced', t.configuration?.title || 'Advanced', 'wrench',
                d?.advanced || 'Configuration files and vault management',
            );
            new ConfigurationSettingsSection(this.plugin, content, this).display();
        });

        // UX-08: make the panel keyboard-scrollable on first render.
        // Without this, PageDown / arrow keys are consumed by whatever had
        // focus before the user opened settings — they have to click inside
        // the panel first. preventScroll keeps the scroll position stable
        // across re-renders triggered by toggling.
        containerEl.setAttribute('tabindex', '-1');
        containerEl.focus({ preventScroll: true });

        // Deep-link consumer — scroll the requested sub-section into view.
        // One-shot: cleared after consumption so a later display() doesn't
        // re-scroll. Uses scrollIntoView with {block: 'start'} so the
        // section header is visible at the top of the panel.
        if (this.pendingScrollToSubSection) {
            const id = this.pendingScrollToSubSection;
            this.pendingScrollToSubSection = null;
            const target = containerEl.querySelector(`[data-section-id="${id}"]`);
            if (target instanceof HTMLElement) {
                requestAnimationFrame(() => target.scrollIntoView({ block: 'start', behavior: 'smooth' }));
            }
        }
    }
}
