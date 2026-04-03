/**
 * Mermaid Chat Prompts
 * System and user prompts for conversational Mermaid diagram editing.
 */

import { getMaxContentCharsForModel } from '../tokenLimits';

export interface MermaidChatPromptOptions {
    currentDiagram: string;    // Current Mermaid code (empty if creating new)
    noteContent: string;       // Note content (truncated to provider token budget)
    userMessage: string;       // User's edit instruction
    conversationHistory: string; // Previous turns formatted as text
    outputLanguage: string;    // For label text in diagrams
    provider: string;          // LLM provider key (for token budget calculation)
    model?: string;            // Optional model name (for model-specific budgets)
    // Phase 4: context enrichment
    siblingDiagrams?: string[];   // Labels extracted from other diagrams in the note
    backlinkContext?: string;      // Titles / headings from backlinked notes
    ragContext?: string;           // Formatted semantic search context chunks
}

/**
 * System prompt establishing the LLM as a Mermaid diagram expert.
 */
export function buildMermaidChatSystemPrompt(options: MermaidChatPromptOptions): string {
    const langInstruction = options.outputLanguage && options.outputLanguage !== 'en'
        ? `Use ${options.outputLanguage} for all node labels, titles, and text within the diagram.`
        : 'Use English for all node labels, titles, and text within the diagram unless the user specifies otherwise.';

    return `You are a Mermaid diagram editor. You receive the current diagram code and a user instruction describing how to change it.

Your rules:
- Output ONLY the complete updated Mermaid code. No explanations, no markdown code fences, no prose.
- Start your response directly with the diagram type keyword (e.g. "flowchart TD", "mindmap", "sequenceDiagram").
- If creating a new diagram, choose the most appropriate type based on the note content and instruction.
- Preserve the existing structure and connections unless the user explicitly asks to change them.
- Keep diagrams readable: aim for 10-30 nodes maximum, use short labels (2-5 words per node).
- Do NOT include \`\`\`mermaid fences or any markdown in your output.
- ${langInstruction}

Supported diagram types and their correct opening keywords:
- flowchart TD / flowchart LR / flowchart BT / flowchart RL
- graph TD / graph LR
- sequenceDiagram
- classDiagram
- stateDiagram-v2
- erDiagram
- gantt
- pie title ...
- mindmap
- timeline
- journey
- quadrantChart
- xychart-beta
- gitGraph
- block-beta`;
}

/**
 * User turn prompt with current diagram + conversation history + edit instruction.
 */
export function buildMermaidChatUserPrompt(options: MermaidChatPromptOptions): string {
    const {
        currentDiagram,
        noteContent,
        userMessage,
        conversationHistory,
        provider,
        model,
    } = options;

    // Dynamic token budget: reserve space for diagram + history + overhead
    const totalBudget = getMaxContentCharsForModel(provider, model);
    const diagramChars = currentDiagram.length;
    const historyChars = conversationHistory.length;
    const overhead = 2000; // XML wrappers + system prompt
    const noteContextBudget = Math.max(0, totalBudget - diagramChars - historyChars - overhead);
    const truncatedNote = noteContent.slice(0, noteContextBudget);

    const diagramSection = currentDiagram.trim()
        ? currentDiagram.trim()
        : 'No existing diagram — create a new one based on the note content and instruction.';

    const historySection = conversationHistory.trim()
        ? `\n<conversation_history>\n${conversationHistory.trim()}\n</conversation_history>\n`
        : '';

    const noteSection = truncatedNote.trim()
        ? `\n<note_context>\n${truncatedNote.trim()}\n</note_context>\n`
        : '';

    // Phase 4: inject related context when available
    const relatedParts: string[] = [];
    if (options.siblingDiagrams && options.siblingDiagrams.length > 0) {
        relatedParts.push(`<sibling_diagram_labels>\n${options.siblingDiagrams.join(', ')}\n</sibling_diagram_labels>`);
    }
    if (options.backlinkContext) {
        relatedParts.push(`<backlink_context>\n${options.backlinkContext.trim()}\n</backlink_context>`);
    }
    if (options.ragContext) {
        relatedParts.push(`<vault_context>\n${options.ragContext.trim()}\n</vault_context>`);
    }
    const relatedSection = relatedParts.length > 0
        ? `\n<related_context>\n${relatedParts.join('\n')}\n</related_context>\n`
        : '';

    return `<current_diagram>
${diagramSection}
</current_diagram>
${noteSection}${relatedSection}${historySection}
<instruction>
${userMessage.trim()}
</instruction>`;
}

/**
 * Format a single conversation turn for inclusion in history.
 */
export function formatConversationTurn(role: 'user' | 'assistant', content: string): string {
    const label = role === 'user' ? 'User' : 'Assistant';
    return `${label}: ${content}`;
}

/**
 * Build an instruction string for converting a diagram to a different type.
 */
export function buildTypeConversionInstruction(
    currentCode: string,
    targetType: string,
    targetLabel: string,
): string {
    const fromType = currentCode.trim().split('\n')[0]?.split(/\s+/)[0]?.trim() ?? 'diagram';
    return `Convert this ${fromType} to a ${targetLabel} (${targetType}) diagram. Preserve all concepts, entities, relationships, and data from the original. Adapt the structure and syntax to fit ${targetLabel} conventions.`;
}

/**
 * Build a prompt to generate concise alt-text for an exported diagram image.
 * Used by MermaidExportService when mermaidChatGenerateAltText is enabled.
 */
export function buildDiagramAltTextPrompt(mermaidCode: string, outputLanguage?: string): string {
    const langInstruction = outputLanguage && outputLanguage !== 'en' && outputLanguage !== 'default'
        ? `Write the alt text in ${outputLanguage}.`
        : 'Write the alt text in English.';
    return `You are an accessibility expert. Write a single concise alt-text description (max 150 characters) for the following Mermaid diagram so that a screen-reader user understands its purpose and key relationships. Output ONLY the alt text — no quotes, no labels, no explanation.

${langInstruction}

\`\`\`mermaid
${mermaidCode.trim()}
\`\`\``;
}
