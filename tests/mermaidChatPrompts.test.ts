/**
 * Tests for mermaidChatPrompts.ts
 */

import {
    buildMermaidChatSystemPrompt,
    buildMermaidChatUserPrompt,
    formatConversationTurn,
    MermaidChatPromptOptions,
} from '../src/services/prompts/mermaidChatPrompts';

const baseOptions: MermaidChatPromptOptions = {
    currentDiagram: 'flowchart TD\n  A --> B',
    noteContent: 'This is a test note about workflows.',
    userMessage: 'Add a C node connected to B',
    conversationHistory: '',
    outputLanguage: 'en',
    provider: 'claude',
    model: 'claude-sonnet-4-6',
};

// ── buildMermaidChatSystemPrompt ──────────────────────────────────────────────

describe('buildMermaidChatSystemPrompt', () => {
    it('returns a non-empty string', () => {
        const prompt = buildMermaidChatSystemPrompt(baseOptions);
        expect(typeof prompt).toBe('string');
        expect(prompt.length).toBeGreaterThan(50);
    });

    it('instructs LLM to output only Mermaid code (no fences)', () => {
        const prompt = buildMermaidChatSystemPrompt(baseOptions);
        expect(prompt).toContain('ONLY');
        expect(prompt.toLowerCase()).toContain('no explanations');
    });

    it('mentions supported diagram types', () => {
        const prompt = buildMermaidChatSystemPrompt(baseOptions);
        expect(prompt).toContain('flowchart');
        expect(prompt).toContain('sequenceDiagram');
        expect(prompt).toContain('mindmap');
    });

    it('instructs to start directly with diagram type keyword', () => {
        const prompt = buildMermaidChatSystemPrompt(baseOptions);
        expect(prompt).toContain('Start your response directly with');
    });

    it('includes language instruction for non-English output', () => {
        const frOptions = { ...baseOptions, outputLanguage: 'fr' };
        const prompt = buildMermaidChatSystemPrompt(frOptions);
        expect(prompt).toContain('fr');
    });

    it('uses English instruction for English output language', () => {
        const prompt = buildMermaidChatSystemPrompt(baseOptions);
        expect(prompt).toContain('English');
    });
});

// ── buildMermaidChatUserPrompt ────────────────────────────────────────────────

describe('buildMermaidChatUserPrompt', () => {
    it('contains the current diagram in the prompt', () => {
        const prompt = buildMermaidChatUserPrompt(baseOptions);
        expect(prompt).toContain('flowchart TD');
        expect(prompt).toContain('A --> B');
    });

    it('contains the user instruction', () => {
        const prompt = buildMermaidChatUserPrompt(baseOptions);
        expect(prompt).toContain('Add a C node connected to B');
    });

    it('wraps sections in XML tags', () => {
        const prompt = buildMermaidChatUserPrompt(baseOptions);
        expect(prompt).toContain('<current_diagram>');
        expect(prompt).toContain('</current_diagram>');
        expect(prompt).toContain('<instruction>');
        expect(prompt).toContain('</instruction>');
    });

    it('includes note content when present', () => {
        const prompt = buildMermaidChatUserPrompt(baseOptions);
        expect(prompt).toContain('<note_context>');
        expect(prompt).toContain('test note about workflows');
    });

    it('truncates note content to fit provider token budget', () => {
        const longNote = 'x'.repeat(5_000_000); // Far exceeds any budget
        const opts = { ...baseOptions, noteContent: longNote };
        const prompt = buildMermaidChatUserPrompt(opts);
        // Prompt should be present but note should be truncated
        expect(prompt).toContain('<note_context>');
        // Prompt length should be reasonable (not 5M chars)
        expect(prompt.length).toBeLessThan(4_000_000);
    });

    it('indicates "create new" when no current diagram', () => {
        const opts = { ...baseOptions, currentDiagram: '' };
        const prompt = buildMermaidChatUserPrompt(opts);
        expect(prompt).toContain('No existing diagram');
        expect(prompt).toContain('create a new one');
    });

    it('includes conversation history when provided', () => {
        const opts = {
            ...baseOptions,
            conversationHistory: 'User: previous question\nAssistant: previous answer',
        };
        const prompt = buildMermaidChatUserPrompt(opts);
        expect(prompt).toContain('<conversation_history>');
        expect(prompt).toContain('previous question');
        expect(prompt).toContain('previous answer');
    });

    it('omits conversation_history section when history is empty', () => {
        const prompt = buildMermaidChatUserPrompt(baseOptions);
        expect(prompt).not.toContain('<conversation_history>');
    });

    it('works with local provider (smaller budget)', () => {
        const opts = { ...baseOptions, provider: 'local', model: undefined };
        expect(() => buildMermaidChatUserPrompt(opts)).not.toThrow();
    });
});

// ── formatConversationTurn ────────────────────────────────────────────────────

describe('formatConversationTurn', () => {
    it('formats user turns with "User:" prefix', () => {
        expect(formatConversationTurn('user', 'Hello')).toBe('User: Hello');
    });

    it('formats assistant turns with "Assistant:" prefix', () => {
        expect(formatConversationTurn('assistant', 'flowchart TD\n  A-->B')).toBe('Assistant: flowchart TD\n  A-->B');
    });
});
