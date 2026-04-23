/**
 * Smart Note Commands
 * Commands for generating and improving notes from embedded multimedia content
 */

import { Editor, MarkdownView, Notice } from 'obsidian';
import type AIOrganiserPlugin from '../main';
import { getLanguageNameForPrompt } from '../services/languages';
import { ensurePrivacyConsent } from '../services/privacyNotice';
// BUILTIN_PERSONAS no longer imported - using configurationService for summary personas
import { ImproveNoteModal, ImproveNotePlacement } from '../ui/modals/ImproveNoteModal';
import { ImprovePreviewModal, ImprovePreviewAction } from '../ui/modals/ImprovePreviewModal';
import { showReviewOrApply } from '../utils/reviewEditsHelper';
import { FindResourcesModal } from '../ui/modals/FindResourcesModal';
import { searchResources } from '../services/resourceSearchService';
import { replaceMainContent, ensureNoteStructureIfEnabled, stripTrailingSections } from '../utils/noteStructure';
import { insertAtCursor } from '../utils/editorUtils';
import { getAvailableFilePath } from '../utils/minutesUtils';
import { MermaidDiagramModal, MermaidDiagramResult } from '../ui/modals/MermaidDiagramModal';
import { MermaidChatModal } from '../ui/modals/MermaidChatModal';
import { MermaidBlockPickerModal } from '../ui/modals/MermaidBlockPickerModal';
import { buildDiagramPrompt, cleanMermaidOutput, wrapInCodeFence } from '../services/prompts/diagramPrompts';
import { findAllMermaidBlocks } from '../utils/mermaidUtils';
import { EnhanceNoteModal, EnhanceAction } from '../ui/modals/EnhanceNoteModal';
import { exportFlashcards } from './flashcardCommands';
import { SEARCH_TERM_SNIPPET_CHARS } from '../core/constants';
import { getServiceType, summarizeText, pluginContext } from '../services/llmFacade';
import { withBusyIndicator } from '../utils/busyIndicator';
import { withProgress } from '../services/progress';



export function registerSmartNoteCommands(plugin: AIOrganiserPlugin): void {

    // Command: Enhance note (action menu)
    plugin.addCommand({
        id: 'enhance-note',
        name: plugin.t.commands.enhance || 'Enhance',
        icon: 'sparkles',
        callback: () => openEnhanceModal(plugin)
    });

    // Command: Edit Mermaid Diagram (conversational chat)
    // Uses callback (not editorCallback) so it works from CommandPickerModal via executeCommandById
    plugin.addCommand({
        id: 'edit-mermaid-diagram',
        name: plugin.t.commands.editMermaidDiagram,
        icon: 'git-branch',
        callback: () => executeEditMermaidDiagram(plugin)
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
            onClick: () => exportFlashcards(plugin)
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

    // Check content exists (read from editor buffer, not disk)
    const currentContent = view.editor.getValue();
    if (!currentContent.trim()) {
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
            // Read from editor buffer inside callback to capture latest edits
            const content = view.editor.getValue();

            const personaPrompt = result.personaId
                ? await configService.getPersonaPrompt(result.personaId)
                : await configService.getPersonaPrompt();

            await improveNoteWithQuery(plugin, view, content, result.query, personaPrompt, result.placement);
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
 * Open MermaidChatModal to edit (or create) a Mermaid diagram
 */
function executeEditMermaidDiagram(plugin: AIOrganiserPlugin): void {
    const view = getActiveMarkdownView(plugin);
    if (!view?.file) {
        new Notice(plugin.t.messages.openNote);
        return;
    }

    const editor = view.editor;
    const content = editor.getValue();
    const cursorLine = editor.getCursor().line;

    const allBlocks = findAllMermaidBlocks(content);

    // If cursor is inside a block, use that one directly
    const blockAtCursor = allBlocks.find(b => cursorLine > b.startLine && cursorLine < b.endLine);
    if (blockAtCursor) {
        new MermaidChatModal(plugin, editor, blockAtCursor).open();
        return;
    }

    // Multiple blocks and cursor not inside any — let the user pick
    if (allBlocks.length > 1) {
        new MermaidBlockPickerModal(
            plugin.app,
            allBlocks,
            (block) => new MermaidChatModal(plugin, editor, block).open(),
            plugin.t.modals.mermaidChat.selectDiagram,
        ).open();
        return;
    }

    // Single block or no blocks — open with closest or null
    new MermaidChatModal(plugin, editor, allBlocks[0] ?? null).open();
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
    const { provider: serviceType } = getServiceType(pluginContext(plugin));

    // Privacy notice gating (centralized)
    {
        const proceed = await ensurePrivacyConsent(plugin, serviceType);
        if (!proceed) return;
    }

    // Build the prompt
    const prompt = buildDiagramPrompt({
        diagramType: options.diagramType,
        instruction: options.instruction,
        noteContent: noteContent
    });

    type DiagramPhase = 'diagramming' | 'validating';
    const t = plugin.t;
    const r = await withProgress<string | null, DiagramPhase>(
        {
            plugin,
            initialPhase: { key: 'diagramming' },
            resolvePhase: (p) => t.progress.smartNote[p.key],
        },
        async (reporter) => {
            const response = await summarizeText(pluginContext(plugin), prompt);
            if (!response.success || !response.content) {
                throw new Error(response.error || t.messages.unknownError);
            }
            reporter.setPhase({ key: 'validating' });
            return response.content;
        },
    );
    if (!r.ok) return; // reporter showed the toast

    const cleanedDiagram = cleanMermaidOutput(r.value!);
    const wrappedDiagram = wrapInCodeFence(cleanedDiagram);
    const cursor = editor.getCursor();
    editor.replaceRange('\n\n' + wrappedDiagram + '\n\n', cursor);
    ensureNoteStructureIfEnabled(editor, plugin.settings);
    new Notice(t.messages.diagramGenerated, 3000);
}

/**
 * Improve note based on user query
 */
async function improveNoteWithQuery(
    plugin: AIOrganiserPlugin,
    view: MarkdownView,
    noteContent: string,
    query: string,
    personaPrompt?: string,
    placement: ImproveNotePlacement = 'replace'
): Promise<void> {
    const editor = view.editor;
    const { provider: serviceType } = getServiceType(pluginContext(plugin));

    // Privacy notice gating (centralized)
    {
        const proceed = await ensurePrivacyConsent(plugin, serviceType);
        if (!proceed) return;
    }

    // Extract frontmatter if present
    const frontmatterMatch = noteContent.match(/^(---\n[\s\S]*?\n---\n?)/);
    const frontmatter = frontmatterMatch ? frontmatterMatch[1] : '';
    const bodyContent = frontmatter ? noteContent.slice(frontmatter.length) : noteContent;

    // Strip References/Pending sections before sending to LLM to prevent duplication
    const strippedBody = stripTrailingSections(bodyContent);

    const prompt = buildImprovePrompt(strippedBody, query, plugin.settings.summaryLanguage, personaPrompt, placement);

    type ImprovePhase = 'improving' | 'validating';
    const t = plugin.t;
    const r = await withProgress<string, ImprovePhase>(
        {
            plugin,
            initialPhase: { key: 'improving' },
            resolvePhase: (p) => t.progress.smartNote[p.key],
        },
        async (reporter) => {
            const response = await summarizeText(pluginContext(plugin), prompt);
            if (!response.success || !response.content) {
                throw new Error(response.error || t.messages.unknownError);
            }
            reporter.setPhase({ key: 'validating' });
            return response.content;
        },
    );
    if (!r.ok) return; // reporter showed the toast

    const content = r.value;

    if (plugin.settings.enableReviewedEdits && placement === 'replace') {
        await showReviewOrApply(
            plugin,
            strippedBody,
            content,
            () => applyImprovement(plugin, view, editor, content, frontmatter, placement),
        );
    } else {
        await new Promise<void>((resolve) => {
            const previewModal = new ImprovePreviewModal(
                plugin.app,
                plugin,
                content,
                placement,
                (action: ImprovePreviewAction) => { void (async () => {
                    if (action === 'confirm') {
                        await applyImprovement(plugin, view, editor, content, frontmatter, placement);
                    } else if (action === 'copy') {
                        await navigator.clipboard.writeText(content);
                        new Notice(plugin.t.messages.copiedToClipboard || 'Copied to clipboard', 3000);
                    }
                    resolve();
                })(); },
            );
            previewModal.open();
        });
    }
}

/**
 * Apply the improved content based on the chosen placement strategy
 */
async function applyImprovement(
    plugin: AIOrganiserPlugin,
    view: MarkdownView,
    editor: Editor,
    content: string,
    frontmatter: string,
    placement: ImproveNotePlacement
): Promise<void> {
    switch (placement) {
        case 'replace': {
            const improvedContent = frontmatter + content;
            replaceMainContent(editor, improvedContent);
            ensureNoteStructureIfEnabled(editor, plugin.settings);
            new Notice(plugin.t.messages.noteImproved, 3000);
            break;
        }
        case 'cursor': {
            insertAtCursor(editor, content);
            ensureNoteStructureIfEnabled(editor, plugin.settings);
            new Notice(plugin.t.messages.noteImproved, 3000);
            break;
        }
        case 'new-note': {
            const file = view.file;
            const folder = file?.parent?.path || '';
            const baseName = file?.basename || 'Note';
            const fileName = `${baseName} (improved).md`;
            const safePath = await getAvailableFilePath(plugin.app.vault, folder, fileName);
            const newContent = frontmatter + content;
            const newFile = await plugin.app.vault.create(safePath, newContent);
            await plugin.app.workspace.getLeaf(true).openFile(newFile);
            new Notice(plugin.t.messages.noteImproved, 3000);
            break;
        }
    }
}

/**
 * Build prompt for note improvement
 */
function buildImprovePrompt(
    noteContent: string,
    query: string,
    language?: string,
    personaPrompt?: string,
    placement: ImproveNotePlacement = 'replace'
): string {
    const languageInstruction = language
        ? `Write your response in ${getLanguageNameForPrompt(language)}.`
        : 'Write your response in the same language as the note.';

    // Include persona if provided
    const personaSection = personaPrompt ? `\n${personaPrompt}\n` : '';

    // Placement-specific return instructions
    const returnInstruction = placement === 'cursor'
        ? '- Return ONLY the new or improved content to be inserted — do NOT return the entire note'
        : '- Return the COMPLETE note with your improvements integrated in the appropriate location(s)';

    const fullNoteInstructions = placement === 'cursor'
        ? ''
        : `
- Do NOT just return the new content - return the entire note with changes woven in`;

    return `<task>
You are helping to improve and enhance a study note based on the user's request.${placement === 'cursor' ? '' : ' You must return the COMPLETE improved note with your changes integrated into the relevant sections.'}
</task>
${personaSection}
<current_note>
${noteContent}
</current_note>

<user_request>
${query}
</user_request>

<instructions>
${returnInstruction}${fullNoteInstructions}
- Place new content in the most relevant section of the note
- If adding an analogy, place it right after the concept it explains
- If expanding a section, integrate the expansion naturally within that section
- If adding examples, place them where they best illustrate the concept
- Maintain the original structure, headings, and formatting of the note
- Keep all existing content unless specifically asked to remove something
- Format your response in markdown
- ${languageInstruction}
- Do NOT include any frontmatter (---) in your response
- Do NOT include References or Pending Integration sections in your response
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
    const { provider: serviceType } = getServiceType(pluginContext(plugin));

    // Privacy notice gating (centralized)
    {
        const proceed = await ensurePrivacyConsent(plugin, serviceType);
        if (!proceed) return;
    }

    new Notice(plugin.t.messages.searchingResources || 'Searching for resources...');

    try {
        // First, ask AI to generate search terms based on the note and query
        const searchTermsPrompt = buildSearchTermsPrompt(noteContent, query);

        const searchTermsResponse = await withBusyIndicator(plugin, () => summarizeText(pluginContext(plugin), searchTermsPrompt));

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

