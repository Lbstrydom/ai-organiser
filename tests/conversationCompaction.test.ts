/**
 * Tests for ConversationCompactionService
 */
import { describe, it, expect, vi } from 'vitest';
import {
    ConversationCompactionService,
    RECENT_KEEP_COUNT,
    HISTORY_BUDGET_FRACTION,
} from '../src/services/chat/conversationCompactionService';
import type { ChatExportMessage } from '../src/utils/chatExportUtils';

function msg(role: ChatExportMessage['role'], content: string): ChatExportMessage {
    return { role, content, timestamp: Date.now() };
}

function makeLongMessage(role: ChatExportMessage['role'], chars: number): ChatExportMessage {
    return msg(role, 'x'.repeat(chars));
}

/** Build a message list that exceeds the compaction threshold for ollama/llama3 */
function makeLongConversation(): ChatExportMessage[] {
    // 20 pairs × 30k chars each = 600k chars, well above any small model budget
    return [
        ...Array.from({ length: 20 }, () => [
            makeLongMessage('user', 15_000),
            makeLongMessage('assistant', 15_000),
        ]).flat(),
        msg('user', 'latest'),
    ];
}

function makeCtx(summarize?: (p: string) => Promise<{ success: boolean; content?: string }>) {
    return {
        provider: 'openai',
        model: 'gpt-4o',
        summarize: summarize ?? vi.fn().mockResolvedValue({ success: false }),
    };
}

describe('ConversationCompactionService', () => {
    describe('needsCompaction', () => {
        it('returns false for short conversations', () => {
            const svc = new ConversationCompactionService(makeCtx());
            const messages = [msg('user', 'hi'), msg('assistant', 'hello')];
            expect(svc.needsCompaction(messages)).toBe(false);
        });

        it('returns true when total chars exceed history budget', () => {
            const svc = new ConversationCompactionService(makeCtx());
            // Budget = getMaxContentCharsForModel('openai','gpt-4o') * HISTORY_BUDGET_FRACTION
            // Use enormous messages to force over threshold regardless of exact budget
            const messages = [
                makeLongMessage('user', 500_000),
                makeLongMessage('assistant', 500_000),
            ];
            expect(svc.needsCompaction(messages)).toBe(true);
        });
    });

    describe('formatHistory', () => {
        it('returns empty string for no non-system messages', async () => {
            const svc = new ConversationCompactionService(makeCtx());
            const result = await svc.formatHistory('free', []);
            expect(result).toBe('');
        });

        it('excludes system messages from history', async () => {
            const svc = new ConversationCompactionService(makeCtx());
            const messages = [
                msg('system', 'System prompt'),
                msg('user', 'Hello'),
                msg('assistant', 'Hi'),
                msg('user', 'latest'),
            ];
            const result = await svc.formatHistory('free', messages);
            expect(result).not.toContain('System prompt');
            expect(result).toContain('USER: Hello');
            expect(result).toContain('ASSISTANT: Hi');
        });

        it('excludes the last message (just-added query)', async () => {
            const svc = new ConversationCompactionService(makeCtx());
            const messages = [
                msg('user', 'first'),
                msg('assistant', 'reply'),
                msg('user', 'latest query'),
            ];
            const result = await svc.formatHistory('free', messages);
            expect(result).toContain('USER: first');
            expect(result).toContain('ASSISTANT: reply');
            expect(result).not.toContain('latest query');
        });

        it('uses plain format when no compaction needed', async () => {
            const svc = new ConversationCompactionService(makeCtx());
            const messages = [msg('user', 'q'), msg('assistant', 'a'), msg('user', 'q2')];
            const result = await svc.formatHistory('free', messages);
            expect(result).toBe('USER: q\nASSISTANT: a');
        });

        it('compacts long history and keeps recent messages verbatim', async () => {
            const summarize = vi.fn().mockResolvedValue({ success: true, content: 'Summary of old messages' });
            // Use ollama with a small model — budget will be tiny, easy to exceed
            const svc = new ConversationCompactionService({ provider: 'ollama', model: 'llama3', summarize });
            const result = await svc.formatHistory('free', makeLongConversation());
            expect(result).toContain('conversation_summary');
            expect(result).toContain('Summary of old messages');
            expect(result).toContain('recent_messages');
        });

        it('falls back to existing summary if LLM fails', async () => {
            const summarize = vi.fn().mockResolvedValue({ success: false });
            const svc = new ConversationCompactionService({ provider: 'ollama', model: 'llama3', summarize });
            svc.restore('free', 'Old cached summary');
            const result = await svc.formatHistory('free', makeLongConversation());
            expect(result).toContain('Old cached summary');
        });

        it('caches summary after successful compaction', async () => {
            const summarize = vi.fn().mockResolvedValue({ success: true, content: 'Cached summary' });
            const svc = new ConversationCompactionService({ provider: 'ollama', model: 'llama3', summarize });
            await svc.formatHistory('free', makeLongConversation());
            expect(svc.getCachedSummary('free')).toBe('Cached summary');
        });
    });

    describe('reset / restore / resetAll', () => {
        it('reset clears a specific mode summary', () => {
            const svc = new ConversationCompactionService(makeCtx());
            svc.restore('free', 'some summary');
            svc.restore('note', 'other summary');
            svc.reset('free');
            expect(svc.getCachedSummary('free')).toBe('');
            expect(svc.getCachedSummary('note')).toBe('other summary');
        });

        it('resetAll clears all mode summaries', () => {
            const svc = new ConversationCompactionService(makeCtx());
            svc.restore('free', 'summary 1');
            svc.restore('vault', 'summary 2');
            svc.resetAll();
            expect(svc.getCachedSummary('free')).toBe('');
            expect(svc.getCachedSummary('vault')).toBe('');
        });

        it('restore stores summary for later retrieval', () => {
            const svc = new ConversationCompactionService(makeCtx());
            svc.restore('free', 'persisted summary');
            expect(svc.getCachedSummary('free')).toBe('persisted summary');
        });

        it('restore ignores empty string', () => {
            const svc = new ConversationCompactionService(makeCtx());
            svc.restore('free', '');
            expect(svc.getCachedSummary('free')).toBe('');
        });
    });

    describe('updateModel', () => {
        it('recalculates budget when model changes', () => {
            const svc = new ConversationCompactionService({ provider: 'openai', model: 'gpt-4o', summarize: vi.fn() });
            // No error when updating model
            expect(() => svc.updateModel('gpt-5.2')).not.toThrow();
        });
    });

    describe('HISTORY_BUDGET_FRACTION constant', () => {
        it('is 0.4', () => {
            expect(HISTORY_BUDGET_FRACTION).toBe(0.4);
        });
    });

    describe('RECENT_KEEP_COUNT constant', () => {
        it('is 6', () => {
            expect(RECENT_KEEP_COUNT).toBe(6);
        });
    });
});
