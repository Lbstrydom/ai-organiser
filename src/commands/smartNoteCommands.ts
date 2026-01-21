/**
 * Smart Note Commands
 * Commands for generating and improving notes from embedded multimedia content
 */

import { Editor, MarkdownView, MarkdownFileInfo, Notice, TFile } from 'obsidian';
import type AIOrganiserPlugin from '../main';
import { detectEmbeddedContent, getExtractableContent, DetectedContent } from '../utils/embeddedContentDetector';
import { ContentSelectionModal, ContentSelectionResult } from '../ui/modals/ContentSelectionModal';
import { ContentExtractionService, serviceSupportsMultimodal, ExtractedContent } from '../services/contentExtractionService';
import { SummaryPromptOptions } from '../services/prompts/summaryPrompts';
import { getLanguageNameForPrompt } from '../services/languages';
import { shouldShowPrivacyNotice, markPrivacyNoticeShown, isCloudProvider } from '../services/privacyNotice';
import { PrivacyNoticeModal } from '../ui/modals/PrivacyNoticeModal';
// BUILTIN_PERSONAS no longer imported - using configurationService for summary personas
import { ImproveNoteModal, ImproveNoteResult } from '../ui/modals/ImproveNoteModal';
import { FindResourcesModal } from '../ui/modals/FindResourcesModal';
import { searchResources } from '../services/resourceSearchService';
import { replaceMainContent, ensureStandardStructure } from '../utils/noteStructure';
import { ConfigurationService, Persona } from '../services/configurationService';
import { MermaidDiagramModal, MermaidDiagramResult } from '../ui/modals/MermaidDiagramModal';
import { buildDiagramPrompt, cleanMermaidOutput, wrapInCodeFence } from '../services/prompts/diagramPrompts';

export function registerSmartNoteCommands(plugin: AIOrganiserPlugin): void {
    const extractionService = new ContentExtractionService(plugin.app);

    // Command: Generate note from embedded content (merged single command)
    plugin.addCommand({
        id: 'generate-from-embedded',
        name: plugin.t.commands.generateFromEmbedded || 'Generate note from embedded content',
        icon: 'sparkles',
        editorCallback: async (editor: Editor, ctx: MarkdownView | MarkdownFileInfo) => {
            const view = ctx instanceof MarkdownView ? ctx : null;
            if (!view?.file) {
                new Notice(plugin.t.messages.openNote);
                return;
            }

            const content = await plugin.app.vault.read(view.file);

            // Detect embedded content
            const detected = detectEmbeddedContent(plugin.app, content, view.file);
            const extractable = getExtractableContent(detected);

            if (extractable.length === 0) {
                new Notice(plugin.t.messages.noEmbeddedContent || 'No extractable content found in this note');
                return;
            }

            // Check if note has text content (excluding frontmatter and embedded syntax)
            const noteHasText = hasTextContent(content);

            // Show selection modal
            const modal = new ContentSelectionModal(
                plugin.app,
                plugin.t,
                extractable,
                noteHasText,
                async (result: ContentSelectionResult) => {
                    if (result.cancelled || result.selectedItems.length === 0) {
                        if (!result.cancelled) {
                            new Notice(plugin.t.messages.noItemsSelected || 'No items selected');
                        }
                        return;
                    }

                    await processSelectedContent(
                        plugin,
                        extractionService,
                        editor,
                        view.file!,
                        result.selectedItems,
                        result.includeNoteText ? content : null
                    );
                }
            );
            modal.open();
        }
    });

    // Command: Improve/Query note with AI
    plugin.addCommand({
        id: 'improve-note',
        name: plugin.t.commands.improveNote || 'Improve note with AI',
        icon: 'message-square-plus',
        editorCallback: async (editor: Editor, ctx: MarkdownView | MarkdownFileInfo) => {
            const view = ctx instanceof MarkdownView ? ctx : null;
            if (!view?.file) {
                new Notice(plugin.t.messages.openNote);
                return;
            }

            const content = await plugin.app.vault.read(view.file);

            if (!content.trim()) {
                new Notice(plugin.t.messages.noContent);
                return;
            }

            // Load personas from configuration
            const configService = new ConfigurationService(plugin.app);
            const personas = await configService.getPersonas();
            const defaultPersona = await configService.getDefaultPersona();

            // Show improve note modal with persona selection
            const modal = new ImproveNoteModal(
                plugin.app,
                plugin.t,
                personas,
                defaultPersona,
                async (result) => {
                    if (!result.query.trim()) {
                        return;
                    }

                    // Get selected persona prompt
                    const personaPrompt = result.personaId
                        ? await configService.getPersonaPrompt(result.personaId)
                        : await configService.getPersonaPrompt();

                    await improveNoteWithQuery(plugin, editor, content, result.query, personaPrompt);
                }
            );
            modal.open();
        }
    });

    // Command: Find resources related to note
    plugin.addCommand({
        id: 'find-resources',
        name: plugin.t.commands.findResources || 'Find related resources',
        icon: 'search',
        editorCallback: async (editor: Editor, ctx: MarkdownView | MarkdownFileInfo) => {
            const view = ctx instanceof MarkdownView ? ctx : null;
            if (!view?.file) {
                new Notice(plugin.t.messages.openNote);
                return;
            }

            const content = await plugin.app.vault.read(view.file);

            if (!content.trim()) {
                new Notice(plugin.t.messages.noContent);
                return;
            }

            // Show find resources modal
            const modal = new FindResourcesModal(
                plugin.app,
                plugin.t,
                async (query: string) => {
                    if (!query.trim()) {
                        return;
                    }

                    await findAndShowResources(plugin, content, query);
                }
            );
            modal.open();
        }
    });

    // Command: Generate Mermaid diagram from note
    plugin.addCommand({
        id: 'generate-mermaid-diagram',
        name: plugin.t.commands.generateMermaidDiagram || 'Generate Mermaid diagram',
        icon: 'git-branch',
        editorCallback: async (editor: Editor, ctx: MarkdownView | MarkdownFileInfo) => {
            const view = ctx instanceof MarkdownView ? ctx : null;
            if (!view?.file) {
                new Notice(plugin.t.messages.openNote);
                return;
            }

            const content = await plugin.app.vault.read(view.file);

            if (!content.trim()) {
                new Notice(plugin.t.messages.noContent);
                return;
            }

            // Show diagram options modal
            const modal = new MermaidDiagramModal(
                plugin.app,
                plugin.t,
                async (result: MermaidDiagramResult) => {
                    await generateMermaidDiagram(plugin, editor, content, result);
                }
            );
            modal.open();
        }
    });
}

/**
 * Generate Mermaid diagram from note content
 */
async function generateMermaidDiagram(
    plugin: AIOrganiserPlugin,
    editor: Editor,
    noteContent: string,
    options: MermaidDiagramResult
): Promise<void> {
    const serviceType = plugin.settings.serviceType === 'cloud'
        ? plugin.settings.cloudServiceType
        : 'local';

    // Show privacy notice for cloud providers
    if (isCloudProvider(serviceType) && shouldShowPrivacyNotice(true)) {
        const proceed = await showPrivacyNotice(plugin, serviceType);
        if (!proceed) {
            return;
        }
        markPrivacyNoticeShown();
    }

    new Notice(plugin.t.messages.generatingDiagram || 'Generating diagram...');

    // Build the prompt
    const prompt = buildDiagramPrompt({
        diagramType: options.diagramType,
        instruction: options.instruction,
        noteContent: noteContent
    });

    try {
        let response: { success: boolean; content?: string; error?: string };

        if (plugin.settings.serviceType === 'cloud') {
            const { CloudLLMService } = await import('../services/cloudService');
            const cloudService = plugin.llmService as InstanceType<typeof CloudLLMService>;
            response = await cloudService.summarizeText(prompt);
        } else {
            const { LocalLLMService } = await import('../services/localService');
            const localService = plugin.llmService as InstanceType<typeof LocalLLMService>;
            response = await localService.summarizeText(prompt);
        }

        if (response.success && response.content) {
            // Clean and wrap the output
            const cleanedDiagram = cleanMermaidOutput(response.content);
            const wrappedDiagram = wrapInCodeFence(cleanedDiagram);

            // Insert at cursor position
            const cursor = editor.getCursor();
            editor.replaceRange('\n\n' + wrappedDiagram + '\n\n', cursor);

            new Notice(plugin.t.messages.diagramGenerated || 'Diagram generated successfully');
        } else {
            new Notice(`${plugin.t.messages.diagramGenerationFailed || 'Diagram generation failed'}: ${response.error || 'Unknown error'}`);
        }
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        new Notice(`${plugin.t.messages.diagramGenerationFailed || 'Error'}: ${errorMessage}`);
    }
}

/**
 * Check if content has meaningful text beyond frontmatter and embedded syntax
 */
function hasTextContent(content: string): boolean {
    // Remove frontmatter
    let textContent = content.replace(/^---[\s\S]*?---\n?/, '');

    // Remove embedded syntax
    textContent = textContent.replace(/!\[([^\]]*)\]\([^)]+\)/g, '');
    textContent = textContent.replace(/!\[\[([^\]]+)\]\]/g, '');
    textContent = textContent.replace(/\[([^\]]+)\]\([^)]+\)/g, '');
    textContent = textContent.replace(/\[\[([^\]]+)\]\]/g, '');

    // Remove whitespace and check if anything remains
    textContent = textContent.replace(/\s+/g, '').trim();

    return textContent.length > 50; // At least 50 chars of actual content
}

/**
 * Process selected content items
 */
async function processSelectedContent(
    plugin: AIOrganiserPlugin,
    extractionService: ContentExtractionService,
    editor: Editor,
    file: TFile,
    selectedItems: DetectedContent[],
    existingNoteText: string | null
): Promise<void> {
    const serviceType = plugin.settings.serviceType === 'cloud'
        ? plugin.settings.cloudServiceType
        : 'local';

    // Show privacy notice for cloud providers
    if (isCloudProvider(serviceType) && shouldShowPrivacyNotice(true)) {
        const proceed = await showPrivacyNotice(plugin, serviceType);
        if (!proceed) {
            return;
        }
        markPrivacyNoticeShown();
    }

    // Check if service supports multimodal (for images/PDFs)
    const hasBinaryContent = selectedItems.some(item =>
        item.type === 'image' || item.type === 'pdf'
    );

    if (hasBinaryContent && !serviceSupportsMultimodal(serviceType)) {
        new Notice(
            plugin.t.messages.multimodalNotSupported ||
            'Images and PDFs require Claude or Gemini. Text content will still be processed.'
        );

        // Filter out binary content
        selectedItems = selectedItems.filter(item =>
            item.type !== 'image' && item.type !== 'pdf'
        );

        if (selectedItems.length === 0) {
            new Notice(plugin.t.messages.noTextContent || 'No text-based content to process');
            return;
        }
    }

    // Extract content from selected items
    new Notice(plugin.t.messages.extractingContent || 'Extracting content...');

    const extractionResult = await extractionService.extractContent(
        selectedItems,
        (current, total, item) => {
            new Notice(`${plugin.t.messages.extracting || 'Extracting'} ${current}/${total}: ${item}`);
        }
    );

    // Report errors
    if (extractionResult.errors.length > 0) {
        console.warn('[AI Organiser] Extraction errors:', extractionResult.errors);
        new Notice(`${extractionResult.errors.length} item(s) failed to extract`, 3000);
    }

    const successfulItems = extractionResult.items.filter(i => i.success);
    if (successfulItems.length === 0) {
        new Notice(plugin.t.messages.extractionFailed || 'Failed to extract any content');
        return;
    }

    // Build prompt - get persona from configuration service
    const configService = plugin.configService;
    const personaPrompt = await configService.getSummaryPersonaPrompt(plugin.settings.defaultSummaryPersona);
    const persona = await configService.getSummaryPersonaById(plugin.settings.defaultSummaryPersona)
        || await configService.getDefaultSummaryPersona();

    const promptOptions: SummaryPromptOptions = {
        length: plugin.settings.summaryLength,
        language: getLanguageNameForPrompt(plugin.settings.summaryLanguage),
        personaPrompt: personaPrompt,
    };

    // Check if we have binary content to send
    const binaryItems = extractionService.getBinaryItems(successfulItems);
    const textPrompt = extractionService.buildCombinedPrompt(
        successfulItems,
        existingNoteText,
        persona.prompt
    );

    new Notice(plugin.t.messages.generatingNote || 'Generating note...');

    try {
        let response: { success: boolean; content?: string; error?: string };

        if (binaryItems.length > 0 && serviceSupportsMultimodal(serviceType)) {
            // Use multimodal API for binary content
            const { CloudLLMService } = await import('../services/cloudService');
            const cloudService = plugin.llmService as InstanceType<typeof CloudLLMService>;

            response = await cloudService.analyzeMultipleContent(binaryItems, textPrompt);
        } else {
            // Text-only processing
            if (plugin.settings.serviceType === 'cloud') {
                const { CloudLLMService } = await import('../services/cloudService');
                const cloudService = plugin.llmService as InstanceType<typeof CloudLLMService>;
                response = await cloudService.summarizeText(textPrompt);
            } else {
                const { LocalLLMService } = await import('../services/localService');
                const localService = plugin.llmService as InstanceType<typeof LocalLLMService>;
                response = await localService.summarizeText(textPrompt);
            }
        }

        if (response.success && response.content) {
            insertGeneratedNote(editor, response.content, successfulItems, plugin);
            new Notice(plugin.t.messages.noteGenerated || 'Note generated successfully');
        } else {
            new Notice(`${plugin.t.messages.generationFailed || 'Generation failed'}: ${response.error || 'Unknown error'}`);
        }
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        new Notice(`${plugin.t.messages.generationFailed || 'Error'}: ${errorMessage}`);
    }
}

/**
 * Improve note based on user query
 */
async function improveNoteWithQuery(
    plugin: AIOrganiserPlugin,
    editor: Editor,
    noteContent: string,
    query: string,
    personaPrompt?: string
): Promise<void> {
    const serviceType = plugin.settings.serviceType === 'cloud'
        ? plugin.settings.cloudServiceType
        : 'local';

    // Show privacy notice for cloud providers
    if (isCloudProvider(serviceType) && shouldShowPrivacyNotice(true)) {
        const proceed = await showPrivacyNotice(plugin, serviceType);
        if (!proceed) {
            return;
        }
        markPrivacyNoticeShown();
    }

    new Notice(plugin.t.messages.improvingNote || 'Improving note...');

    // Extract frontmatter if present
    const frontmatterMatch = noteContent.match(/^(---\n[\s\S]*?\n---\n?)/);
    const frontmatter = frontmatterMatch ? frontmatterMatch[1] : '';
    const bodyContent = frontmatter ? noteContent.slice(frontmatter.length) : noteContent;

    const prompt = buildImprovePrompt(bodyContent, query, plugin.settings.summaryLanguage, personaPrompt);

    try {
        let response: { success: boolean; content?: string; error?: string };

        if (plugin.settings.serviceType === 'cloud') {
            const { CloudLLMService } = await import('../services/cloudService');
            const cloudService = plugin.llmService as InstanceType<typeof CloudLLMService>;
            response = await cloudService.summarizeText(prompt);
        } else {
            const { LocalLLMService } = await import('../services/localService');
            const localService = plugin.llmService as InstanceType<typeof LocalLLMService>;
            response = await localService.summarizeText(prompt);
        }

        if (response.success && response.content) {
            // Replace main content while preserving References and Pending Integration sections
            const improvedContent = frontmatter + response.content;
            replaceMainContent(editor, improvedContent);

            // Ensure standard structure exists after improvement
            ensureStandardStructure(editor);

            new Notice(plugin.t.messages.noteImproved || 'Note improved successfully');
        } else {
            new Notice(`${plugin.t.messages.improvementFailed || 'Improvement failed'}: ${response.error || 'Unknown error'}`);
        }
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        new Notice(`${plugin.t.messages.improvementFailed || 'Error'}: ${errorMessage}`);
    }
}

/**
 * Build prompt for note improvement
 */
function buildImprovePrompt(noteContent: string, query: string, language?: string, personaPrompt?: string): string {
    const languageInstruction = language
        ? `Write your response in ${getLanguageNameForPrompt(language)}.`
        : 'Write your response in the same language as the note.';

    // Include persona if provided
    const personaSection = personaPrompt ? `\n${personaPrompt}\n` : '';

    return `<task>
You are helping to improve and enhance a study note based on the user's request. You must return the COMPLETE improved note with your changes integrated into the relevant sections.
</task>
${personaSection}
<current_note>
${noteContent}
</current_note>

<user_request>
${query}
</user_request>

<instructions>
- Return the COMPLETE note with your improvements integrated in the appropriate location(s)
- Do NOT just return the new content - return the entire note with changes woven in
- Place new content in the most relevant section of the note
- If adding an analogy, place it right after the concept it explains
- If expanding a section, integrate the expansion naturally within that section
- If adding examples, place them where they best illustrate the concept
- Maintain the original structure, headings, and formatting of the note
- Keep all existing content unless specifically asked to remove something
- Format your response in markdown
- ${languageInstruction}
- Do NOT include any frontmatter (---) in your response
- Do NOT add explanations before or after the note - just output the improved note content
</instructions>`;
}

/**
 * Find and show resources related to the note
 */
async function findAndShowResources(
    plugin: AIOrganiserPlugin,
    noteContent: string,
    query: string
): Promise<void> {
    const serviceType = plugin.settings.serviceType === 'cloud'
        ? plugin.settings.cloudServiceType
        : 'local';

    // Show privacy notice for cloud providers
    if (isCloudProvider(serviceType) && shouldShowPrivacyNotice(true)) {
        const proceed = await showPrivacyNotice(plugin, serviceType);
        if (!proceed) {
            return;
        }
        markPrivacyNoticeShown();
    }

    new Notice(plugin.t.messages.searchingResources || 'Searching for resources...');

    try {
        // First, ask AI to generate search terms based on the note and query
        const searchTermsPrompt = buildSearchTermsPrompt(noteContent, query);

        let searchTermsResponse: { success: boolean; content?: string; error?: string };

        if (plugin.settings.serviceType === 'cloud') {
            const { CloudLLMService } = await import('../services/cloudService');
            const cloudService = plugin.llmService as InstanceType<typeof CloudLLMService>;
            searchTermsResponse = await cloudService.summarizeText(searchTermsPrompt);
        } else {
            const { LocalLLMService } = await import('../services/localService');
            const localService = plugin.llmService as InstanceType<typeof LocalLLMService>;
            searchTermsResponse = await localService.summarizeText(searchTermsPrompt);
        }

        if (!searchTermsResponse.success || !searchTermsResponse.content) {
            new Notice(plugin.t.messages.searchFailed || 'Failed to generate search terms');
            return;
        }

        // Parse search terms from AI response
        const searchTerms = parseSearchTerms(searchTermsResponse.content);

        if (searchTerms.length === 0) {
            new Notice(plugin.t.messages.noSearchTerms || 'No search terms generated');
            return;
        }

        // Search for resources
        const results = await searchResources(searchTerms, query);

        if (results.length === 0) {
            new Notice(plugin.t.messages.noResourcesFound || 'No resources found');
            return;
        }

        // Show results modal
        const { ResourceResultsModal } = await import('../ui/modals/ResourceResultsModal');
        const modal = new ResourceResultsModal(plugin.app, plugin.t, results);
        modal.open();

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        new Notice(`${plugin.t.messages.searchFailed || 'Search failed'}: ${errorMessage}`);
    }
}

/**
 * Build prompt for generating search terms
 */
function buildSearchTermsPrompt(noteContent: string, query: string): string {
    return `<task>
Based on the note content and user's request, generate 3-5 specific search terms that would help find relevant YouTube videos, articles, or educational resources.
</task>

<note_content>
${noteContent.substring(0, 2000)}
</note_content>

<user_request>
${query}
</user_request>

<instructions>
- Generate 3-5 search terms/phrases
- Make them specific enough to find relevant educational content
- Include variations (e.g., "tutorial", "explained", "introduction")
- Output ONLY the search terms, one per line
- No explanations or additional text
</instructions>

<output_format>
search term 1
search term 2
search term 3
</output_format>`;
}

/**
 * Parse search terms from AI response
 */
function parseSearchTerms(response: string): string[] {
    return response
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0 && line.length < 100)
        .filter(line => !line.startsWith('<') && !line.startsWith('-'))
        .slice(0, 5);
}

/**
 * Show privacy notice modal
 */
async function showPrivacyNotice(plugin: AIOrganiserPlugin, provider: string): Promise<boolean> {
    return new Promise((resolve) => {
        const modal = new PrivacyNoticeModal(plugin.app, plugin.t, provider, (proceed) => {
            resolve(proceed);
        });
        modal.open();
    });
}

/**
 * Insert generated note into editor
 */
function insertGeneratedNote(
    editor: Editor,
    content: string,
    sources: ExtractedContent[],
    plugin: AIOrganiserPlugin
): void {
    const cursor = editor.getCursor();
    let output = '';

    // Add sources section if metadata is enabled
    if (plugin.settings.includeSummaryMetadata && sources.length > 0) {
        output += '\n\n---\n\n### Sources\n\n';
        for (const source of sources) {
            const item = source.source;
            if (item.isExternal) {
                output += `- [${item.displayName}](${item.url})\n`;
            } else {
                output += `- [[${item.url}|${item.displayName}]]\n`;
            }
        }
    }

    // Insert content first, then sources
    const finalOutput = content + output;
    editor.replaceRange(finalOutput, cursor);
}
