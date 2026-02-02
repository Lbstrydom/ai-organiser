/**
 * Tests for chat conversation history formatting and export markdown generation.
 *
 * These test the production pure logic from chatExportUtils.ts — the same
 * functions used by ChatWithVaultModal.
 */

import {
    formatConversationHistory,
    formatExportMarkdown,
    MAX_HISTORY_MESSAGES,
    MAX_HISTORY_CHARS,
    ChatExportMessage
} from '../src/utils/chatExportUtils';

function msg(role: ChatExportMessage['role'], content: string): ChatExportMessage {
    return { role, content, timestamp: Date.now() };
}

describe('formatConversationHistory', () => {
    it('returns empty string when no non-system messages exist', () => {
        const messages = [msg('system', 'Welcome'), msg('user', 'Hello')];
        // Only one non-system message, and the last is excluded → empty
        expect(formatConversationHistory(messages)).toBe('');
    });

    it('excludes system messages from history', () => {
        const messages = [
            msg('system', 'System info'),
            msg('user', 'First question'),
            msg('assistant', 'First answer'),
            msg('system', 'Status update'),
            msg('user', 'Second question') // this is the "just-added" query
        ];
        const result = formatConversationHistory(messages);
        expect(result).not.toContain('System info');
        expect(result).not.toContain('Status update');
        expect(result).toContain('USER: First question');
        expect(result).toContain('ASSISTANT: First answer');
    });

    it('excludes the last message (just-added user query)', () => {
        const messages = [
            msg('user', 'Q1'),
            msg('assistant', 'A1'),
            msg('user', 'Q2')
        ];
        const result = formatConversationHistory(messages);
        expect(result).toContain('USER: Q1');
        expect(result).toContain('ASSISTANT: A1');
        expect(result).not.toContain('Q2');
    });

    it('respects MAX_HISTORY_CHARS truncation', () => {
        const longContent = 'x'.repeat(5000);
        const messages = [
            msg('user', longContent),
            msg('assistant', longContent),
            msg('user', 'latest')
        ];
        const result = formatConversationHistory(messages);
        expect(result.startsWith('...')).toBe(true);
        expect(result.length).toBeLessThanOrEqual(MAX_HISTORY_CHARS + 3); // +3 for '...'
    });

    it('respects MAX_HISTORY_MESSAGES limit', () => {
        const messages: ChatExportMessage[] = [];
        for (let i = 0; i < 50; i++) {
            messages.push(msg('user', `Q${i}`));
            messages.push(msg('assistant', `A${i}`));
        }
        messages.push(msg('user', 'latest'));
        const result = formatConversationHistory(messages);
        // Should contain the last 20 non-system messages (excluding "latest")
        const lines = result.split('\n');
        expect(lines.length).toBeLessThanOrEqual(MAX_HISTORY_MESSAGES);
    });
});

// ---------- Export markdown formatting ----------

describe('formatExportMarkdown', () => {
    it('excludes system messages from export', () => {
        const messages = [
            msg('system', 'Welcome'),
            msg('user', 'Hello'),
            msg('assistant', 'Hi there')
        ];
        const result = formatExportMarkdown(messages);
        expect(result).not.toContain('Welcome');
        expect(result).toContain('**You**');
        expect(result).toContain('**Assistant**');
    });

    it('includes heading with date', () => {
        const result = formatExportMarkdown([msg('user', 'test')]);
        expect(result).toMatch(/^# Chat with Vault — /);
    });

    it('formats sources as wikilinks', () => {
        const messages: ChatExportMessage[] = [{
            role: 'assistant',
            content: 'Answer',
            timestamp: Date.now(),
            sources: ['Notes/Meeting.md', 'Notes/Project.md']
        }];
        const result = formatExportMarkdown(messages);
        expect(result).toContain('[[Notes/Meeting.md]]');
        expect(result).toContain('[[Notes/Project.md]]');
    });

    it('omits sources section when no sources present', () => {
        const messages = [msg('assistant', 'General answer')];
        const result = formatExportMarkdown(messages);
        expect(result).not.toContain('Sources:');
    });

    it('separates messages with horizontal rules', () => {
        const messages = [msg('user', 'Q'), msg('assistant', 'A')];
        const result = formatExportMarkdown(messages);
        const hrCount = (result.match(/---/g) || []).length;
        expect(hrCount).toBe(2); // one after each message
    });
});
