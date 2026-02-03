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
