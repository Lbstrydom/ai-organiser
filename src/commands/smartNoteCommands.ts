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
import { ensurePrivacyConsent } from '../services/privacyNotice';
// BUILTIN_PERSONAS no longer imported - using configurationService for summary personas
import { ImproveNoteModal } from '../ui/modals/ImproveNoteModal';
import { FindResourcesModal } from '../ui/modals/FindResourcesModal';
import { searchResources } from '../services/resourceSearchService';
import { replaceMainContent, ensureNoteStructureIfEnabled } from '../utils/noteStructure';
import { MermaidDiagramModal, MermaidDiagramResult } from '../ui/modals/MermaidDiagramModal';
import { buildDiagramPrompt, cleanMermaidOutput, wrapInCodeFence } from '../services/prompts/diagramPrompts';
import { EnhanceNoteModal, EnhanceAction } from '../ui/modals/EnhanceNoteModal';
import { exportFlashcardsFromCurrentNote } from './flashcardCommands';
import { MIN_TEXT_CONTENT_CHARS, SEARCH_TERM_SNIPPET_CHARS } from '../core/constants';
import { analyzeMultipleContent, getServiceType, summarizeText } from '../services/llmFacade';
import { showErrorNotice, showSuccessNotice } from '../utils/executeWithNotice';

/**
 * Get Gemini API key for YouTube processing
 * Checks dedicated YouTube key first, then falls back to main Gemini key
 */
function getYouTubeGeminiApiKey(plugin: AIOrganiserPlugin): string | null {
    if (plugin.settings.youtubeGeminiApiKey) {
        return plugin.settings.youtubeGeminiApiKey;
    }
    if (plugin.settings.cloudServiceType === 'gemini' && plugin.settings.cloudApiKey) {
        return plugin.settings.cloudApiKey;
    }
    if (plugin.settings.providerSettings?.gemini?.apiKey) {
        return plugin.settings.providerSettings.gemini.apiKey;
    }
    return null;
}

export function registerSmartNoteCommands(plugin: AIOrganiserPlugin): void {
    // Get Gemini config for YouTube transcription if available
    const geminiApiKey = getYouTubeGeminiApiKey(plugin);
    const youtubeGeminiConfig = geminiApiKey ? {
        apiKey: geminiApiKey,
        model: plugin.settings.youtubeGeminiModel,
        timeoutMs: plugin.settings.summarizeTimeoutSeconds * 1000
    } : undefined;

    const extractionService = new ContentExtractionService(plugin.app, youtubeGeminiConfig);

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

    // Command: Enhance note (action menu)
    plugin.addCommand({
        id: 'enhance-note',
        name: plugin.t.commands.enhance || 'Enhance',
        icon: 'sparkles',
        callback: () => openEnhanceModal(plugin)
    });
}

function openEnhanceModal(plugin: AIOrganiserPlugin): void {
    const actions: EnhanceAction[] = [
        {
            id: 'improve',
            icon: 'wand-2',
            label: plugin.t.modals.enhance.improve,
            description: plugin.t.modals.enhance.improveDesc,
            onClick: () => executeImproveNote(plugin)
        },
        {
            id: 'diagram',
            icon: 'git-branch',
            label: plugin.t.modals.enhance.diagram,
            description: plugin.t.modals.enhance.diagramDesc,
            onClick: () => executeGenerateMermaidDiagram(plugin)
        },
        {
            id: 'resources',
            icon: 'search',
            label: plugin.t.modals.enhance.resources,
            description: plugin.t.modals.enhance.resourcesDesc,
            onClick: () => executeFindResources(plugin)
        },
        {
            id: 'flashcards',
            icon: 'layers',
            label: plugin.t.modals.enhance.flashcards,
            description: plugin.t.modals.enhance.flashcardsDesc,
            onClick: () => exportFlashcardsFromCurrentNote(plugin)
        }
    ];

    new EnhanceNoteModal(plugin.app, plugin, actions).open();
}

function getActiveMarkdownView(plugin: AIOrganiserPlugin): MarkdownView | null {
    return plugin.app.workspace.getActiveViewOfType(MarkdownView);
}

async function executeImproveNote(plugin: AIOrganiserPlugin): Promise<void> {
    const view = getActiveMarkdownView(plugin);
    if (!view?.file) {
        new Notice(plugin.t.messages.openNote);
        return;
    }

    const content = await plugin.app.vault.read(view.file);
    if (!content.trim()) {
        new Notice(plugin.t.messages.noContent);
        return;
    }

    const configService = plugin.configService;
    const personas = await configService.getPersonas();
    const defaultPersona = await configService.getDefaultPersona();

    const modal = new ImproveNoteModal(
        plugin.app,
        plugin.t,
        personas,
        defaultPersona,
        async (result) => {
            if (!result.query.trim()) {
                return;
            }

            const personaPrompt = result.personaId
                ? await configService.getPersonaPrompt(result.personaId)
                : await configService.getPersonaPrompt();

            await improveNoteWithQuery(plugin, view.editor, content, result.query, personaPrompt);
        }
    );
    modal.open();
}

async function executeFindResources(plugin: AIOrganiserPlugin): Promise<void> {
    const view = getActiveMarkdownView(plugin);
    if (!view?.file) {
        new Notice(plugin.t.messages.openNote);
        return;
    }

    const content = await plugin.app.vault.read(view.file);
    if (!content.trim()) {
        new Notice(plugin.t.messages.noContent);
        return;
    }

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
    ensureNoteStructureIfEnabled(view.editor, plugin.settings);
}

async function executeGenerateMermaidDiagram(plugin: AIOrganiserPlugin): Promise<void> {
    const view = getActiveMarkdownView(plugin);
    if (!view?.file) {
        new Notice(plugin.t.messages.openNote);
        return;
    }

    const content = await plugin.app.vault.read(view.file);
    if (!content.trim()) {
        new Notice(plugin.t.messages.noContent);
        return;
    }

    const modal = new MermaidDiagramModal(
        plugin.app,
        plugin.t,
        async (result: MermaidDiagramResult) => {
            await generateMermaidDiagram(plugin, view.editor, content, result);
        }
    );
    modal.open();
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
    const { provider: serviceType } = getServiceType({ llmService: plugin.llmService, settings: plugin.settings });

    // Privacy notice gating (centralized)
    {
        const proceed = await ensurePrivacyConsent(plugin, serviceType);
        if (!proceed) return;
    }

    new Notice(plugin.t.messages.generatingDiagram || 'Generating diagram...');

    // Build the prompt
    const prompt = buildDiagramPrompt({
        diagramType: options.diagramType,
        instruction: options.instruction,
        noteContent: noteContent
    });

    try {
        const response = await summarizeText({ llmService: plugin.llmService, settings: plugin.settings }, prompt);

        if (response.success && response.content) {
            // Clean and wrap the output
            const cleanedDiagram = cleanMermaidOutput(response.content);
            const wrappedDiagram = wrapInCodeFence(cleanedDiagram);

            // Insert at cursor position
            const cursor = editor.getCursor();
            editor.replaceRange('\n\n' + wrappedDiagram + '\n\n', cursor);
            ensureNoteStructureIfEnabled(editor, plugin.settings);

            new Notice(plugin.t.messages.diagramGenerated || 'Diagram generated successfully');
        } else {
            showErrorNotice(response.error || 'Unknown error', 'Diagram generation');
        }
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        showErrorNotice(errorMessage, 'Diagram generation');
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

    return textContent.length > MIN_TEXT_CONTENT_CHARS; // At least some actual content
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
    const { provider: serviceType } = getServiceType({ llmService: plugin.llmService, settings: plugin.settings });

    // Privacy notice gating (centralized)
    {
        const proceed = await ensurePrivacyConsent(plugin, serviceType);
        if (!proceed) return;
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
        const response = binaryItems.length > 0 && serviceSupportsMultimodal(serviceType)
            ? await analyzeMultipleContent({ llmService: plugin.llmService, settings: plugin.settings }, binaryItems, textPrompt)
            : await summarizeText({ llmService: plugin.llmService, settings: plugin.settings }, textPrompt);

        if (response.success && response.content) {
            insertGeneratedNote(editor, response.content, successfulItems, plugin);
            showSuccessNotice('Note generated successfully', 'Generation');
        } else {
            showErrorNotice(response.error || 'Unknown error', 'Note generation');
        }
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        showErrorNotice(errorMessage, 'Note generation');
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
    const { provider: serviceType } = getServiceType({ llmService: plugin.llmService, settings: plugin.settings });

    // Privacy notice gating (centralized)
    {
        const proceed = await ensurePrivacyConsent(plugin, serviceType);
        if (!proceed) return;
    }

    new Notice(plugin.t.messages.improvingNote || 'Improving note...');

    // Extract frontmatter if present
    const frontmatterMatch = noteContent.match(/^(---\n[\s\S]*?\n---\n?)/);
    const frontmatter = frontmatterMatch ? frontmatterMatch[1] : '';
    const bodyContent = frontmatter ? noteContent.slice(frontmatter.length) : noteContent;

    const prompt = buildImprovePrompt(bodyContent, query, plugin.settings.summaryLanguage, personaPrompt);

    try {
        const response = await summarizeText({ llmService: plugin.llmService, settings: plugin.settings }, prompt);

        if (response.success && response.content) {
            // Replace main content while preserving References and Pending Integration sections
            const improvedContent = frontmatter + response.content;
            replaceMainContent(editor, improvedContent);

            // Ensure standard structure exists after improvement
            ensureNoteStructureIfEnabled(editor, plugin.settings);

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
    const { provider: serviceType } = getServiceType({ llmService: plugin.llmService, settings: plugin.settings });

    // Privacy notice gating (centralized)
    {
        const proceed = await ensurePrivacyConsent(plugin, serviceType);
        if (!proceed) return;
    }

    new Notice(plugin.t.messages.searchingResources || 'Searching for resources...');

    try {
        // First, ask AI to generate search terms based on the note and query
        const searchTermsPrompt = buildSearchTermsPrompt(noteContent, query);

        const searchTermsResponse = await summarizeText({ llmService: plugin.llmService, settings: plugin.settings }, searchTermsPrompt);

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
${noteContent.substring(0, SEARCH_TERM_SNIPPET_CHARS)}
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

// Privacy notice gating is centralized via ensurePrivacyConsent()

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
    ensureNoteStructureIfEnabled(editor, plugin.settings);
}
