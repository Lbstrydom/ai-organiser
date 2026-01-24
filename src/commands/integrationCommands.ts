/**
 * Integration Commands
 * Commands for adding content to Pending Integration and integrating it into notes
 */

import { Editor, Notice, Modal, App, Setting, TextAreaComponent, TFile } from 'obsidian';
import type AIOrganiserPlugin from '../main';
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
import { detectEmbeddedContent, DetectedContent } from '../utils/embeddedContentDetector';
import { DocumentExtractionService } from '../services/documentExtractionService';
import { ConfigurationService, Persona } from '../services/configurationService';
import { PersonaSelectModal, createPersonaButton } from '../ui/modals/PersonaSelectModal';

export function registerIntegrationCommands(plugin: AIOrganiserPlugin): void {
    // Command: Add content to Pending Integration
    plugin.addCommand({
        id: 'add-to-pending-integration',
        name: 'Add content to Pending Integration',
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

                    new Notice('Content added to Pending Integration');
                }
            });
            modal.open();
        }
    });

    // Command: Integrate pending content
    plugin.addCommand({
        id: 'integrate-pending-content',
        name: 'Integrate pending content into note',
        icon: 'git-merge',
        editorCallback: async (editor: Editor) => {
            const pendingContent = getPendingIntegrationContent(editor);

            if (!pendingContent) {
                new Notice('No pending content to integrate');
                return;
            }

            const mainContent = getMainContent(editor);

            if (!mainContent.trim()) {
                new Notice('No main content to integrate into');
                return;
            }

            // Load personas and show confirmation modal with persona selection
            const configService = new ConfigurationService(plugin.app);
            const personas = await configService.getPersonas();
            const defaultPersona = await configService.getDefaultPersona();

            const modal = new IntegrationConfirmModal(
                plugin.app,
                personas,
                defaultPersona,
                async (selectedPersona) => {
                    new Notice('Integrating content...');

                    try {
                        // Get persona prompt
                        const personaPrompt = await configService.getPersonaPrompt(selectedPersona.id);

                        // Build the integration prompt with persona
                        const prompt = buildIntegrationPrompt(mainContent, pendingContent, plugin, personaPrompt);

                        // Call the LLM service using the same pattern as summarization
                        const response = await callLLMForIntegration(plugin, prompt);

                        if (!response.success || !response.content) {
                            new Notice(`Integration failed: ${response.error || 'No response from LLM'}`);
                            return;
                        }

                        // Replace main content while preserving References and Pending sections
                        replaceMainContent(editor, response.content);

                        // Clear the pending integration section
                        clearPendingIntegration(editor);

                        new Notice('Content integrated successfully');

                    } catch (error) {
                        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                        new Notice(`Integration failed: ${errorMessage}`);
                    }
                }
            );
            modal.open();
        }
    });

    // Command: Resolve pending embeds
    plugin.addCommand({
        id: 'resolve-pending-embeds',
        name: plugin.t.integration?.resolveEmbeds || 'Resolve pending embeds',
        icon: 'scan-text',
        editorCallback: async (editor: Editor) => {
            await resolvePendingEmbeds(plugin, editor);
        }
    });

    // Command: Ensure standard note structure
    plugin.addCommand({
        id: 'ensure-note-structure',
        name: 'Add References and Pending Integration sections',
        icon: 'layout-template',
        editorCallback: (editor: Editor) => {
            ensureStandardStructure(editor);
            new Notice('Note structure added');
        }
    });

    // Command: Quick add text to pending
    plugin.addCommand({
        id: 'quick-add-text-pending',
        name: 'Quick add: Text to Pending Integration',
        icon: 'text',
        editorCallback: async (editor: Editor) => {
            const modal = new QuickTextModal(plugin.app, plugin.t, (text) => {
                if (text) {
                    // Simple format - just number and content
                    const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                    const source: PendingSource = {
                        type: 'manual',
                        title: `Added ${timestamp}`,
                        date: getTodayDate(),
                        content: text
                    };
                    addToPendingIntegration(editor, source);
                    new Notice('Content added to Pending Integration');
                }
            });
            modal.open();
        }
    });

    // Command: Quick add URL to pending
    plugin.addCommand({
        id: 'quick-add-url-pending',
        name: 'Quick add: URL to Pending Integration',
        icon: 'link',
        editorCallback: async (editor: Editor) => {
            const modal = new QuickUrlModal(plugin.app, (url) => {
                if (url) {
                    const source: PendingSource = {
                        type: 'web',
                        title: 'Web Link',
                        date: getTodayDate(),
                        content: url,  // Just the URL - AI will handle during integration
                        link: url
                    };
                    addToPendingIntegration(editor, source);

                    // Also add to references
                    const sourceRef: SourceReference = {
                        type: 'web',
                        title: 'Web Link',
                        link: url,
                        date: getTodayDate(),
                        isInternal: false
                    };
                    addToReferencesSection(editor, sourceRef);

                    new Notice('URL added to Pending Integration');
                }
            });
            modal.open();
        }
    });

    // Command: Drop selection to pending (no modal, instant)
    plugin.addCommand({
        id: 'drop-selection-pending',
        name: 'Drop selection to Pending Integration',
        icon: 'arrow-down-to-line',
        editorCallback: (editor: Editor) => {
            const selection = editor.getSelection();

            if (!selection || !selection.trim()) {
                new Notice('Select some text first');
                return;
            }

            // Detect content type from selection
            const contentType = detectContentType(selection.trim());
            const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

            const source: PendingSource = {
                type: contentType.type,
                title: contentType.title || `Added ${timestamp}`,
                date: getTodayDate(),
                content: selection.trim(),
                link: contentType.link
            };

            addToPendingIntegration(editor, source);

            // If it's a URL or link, add to references too
            if (contentType.link) {
                const sourceRef: SourceReference = {
                    type: contentType.type,
                    title: contentType.title || 'Link',
                    link: contentType.link,
                    date: getTodayDate(),
                    isInternal: contentType.isInternal || false
                };
                addToReferencesSection(editor, sourceRef);
            }

            new Notice('Selection added to Pending Integration');
        }
    });
}

async function resolvePendingEmbeds(plugin: AIOrganiserPlugin, editor: Editor): Promise<void> {
    const t = plugin.t.integration;
    const pendingContent = getPendingIntegrationContent(editor);

    if (!pendingContent) {
        new Notice(t?.noEmbedsToResolve || 'No embeds to resolve in Pending Integration');
        return;
    }

    const activeFile = plugin.app.workspace.getActiveFile() || undefined;
    const detected = detectEmbeddedContent(plugin.app, pendingContent, activeFile);
    const extractable = detected.items.filter(item => item.type === 'document' || item.type === 'pdf');

    if (extractable.length === 0) {
        new Notice(t?.noEmbedsToResolve || 'No embeds to resolve in Pending Integration');
        return;
    }

    const typeCounts: Record<string, number> = {};
    for (const item of extractable) {
        typeCounts[item.type] = (typeCounts[item.type] || 0) + 1;
    }
    const typesSummary = Object.entries(typeCounts)
        .map(([type, count]) => `${count} ${type}`)
        .join(', ');

    const foundMessage = (t?.embedsFound || '{count} embed(s) found ({types})')
        .replace('{count}', String(extractable.length))
        .replace('{types}', typesSummary);
    const confirmMessage = t?.resolveConfirm || 'Extract text from embeds?';

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
        (t?.resolveSuccess || 'Resolved {count} embed(s)').replace('{count}', String(resolvedCount))
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
function detectContentType(text: string): {
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
            return { type: 'youtube', title: 'YouTube Video', link: trimmed, isInternal: false };
        }
        return { type: 'web', title: 'Web Link', link: trimmed, isInternal: false };
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

        if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext || '')) {
            return { type: 'image', title: filename, link: filename, isInternal: true };
        }
        if (ext === 'pdf') {
            return { type: 'pdf', title: filename, link: filename, isInternal: true };
        }
        if (['mp3', 'wav', 'm4a', 'ogg', 'webm'].includes(ext || '')) {
            return { type: 'audio', title: filename, link: filename, isInternal: true };
        }
        if (['mp4', 'mov', 'avi'].includes(ext || '')) {
            return { type: 'video', title: filename, link: filename, isInternal: true };
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
    try {
        if (plugin.settings.serviceType === 'cloud') {
            const { CloudLLMService } = await import('../services/cloudService');
            const cloudService = plugin.llmService as InstanceType<typeof CloudLLMService>;
            return await cloudService.summarizeText(prompt);
        } else {
            const { LocalLLMService } = await import('../services/localService');
            const localService = plugin.llmService as InstanceType<typeof LocalLLMService>;
            return await localService.summarizeText(prompt);
        }
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return { success: false, error: errorMessage };
    }
}

/**
 * Build the prompt for integrating pending content
 */
function buildIntegrationPrompt(
    mainContent: string,
    pendingContent: string,
    plugin: AIOrganiserPlugin,
    personaPrompt?: string
): string {
    const language = plugin.settings.summaryLanguage || 'English';
    const personaSection = personaPrompt ? `\n${personaPrompt}\n` : '';

    return `<task>
You are helping to integrate new content into an existing note. Merge the pending content with the main content in a way that:
1. Preserves the existing structure and organization of the main content
2. Integrates new information into relevant existing sections by topic
3. Creates new sections only when the new content covers entirely different topics
4. Maintains a coherent narrative and logical flow
5. Removes redundancy - don't repeat information that's already in the main content
6. Preserves important details and nuances from both sources
</task>
${personaSection}
<requirements>
- Output ONLY the merged content - no explanations or meta-commentary
- Keep the same writing style as the main content
- Integrate by topic, not by source
- If there are conflicting facts, include both with appropriate context
- Output in ${language}
</requirements>

<main_content>
${mainContent}
</main_content>

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
    private onConfirm: (persona: Persona) => void;
    private personaButtonEl: HTMLElement | null = null;

    constructor(
        app: App,
        personas: Persona[],
        defaultPersona: Persona,
        onConfirm: (persona: Persona) => void
    ) {
        super(app);
        this.personas = personas;
        this.selectedPersona = defaultPersona;
        this.onConfirm = onConfirm;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl('h2', { text: 'Integrate Pending Content' });
        contentEl.createEl('p', {
            text: 'The AI will merge your pending content into the main note by topic.',
            cls: 'setting-item-description'
        });

        // Persona selector row
        if (this.personas.length > 1) {
            const personaRow = contentEl.createEl('div', { cls: 'persona-selector-row' });
            personaRow.createEl('span', {
                text: 'Writing style:',
                cls: 'persona-selector-label'
            });

            this.personaButtonEl = createPersonaButton(
                personaRow,
                this.selectedPersona,
                () => this.openPersonaSelector()
            );
        }

        // Buttons
        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText('Cancel')
                .onClick(() => this.close()))
            .addButton(btn => btn
                .setButtonText('Integrate')
                .setCta()
                .onClick(() => {
                    this.close();
                    this.onConfirm(this.selectedPersona);
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
    private t: any;

    constructor(app: App, t: any, onSubmit: (result: PendingSource | null) => void) {
        super(app);
        this.t = t;
        this.onSubmit = onSubmit;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl('h2', { text: this.t.modals?.addContent?.title || 'Add Content to Pending Integration' });

        let selectedType: SourceType = 'manual';
        let title = '';
        let link = '';
        let content = '';

        // Source type dropdown
        new Setting(contentEl)
            .setName(this.t.modals?.addContent?.sourceType || 'Source Type')
            .addDropdown(dropdown => {
                dropdown
                    .addOption('manual', this.t.modals?.addContent?.types?.manual || 'My Notes')
                    .addOption('web', this.t.modals?.addContent?.types?.web || 'Web Article')
                    .addOption('youtube', this.t.modals?.addContent?.types?.youtube || 'YouTube Video')
                    .addOption('audio', this.t.modals?.addContent?.types?.audio || 'Audio Recording')
                    .addOption('pdf', this.t.modals?.addContent?.types?.pdf || 'PDF Document')
                    .addOption('image', this.t.modals?.addContent?.types?.image || 'Image/Screenshot')
                    .addOption('note', this.t.modals?.addContent?.types?.note || 'Obsidian Note')
                    .setValue('manual')
                    .onChange(value => {
                        selectedType = value as SourceType;
                    });
            });

        // Title
        new Setting(contentEl)
            .setName(this.t.modals?.addContent?.sourceTitle || 'Source Title')
            .setDesc(this.t.modals?.addContent?.sourceTitleDesc || 'A name for this source')
            .addText(text => {
                text
                    .setPlaceholder(this.t.modals?.addContent?.sourceTitlePlaceholder || 'e.g., Lecture Notes, Article Name')
                    .onChange(value => {
                        title = value;
                    });
            });

        // Link (optional)
        new Setting(contentEl)
            .setName(this.t.modals?.addContent?.sourceLink || 'Link (optional)')
            .setDesc(this.t.modals?.addContent?.sourceLinkDesc || 'URL or [[wikilink]] to the source')
            .addText(text => {
                text
                    .setPlaceholder(this.t.modals?.addContent?.sourceLinkPlaceholder || 'https://... or [[Note Name]]')
                    .onChange(value => {
                        link = value;
                    });
            });

        // Content
        const contentSetting = new Setting(contentEl)
            .setName(this.t.modals?.addContent?.content || 'Content')
            .setDesc(this.t.modals?.addContent?.contentDesc || 'Paste or type the content to integrate');

        const textArea = new TextAreaComponent(contentSetting.controlEl);
        textArea
            .setPlaceholder(this.t.modals?.addContent?.contentPlaceholder || 'Paste content here...')
            .onChange(value => {
                content = value;
            });
        textArea.inputEl.rows = 10;
        textArea.inputEl.style.width = '100%';

        // Buttons
        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText(this.t.modals?.cancel || 'Cancel')
                .onClick(() => {
                    this.close();
                }))
            .addButton(btn => btn
                .setButtonText(this.t.modals?.add || 'Add')
                .setCta()
                .onClick(() => {
                    if (!content.trim()) {
                        new Notice(this.t.messages?.contentRequired || 'Please enter some content');
                        return;
                    }

                    this.result = {
                        type: selectedType,
                        title: title || this.getDefaultTitle(selectedType),
                        date: getTodayDate(),
                        content: content.trim(),
                        link: link || undefined
                    };
                    this.close();
                }));
    }

    private getDefaultTitle(type: SourceType): string {
        const defaults: Record<SourceType, string> = {
            manual: 'My Notes',
            web: 'Web Article',
            youtube: 'YouTube Video',
            audio: 'Audio Recording',
            pdf: 'PDF Document',
            image: 'Image/Screenshot',
            note: 'Obsidian Note',
            video: 'Video',
            transcript: 'Transcript'
        };
        return defaults[type] || 'Source';
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
    private t: any;

    constructor(app: App, t: any, onSubmit: (text: string) => void) {
        super(app);
        this.t = t;
        this.onSubmit = onSubmit;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl('h2', { text: 'Quick Add to Pending' });
        contentEl.createEl('p', {
            text: 'Just paste or type anything - text, URLs, notes. The AI will organize it during integration.',
            cls: 'setting-item-description'
        });

        let text = '';

        const textArea = new TextAreaComponent(contentEl);
        textArea
            .setPlaceholder('Paste anything here:\n- Text notes\n- URLs (https://...)\n- File links ([[filename]])\n- Screenshots (![[image.png]])\n- Any content to integrate later...')
            .onChange(value => { text = value; });
        textArea.inputEl.rows = 10;
        textArea.inputEl.style.width = '100%';
        textArea.inputEl.style.marginBottom = '1em';

        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText('Cancel')
                .onClick(() => this.close()))
            .addButton(btn => btn
                .setButtonText('Add')
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

    constructor(app: App, onSubmit: (url: string) => void) {
        super(app);
        this.onSubmit = onSubmit;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl('h2', { text: 'Add URL to Pending' });
        contentEl.createEl('p', {
            text: 'Paste a URL. Use "Summarize URL" command first if you want to fetch and summarize the content.',
            cls: 'setting-item-description'
        });

        let url = '';

        new Setting(contentEl)
            .setName('URL')
            .addText(input => {
                input
                    .setPlaceholder('https://...')
                    .onChange(value => { url = value; });
                input.inputEl.style.width = '100%';
            });

        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText('Cancel')
                .onClick(() => this.close()))
            .addButton(btn => btn
                .setButtonText('Add')
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
