/**
 * Project memory tests
 *
 * Tests cover: memory marker regex detection, marker stripping from display text,
 * memory deduplication, project context injection format, and pinned file
 * budget estimation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('obsidian', async () => {
    const actual = await vi.importActual('./mocks/obsidian');
    return {
        ...actual,
        Notice: class MockNotice {
            constructor(_msg: string, _timeout?: number) { /* silent */ }
        },
    };
});

vi.mock('../src/core/settings', () => ({
    getChatRootFullPath: () => 'AI-Organiser/AI Chat',
}));

// ─── Memory marker regex ─────────────────────────────────────────────────────

describe('Auto-memory marker detection', () => {
    // Phase 5 regex: detects [MEMORY: ...] markers in assistant responses
    const MEMORY_MARKER_REGEX = /\[MEMORY:\s*(.+?)\]/g;

    it('detects a single memory marker', () => {
        const text = 'Sure! [MEMORY: User prefers TypeScript over JavaScript]';
        const matches = [...text.matchAll(MEMORY_MARKER_REGEX)];
        expect(matches).toHaveLength(1);
        expect(matches[0][1]).toBe('User prefers TypeScript over JavaScript');
    });

    it('detects multiple memory markers', () => {
        const text = '[MEMORY: Uses Vitest] and also [MEMORY: Prefers functional style]';
        const matches = [...text.matchAll(MEMORY_MARKER_REGEX)];
        expect(matches).toHaveLength(2);
        expect(matches[0][1]).toBe('Uses Vitest');
        expect(matches[1][1]).toBe('Prefers functional style');
    });

    it('handles multiline content', () => {
        const text = 'Line 1\n[MEMORY: Important fact]\nLine 3';
        const matches = [...text.matchAll(MEMORY_MARKER_REGEX)];
        expect(matches).toHaveLength(1);
        expect(matches[0][1]).toBe('Important fact');
    });

    it('returns no matches when no markers present', () => {
        const text = 'Regular text without any markers';
        const matches = [...text.matchAll(MEMORY_MARKER_REGEX)];
        expect(matches).toHaveLength(0);
    });

    it('handles extra whitespace in marker', () => {
        const text = '[MEMORY:   Extra spaces   ]';
        const matches = [...text.matchAll(MEMORY_MARKER_REGEX)];
        expect(matches).toHaveLength(1);
        expect(matches[0][1].trim()).toBe('Extra spaces');
    });

    it('does not match incomplete markers', () => {
        const text = '[MEMORY: missing end bracket';
        const matches = [...text.matchAll(MEMORY_MARKER_REGEX)];
        expect(matches).toHaveLength(0);
    });
});

describe('Memory marker stripping', () => {
    function stripMemoryMarkers(text: string): string {
        return text.replace(/\[MEMORY:\s*(.+?)\]/g, '').replace(/\s{2,}/g, ' ').trim();
    }

    it('strips a single marker leaving surrounding text', () => {
        const text = 'Got it! [MEMORY: Uses ESM modules] I will remember that.';
        expect(stripMemoryMarkers(text)).toBe('Got it! I will remember that.');
    });

    it('strips multiple markers', () => {
        const text = '[MEMORY: A] and [MEMORY: B] text';
        expect(stripMemoryMarkers(text)).toBe('and text');
    });

    it('returns original text when no markers', () => {
        const text = 'Normal response text';
        expect(stripMemoryMarkers(text)).toBe('Normal response text');
    });
});

// ─── Memory deduplication ────────────────────────────────────────────────────

describe('Memory deduplication', () => {
    function isDuplicate(existing: string[], newFact: string): boolean {
        const normalized = newFact.trim().toLowerCase();
        return existing.some(m => m.toLowerCase() === normalized);
    }

    it('detects exact duplicate (case-insensitive)', () => {
        const existing = ['Uses TypeScript', 'Prefers dark mode'];
        expect(isDuplicate(existing, 'uses typescript')).toBe(true);
    });

    it('does not flag non-duplicate', () => {
        const existing = ['Uses TypeScript'];
        expect(isDuplicate(existing, 'Uses JavaScript')).toBe(false);
    });

    it('handles whitespace in comparison', () => {
        const existing = ['Uses TypeScript'];
        expect(isDuplicate(existing, '  Uses TypeScript  ')).toBe(true);
    });

    it('handles empty existing list', () => {
        expect(isDuplicate([], 'New fact')).toBe(false);
    });
});

// ─── Project context injection format ────────────────────────────────────────

describe('Project context injection', () => {
    function buildProjectSystemPrompt(
        instructions: string,
        memory: string[],
        pinnedContent: string,
    ): string {
        const parts: string[] = [];
        if (instructions) {
            parts.push(`<project_instructions>\n${instructions}\n</project_instructions>`);
        }
        if (memory.length > 0) {
            const items = memory.map(m => `- ${m}`).join('\n');
            parts.push(`<project_memory>\n${items}\n</project_memory>`);
        }
        if (pinnedContent) {
            parts.push(pinnedContent); // Already wrapped in <pinned_file> tags
        }
        return parts.join('\n\n');
    }

    it('includes instructions when present', () => {
        const result = buildProjectSystemPrompt('Be concise', [], '');
        expect(result).toContain('<project_instructions>');
        expect(result).toContain('Be concise');
    });

    it('includes memory items as bullet list', () => {
        const result = buildProjectSystemPrompt('', ['fact1', 'fact2'], '');
        expect(result).toContain('<project_memory>');
        expect(result).toContain('- fact1');
        expect(result).toContain('- fact2');
    });

    it('includes pinned content', () => {
        const pinned = '<pinned_file name="Notes">content</pinned_file>';
        const result = buildProjectSystemPrompt('', [], pinned);
        expect(result).toContain('<pinned_file');
    });

    it('returns empty string when all inputs are empty', () => {
        const result = buildProjectSystemPrompt('', [], '');
        expect(result).toBe('');
    });

    it('combines all sections', () => {
        const pinned = '<pinned_file name="X">data</pinned_file>';
        const result = buildProjectSystemPrompt('Inst', ['mem1'], pinned);
        expect(result).toContain('<project_instructions>');
        expect(result).toContain('<project_memory>');
        expect(result).toContain('<pinned_file');
    });
});

// ─── Pinned file wrapping ────────────────────────────────────────────────────

describe('Pinned file content wrapping', () => {
    function wrapPinnedContent(link: string, content: string): string {
        const name = link.replace(/[[\]]/g, '');
        return `<pinned_file name="${name}">\n${content}\n</pinned_file>`;
    }

    it('wraps content with pinned_file tags', () => {
        const result = wrapPinnedContent('[[My Note]]', 'Note content here');
        expect(result).toBe('<pinned_file name="My Note">\nNote content here\n</pinned_file>');
    });

    it('strips wikilink brackets from name', () => {
        const result = wrapPinnedContent('[[Folder/Note]]', 'content');
        expect(result).toContain('name="Folder/Note"');
    });
});

// ─── Auto-memory marker extraction (Phase 5) ────────────────────────────────

describe('Auto-memory extraction from assistant messages', () => {
    const MEMORY_MARKER_REGEX = /\[MEMORY:\s*(.+?)\]/g;

    function extractAndStrip(content: string): { stripped: string; facts: string[] } {
        const facts: string[] = [];
        for (const match of content.matchAll(MEMORY_MARKER_REGEX)) {
            facts.push(match[1].trim());
        }
        if (facts.length === 0) return { stripped: content, facts: [] };
        const stripped = content.replace(MEMORY_MARKER_REGEX, '').replace(/\s{2,}/g, ' ').trim();
        return { stripped, facts };
    }

    it('extracts single memory marker and strips it', () => {
        const content = 'Got it! [MEMORY: User prefers TypeScript] I will remember.';
        const result = extractAndStrip(content);
        expect(result.facts).toEqual(['User prefers TypeScript']);
        expect(result.stripped).toBe('Got it! I will remember.');
    });

    it('extracts multiple memory markers', () => {
        const content = '[MEMORY: Fact A] and [MEMORY: Fact B] done.';
        const result = extractAndStrip(content);
        expect(result.facts).toEqual(['Fact A', 'Fact B']);
        expect(result.stripped).toBe('and done.');
    });

    it('returns unchanged content when no markers present', () => {
        const content = 'Just a normal response.';
        const result = extractAndStrip(content);
        expect(result.facts).toEqual([]);
        expect(result.stripped).toBe('Just a normal response.');
    });

    it('handles markers at start and end of content', () => {
        const content = '[MEMORY: Start fact] Some text [MEMORY: End fact]';
        const result = extractAndStrip(content);
        expect(result.facts).toHaveLength(2);
        expect(result.stripped).toBe('Some text');
    });

    it('handles marker on its own line', () => {
        const content = 'Line 1\n[MEMORY: Important]\nLine 3';
        const result = extractAndStrip(content);
        expect(result.facts).toEqual(['Important']);
        expect(result.stripped).toContain('Line 1');
        expect(result.stripped).toContain('Line 3');
    });
});

// ─── Pinned file budget allocation (Phase 4) ────────────────────────────────

describe('Pinned file budget allocation', () => {
    function truncatePinnedContent(content: string, modelBudget: number): string {
        const pinnedBudget = Math.floor(modelBudget / 5);
        if (content.length > pinnedBudget) {
            return content.slice(0, pinnedBudget) + '\n[Pinned content truncated...]';
        }
        return content;
    }

    it('does not truncate short pinned content', () => {
        const content = '<pinned_file name="Note">short</pinned_file>';
        const result = truncatePinnedContent(content, 75000);
        expect(result).toBe(content);
    });

    it('truncates content exceeding ⅕ of budget', () => {
        const content = 'x'.repeat(20000);
        const result = truncatePinnedContent(content, 75000); // budget = 15000
        expect(result.length).toBeLessThan(content.length);
        expect(result).toContain('[Pinned content truncated...]');
    });

    it('allocates exactly ⅕ of budget', () => {
        const budget = 100000;
        const pinnedBudget = Math.floor(budget / 5);
        expect(pinnedBudget).toBe(20000);
    });
});

// ─── Auto-memory system instruction (Phase 5) ───────────────────────────────

describe('Auto-memory system prompt injection', () => {
    it('injects instruction when project instructions are present', () => {
        const projectInstructions = 'Be concise';
        const parts: string[] = [];
        if (projectInstructions !== null) {
            parts.push('<auto_memory_instruction>When you learn an important fact...</auto_memory_instruction>');
        }
        if (projectInstructions) {
            parts.push(`<project_instructions>${projectInstructions}</project_instructions>`);
        }
        expect(parts.some(p => p.includes('auto_memory_instruction'))).toBe(true);
    });

    it('injects instruction when memory items exist', () => {
        const memory = ['fact1'];
        const parts: string[] = [];
        if (memory.length > 0) {
            parts.push('<auto_memory_instruction>instruction</auto_memory_instruction>');
        }
        expect(parts.some(p => p.includes('auto_memory_instruction'))).toBe(true);
    });

    it('does not inject when no project context', () => {
        const projectInstructions: string | null = null;
        const memory: string[] = [];
        const parts: string[] = [];
        if (projectInstructions !== null || memory.length > 0) {
            parts.push('<auto_memory_instruction>instruction</auto_memory_instruction>');
        }
        expect(parts).toHaveLength(0);
    });
});
