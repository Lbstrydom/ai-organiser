/**
 * Integration Commands
 * Commands for adding content to Pending Integration and integrating it into notes
 */

import { Editor, MarkdownView, Notice, Modal, App, Setting, TextAreaComponent, TFile } from 'obsidian';
import type AIOrganiserPlugin from '../main';
import type { Translations } from '../i18n';
import {
    addToPendingIntegration,
    getPendingIntegrationContent,
    setPendingIntegrationContent,
    getMainContent,
    clearPendingIntegration,
    replaceMainContent,
    ensureStandardStructure,
    PendingSource,
    SourceType,
    getTodayDate,
    addToReferencesSection,
    SourceReference
} from '../utils/noteStructure';
import { AUDIO_EXTENSIONS, IMAGE_EXTENSIONS, VIDEO_EXTENSIONS, PlacementStrategy, FormatStrategy, DetailStrategy, DEFAULT_PLACEMENT_STRATEGY, DEFAULT_FORMAT_STRATEGY, DEFAULT_DETAIL_STRATEGY } from '../core/constants';
import { getPlacementInstructions, getFormatInstructions, getDetailInstructions } from '../services/prompts/integrationPrompts';
import { insertAtCursor, appendAsNewSections } from '../utils/editorUtils';
import { detectEmbeddedContent, DetectedContent } from '../utils/embeddedContentDetector';
import { DocumentExtractionService } from '../services/documentExtractionService';
import { PersonaSelectModal, createPersonaButton } from '../ui/modals/PersonaSelectModal';
import type { Persona } from '../services/configurationService';
import { summarizeText } from '../services/llmFacade';
import { showErrorNotice, showSuccessNotice } from '../utils/executeWithNotice';

export function registerIntegrationCommands(plugin: AIOrganiserPlugin): void {
    // Command: Add content to Pending Integration
    plugin.addCommand({
        id: 'add-to-pending-integration',
        name: plugin.t.commands.addToPendingIntegration,
        icon: 'plus-circle',
        editorCallback: async (editor: Editor) => {
            const modal = new AddContentModal(plugin.app, plugin.t, async (result) => {
                if (result) {
                    addToPendingIntegration(editor, result);

                    // If there's a link, also add to References
                    if (result.link) {
                        const sourceRef: SourceReference = {
                            type: result.type,
                            title: result.title,
                            link: result.link,
                            date: result.date,
                            isInternal: !result.link.startsWith('http')
                        };
                        addToReferencesSection(editor, sourceRef);
                    }

                    new Notice(plugin.t.messages.contentAddedToPending);
                }
            });
            modal.open();
        }
    });

    // Command: Integrate pending content
    plugin.addCommand({
        id: 'integrate-pending-content',
        name: plugin.t.commands.integratePendingContent,
        icon: 'git-merge',
        editorCallback: async (editor: Editor) => {
            const pendingContent = getPendingIntegrationContent(editor);

            if (!pendingContent) {
                new Notice(plugin.t.messages.noPendingContentToIntegrate);
                return;
            }

            const mainContent = getMainContent(editor);

            // Load personas and show confirmation modal with persona selection
            const personas = await plugin.configService.getPersonas();
            const defaultPersona = await plugin.configService.getDefaultPersona();

            const modal = new IntegrationConfirmModal(
                plugin.app,
                personas,
                defaultPersona,
                plugin.t,
                async (selectedPersona, placement, format, detail, autoTag) => {
                    // Guard: callout/merge require main content
                    if ((placement === 'callout' || placement === 'merge') && !mainContent.trim()) {
                        new Notice(plugin.t.messages.noMainContentToIntegrateInto);
                        return;
                    }

                    new Notice(plugin.t.messages.integratingContent);

                    try {
                        // Get persona prompt
                        const personaPrompt = await plugin.configService.getPersonaPrompt(selectedPersona.id);

                        // Build the integration prompt with strategy params
                        const prompt = buildIntegrationPrompt(mainContent, pendingContent, plugin, personaPrompt, placement, format, detail);

                        // Call the LLM service
                        const response = await callLLMForIntegration(plugin, prompt);

                        if (!response.success || !response.content) {
                            const errorMessage = response.error || plugin.t.messages.noResponseFromLlm;
                            showErrorNotice(plugin.t.messages.integratingContentFailed.replace('{error}', errorMessage));
                            return;
                        }

                        // Apply content based on placement strategy
                        if (placement === 'cursor') {
                            insertAtCursor(editor, response.content);
                        } else if (placement === 'append') {
                            appendAsNewSections(editor, response.content);
                        } else {
                            // callout or merge — rewrite main content
                            replaceMainContent(editor, response.content);
                        }

                        // Clear the pending integration section
                        clearPendingIntegration(editor);

                        // Auto-tag if requested — use editor buffer (not disk) for fresh content
                        if (autoTag) {
                            const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
                            if (view?.file) {
                                const noteContent = editor.getValue();
                                await plugin.analyzeAndTagNote(view.file, noteContent);
                            }
                        }

                        showSuccessNotice(plugin.t.messages.contentIntegratedSuccessfully);

                    } catch (error) {
                        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                        showErrorNotice(plugin.t.messages.integratingContentFailed.replace('{error}', errorMessage));
                    }
                }
            );
            modal.open();
        }
    });

    // Command: Resolve pending embeds
    plugin.addCommand({
        id: 'resolve-pending-embeds',
        name: plugin.t.commands.resolvePendingEmbeds,
        icon: 'scan-text',
        editorCallback: async (editor: Editor) => {
            await resolvePendingEmbeds(plugin, editor);
        }
    });

    // Command: Ensure standard note structure
    plugin.addCommand({
        id: 'ensure-note-structure',
        name: plugin.t.commands.ensureNoteStructure,
        icon: 'layout-template',
        editorCallback: (editor: Editor) => {
            ensureStandardStructure(editor);
            new Notice(plugin.t.messages.noteStructureAdded);
        }
    });

    // Command: Quick add text to pending
    plugin.addCommand({
        id: 'quick-add-text-pending',
        name: plugin.t.commands.quickAddTextPending,
        icon: 'text',
        editorCallback: async (editor: Editor) => {
            const modal = new QuickTextModal(plugin.app, plugin.t, (text) => {
                if (text) {
                    // Simple format - just number and content
                    const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                    const source: PendingSource = {
                        type: 'manual',
                        title: plugin.t.messages.addedTimestamp.replace('{time}', timestamp),
                        date: getTodayDate(),
                        content: text
                    };
                    addToPendingIntegration(editor, source);
                    new Notice(plugin.t.messages.contentAddedToPending);
                }
            });
            modal.open();
        }
    });

    // Command: Quick add URL to pending
    plugin.addCommand({
        id: 'quick-add-url-pending',
        name: plugin.t.commands.quickAddUrlPending,
        icon: 'link',
        editorCallback: async (editor: Editor) => {
            const modal = new QuickUrlModal(plugin.app, plugin.t, (url) => {
                if (url) {
                    const defaultTitle = getDefaultSourceTitle(plugin.t, 'web');
                    const source: PendingSource = {
                        type: 'web',
                        title: defaultTitle,
                        date: getTodayDate(),
                        content: url,  // Just the URL - AI will handle during integration
                        link: url
                    };
                    addToPendingIntegration(editor, source);

                    // Also add to references
                    const sourceRef: SourceReference = {
                        type: 'web',
                        title: defaultTitle,
                        link: url,
                        date: getTodayDate(),
                        isInternal: false
                    };
                    addToReferencesSection(editor, sourceRef);

                    new Notice(plugin.t.messages.urlAddedToPending);
                }
            });
            modal.open();
        }
    });

    // Command: Drop selection to pending (no modal, instant)
    plugin.addCommand({
        id: 'drop-selection-pending',
        name: plugin.t.commands.dropSelectionPending,
        icon: 'arrow-down-to-line',
        editorCallback: (editor: Editor) => {
            const selection = editor.getSelection();

            if (!selection || !selection.trim()) {
                new Notice(plugin.t.messages.selectTextFirst);
                return;
            }

            // Detect content type from selection
            const contentType = detectContentType(selection.trim(), plugin.t);
            const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const defaultTitle = contentType.type === 'manual'
                ? plugin.t.messages.addedTimestamp.replace('{time}', timestamp)
                : getDefaultSourceTitle(plugin.t, contentType.type);

            const source: PendingSource = {
                type: contentType.type,
                title: contentType.title || defaultTitle,
                date: getTodayDate(),
                content: selection.trim(),
                link: contentType.link
            };

            addToPendingIntegration(editor, source);

            // If it's a URL or link, add to references too
            if (contentType.link) {
                const sourceRef: SourceReference = {
                    type: contentType.type,
                    title: contentType.title || defaultTitle,
                    link: contentType.link,
                    date: getTodayDate(),
                    isInternal: contentType.isInternal || false
                };
                addToReferencesSection(editor, sourceRef);
            }

            new Notice(plugin.t.messages.selectionAddedToPending);
        }
    });
}

function getDefaultSourceTitle(t: Translations, type: SourceType): string {
    const typeLabels = t.modals.addContent.types as Record<SourceType, string>;
    return typeLabels[type] || t.modals.addContent.defaultTitle;
}

async function resolvePendingEmbeds(plugin: AIOrganiserPlugin, editor: Editor): Promise<void> {
    const t = plugin.t.integration;
    const pendingContent = getPendingIntegrationContent(editor);

    if (!pendingContent) {
        new Notice(t.noEmbedsToResolve);
        return;
    }

    const activeFile = plugin.app.workspace.getActiveFile() || undefined;
    const detected = detectEmbeddedContent(plugin.app, pendingContent, activeFile);
    const extractable = detected.items.filter(item => item.type === 'document' || item.type === 'pdf');

    if (extractable.length === 0) {
        new Notice(t.noEmbedsToResolve);
        return;
    }

    const typeCounts: Record<string, number> = {};
    for (const item of extractable) {
        typeCounts[item.type] = (typeCounts[item.type] || 0) + 1;
    }
    const typesSummary = Object.entries(typeCounts)
        .map(([type, count]) => `${count} ${type}`)
        .join(', ');

    const foundMessage = t.embedsFound
        .replace('{count}', String(extractable.length))
        .replace('{types}', typesSummary);
    const confirmMessage = t.resolveConfirm;

    const proceed = await plugin.showConfirmationDialog(`${foundMessage}\n\n${confirmMessage}`);
    if (!proceed) {
        return;
    }

    const documentService = new DocumentExtractionService(plugin.app);
    let updatedContent = pendingContent;
    let resolvedCount = 0;

    for (const item of extractable) {
        const result = await extractPendingEmbedText(plugin, documentService, item);
        if (result.success && result.text) {
            const replacement = `\n\n### Extracted: ${item.displayName}\n\n${result.text}\n`;
            updatedContent = updatedContent.split(item.originalText).join(replacement);
            resolvedCount++;
        }
    }

    if (resolvedCount > 0) {
        setPendingIntegrationContent(editor, updatedContent);
    }

    new Notice(
        t.resolveSuccess.replace('{count}', String(resolvedCount))
    );
}

async function extractPendingEmbedText(
    plugin: AIOrganiserPlugin,
    documentService: DocumentExtractionService,
    item: DetectedContent
): Promise<{ success: boolean; text?: string; error?: string }> {
    if (item.isExternal) {
        if (item.type === 'document') {
            return await documentService.extractFromUrl(item.url);
        }
        return { success: false, error: 'External PDFs are not supported' };
    }

    let file = item.resolvedFile;
    if (!file) {
        const abstractFile = plugin.app.vault.getAbstractFileByPath(item.url);
        if (abstractFile instanceof TFile) {
            file = abstractFile;
        }
    }

    if (!file) {
        return { success: false, error: 'File not found' };
    }

    return await documentService.extractText(file);
}

/**
 * Detect content type from text
 */
function detectContentType(text: string, t: Translations): {
    type: SourceType;
    title?: string;
    link?: string;
    isInternal?: boolean;
} {
    const trimmed = text.trim();

    // Check for URL
    const urlMatch = trimmed.match(/^(https?:\/\/[^\s]+)$/);
    if (urlMatch) {
        // Check if it's YouTube
        if (trimmed.includes('youtube.com') || trimmed.includes('youtu.be')) {
            return { type: 'youtube', title: getDefaultSourceTitle(t, 'youtube'), link: trimmed, isInternal: false };
        }
        return { type: 'web', title: getDefaultSourceTitle(t, 'web'), link: trimmed, isInternal: false };
    }

    // Check for wikilink [[...]]
    const wikilinkMatch = trimmed.match(/^\[\[([^\]]+)\]\]$/);
    if (wikilinkMatch) {
        return { type: 'note', title: wikilinkMatch[1], link: wikilinkMatch[1], isInternal: true };
    }

    // Check for embed ![[...]]
    const embedMatch = trimmed.match(/^!\[\[([^\]]+)\]\]$/);
    if (embedMatch) {
        const filename = embedMatch[1];
        const ext = filename.split('.').pop()?.toLowerCase();
        const extWithDot = ext ? `.${ext}` : '';

        if (IMAGE_EXTENSIONS.includes(extWithDot)) {
            return { type: 'image', title: filename, link: filename, isInternal: true };
        }
        if (extWithDot === '.pdf') {
            return { type: 'pdf', title: filename, link: filename, isInternal: true };
        }
        if (VIDEO_EXTENSIONS.includes(extWithDot)) {
            return { type: 'video', title: filename, link: filename, isInternal: true };
        }
        if (AUDIO_EXTENSIONS.includes(extWithDot)) {
            return { type: 'audio', title: filename, link: filename, isInternal: true };
        }
        return { type: 'note', title: filename, link: filename, isInternal: true };
    }

    // Default: plain text/manual notes
    return { type: 'manual' };
}

/**
 * Call LLM service for content integration
 */
async function callLLMForIntegration(
    plugin: AIOrganiserPlugin,
    prompt: string
): Promise<{ success: boolean; content?: string; error?: string }> {
    return await summarizeText({ llmService: plugin.llmService, settings: plugin.settings }, prompt);
}

/**
 * Build the prompt for integrating pending content
 */
export function buildIntegrationPrompt(
    mainContent: string,
    pendingContent: string,
    plugin: AIOrganiserPlugin,
    personaPrompt?: string,
    placement: PlacementStrategy = DEFAULT_PLACEMENT_STRATEGY,
    format: FormatStrategy = DEFAULT_FORMAT_STRATEGY,
    detail: DetailStrategy = DEFAULT_DETAIL_STRATEGY
): string {
    const language = plugin.settings.summaryLanguage || 'English';
    const personaSection = personaPrompt ? `\n${personaPrompt}\n` : '';
    const placementInstructions = getPlacementInstructions(placement);
    const formatInstructions = getFormatInstructions(format);
    const detailInstructions = getDetailInstructions(detail);

    const needsMainContent = placement === 'callout' || placement === 'merge';

    const mainContentSection = needsMainContent ? `
<main_content>
${mainContent}
</main_content>
` : '';

    return `<task>
You are helping to integrate new content into an existing note.

${placementInstructions}
</task>
${personaSection}
<requirements>
- Output ONLY the content - no explanations or meta-commentary
- Keep the same writing style as the main content
- ${formatInstructions}
- ${detailInstructions}
- If there are conflicting facts, include both with appropriate context
- Output in ${language}
</requirements>
${mainContentSection}
<pending_content_to_integrate>
${pendingContent}
</pending_content_to_integrate>

<output_format>
Return ONLY the integrated note content. Do not include:
- Any introductory text like "Here is the integrated content"
- The "## References" or "## Pending Integration" sections (these are managed separately)
- Any markdown code fences around the output
</output_format>`;
}

/**
 * Modal for confirming integration with persona selection
 */
class IntegrationConfirmModal extends Modal {
    private personas: Persona[];
    private selectedPersona: Persona;
    private onConfirm: (persona: Persona, placement: PlacementStrategy, format: FormatStrategy, detail: DetailStrategy, autoTag: boolean) => void;
    private personaButtonEl: HTMLElement | null = null;
    private t: Translations;
    private selectedPlacement: PlacementStrategy = DEFAULT_PLACEMENT_STRATEGY;
    private selectedFormat: FormatStrategy = DEFAULT_FORMAT_STRATEGY;
    private selectedDetail: DetailStrategy = DEFAULT_DETAIL_STRATEGY;
    private autoTag = false;

    constructor(
        app: App,
        personas: Persona[],
        defaultPersona: Persona,
        t: Translations,
        onConfirm: (persona: Persona, placement: PlacementStrategy, format: FormatStrategy, detail: DetailStrategy, autoTag: boolean) => void
    ) {
        super(app);
        this.personas = personas;
        this.selectedPersona = defaultPersona;
        this.t = t;
        this.onConfirm = onConfirm;
    }

    onOpen() {
        const { contentEl } = this;
        const ic = this.t.modals.integrationConfirm;
        contentEl.empty();

        contentEl.createEl('h2', { text: ic.title });
        contentEl.createEl('p', {
            text: ic.description,
            cls: 'setting-item-description'
        });

        // Persona selector row
        if (this.personas.length > 1) {
            const personaRow = contentEl.createEl('div', { cls: 'persona-selector-row' });
            personaRow.createEl('span', {
                text: ic.personaLabel,
                cls: 'persona-selector-label'
            });

            this.personaButtonEl = createPersonaButton(
                personaRow,
                this.selectedPersona,
                () => this.openPersonaSelector()
            );
        }

        // Placement dropdown
        const placementSetting = new Setting(contentEl)
            .setName(ic.placementLabel)
            .setDesc(ic.placementDesc)
            .addDropdown(dd => dd
                .addOption('cursor', ic.placementCursor)
                .addOption('append', ic.placementAppend)
                .addOption('callout', ic.placementCallout)
                .addOption('merge', ic.placementMerge)
                .setValue(this.selectedPlacement)
                .onChange((value: string) => {
                    this.selectedPlacement = value as PlacementStrategy;
                    // Show merge warning dynamically
                    if (value === 'merge') {
                        placementSetting.setDesc(ic.placementMergeWarn);
                    } else {
                        placementSetting.setDesc(ic.placementDesc);
                    }
                }));

        // Format dropdown
        new Setting(contentEl)
            .setName(ic.formatLabel)
            .setDesc(ic.formatDesc)
            .addDropdown(dd => dd
                .addOption('prose', ic.formatProse)
                .addOption('bullets', ic.formatBullets)
                .addOption('tasks', ic.formatTasks)
                .addOption('table', ic.formatTable)
                .setValue(this.selectedFormat)
                .onChange((value: string) => {
                    this.selectedFormat = value as FormatStrategy;
                }));

        // Detail level dropdown
        new Setting(contentEl)
            .setName(ic.detailLabel)
            .setDesc(ic.detailDesc)
            .addDropdown(dd => dd
                .addOption('full', ic.detailFull)
                .addOption('concise', ic.detailConcise)
                .addOption('summary', ic.detailSummary)
                .setValue(this.selectedDetail)
                .onChange((value: string) => {
                    this.selectedDetail = value as DetailStrategy;
                }));

        // Auto-tag toggle
        new Setting(contentEl)
            .setName(ic.autoTagLabel)
            .setDesc(ic.autoTagDesc)
            .addToggle(toggle => toggle
                .setValue(this.autoTag)
                .onChange(value => {
                    this.autoTag = value;
                }));

        // Buttons
        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText(this.t.modals.cancel)
                .onClick(() => this.close()))
            .addButton(btn => btn
                .setButtonText(ic.confirmButton)
                .setCta()
                .onClick(() => {
                    this.close();
                    this.onConfirm(this.selectedPersona, this.selectedPlacement, this.selectedFormat, this.selectedDetail, this.autoTag);
                }));
    }

    private openPersonaSelector() {
        const modal = new PersonaSelectModal(
            this.app,
            this.personas,
            this.selectedPersona.id,
            (persona) => {
                this.selectedPersona = persona;
                this.updatePersonaButton();
            }
        );
        modal.open();
    }

    private updatePersonaButton() {
        if (this.personaButtonEl) {
            const label = this.personaButtonEl.querySelector('.persona-button-label');
            if (label) {
                label.textContent = this.selectedPersona.name;
            }
        }
    }

    onClose() {
        this.contentEl.empty();
    }
}

/**
 * Modal for adding content to Pending Integration
 */
class AddContentModal extends Modal {
    private result: PendingSource | null = null;
    private onSubmit: (result: PendingSource | null) => void;
    private t: Translations;

    constructor(app: App, t: Translations, onSubmit: (result: PendingSource | null) => void) {
        super(app);
        this.t = t;
        this.onSubmit = onSubmit;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl('h2', { text: this.t.modals.addContent.title });

        let selectedType: SourceType = 'manual';
        let title = '';
        let link = '';
        let content = '';

        // Source type dropdown
        new Setting(contentEl)
            .setName(this.t.modals.addContent.sourceType)
            .addDropdown(dropdown => {
                dropdown
                    .addOption('manual', this.t.modals.addContent.types.manual)
                    .addOption('web', this.t.modals.addContent.types.web)
                    .addOption('youtube', this.t.modals.addContent.types.youtube)
                    .addOption('audio', this.t.modals.addContent.types.audio)
                    .addOption('pdf', this.t.modals.addContent.types.pdf)
                    .addOption('image', this.t.modals.addContent.types.image)
                    .addOption('note', this.t.modals.addContent.types.note)
                    .setValue('manual')
                    .onChange(value => {
                        selectedType = value as SourceType;
                    });
            });

        // Title
        new Setting(contentEl)
            .setName(this.t.modals.addContent.sourceTitle)
            .setDesc(this.t.modals.addContent.sourceTitleDesc)
            .addText(text => {
                text
                    .setPlaceholder(this.t.modals.addContent.sourceTitlePlaceholder)
                    .onChange(value => {
                        title = value;
                    });
            });

        // Link (optional)
        new Setting(contentEl)
            .setName(this.t.modals.addContent.sourceLink)
            .setDesc(this.t.modals.addContent.sourceLinkDesc)
            .addText(text => {
                text
                    .setPlaceholder(this.t.modals.addContent.sourceLinkPlaceholder)
                    .onChange(value => {
                        link = value;
                    });
            });

        // Content
        const contentSetting = new Setting(contentEl)
            .setName(this.t.modals.addContent.content)
            .setDesc(this.t.modals.addContent.contentDesc);

        const textArea = new TextAreaComponent(contentSetting.controlEl);
        textArea
            .setPlaceholder(this.t.modals.addContent.contentPlaceholder)
            .onChange(value => {
                content = value;
            });
        textArea.inputEl.rows = 10;
        textArea.inputEl.style.width = '100%';

        // Buttons
        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText(this.t.modals.cancel)
                .onClick(() => {
                    this.close();
                }))
            .addButton(btn => btn
                .setButtonText(this.t.modals.addContent.add)
                .setCta()
                .onClick(() => {
                    if (!content.trim()) {
                        new Notice(this.t.messages.contentRequired);
                        return;
                    }

                    this.result = {
                        type: selectedType,
                        title: title || getDefaultSourceTitle(this.t, selectedType),
                        date: getTodayDate(),
                        content: content.trim(),
                        link: link || undefined
                    };
                    this.close();
                }));
    }

    onClose() {
        this.onSubmit(this.result);
        this.contentEl.empty();
    }
}

/**
 * Quick modal for adding text - simplified single textarea
 */
class QuickTextModal extends Modal {
    private onSubmit: (text: string) => void;
    private t: Translations;

    constructor(app: App, t: Translations, onSubmit: (text: string) => void) {
        super(app);
        this.t = t;
        this.onSubmit = onSubmit;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl('h2', { text: this.t.modals.quickAddText.title });
        contentEl.createEl('p', {
            text: this.t.modals.quickAddText.description,
            cls: 'setting-item-description'
        });

        let text = '';

        const textArea = new TextAreaComponent(contentEl);
        textArea
            .setPlaceholder(this.t.modals.quickAddText.placeholder)
            .onChange(value => { text = value; });
        textArea.inputEl.rows = 10;
        textArea.inputEl.style.width = '100%';
        textArea.inputEl.style.marginBottom = '1em';

        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText(this.t.modals.cancel)
                .onClick(() => this.close()))
            .addButton(btn => btn
                .setButtonText(this.t.modals.addContent.add)
                .setCta()
                .onClick(() => {
                    if (text.trim()) {
                        this.onSubmit(text.trim());
                    }
                    this.close();
                }));
    }

    onClose() {
        this.contentEl.empty();
    }
}

/**
 * Quick modal for adding URL - simplified
 */
class QuickUrlModal extends Modal {
    private onSubmit: (url: string) => void;
    private t: Translations;

    constructor(app: App, t: Translations, onSubmit: (url: string) => void) {
        super(app);
        this.t = t;
        this.onSubmit = onSubmit;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl('h2', { text: this.t.modals.quickAddUrl.title });
        contentEl.createEl('p', {
            text: this.t.modals.quickAddUrl.description,
            cls: 'setting-item-description'
        });

        let url = '';

        new Setting(contentEl)
            .setName(this.t.modals.quickAddUrl.urlLabel)
            .addText(input => {
                input
                    .setPlaceholder(this.t.modals.quickAddUrl.urlPlaceholder)
                    .onChange(value => { url = value; });
                input.inputEl.style.width = '100%';
            });

        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText(this.t.modals.cancel)
                .onClick(() => this.close()))
            .addButton(btn => btn
                .setButtonText(this.t.modals.addContent.add)
                .setCta()
                .onClick(() => {
                    if (url.trim()) {
                        this.onSubmit(url.trim());
                    }
                    this.close();
                }));
    }

    onClose() {
        this.contentEl.empty();
    }
}
