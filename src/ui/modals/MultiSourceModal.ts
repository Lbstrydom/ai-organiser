/**
 * Multi-Source Summarization Modal
 *
 * Gestalt-optimized design for selecting multiple sources to summarize:
 * - Proximity: Related items grouped together (sources by type, add inputs in section)
 * - Similarity: Consistent visual treatment for same-type elements
 * - Enclosure: Sections bounded with subtle backgrounds
 * - Figure/Ground: Active sections prominent, empty sections muted
 * - Common Fate: Selected items share visual state
 */

import { App, Modal, Setting, setIcon } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import type { Persona } from '../../services/configurationService';
import {
    DetectedSource,
    DetectedSources,
    detectSourcesFromContent,
    getTotalSourceCount,
    hasAnySources
} from '../../utils/sourceDetection';

export interface SelectedSources {
    urls: string[];
    youtube: string[];
    pdfs: Array<{ path: string; isVaultFile: boolean }>;
    documents: Array<{ path: string; isVaultFile: boolean }>;
    audio: Array<{ path: string; isVaultFile: boolean }>;
}

export interface MultiSourceModalResult {
    sources: SelectedSources;
    summarizeNote: boolean;
    focusContext?: string;
    personaId?: string;
}

interface SourceSection {
    type: 'urls' | 'youtube' | 'pdfs' | 'documents' | 'audio';
    title: string;
    icon: string;
    placeholder: string;
    detected: DetectedSource[];
    manualInputs: string[];
}

export class MultiSourceModal extends Modal {
    private plugin: AIOrganiserPlugin;
    private noteContent: string;
    private detectedSources: DetectedSources;
    private onConfirm: (result: MultiSourceModalResult) => void;

    // Selection state
    private selectedUrls = new Set<string>();
    private selectedYoutube = new Set<string>();
    private selectedPdfs = new Set<string>();
    private selectedDocuments = new Set<string>();
    private selectedAudio = new Set<string>();
    private summarizeNote: boolean;
    private focusContext = '';
    private selectedPersonaId: string;

    // Manual input state
    private manualUrls: string[] = [];
    private manualYoutube: string[] = [];
    private manualPdfs: string[] = [];
    private manualDocuments: string[] = [];
    private manualAudio: string[] = [];

    // Personas
    private personas: Persona[] = [];

    // UI references
    private ctaButton!: HTMLButtonElement;
    private sectionsContainer!: HTMLElement;

    constructor(
        app: App,
        plugin: AIOrganiserPlugin,
        noteContent: string,
        onConfirm: (result: MultiSourceModalResult) => void
    ) {
        super(app);
        this.plugin = plugin;
        this.noteContent = noteContent;
        this.onConfirm = onConfirm;
        this.detectedSources = detectSourcesFromContent(noteContent, app);

        // Pre-select all detected sources
        this.detectedSources.urls.forEach(s => this.selectedUrls.add(s.value));
        this.detectedSources.youtube.forEach(s => this.selectedYoutube.add(s.value));
        this.detectedSources.pdfs.forEach(s => this.selectedPdfs.add(s.value));
        this.detectedSources.documents.forEach(s => this.selectedDocuments.add(s.value));
        this.detectedSources.audio.forEach(s => this.selectedAudio.add(s.value));

        // Smart default for "Include note content":
        // - If no external sources detected, always include note content
        // - If external sources exist, only include note if there's substantial text beyond just URLs
        const hasExternalSources = hasAnySources(this.detectedSources);
        if (hasExternalSources) {
            const meaningfulText = this.getTextBeyondUrls(noteContent);
            // Include note content only if there's substantial text (>100 chars after removing URLs)
            this.summarizeNote = meaningfulText.length > 100;
        } else {
            this.summarizeNote = true;
        }

        // Initialize persona to default
        this.selectedPersonaId = plugin.settings.defaultSummaryPersona || 'student';
    }

    /**
     * Strip URLs, markdown links, and vault embeds from content to see if there's meaningful text
     */
    private getTextBeyondUrls(content: string): string {
        let text = content;

        // Remove markdown links: [text](url)
        text = text.replace(/\[([^\]]*)\]\([^)]+\)/g, '$1');

        // Remove raw URLs
        text = text.replace(/https?:\/\/[^\s\])\"'<>]+/gi, '');

        // Remove vault embeds: ![[file]] and links: [[file]]
        text = text.replace(/!?\[\[[^\]]+\]\]/g, '');

        // Remove extra whitespace
        text = text.replace(/\s+/g, ' ').trim();

        return text;
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('ai-organiser-multi-source-modal');

        const t = this.plugin.t.modals.multiSource;

        // Load personas asynchronously, then re-render settings section
        this.plugin.configService.getSummaryPersonas().then(personas => {
            this.personas = personas;
            // Re-render settings section to include persona dropdown
            const settingsSection = this.sectionsContainer?.querySelector('.ai-organiser-multi-source-settings');
            if (settingsSection) {
                settingsSection.remove();
                this.renderSettingsSection();
            }
        });

        // Title
        contentEl.createEl('h2', {
            text: t?.title || 'Summarize Sources',
            cls: 'ai-organiser-multi-source-title'
        });

        // Description
        const descEl = contentEl.createEl('p', {
            text: t?.description || 'Select sources to summarize. The AI will synthesize content from all selected sources.',
            cls: 'ai-organiser-multi-source-desc'
        });

        // Sections container
        this.sectionsContainer = contentEl.createDiv({ cls: 'ai-organiser-multi-source-sections' });

        // Note section (special - always first)
        this.renderNoteSection();

        // Source sections
        const sections: SourceSection[] = [
            {
                type: 'urls',
                title: t?.webPages || 'Web Pages',
                icon: 'link',
                placeholder: t?.addUrlPlaceholder || 'https://example.com',
                detected: this.detectedSources.urls,
                manualInputs: this.manualUrls
            },
            {
                type: 'youtube',
                title: t?.youtubeVideos || 'YouTube Videos',
                icon: 'youtube',
                placeholder: t?.addYoutubePlaceholder || 'https://youtube.com/watch?v=...',
                detected: this.detectedSources.youtube,
                manualInputs: this.manualYoutube
            },
            {
                type: 'pdfs',
                title: t?.pdfDocuments || 'PDF Documents',
                icon: 'file-text',
                placeholder: t?.addPdfPlaceholder || 'Path to PDF or URL',
                detected: this.detectedSources.pdfs,
                manualInputs: this.manualPdfs
            },
            {
                type: 'documents',
                title: t?.officeDocuments || 'Office Documents',
                icon: 'file-spreadsheet',
                placeholder: t?.addDocumentPlaceholder || 'Path to .docx/.xlsx/.pptx or URL',
                detected: this.detectedSources.documents,
                manualInputs: this.manualDocuments
            },
            {
                type: 'audio',
                title: t?.audioFiles || 'Audio Files',
                icon: 'mic',
                placeholder: t?.addAudioPlaceholder || 'Path to audio file',
                detected: this.detectedSources.audio,
                manualInputs: this.manualAudio
            }
        ];

        for (const section of sections) {
            this.renderSourceSection(section);
        }

        // Settings section
        this.renderSettingsSection();

        // Button container
        const buttonContainer = contentEl.createDiv({ cls: 'ai-organiser-multi-source-buttons' });

        new Setting(buttonContainer)
            .addButton(btn => btn
                .setButtonText(this.plugin.t.modals.cancel)
                .onClick(() => this.close()))
            .addButton(btn => {
                this.ctaButton = btn.buttonEl;
                btn.setCta()
                    .onClick(() => this.handleConfirm());
                this.updateCtaButton();
            });
    }

    private renderNoteSection(): void {
        const t = this.plugin.t.modals.multiSource;
        const section = this.sectionsContainer.createDiv({
            cls: 'ai-organiser-multi-source-section ai-organiser-multi-source-section-note'
        });

        // Section header
        const header = section.createDiv({ cls: 'ai-organiser-multi-source-section-header' });
        const iconEl = header.createSpan({ cls: 'ai-organiser-multi-source-section-icon' });
        setIcon(iconEl, 'file-text');
        header.createSpan({ text: t?.currentNote || 'Current Note', cls: 'ai-organiser-multi-source-section-title' });

        // Checkbox for including note
        const itemEl = section.createDiv({ cls: 'ai-organiser-multi-source-item' });

        const checkbox = itemEl.createEl('input', {
            type: 'checkbox',
            cls: 'ai-organiser-multi-source-checkbox'
        });
        checkbox.checked = this.summarizeNote;
        checkbox.addEventListener('change', () => {
            this.summarizeNote = checkbox.checked;
            this.updateCtaButton();
        });

        const label = itemEl.createDiv({ cls: 'ai-organiser-multi-source-item-content' });
        label.createDiv({
            text: t?.includeNoteContent || 'Include note content',
            cls: 'ai-organiser-multi-source-item-label'
        });
        label.createDiv({
            text: t?.noteContentDesc || 'Analyze the current note alongside external sources',
            cls: 'ai-organiser-multi-source-item-desc'
        });

        // Click anywhere on item to toggle
        itemEl.addEventListener('click', (e) => {
            if (e.target !== checkbox) {
                checkbox.checked = !checkbox.checked;
                this.summarizeNote = checkbox.checked;
                this.updateCtaButton();
            }
        });
    }

    private renderSourceSection(config: SourceSection): void {
        const hasDetected = config.detected.length > 0;
        const hasManual = config.manualInputs.length > 0;
        const isEmpty = !hasDetected && !hasManual;

        const section = this.sectionsContainer.createDiv({
            cls: `ai-organiser-multi-source-section ${isEmpty ? 'ai-organiser-multi-source-section-empty' : ''}`
        });
        section.dataset.type = config.type;

        // Section header with count badge
        const header = section.createDiv({ cls: 'ai-organiser-multi-source-section-header' });
        const iconEl = header.createSpan({ cls: 'ai-organiser-multi-source-section-icon' });
        setIcon(iconEl, config.icon);
        header.createSpan({ text: config.title, cls: 'ai-organiser-multi-source-section-title' });

        if (hasDetected) {
            header.createSpan({
                text: `${config.detected.length}`,
                cls: 'ai-organiser-multi-source-count-badge'
            });
        }

        // Items container
        const itemsContainer = section.createDiv({ cls: 'ai-organiser-multi-source-items' });

        // Render detected sources
        for (const source of config.detected) {
            this.renderSourceItem(itemsContainer, config.type, source);
        }

        // Render manual inputs
        for (let i = 0; i < config.manualInputs.length; i++) {
            this.renderManualItem(itemsContainer, config.type, i);
        }

        // Add input row
        const addRow = section.createDiv({ cls: 'ai-organiser-multi-source-add-row' });
        const addInput = addRow.createEl('input', {
            type: 'text',
            placeholder: config.placeholder,
            cls: 'ai-organiser-multi-source-add-input'
        });

        const addButton = addRow.createEl('button', {
            cls: 'ai-organiser-multi-source-add-button'
        });
        setIcon(addButton, 'plus');

        const addManualSource = () => {
            const value = addInput.value.trim();
            if (!value) return;

            // Add to manual inputs and select it
            config.manualInputs.push(value);
            this.selectSource(config.type, value, true);

            // Re-render section
            this.rerenderSection(config);
            addInput.value = '';
        };

        addButton.addEventListener('click', addManualSource);
        addInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                addManualSource();
            }
        });
    }

    private renderSourceItem(container: HTMLElement, type: string, source: DetectedSource): void {
        const itemEl = container.createDiv({ cls: 'ai-organiser-multi-source-item' });

        const checkbox = itemEl.createEl('input', {
            type: 'checkbox',
            cls: 'ai-organiser-multi-source-checkbox'
        });
        checkbox.checked = this.isSelected(type, source.value);
        checkbox.addEventListener('change', () => {
            this.selectSource(type, source.value, checkbox.checked);
            this.updateCtaButton();
        });

        const content = itemEl.createDiv({ cls: 'ai-organiser-multi-source-item-content' });

        const labelRow = content.createDiv({ cls: 'ai-organiser-multi-source-item-label-row' });
        labelRow.createSpan({ text: source.displayName, cls: 'ai-organiser-multi-source-item-label' });
        labelRow.createSpan({ text: '(detected)', cls: 'ai-organiser-detected-badge' });

        if (source.context) {
            content.createDiv({
                text: source.context,
                cls: 'ai-organiser-multi-source-item-context'
            });
        }

        // Click anywhere on item to toggle
        itemEl.addEventListener('click', (e) => {
            if (e.target !== checkbox) {
                checkbox.checked = !checkbox.checked;
                this.selectSource(type, source.value, checkbox.checked);
                this.updateCtaButton();
            }
        });
    }

    private renderManualItem(container: HTMLElement, type: string, index: number): void {
        const manualInputs = this.getManualInputs(type);
        const value = manualInputs[index];

        const itemEl = container.createDiv({ cls: 'ai-organiser-multi-source-item ai-organiser-multi-source-item-manual' });

        const checkbox = itemEl.createEl('input', {
            type: 'checkbox',
            cls: 'ai-organiser-multi-source-checkbox'
        });
        checkbox.checked = this.isSelected(type, value);
        checkbox.addEventListener('change', () => {
            this.selectSource(type, value, checkbox.checked);
            this.updateCtaButton();
        });

        const content = itemEl.createDiv({ cls: 'ai-organiser-multi-source-item-content' });
        content.createDiv({
            text: this.truncateUrl(value, 50),
            cls: 'ai-organiser-multi-source-item-label'
        });

        // Remove button
        const removeBtn = itemEl.createEl('button', {
            cls: 'ai-organiser-multi-source-remove-button'
        });
        setIcon(removeBtn, 'x');
        removeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            manualInputs.splice(index, 1);
            this.selectSource(type, value, false);
            this.rerenderSection({ type: type as SourceSection['type'] } as SourceSection);
        });

        // Click anywhere on item to toggle
        itemEl.addEventListener('click', (e) => {
            if (e.target !== checkbox && e.target !== removeBtn && !removeBtn.contains(e.target as Node)) {
                checkbox.checked = !checkbox.checked;
                this.selectSource(type, value, checkbox.checked);
                this.updateCtaButton();
            }
        });
    }

    private renderSettingsSection(): void {
        const t = this.plugin.t.modals.multiSource;
        const settingsSection = this.sectionsContainer.createDiv({
            cls: 'ai-organiser-multi-source-settings'
        });

        // Persona selection dropdown
        if (this.personas.length > 0) {
            new Setting(settingsSection)
                .setName(t?.persona || 'Summary Style')
                .setDesc(t?.personaDesc || 'Choose how the summary should be written')
                .addDropdown(dropdown => {
                    for (const persona of this.personas) {
                        dropdown.addOption(persona.id, persona.name);
                    }
                    dropdown.setValue(this.selectedPersonaId);
                    dropdown.onChange(value => {
                        this.selectedPersonaId = value;
                    });
                });
        }

        // Focus context input
        new Setting(settingsSection)
            .setName(t?.focusContext || 'Focus Context')
            .setDesc(t?.focusContextDesc || 'Optional: Specify what aspects to focus on')
            .addText(text => text
                .setPlaceholder(t?.focusPlaceholder || 'e.g., "key findings" or "action items"')
                .setValue(this.focusContext)
                .onChange(value => {
                    this.focusContext = value;
                }));
    }

    private rerenderSection(config: Partial<SourceSection>): void {
        const t = this.plugin.t.modals.multiSource;
        const type = config.type!;

        // Find existing section
        const existingSection = this.sectionsContainer.querySelector(`[data-type="${type}"]`);
        if (!existingSection) return;

        // Get full config
        const fullConfig: SourceSection = {
            type,
            title: config.title || this.getSectionTitle(type),
            icon: config.icon || this.getSectionIcon(type),
            placeholder: config.placeholder || '',
            detected: this.getDetectedSources(type),
            manualInputs: this.getManualInputs(type)
        };

        // Remove and re-render
        existingSection.remove();

        // Find insertion point (after note section, in order)
        const sectionOrder = ['urls', 'youtube', 'pdfs', 'documents', 'audio'];
        const currentIndex = sectionOrder.indexOf(type);
        let insertBefore: Element | null = null;

        for (let i = currentIndex + 1; i < sectionOrder.length; i++) {
            const nextSection = this.sectionsContainer.querySelector(`[data-type="${sectionOrder[i]}"]`);
            if (nextSection) {
                insertBefore = nextSection;
                break;
            }
        }

        // Create new section
        const tempContainer = document.createElement('div');
        this.sectionsContainer.appendChild(tempContainer);

        // Re-render into temp, then move
        const hasDetected = fullConfig.detected.length > 0;
        const hasManual = fullConfig.manualInputs.length > 0;
        const isEmpty = !hasDetected && !hasManual;

        const section = document.createElement('div');
        section.className = `ai-organiser-multi-source-section ${isEmpty ? 'ai-organiser-multi-source-section-empty' : ''}`;
        section.dataset.type = type;

        // Render content into section
        this.renderSectionContent(section, fullConfig);

        tempContainer.remove();

        if (insertBefore) {
            this.sectionsContainer.insertBefore(section, insertBefore);
        } else {
            // Insert before settings section
            const settingsSection = this.sectionsContainer.querySelector('.ai-organiser-multi-source-settings');
            if (settingsSection) {
                this.sectionsContainer.insertBefore(section, settingsSection);
            } else {
                this.sectionsContainer.appendChild(section);
            }
        }

        this.updateCtaButton();
    }

    private renderSectionContent(section: HTMLElement, config: SourceSection): void {
        const hasDetected = config.detected.length > 0;

        // Section header
        const header = section.createDiv({ cls: 'ai-organiser-multi-source-section-header' });
        const iconEl = header.createSpan({ cls: 'ai-organiser-multi-source-section-icon' });
        setIcon(iconEl, config.icon);
        header.createSpan({ text: config.title, cls: 'ai-organiser-multi-source-section-title' });

        if (hasDetected) {
            header.createSpan({
                text: `${config.detected.length}`,
                cls: 'ai-organiser-multi-source-count-badge'
            });
        }

        // Items container
        const itemsContainer = section.createDiv({ cls: 'ai-organiser-multi-source-items' });

        // Render detected sources
        for (const source of config.detected) {
            this.renderSourceItem(itemsContainer, config.type, source);
        }

        // Render manual inputs
        for (let i = 0; i < config.manualInputs.length; i++) {
            this.renderManualItem(itemsContainer, config.type, i);
        }

        // Add input row
        const addRow = section.createDiv({ cls: 'ai-organiser-multi-source-add-row' });
        const addInput = addRow.createEl('input', {
            type: 'text',
            placeholder: config.placeholder,
            cls: 'ai-organiser-multi-source-add-input'
        });

        const addButton = addRow.createEl('button', {
            cls: 'ai-organiser-multi-source-add-button'
        });
        setIcon(addButton, 'plus');

        const addManualSource = () => {
            const value = addInput.value.trim();
            if (!value) return;

            config.manualInputs.push(value);
            this.selectSource(config.type, value, true);
            this.rerenderSection(config);
            addInput.value = '';
        };

        addButton.addEventListener('click', addManualSource);
        addInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                addManualSource();
            }
        });
    }

    private getSectionTitle(type: string): string {
        const t = this.plugin.t.modals.multiSource;
        switch (type) {
            case 'urls': return t?.webPages || 'Web Pages';
            case 'youtube': return t?.youtubeVideos || 'YouTube Videos';
            case 'pdfs': return t?.pdfDocuments || 'PDF Documents';
            case 'documents': return t?.officeDocuments || 'Office Documents';
            case 'audio': return t?.audioFiles || 'Audio Files';
            default: return type;
        }
    }

    private getSectionIcon(type: string): string {
        switch (type) {
            case 'urls': return 'link';
            case 'youtube': return 'youtube';
            case 'pdfs': return 'file-text';
            case 'documents': return 'file-spreadsheet';
            case 'audio': return 'mic';
            default: return 'file';
        }
    }

    private getDetectedSources(type: string): DetectedSource[] {
        switch (type) {
            case 'urls': return this.detectedSources.urls;
            case 'youtube': return this.detectedSources.youtube;
            case 'pdfs': return this.detectedSources.pdfs;
            case 'documents': return this.detectedSources.documents;
            case 'audio': return this.detectedSources.audio;
            default: return [];
        }
    }

    private getManualInputs(type: string): string[] {
        switch (type) {
            case 'urls': return this.manualUrls;
            case 'youtube': return this.manualYoutube;
            case 'pdfs': return this.manualPdfs;
            case 'documents': return this.manualDocuments;
            case 'audio': return this.manualAudio;
            default: return [];
        }
    }

    private isSelected(type: string, value: string): boolean {
        switch (type) {
            case 'urls': return this.selectedUrls.has(value);
            case 'youtube': return this.selectedYoutube.has(value);
            case 'pdfs': return this.selectedPdfs.has(value);
            case 'documents': return this.selectedDocuments.has(value);
            case 'audio': return this.selectedAudio.has(value);
            default: return false;
        }
    }

    private selectSource(type: string, value: string, selected: boolean): void {
        const set = this.getSelectionSet(type);
        if (selected) {
            set.add(value);
        } else {
            set.delete(value);
        }
    }

    private getSelectionSet(type: string): Set<string> {
        switch (type) {
            case 'urls': return this.selectedUrls;
            case 'youtube': return this.selectedYoutube;
            case 'pdfs': return this.selectedPdfs;
            case 'documents': return this.selectedDocuments;
            case 'audio': return this.selectedAudio;
            default: return new Set();
        }
    }

    private getTotalSelectedCount(): number {
        let count = 0;
        if (this.summarizeNote) count++;
        count += this.selectedUrls.size;
        count += this.selectedYoutube.size;
        count += this.selectedPdfs.size;
        count += this.selectedDocuments.size;
        count += this.selectedAudio.size;
        return count;
    }

    private updateCtaButton(): void {
        if (!this.ctaButton) return;

        const t = this.plugin.t.modals.multiSource;
        const count = this.getTotalSelectedCount();

        if (count === 0) {
            this.ctaButton.textContent = t?.summarizeButton || 'Summarize';
            this.ctaButton.disabled = true;
        } else if (count === 1) {
            this.ctaButton.textContent = t?.summarizeOne || 'Summarize 1 source';
            this.ctaButton.disabled = false;
        } else {
            this.ctaButton.textContent = (t?.summarizeMultiple || 'Summarize {count} sources').replace('{count}', String(count));
            this.ctaButton.disabled = false;
        }
    }

    private truncateUrl(url: string, maxLength: number): string {
        if (url.length <= maxLength) return url;
        return url.substring(0, maxLength - 3) + '...';
    }

    private isVaultFile(value: string): boolean {
        // Check if it's a vault file path (not a URL)
        return !value.startsWith('http://') && !value.startsWith('https://');
    }

    private handleConfirm(): void {
        const result: MultiSourceModalResult = {
            sources: {
                urls: Array.from(this.selectedUrls),
                youtube: Array.from(this.selectedYoutube),
                pdfs: Array.from(this.selectedPdfs).map(path => ({
                    path,
                    isVaultFile: this.isVaultFile(path)
                })),
                documents: Array.from(this.selectedDocuments).map(path => ({
                    path,
                    isVaultFile: this.isVaultFile(path)
                })),
                audio: Array.from(this.selectedAudio).map(path => ({
                    path,
                    isVaultFile: this.isVaultFile(path)
                }))
            },
            summarizeNote: this.summarizeNote,
            focusContext: this.focusContext.trim() || undefined,
            personaId: this.selectedPersonaId
        };

        this.close();
        this.onConfirm(result);
    }

    onClose(): void {
        this.contentEl.empty();
    }
}
