/**
 * Tests for chat persistence serialization helpers in chatExportUtils
 */
import { describe, it, expect } from 'vitest';
import {
    serializeConversationNote,
    extractConversationState,
    ConversationState,
} from '../src/utils/chatExportUtils';

function makeState(overrides: Partial<ConversationState> = {}): ConversationState {
    return {
        version: 1,
        mode: 'free',
        messages: [
            { role: 'user', content: 'Hello there', timestamp: 1700000000000 },
            { role: 'assistant', content: 'Hi! How can I help?', timestamp: 1700000001000 },
        ],
        compactionSummary: '',
        createdAt: '2024-01-15T10:00:00.000Z',
        lastActiveAt: '2024-01-15T10:01:00.000Z',
        ...overrides,
    };
}

describe('serializeConversationNote', () => {
    it('produces valid markdown with frontmatter', () => {
        const note = serializeConversationNote(makeState());
        expect(note).toContain('---');
        expect(note).toContain('tags:');
        expect(note).toContain('ai-chat');
        expect(note).toContain('ai-chat/free');
        expect(note).toContain('chat_mode: free');
    });

    it('uses first user message as title', () => {
        const note = serializeConversationNote(makeState());
        expect(note).toContain('# Hello there');
    });

    it('falls back to date title when no user message', () => {
        const state = makeState({ messages: [] });
        const note = serializeConversationNote(state);
        expect(note).toContain('# Chat —');
    });

    it('excludes system messages from rendered content', () => {
        const state = makeState({
            messages: [
                { role: 'system', content: 'Internal context', timestamp: Date.now() },
                { role: 'user', content: 'User question', timestamp: Date.now() },
            ],
        });
        const note = serializeConversationNote(state);
        expect(note).not.toContain('Internal context');
        expect(note).toContain('User question');
    });

    it('includes project_id in frontmatter when set', () => {
        const note = serializeConversationNote(makeState({ projectId: 'proj-uuid-123' }));
        expect(note).toContain('project_id: "proj-uuid-123"');
    });

    it('embeds base64 state marker', () => {
        const note = serializeConversationNote(makeState());
        expect(note).toContain('<!-- chat-state-b64:');
        expect(note).toContain(' -->');
    });

    it('truncates long first message to 80 chars in title', () => {
        const longMsg = 'A'.repeat(200);
        const state = makeState({
            messages: [{ role: 'user', content: longMsg, timestamp: Date.now() }],
        });
        const note = serializeConversationNote(state);
        const titleLine = note.split('\n').find(l => l.startsWith('# '));
        expect(titleLine?.slice(2).length).toBeLessThanOrEqual(80);
    });
});

describe('extractConversationState', () => {
    it('round-trips state through serialize/extract', () => {
        const original = makeState({ compactionSummary: 'Some context' });
        const note = serializeConversationNote(original);
        const extracted = extractConversationState(note);
        expect(extracted).not.toBeNull();
        expect(extracted!.mode).toBe('free');
        expect(extracted!.version).toBe(1);
        expect(extracted!.compactionSummary).toBe('Some context');
        expect(extracted!.messages).toHaveLength(original.messages.length);
    });

    it('returns null when no marker found', () => {
        expect(extractConversationState('# Just a note\n\nNo state here.')).toBeNull();
    });

    it('returns null for malformed base64', () => {
        const note = '<!-- chat-state-b64:NOT_VALID_BASE64!!! -->';
        expect(extractConversationState(note)).toBeNull();
    });

    it('preserves projectId through round-trip', () => {
        const state = makeState({ projectId: 'test-proj-id' });
        const extracted = extractConversationState(serializeConversationNote(state));
        expect(extracted?.projectId).toBe('test-proj-id');
    });

    it('preserves messages with timestamps', () => {
        const state = makeState();
        const extracted = extractConversationState(serializeConversationNote(state));
        expect(extracted?.messages[0].timestamp).toBe(1700000000000);
        expect(extracted?.messages[1].timestamp).toBe(1700000001000);
    });
});
