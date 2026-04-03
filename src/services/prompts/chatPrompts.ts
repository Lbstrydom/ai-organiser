const NOTE_CONTENT_LIMIT = 8000;

export function buildNoteChatPrompt(
    question: string,
    noteContent: string,
    noteTitle: string,
    conversationHistory: string
): string {
    const trimmed = noteContent.slice(0, NOTE_CONTENT_LIMIT);
    const historySection = conversationHistory
        ? `\n<conversation_history>\n${conversationHistory}\n</conversation_history>\n`
        : '';

    return `<task>
You are helping the user understand their note "${noteTitle}".
Answer based on the note content below. If the note is missing information, say so.
</task>

<note_title>
${noteTitle}
</note_title>

<note_content>
${trimmed}
</note_content>
${historySection}
<question>
${question}
</question>`;
}

export function buildVaultFallbackPrompt(
    question: string,
    conversationHistory: string
): string {
    const historySection = conversationHistory
        ? `\n<conversation_history>\n${conversationHistory}\n</conversation_history>\n`
        : '';

    return `<task>
You are a helpful assistant. The user has a personal knowledge vault, but no matching content was found.
Answer from your general knowledge while being clear about any uncertainty.
</task>
${historySection}
<question>
${question}
</question>`;
}

export function buildChatFileNamePrompt(firstUserMessage: string, mode: string, noteTitle?: string): string {
    const context = noteTitle ? `Chat about "${noteTitle}" (${mode} mode).` : `Chat (${mode} mode).`;
    return `<task>Generate a short file name for a saved chat conversation.</task>
<context>${context} First user message: ${firstUserMessage.slice(0, 200)}</context>
<requirements>
- 2-5 words, kebab-case (lowercase with hyphens)
- Descriptive of the chat topic
- No dates, no special characters
- Return ONLY the file name
</requirements>
<example>wine-award-analysis</example>`;
}

export function buildCompactionPrompt(existingSummaryBlock: string, conversationBlock: string): string {
    return `<task>
Summarise the following conversation history into a concise context briefing.
</task>
${existingSummaryBlock}
<conversation>
${conversationBlock}
</conversation>

<requirements>
- Capture: topics discussed, decisions made, user preferences, any pending questions or tasks
- Be factual and specific — include names, numbers, file paths, and concrete details
- Preserve any instructions the user gave about how they want responses formatted
- Keep under 500 words
- Do NOT add interpretation, suggestions, or commentary
- Write in third person ("The user asked about..." / "The assistant explained...")
- If an existing_summary is provided, merge its content with the new conversation into a single unified summary
</requirements>
<output_format>
A structured briefing with these sections (omit empty sections):

TOPICS: What was discussed
DECISIONS: What was decided or agreed
PREFERENCES: How the user wants things done
PENDING: Open questions or next steps
</output_format>`;
}
