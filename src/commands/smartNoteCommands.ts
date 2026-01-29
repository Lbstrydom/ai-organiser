/**
 * Smart Note Commands
 * Commands for generating and improving notes from embedded multimedia content
 */

import { Editor, MarkdownView, Notice } from 'obsidian';
import type AIOrganiserPlugin from '../main';
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
import { SEARCH_TERM_SNIPPET_CHARS } from '../core/constants';
import { getServiceType, summarizeText } from '../services/llmFacade';



export function registerSmartNoteCommands(plugin: AIOrganiserPlugin): void {

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

            new Notice(plugin.t.messages.diagramGenerated, 3000);
        } else {
            new Notice(`${plugin.t.messages.diagramGenerationFailed}: ${response.error || plugin.t.messages.unknownError}`, 5000);
        }
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : plugin.t.messages.unknownError;
        new Notice(`${plugin.t.messages.diagramGenerationFailed}: ${errorMessage}`, 5000);
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

    new Notice(plugin.t.messages.improvingNote);

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

            new Notice(plugin.t.messages.noteImproved, 3000);
        } else {
            new Notice(`${plugin.t.messages.improvementFailed}: ${response.error || plugin.t.messages.unknownError}`, 5000);
        }
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : plugin.t.messages.unknownError;
        new Notice(`${plugin.t.messages.improvementFailed}: ${errorMessage}`, 5000);
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

