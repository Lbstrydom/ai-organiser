/**
 * Pure utility functions for chat conversation history and export formatting.
 * Shared between UnifiedChatModal and tests.
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
export function formatExportMarkdown(messages: ChatExportMessage[], title?: string): string {
    const nonSystemMessages = messages.filter(m => m.role !== 'system');
    const now = new Date();
    const dateLabel = now.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
    const heading = title || `Chat — ${dateLabel}`;
    const lines: string[] = [`# ${heading}\n`];

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

// === Chat Persistence Types & Helpers ===

export interface ConversationState {
    version: 1;
    mode: import('../ui/chat/ChatModeHandler').ChatMode;
    messages: ChatExportMessage[];
    compactionSummary: string;
    projectId?: string;
    /** Direct path to project folder (e.g. AI-Organiser/AI Chat/Projects/my-project) */
    projectFolderPath?: string;
    freeState?: SerializableFreeChatState;
    createdAt: string;
    /** ISO timestamp of last save — preferred over lastActiveAt */
    updatedAt?: string;
    lastActiveAt?: string;
}

export interface ConversationSummary {
    filePath: string;
    title: string;
    mode: import('../ui/chat/ChatModeHandler').ChatMode;
    messageCount: number;
    projectId?: string;
    createdAt?: string;
    updatedAt: string;
    lastActiveAt?: string;
}

export interface SerializableAttachment {
    path: string;
    name: string;
    mtime: number;
    included: boolean;
}

export interface SerializableFreeChatState {
    uiState: 'chat';
    selectedModel: string;
    brandEnabled: boolean;
    approvedOutline: string | null;
    attachments: SerializableAttachment[];
}

const CHAT_STATE_MARKER = '<!-- chat-state-b64:';
const CHAT_STATE_END = ' -->';

function utf8ToBase64(str: string): string {
    const bytes = new TextEncoder().encode(str);
    const binary = Array.from(bytes, b => String.fromCodePoint(b)).join('');
    return btoa(binary);
}

function base64ToUtf8(b64: string): string {
    const binary = atob(b64);
    const bytes = Uint8Array.from(binary, c => c.codePointAt(0) ?? 0);
    return new TextDecoder().decode(bytes);
}

export function serializeConversationNote(state: ConversationState): string {
    const messages = state.messages.filter(m => m.role !== 'system');
    const frontmatter = [
        '---', 'tags:', '  - ai-chat', `  - ai-chat/${state.mode}`,
        `created: ${state.createdAt}`, `chat_mode: ${state.mode}`,
    ];
    if (state.projectId) frontmatter.push(`project_id: "${state.projectId}"`, '---', '');
    else frontmatter.push('---', '');

    const firstUserMsg = messages.find(m => m.role === 'user');
    const title = firstUserMsg
        ? firstUserMsg.content.slice(0, 80).replaceAll('\n', ' ')
        : `Chat — ${state.createdAt.slice(0, 10)}`;

    const lines = [...frontmatter, `# ${title}`, ''];

    for (const msg of messages) {
        const dt = new Date(msg.timestamp);
        const time = `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
        const label = msg.role === 'user' ? '**You**' : '**Assistant**';
        lines.push(`${label} (${time}):`, '', msg.content, '', '---', '');
    }

    const json = JSON.stringify(state);
    lines.push(`${CHAT_STATE_MARKER}${utf8ToBase64(json)}${CHAT_STATE_END}`);
    return lines.join('\n');
}

export function extractConversationState(content: string): ConversationState | null {
    const startIdx = content.indexOf(CHAT_STATE_MARKER);
    if (startIdx === -1) return null;
    const b64Start = startIdx + CHAT_STATE_MARKER.length;
    const endIdx = content.indexOf(CHAT_STATE_END, b64Start);
    if (endIdx === -1) return null;
    try {
        const b64 = content.substring(b64Start, endIdx).trim();
        return JSON.parse(base64ToUtf8(b64)) as ConversationState;
    } catch { return null; }
}
