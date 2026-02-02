/**
 * Pure utility functions for chat conversation history and export formatting.
 * Shared between ChatWithVaultModal and tests.
 */

export const MAX_HISTORY_MESSAGES = 20;
export const MAX_HISTORY_CHARS = 8000;

export interface ChatExportMessage {
    role: 'user' | 'assistant' | 'system';
    content: string;
    timestamp: number;
    sources?: string[];
}

/**
 * Format conversation history for LLM context injection.
 * Excludes system messages and the just-added user query (last message).
 */
export function formatConversationHistory(messages: ChatExportMessage[]): string {
    const relevant = messages
        .filter(m => m.role !== 'system')
        .slice(0, -1)                    // exclude the just-added user query
        .slice(-MAX_HISTORY_MESSAGES);
    if (relevant.length === 0) return '';
    let history = relevant
        .map(m => `${m.role.toUpperCase()}: ${m.content}`)
        .join('\n');
    if (history.length > MAX_HISTORY_CHARS) {
        history = '...' + history.slice(history.length - MAX_HISTORY_CHARS);
    }
    return history;
}

/**
 * Format chat messages as markdown for file export.
 * Excludes system messages, adds timestamps and wikilink sources.
 */
export function formatExportMarkdown(messages: ChatExportMessage[]): string {
    const nonSystemMessages = messages.filter(m => m.role !== 'system');
    const now = new Date();
    const dateLabel = now.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
    const lines: string[] = [`# Chat with Vault — ${dateLabel}\n`];

    for (const msg of nonSystemMessages) {
        const time = new Date(msg.timestamp).toLocaleTimeString();
        const roleLabel = msg.role === 'user' ? '**You**' : '**Assistant**';
        lines.push(`${roleLabel} (${time}):\n`);
        lines.push(msg.content);

        if (msg.sources && msg.sources.length > 0) {
            lines.push('\nSources: ' + msg.sources.map(s => `[[${s}]]`).join(', '));
        }

        lines.push('\n---\n');
    }

    return lines.join('\n');
}
