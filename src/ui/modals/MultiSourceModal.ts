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
import { DEFAULT_SUMMARY_PERSONA_ID } from '../../core/settings';
import { COMMON_LANGUAGES, getLanguageDisplayName } from '../../services/languages';
import { isRecordingSupported } from '../../services/audioRecordingService';
import { AudioRecorderModal } from './AudioRecorderModal';
import {
    DetectedSource,
    DetectedSources,
    detectSourcesFromContent,
    hasAnySources
} from '../../utils/sourceDetection';

export interface SelectedSources {
    urls: string[];
    youtube: string[];
    pdfs: Array<{ path: string; isVaultFile: boolean }>;
    documents: Array<{ path: string; isVaultFile: boolean }>;
    audio: Array<{ path: string; isVaultFile: boolean }>;
    images: Array<{ path: string; isVaultFile: boolean }>;
}

export interface MultiSourceModalConfig {
    mode: 'summarize' | 'translate';
    hidePersona?: boolean;
    hideFocusContext?: boolean;
    showLanguageSelector?: boolean;
    ctaLabel?: string;
}

export interface MultiSourceModalResult {
    sources: SelectedSources;
    summarizeNote: boolean;
    focusContext?: string;
    personaId?: string;
    includeCompanion?: boolean;  // Study companion toggle state
    targetLanguage?: string;
    targetLanguageName?: string;
}

type SourceSectionType = 'urls' | 'youtube' | 'pdfs' | 'documents' | 'audio' | 'images';

interface SourceSection {
    type: SourceSectionType;
    title: string;
    icon: string;
    placeholder: string;
    detected: DetectedSource[];
    manualInputs: string[];
}

/** Config map entry for a source section — eliminates switch-on-type pattern */
interface SectionConfig {
    title: () => string;
    icon: string;
    placeholder: () => string;
    getDetected: () => DetectedSource[];
    getManual: () => string[];
    getSelected: () => Set<string>;
}

/** Section display order */
const SECTION_ORDER: SourceSectionType[] = ['urls', 'youtube', 'pdfs', 'documents', 'audio', 'images'];

/** Max images to pre-select (avoid accidental cost on image-heavy notes) */
const MAX_IMAGE_AUTO_SELECT = 5;

export class MultiSourceModal extends Modal {
    private plugin: AIOrganiserPlugin;
    private noteContent: string;
    private detectedSources: DetectedSources;
    private onConfirm: (result: MultiSourceModalResult) => void;
    private config: MultiSourceModalConfig;

    // Selection state (one Set per source type)
    private selectedUrls = new Set<string>();
    private selectedYoutube = new Set<string>();
    private selectedPdfs = new Set<string>();
    private selectedDocuments = new Set<string>();
    private selectedAudio = new Set<string>();
    private selectedImages = new Set<string>();
    private summarizeNote: boolean;
    private focusContext = '';
    private cleanups: (() => void)[] = [];
    private includeCompanion = true;
    private selectedPersonaId: string;
    private selectedTargetLanguage: string;

    // Manual input state (one array per source type)
    private manualUrls: string[] = [];
    private manualYoutube: string[] = [];
    private manualPdfs: string[] = [];
    private manualDocuments: string[] = [];
    private manualAudio: string[] = [];
    private manualImages: string[] = [];

    // Config map — replaces 6 switch statements
    private sectionConfigs!: Record<SourceSectionType, SectionConfig>;

    // Personas
    private personas: Persona[] = [];

    // UI references
    private ctaButton!: HTMLButtonElement;
    private sectionsContainer!: HTMLElement;

    constructor(
        app: App,
        plugin: AIOrganiserPlugin,
        noteContent: string,
        onConfirm: (result: MultiSourceModalResult) => void,
        config: Partial<MultiSourceModalConfig> = {}
    ) {
        super(app);
        this.plugin = plugin;
        this.noteContent = noteContent;
        this.onConfirm = onConfirm;
        this.detectedSources = detectSourcesFromContent(noteContent, app);

        // Set config defaults
        this.config = {
            mode: config.mode || 'summarize',
            hidePersona: config.hidePersona ?? (config.mode === 'translate'),
            hideFocusContext: config.hideFocusContext ?? (config.mode === 'translate'),
            showLanguageSelector: config.showLanguageSelector ?? (config.mode === 'translate'),
            ctaLabel: config.ctaLabel
        };

        // Build section config map (replaces all switch statements)
        this.initSectionConfigs();

        // Pre-select all detected sources
        this.detectedSources.urls.forEach(s => this.selectedUrls.add(s.value));
        this.detectedSources.youtube.forEach(s => this.selectedYoutube.add(s.value));
        this.detectedSources.pdfs.forEach(s => this.selectedPdfs.add(s.value));
        this.detectedSources.documents.forEach(s => this.selectedDocuments.add(s.value));
        this.detectedSources.audio.forEach(s => this.selectedAudio.add(s.value));
        // Images: only pre-select if ≤ MAX_IMAGE_AUTO_SELECT to avoid accidental cost
        if (this.detectedSources.images.length <= MAX_IMAGE_AUTO_SELECT) {
            this.detectedSources.images.forEach(s => this.selectedImages.add(s.value));
        }

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
        this.selectedPersonaId = plugin.settings.defaultSummaryPersona || DEFAULT_SUMMARY_PERSONA_ID;

        // Initialize target language
        this.selectedTargetLanguage = 'en';
    }

    /** Initialize the config map that replaces all switch-on-type patterns */
    private initSectionConfigs(): void {
        const t = this.plugin.t.modals.multiSource;
        this.sectionConfigs = {
            urls: {
                title: () => t?.webPages || 'Web Pages', icon: 'link',
                placeholder: () => t?.addUrlPlaceholder || 'https://example.com',
                getDetected: () => this.detectedSources.urls,
                getManual: () => this.manualUrls, getSelected: () => this.selectedUrls
            },
            youtube: {
                title: () => t?.youtubeVideos || 'YouTube Videos', icon: 'youtube',
                placeholder: () => t?.addYoutubePlaceholder || 'https://youtube.com/watch?v=...',
                getDetected: () => this.detectedSources.youtube,
                getManual: () => this.manualYoutube, getSelected: () => this.selectedYoutube
            },
            pdfs: {
                title: () => t?.pdfDocuments || 'PDF Documents', icon: 'file-text',
                placeholder: () => t?.addPdfPlaceholder || 'Path to PDF or URL',
                getDetected: () => this.detectedSources.pdfs,
                getManual: () => this.manualPdfs, getSelected: () => this.selectedPdfs
            },
            documents: {
                title: () => t?.officeDocuments || 'Office Documents', icon: 'file-spreadsheet',
                placeholder: () => t?.addDocumentPlaceholder || 'Path to .docx/.xlsx/.pptx or URL',
                getDetected: () => this.detectedSources.documents,
                getManual: () => this.manualDocuments, getSelected: () => this.selectedDocuments
            },
            audio: {
                title: () => t?.audioFiles || 'Audio Files', icon: 'mic',
                placeholder: () => t?.addAudioPlaceholder || 'Path to audio file',
                getDetected: () => this.detectedSources.audio,
                getManual: () => this.manualAudio, getSelected: () => this.selectedAudio
            },
            images: {
                title: () => t?.images || 'Images', icon: 'image',
                placeholder: () => t?.addImagePlaceholder || 'Vault image file path',
                getDetected: () => this.detectedSources.images,
                getManual: () => this.manualImages, getSelected: () => this.selectedImages
            }
        };
    }

    /**
     * Strip URLs, markdown links, and vault embeds from content to see if there's meaningful text
     */
    private getTextBeyondUrls(content: string): string {
        let text = content;

        // Remove markdown links: [text](url)
        text = text.replace(/\[([^\]]*)\]\([^)]+\)/g, '$1');

        // Remove raw URLs
        text = text.replace(/https?:\/\/[^\s\])"'<>]+/gi, '');

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

        // Load personas asynchronously if needed, then re-render settings section
        if (!this.config.hidePersona) {
            void this.plugin.configService.getSummaryPersonas().then(personas => {
                this.personas = personas;
                // Re-render settings section to include persona dropdown
                const settingsSection = this.sectionsContainer?.querySelector('.ai-organiser-multi-source-settings');
                if (settingsSection) {
                    settingsSection.remove();
                    this.renderSettingsSection();
                }
            });
        }

        // Title
        contentEl.createEl('h2', {
            text: this.config.mode === 'translate'
                ? (t?.translateTitle || 'Translate Sources')
                : (t?.title || 'Summarize Sources'),
            cls: 'ai-organiser-multi-source-title'
        });

        // Description
        contentEl.createEl('p', {
            text: this.config.mode === 'translate'
                ? (t?.translateDescription || 'Select sources to translate. Content will be translated to the target language.')
                : (t?.description || 'Select sources to summarize. The AI will synthesize content from all selected sources.'),
            cls: 'ai-organiser-multi-source-desc'
        });

        // Sections container
        this.sectionsContainer = contentEl.createDiv({ cls: 'ai-organiser-multi-source-sections' });

        // Note section (special - always first)
        this.renderNoteSection();

        // Source sections — built from config map
        let nonEmptyCount = 0;
        let emptyCount = 0;
        for (const type of SECTION_ORDER) {
            const cfg = this.sectionConfigs[type];
            const detected = cfg.getDetected();
            const manual = cfg.getManual();
            const isEmpty = detected.length === 0 && manual.length === 0;
            if (isEmpty) emptyCount++; else nonEmptyCount++;
            this.renderSourceSection({
                type,
                title: cfg.title(),
                icon: cfg.icon,
                placeholder: cfg.placeholder(),
                detected,
                manualInputs: manual
            });
        }

        // Collapse initially-empty source cards behind a disclosure when at least one
        // section already has content. Without this, a single-URL flow shows 5 dead
        // source cards (YouTube/PDF/Office/Audio/Images) that push the CTA below the
        // fold. Persona test (Maya) flagged this as P1 — 2026-04-19.
        if (nonEmptyCount > 0 && emptyCount > 0) {
            this.sectionsContainer.addClass('ai-organiser-multi-source-compact');
            // Leading ± symbols live in the UI layer, not the translation.
            // The Obsidian review bot flags them as sentence-case violations
            // when they're embedded in locale strings.
            const addLabel = `+ ${t?.addOtherSources || 'Add other source types'}`;
            const hideLabel = `\u2212 ${t?.hideOtherSources || 'Hide other source types'}`;
            const disclosure = this.sectionsContainer.createEl('button', {
                cls: 'ai-organiser-multi-source-extras-toggle',
                text: addLabel,
                attr: { type: 'button' }
            });
            disclosure.addEventListener('click', () => {
                const expanded = this.sectionsContainer.hasClass('ai-organiser-multi-source-compact');
                if (expanded) {
                    this.sectionsContainer.removeClass('ai-organiser-multi-source-compact');
                    disclosure.setText(hideLabel);
                } else {
                    this.sectionsContainer.addClass('ai-organiser-multi-source-compact');
                    disclosure.setText(addLabel);
                }
            });
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
            text: this.config.mode === 'translate'
                ? (t?.translateNoteLabel || 'Translate note content')
                : (t?.includeNoteContent || 'Include note content'),
            cls: 'ai-organiser-multi-source-item-label'
        });
        label.createDiv({
            text: this.config.mode === 'translate'
                ? (t?.translateNoteDesc || 'Translate text in the current note')
                : (t?.noteContentDesc || 'Analyze the current note alongside external sources'),
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

        // Status badge for source types needing extra provider setup

        // Record button for audio section (renders on all platforms)
        if (config.type === 'audio') {
            this.renderAudioRecordButton(header);
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
            this.rerenderSection({ type: type as SourceSectionType } as SourceSection);
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

        // Language Selector (Translate Mode)
        if (this.config.showLanguageSelector) {
            new Setting(settingsSection)
                .setName(t?.languageLabel || 'Target language')
                .setDesc(t?.languageDesc || 'Language to translate all content into')
                .addDropdown(dropdown => {
                     COMMON_LANGUAGES.forEach(lang => {
                          if (lang.code !== 'auto') {
                               dropdown.addOption(lang.code, getLanguageDisplayName(lang));
                          }
                     });
                     dropdown.setValue(this.selectedTargetLanguage);
                     dropdown.onChange(value => {
                          this.selectedTargetLanguage = value;
                     });
                });
        }

        // Persona selection dropdown (Summarize Mode)
        let companionToggleEl: HTMLElement | null = null;
        if (!this.config.hidePersona && this.personas.length > 0) {
            new Setting(settingsSection)
                .setName(t?.persona || 'Summary style')
                .setDesc(t?.personaDesc || 'Choose how the summary should be written')
                .addDropdown(dropdown => {
                    for (const persona of this.personas) {
                        dropdown.addOption(persona.id, persona.name);
                    }
                    dropdown.setValue(this.selectedPersonaId);
                    dropdown.onChange(value => {
                        this.selectedPersonaId = value;
                        if (companionToggleEl) {
                            companionToggleEl.toggleClass('ai-organiser-hidden',
                                !(this.plugin.settings.enableStudyCompanion && value === 'study'));
                        }
                    });
                });

            // Companion toggle (visible only when Study persona is selected)
            const companionSetting = new Setting(settingsSection)
                .setName(this.plugin.t.settings.summarization.enableCompanion || 'Study companion notes')
                .setDesc(this.plugin.t.settings.summarization.enableCompanionDesc || 'Create a companion note that explains the material in conversational language')
                .addToggle(toggle => toggle
                    .setValue(this.includeCompanion)
                    .onChange(value => this.includeCompanion = value));
            companionToggleEl = companionSetting.settingEl;
            companionToggleEl.toggleClass('ai-organiser-hidden',
                !(this.plugin.settings.enableStudyCompanion && this.selectedPersonaId === 'study'));
        }

        // Focus context input (Summarize Mode)
        if (!this.config.hideFocusContext) {
            new Setting(settingsSection)
                .setName(t?.focusContext || 'Focus context')
                .setDesc(t?.focusContextDesc || 'Optional: Specify what aspects to focus on')
                .addText(text => text
                    .setPlaceholder(t?.focusPlaceholder || 'e.g., "key findings" or "action items"')
                    .setValue(this.focusContext)
                    .onChange(value => {
                        this.focusContext = value;
                    }));
        }
    }

    private rerenderSection(config: Partial<SourceSection>): void {
        const type = config.type!;

        // Find existing section
        const existingSection = this.sectionsContainer.querySelector(`[data-type="${type}"]`);
        if (!existingSection) return;

        // Get full config from config map
        const cfg = this.sectionConfigs[type];
        const fullConfig: SourceSection = {
            type,
            title: cfg.title(),
            icon: cfg.icon,
            placeholder: cfg.placeholder(),
            detected: cfg.getDetected(),
            manualInputs: cfg.getManual()
        };

        // Remove and re-render
        existingSection.remove();

        // Find insertion point (after note section, in order)
        const currentIndex = SECTION_ORDER.indexOf(type);
        let insertBefore: Element | null = null;

        for (let i = currentIndex + 1; i < SECTION_ORDER.length; i++) {
            const nextSection = this.sectionsContainer.querySelector(`[data-type="${SECTION_ORDER[i]}"]`);
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

        // Status badge for source types needing extra provider setup

        // Record button for audio section (survives rerenderSection)
        if (config.type === 'audio') {
            this.renderAudioRecordButton(header);
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

    // --- Config-map based lookups (replacing switch statements) ---

    private getSectionTitle(type: string): string {
        return this.sectionConfigs[type as SourceSectionType]?.title() ?? type;
    }

    private getSectionIcon(type: string): string {
        return this.sectionConfigs[type as SourceSectionType]?.icon ?? 'file';
    }

    private getDetectedSources(type: string): DetectedSource[] {
        return this.sectionConfigs[type as SourceSectionType]?.getDetected() ?? [];
    }

    private getManualInputs(type: string): string[] {
        return this.sectionConfigs[type as SourceSectionType]?.getManual() ?? [];
    }

    private isSelected(type: string, value: string): boolean {
        return this.sectionConfigs[type as SourceSectionType]?.getSelected().has(value) ?? false;
    }

    /**
     * Add record button to audio section header.
     * Called from both renderSourceSection() and renderSectionContent() to survive rerenders.
     */
    private renderAudioRecordButton(header: HTMLElement): void {
        if (!isRecordingSupported()) return;

        const recordLabel = this.plugin.t.recording?.title || 'Record Audio';
        const recordBtn = header.createEl('button', {
            cls: 'ai-organiser-multi-source-record-btn clickable-icon',
            attr: { 'aria-label': recordLabel, title: recordLabel }
        });
        setIcon(recordBtn, 'mic');
        recordBtn.addEventListener('click', () => {
            new AudioRecorderModal(this.app, this.plugin, {
                mode: 'multi-source',
                onComplete: (result) => {
                    this.manualAudio.push(result.file.path);
                    this.selectSource('audio', result.file.path, true);
                    this.rerenderSection({ type: 'audio' } as SourceSection);
                }
            }).open();
        });
    }

    /**
     * Show a status badge on source sections that need extra provider setup.
     * Called from both renderSourceSection() and renderSectionContent().
     */

    private selectSource(type: string, value: string, selected: boolean): void {
        const set = this.sectionConfigs[type as SourceSectionType]?.getSelected();
        if (!set) return;
        if (selected) {
            set.add(value);
        } else {
            set.delete(value);
        }
    }

    private getTotalSelectedCount(): number {
        let count = 0;
        if (this.summarizeNote) count++;
        for (const type of SECTION_ORDER) {
            count += this.sectionConfigs[type].getSelected().size;
        }
        return count;
    }

    private updateCtaButton(): void {
        if (!this.ctaButton) return;

        const t = this.plugin.t.modals.multiSource;
        const count = this.getTotalSelectedCount();
        const isTranslate = this.config.mode === 'translate';

        if (count === 0) {
            this.ctaButton.textContent = isTranslate ? (t?.translateButton || 'Translate Sources') : (t?.summarizeButton || 'Summarize');
            this.ctaButton.disabled = true;
        } else if (count === 1) {
            this.ctaButton.textContent = isTranslate ? (t?.translateOne || 'Translate 1 Source') : (t?.summarizeOne || 'Summarize 1 source');
            this.ctaButton.disabled = false;
        } else {
            const template = isTranslate ? (t?.translateMultiple || 'Translate {count} Sources') : (t?.summarizeMultiple || 'Summarize {count} sources');
            this.ctaButton.textContent = template.replace('{count}', String(count));
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
                })),
                images: Array.from(this.selectedImages).map(path => ({
                    path,
                    isVaultFile: this.isVaultFile(path)
                }))
            },
            summarizeNote: this.summarizeNote,
            focusContext: this.focusContext.trim() || undefined,
            personaId: this.selectedPersonaId,
            includeCompanion: (this.plugin.settings.enableStudyCompanion && this.selectedPersonaId === 'study') ? this.includeCompanion : undefined
        };

        if (this.config.mode === 'translate') {
             result.targetLanguage = this.selectedTargetLanguage;
             const lang = COMMON_LANGUAGES.find(l => l.code === this.selectedTargetLanguage);
             result.targetLanguageName = lang ? lang.name : this.selectedTargetLanguage;
             delete result.personaId;
             delete result.focusContext;
             delete result.includeCompanion;
        }

        this.close();
        this.onConfirm(result);
    }

    onClose(): void {
        this.contentEl.empty();
    }
}
