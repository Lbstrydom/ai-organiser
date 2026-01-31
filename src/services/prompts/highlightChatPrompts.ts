export interface HighlightChatMessage {
    role: 'user' | 'assistant';
    content: string;
}

export function buildHighlightChatPrompt(
    question: string,
    selectedPassages: string[],
    noteTitle: string,
    conversationHistory: HighlightChatMessage[]
): string {
    const passages = selectedPassages
        .map((text, index) => `Passage ${index + 1}:\n${text}`)
        .join('\n\n');

    const history = conversationHistory.length > 0
        ? conversationHistory.map(message => `${message.role.toUpperCase()}: ${message.content}`).join('\n')
        : 'None';

    return `<task>
You are helping the user understand specific passages from their note "${noteTitle}".
Answer based primarily on the highlighted passages below.
Reference broader context when relevant, but keep focus on the highlighted content.
</task>

<highlighted_passages>
${passages}
</highlighted_passages>

<conversation_history>
${history}
</conversation_history>

<question>
${question}
</question>`;
}

export function buildInsertSummaryPrompt(
    selectedPassages: string[],
    conversationHistory: HighlightChatMessage[],
    noteTitle: string
): string {
    const passages = selectedPassages
        .map((text, index) => `Passage ${index + 1}:\n${text}`)
        .join('\n\n');

    const history = conversationHistory.length > 0
        ? conversationHistory.map(message => `${message.role.toUpperCase()}: ${message.content}`).join('\n')
        : 'None';

    return `<task>
Based on the conversation about passages from "${noteTitle}",
write a concise, well-structured section suitable for inserting into the note.

CRITICAL: Write as standalone prose. Do NOT reference "Passage 1", "the highlighted text",
or any positional references. The reader has no knowledge of the conversation or passage numbering.
Use markdown formatting. Be concise.
</task>

<highlighted_passages>
${passages}
</highlighted_passages>

<conversation_history>
${history}
</conversation_history>`;
}

export function buildInsertAnswerPrompt(
    lastQuestion: string,
    lastAnswer: string,
    selectedPassages: string[],
    noteTitle: string
): string {
    const passages = selectedPassages
        .map((text, index) => `Passage ${index + 1}:\n${text}`)
        .join('\n\n');

    return `<task>
Rewrite the assistant's last answer into a clean, insertable note section for "${noteTitle}".

CRITICAL: Write as standalone prose. Do NOT reference "Passage 1", "the highlighted text",
or any positional references. The reader has no knowledge of the conversation or passage numbering.
Use markdown formatting. Be concise.
</task>

<highlighted_passages>
${passages}
</highlighted_passages>

<last_question>
${lastQuestion}
</last_question>

<last_answer>
${lastAnswer}
</last_answer>`;
}
