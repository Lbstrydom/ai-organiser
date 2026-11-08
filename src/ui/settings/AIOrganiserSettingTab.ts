import { App, PluginSettingTab, Setting, setIcon } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import { planSearch, type SearchableSection } from './settingsSearch';
import { LLMSettingsSection } from './LLMSettingsSection';
import { SpecialistProvidersSettingsSection } from './SpecialistProvidersSettingsSection';
import { TaggingSettingsSection } from './TaggingSettingsSection';
import { InterfaceSettingsSection } from './InterfaceSettingsSection';
import { QuickCommandsSettingsSection } from './QuickCommandsSettingsSection';
import { SummarizationSettingsSection } from './SummarizationSettingsSection';
import { MinutesSettingsSection } from './MinutesSettingsSection';
import { ConfigurationSettingsSection } from './ConfigurationSettingsSection';
import { SemanticSearchSettingsSection } from './SemanticSearchSettingsSection';
import { VisualSearchSettingsSection } from './VisualSearchSettingsSection';
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
import { PresentationModelsSettingsSection } from './PresentationModelsSettingsSection';
import { BrandSettingsSection } from './BrandSettingsSection';
import { FeaturesSettingsSection } from './FeaturesSettingsSection';
import { ProtectedFoldersSettingsSection } from './ProtectedFoldersSettingsSection';
import { FindEmbedsSettingsSection } from './FindEmbedsSettingsSection';
import { AgentIndexSettingsSection } from './AgentIndexSettingsSection';
import { CloudInventorySettingsSection } from './CloudInventorySettingsSection';
import { InboxSweepSettingsSection } from './InboxSweepSettingsSection';
import { CaptureInboxSettingsSection } from './CaptureInboxSettingsSection';
import { GoogleTasksSettingsSection } from './GoogleTasksSettingsSection';
import { ProjectsSettingsSection } from './ProjectsSettingsSection';
import { AiWorkspacesSettingsSection } from './AiWorkspacesSettingsSection';
import { integrationRowVisible, renderIntegrationStatusRow } from './IntegrationStatusRow';
import { VaultUpkeepSettingsSection } from './VaultUpkeepSettingsSection';
import { AgentConnectorsSettingsSection } from './AgentConnectorsSettingsSection';
import { SECTION_FEATURE, INFRA_SECTIONS, FEATURE_BY_ID, type FeatureId } from '../../core/features';
import { isFeatureEnabled } from '../../services/featureService';

export class AIOrganiserSettingTab extends PluginSettingTab {
    private plugin: AIOrganiserPlugin;
    // Only AI provider opens by default — Features is an infrequent-access
    // section (user feedback 2026-06-11), so it starts collapsed like the rest.
    private expandedSections = new Set<string>(['ai-provider']);

    /** Sub-section id to scroll into view after the next display() — set
     *  by `revealSubSection()` and consumed once. */
    private pendingScrollToSubSection: string | null = null;

    /** Settings search. The query survives a re-render; the open/closed choices of the user are
     *  snapshotted on the first keystroke and restored when the query is cleared (an overlay,
     *  never persisted). */
    private searchQuery = '';
    /** What is typed in the box right now (ahead of the debounce), so a redraw keeps it. */
    private searchDraft: string | null = null;
    private expandedBeforeSearch: Set<string> | null = null;
    private searchTimer: number | null = null;
    private noMatchEl: HTMLElement | null = null;

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
        this.addTurnOffLink(sectionId);
    }

    /**
     * A feature's own section says where its off switch is and takes the person there: people look for "turn off" in the
     * section they are reading, not in Features at the top. Core features cannot be turned off, so they get no link.
     */
    private addTurnOffLink(sectionId: string): void {
        const feature = SECTION_FEATURE[sectionId];
        if (!feature || FEATURE_BY_ID[feature].core) return;
        const details = this.containerEl.querySelector(`details[data-section-id="${sectionId}"]`);
        const content = details?.querySelector<HTMLElement>(':scope > .ai-organiser-settings-section-content, :scope > .ai-organiser-settings-sub-section-content');
        if (!content) return;
        const t = this.plugin.t.features;
        const name = this.featureLabel(feature);
        new Setting(content)
            .setName(t.turnOffName.replace('{feature}', name))
            .setDesc(t.turnOffDesc)
            .then((row) => row.settingEl.addClass('ai-organiser-feature-turn-off'))
            .addButton((b) => b.setButtonText(t.turnOffShow).onClick(() => this.revealFeatureSwitch(feature)));
    }

    private featureLabel(id: FeatureId): string {
        let cur: unknown = this.plugin.t;
        for (const part of FEATURE_BY_ID[id].labelKey.split('.')) {
            cur = cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[part] : undefined;
        }
        return typeof cur === 'string' ? cur : id;
    }

    /** Open Features, bring the feature's switch into view and put focus on it. Changes nothing. */
    private revealFeatureSwitch(id: FeatureId): void {
        this.endSearch();
        const features = this.containerEl.querySelector<HTMLDetailsElement>('details[data-section-id="features"]');
        if (features) { features.open = true; this.expandedSections.add('features'); }
        const row = this.containerEl.querySelector<HTMLElement>(`[data-feature-id="${id}"]`);
        if (!row) return;
        row.scrollIntoView({ block: 'center' });
        row.querySelector<HTMLElement>('.checkbox-container')?.focus();
    }

    /** Leaving the settings ends a search, so the next visit shows every section again. */
    hide(): void {
        this.endSearch();
        super.hide();
    }

    /**
     * Empty-collapsible suppression by post-block removal (FT-10i, async-aware).
     * Called AFTER a collapsible's children have rendered + awaited: if the content
     * container has ZERO child elements, remove the whole `<details>`. Uses
     * `children.length` (not a `.ai-organiser-settings-sub-section` selector) so it is
     * correct for BOTH container shapes (Gemini-R9-G4) — umbrellas that hold sub-
     * collapsibles AND any collapsible wrapping a single direct child that renders
     * `.setting-item`s straight into the content. A disabled child contributes no element
     * (its `renderIfEnabled` block was skipped), so an all-disabled container is empty.
     * Pure DOM derivation of the gated child set — no pre-computed child-count shadow.
     */
    private removeUmbrellaIfEmpty(content: HTMLElement): void {
        if (content.children.length === 0) {
            content.closest('details')?.remove();
        }
    }

    /**
     * Deep-link entry point: ensure the parent + sub-section are expanded
     * and scroll the sub-section into view on the next render. Safe to
     * call before display(); the scroll happens after the DOM is built.
     */
    revealSubSection(parentId: string, subId: string): void {
        // A deep link ends any search first, restoring the user's own open/closed state.
        this.endSearch();
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
            cls: 'ai-organiser-settings-section',
            attr: { 'data-section-id': id },
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

    /** Awaitable re-render — used by `applyFeatureFlags` so the flag write can await the
     *  tab refresh (Obsidian's `display()` is fire-and-forget; this exposes the promise). */
    render(): Promise<void> { return this.displayAsync(); }

    private async displayAsync(): Promise<void> {
        const { containerEl } = this;
        // A change inside the page (adding a folder, flipping a switch) redraws it; stay where the person was.
        const keepScrollTop = containerEl.scrollTop;
        containerEl.empty();
        containerEl.addClass('ai-organiser-settings');
        this.renderSearchBox(containerEl);

        const t = this.plugin.t.settings;
        const d = t.sectionDescriptions;

        // Features control panel — ALWAYS first, never gated (it IS the gate). Renders the
        // grouped feature toggles; writes route through plugin.applyFeatureFlags (FT-5).
        {
            const ft = this.plugin.t.features;
            const content = this.createCollapsibleSection('features', ft.title, 'sliders-horizontal', ft.desc);
            new FeaturesSettingsSection(this.plugin, content, this).display();
        }

        // Every feature-owned child section below is wrapped in `renderIfEnabled` (the FT-4
        // guard / render-spy); infra children render unconditionally.

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
                // Visual search rides the SAME gate as Semantic Search (C17): the consent/
                // enable panel must be visible BEFORE the visual-search feature is on, so it
                // is deliberately NOT wrapped in its own renderIfEnabled('visual-search').
                const visualSub = this.createSubCollapsibleSection(content, 'sub-visual-search', this.plugin.t.settings.visualSearch.title, 'scan-search');
                await new VisualSearchSettingsSection(this.plugin, visualSub, this).display();
            });
            await this.renderIfEnabled('sub-canvas', () => {
                const sub = this.createSubCollapsibleSection(content, 'sub-canvas', this.plugin.t.canvas?.settingsTitle || 'Canvas Boards', 'layout-grid');
                new CanvasSettingsSection(this.plugin, sub, this).display();
            });
            await this.renderIfEnabled('sub-mermaid', () => {
                const sub = this.createSubCollapsibleSection(content, 'sub-mermaid', this.plugin.t.modals?.mermaidChat?.settingsTitle || 'Mermaid Diagram Chat', 'share-2');
                new MermaidChatSettingsSection(this.plugin, sub, this).display();
            });
            await this.renderIfEnabled('sub-agent-index', () => {
                const sub = this.createSubCollapsibleSection(content, 'sub-agent-index', this.plugin.t.agentIndex.sectionTitle, 'list-tree');
                new AgentIndexSettingsSection(this.plugin, sub, this).display();
            });
            await this.renderIfEnabled('sub-agent-connectors', () => {
                const sub = this.createSubCollapsibleSection(content, 'sub-agent-connectors', this.plugin.t.agentConnectors.sectionTitle, 'plug-zap');
                new AgentConnectorsSettingsSection(this.plugin, sub, this).display();
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
            // Per-role model selection for the consultant-quality presentation pipeline (Cluster B).
            const presModels = this.createSubCollapsibleSection(content, 'sub-pres-models', this.plugin.t.presentationModels?.settingsTitle || 'Presentation models', 'sparkles');
            new PresentationModelsSettingsSection(this.plugin, presModels, this).display();
        });

        // 9. Integrations (Bases, NotebookLM, Newsletter, Export, Brand)
        {
            const content = this.createCollapsibleSection(
                'integrations', t.integrations?.title || 'Integrations', 'puzzle',
                d?.integrations || 'External tools and export options',
            );
            // One status row for the Google script, ahead of the features that use it.
            if (integrationRowVisible(this.plugin.settings)) renderIntegrationStatusRow(content, this.plugin, () => this.display());
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
            await this.renderIfEnabled('sub-cloud-inventory', () => {
                const sub = this.createSubCollapsibleSection(content, 'sub-cloud-inventory', this.plugin.t.cloudInventory.sectionTitle, 'cloud');
                new CloudInventorySettingsSection(this.plugin, sub, this).display();
            });
            await this.renderIfEnabled('sub-inbox-sweep', () => {
                const sub = this.createSubCollapsibleSection(content, 'sub-inbox-sweep', this.plugin.t.inboxSweep.sectionTitle, 'inbox');
                new InboxSweepSettingsSection(this.plugin, sub, this).display();
            });
            await this.renderIfEnabled('sub-capture-inbox', () => {
                const sub = this.createSubCollapsibleSection(content, 'sub-capture-inbox', this.plugin.t.captureInbox.sectionTitle, 'inbox');
                new CaptureInboxSettingsSection(this.plugin, sub, this).display();
            });
            await this.renderIfEnabled('sub-google-tasks', () => {
                const sub = this.createSubCollapsibleSection(content, 'sub-google-tasks', this.plugin.t.googleTasks.sectionTitle, 'list-checks');
                new GoogleTasksSettingsSection(this.plugin, sub, this).display();
            });
            await this.renderIfEnabled('sub-projects', () => {
                const sub = this.createSubCollapsibleSection(content, 'sub-projects', this.plugin.t.projects.sectionTitle, 'folder-kanban');
                new ProjectsSettingsSection(this.plugin, sub, this).display();
            });
            await this.renderIfEnabled('sub-ai-workspaces', () => {
                const sub = this.createSubCollapsibleSection(content, 'sub-ai-workspaces', this.plugin.t.aiWorkspaces.sectionTitle, 'messages-square');
                new AiWorkspacesSettingsSection(this.plugin, sub, this).display();
            });
            await this.renderIfEnabled('sub-vault-upkeep', () => {
                const sub = this.createSubCollapsibleSection(content, 'sub-vault-upkeep', this.plugin.t.vaultUpkeep.sectionTitle, 'broom');
                new VaultUpkeepSettingsSection(this.plugin, sub, this).display();
            });
            await this.renderIfEnabled('sub-find-embeds', () => {
                const sub = this.createSubCollapsibleSection(content, 'sub-find-embeds', this.plugin.t.embedScan.settingsTitle, 'hard-drive');
                new FindEmbedsSettingsSection(this.plugin, sub, this).display();
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
            await this.renderIfEnabled('sub-quick-commands', () => {
                const sub = this.createSubCollapsibleSection(content, 'sub-quick-commands', t.interface?.pinnedTitle || 'Quick commands', 'star');
                new QuickCommandsSettingsSection(this.plugin, sub, this).display();
            });
            await this.renderIfEnabled('sub-interface', () => {
                const sub = this.createSubCollapsibleSection(content, 'sub-interface', t.interface?.title || 'Language & Interface', 'languages');
                new InterfaceSettingsSection(this.plugin, sub, this).display();
            });
            await this.renderIfEnabled('sub-protected-folders', () => {
                const sub = this.createSubCollapsibleSection(content, 'sub-protected-folders', this.plugin.t.protectedFolders.sectionTitle, 'shield');
                new ProtectedFoldersSettingsSection(this.plugin, sub, this).display();
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
        // A re-render during a search shows the same result.
        if (this.searchQuery) this.applySearch();
        if (!this.pendingScrollToSubSection && keepScrollTop > 0) containerEl.scrollTop = keepScrollTop;
        if (this.pendingScrollToSubSection) {
            const id = this.pendingScrollToSubSection;
            this.pendingScrollToSubSection = null;
            const target = containerEl.querySelector(`[data-section-id="${id}"]`);
            if (target instanceof HTMLElement) {
                window.requestAnimationFrame(() => target.scrollIntoView({ block: 'start', behavior: 'smooth' }));
            }
        }
    }

    // ── Settings search ─────────────────────────────────────────────────────────────

    private renderSearchBox(containerEl: HTMLElement): void {
        const t = this.plugin.t.settingsSearch;
        const box = containerEl.createDiv({ cls: 'ai-organiser-settings-search' });
        const input = box.createEl('input', {
            type: 'search',
            cls: 'ai-organiser-settings-search-input',
            attr: { placeholder: t.placeholder, 'aria-label': t.placeholder },
        });
        input.value = this.searchDraft ?? this.searchQuery;
        this.noMatchEl = box.createDiv({ cls: 'ai-organiser-settings-search-empty ai-organiser-hidden' });
        input.addEventListener('input', () => {
            this.searchDraft = input.value;
            if (this.searchTimer !== null) window.clearTimeout(this.searchTimer);
            this.searchTimer = window.setTimeout(() => {
                this.searchTimer = null;
                if (!input.isConnected) return; // the tab re-rendered: a newer box owns the query
                this.setSearch(input.value);
            }, 150);
        });
    }

    /** Begin, change or end a search. */
    private setSearch(query: string): void {
        const q = query.trim();
        if (!q) { this.endSearch(); return; }
        if (!this.expandedBeforeSearch) this.expandedBeforeSearch = new Set(this.expandedSections);
        this.searchQuery = q;
        this.applySearch();
    }

    /** Read the current DOM, then show and open only what matches. */
    private applySearch(): void {
        const root = this.containerEl;
        const top = Array.from(root.querySelectorAll<HTMLDetailsElement>(':scope > details.ai-organiser-settings-section'));
        const textsOf = (el: Element): string[] => [
            el.querySelector(':scope > summary')?.textContent ?? '',
            ...Array.from(el.querySelectorAll('.setting-item-name, .setting-item-description')).map((n) => n.textContent ?? ''),
        ];
        const sections: SearchableSection[] = top.map((d) => ({
            id: d.getAttribute('data-section-id') ?? '',
            texts: textsOf(d),
            children: Array.from(d.querySelectorAll<HTMLDetailsElement>('details.ai-organiser-settings-sub-section')).map((c) => ({
                id: c.getAttribute('data-section-id') ?? '',
                texts: textsOf(c),
            })),
        }));
        const plan = planSearch(sections, this.searchQuery);
        for (const d of top) {
            const id = d.getAttribute('data-section-id') ?? '';
            d.toggleClass('ai-organiser-settings-hidden', !plan.visible.has(id));
            d.open = plan.open.has(id);
            for (const c of Array.from(d.querySelectorAll<HTMLDetailsElement>('details.ai-organiser-settings-sub-section'))) {
                c.open = plan.open.has(c.getAttribute('data-section-id') ?? '');
            }
        }
        if (this.noMatchEl) {
            this.noMatchEl.setText(plan.visible.size === 0 ? this.plugin.t.settingsSearch.noMatch.replace('{query}', this.searchQuery) : '');
            this.noMatchEl.toggleClass('ai-organiser-hidden', plan.visible.size > 0);
        }
    }

    /** End the search: restore exactly the open/closed state the user had before it. */
    private endSearch(): void {
        if (this.searchTimer !== null) { window.clearTimeout(this.searchTimer); this.searchTimer = null; }
        this.searchDraft = null;
        this.searchQuery = '';
        const before = this.expandedBeforeSearch;
        this.expandedBeforeSearch = null;
        if (before) {
            this.expandedSections.clear();
            for (const id of before) this.expandedSections.add(id);
        }
        const root = this.containerEl;
        for (const d of Array.from(root.querySelectorAll<HTMLDetailsElement>('details[data-section-id]'))) {
            d.removeClass('ai-organiser-settings-hidden');
            d.open = this.expandedSections.has(d.getAttribute('data-section-id') ?? '');
        }
        this.noMatchEl?.addClass('ai-organiser-hidden');
    }

}
