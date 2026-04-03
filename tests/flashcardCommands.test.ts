/**
 * Flashcard Commands — Unit Tests
 * Tests multi-note assembly, size guardrails, and CSV cleanup.
 */
import { vi } from 'vitest';
import { createTFile } from './mocks/obsidian';
import { assembleMultiNoteContent, looksLikeProse } from '../src/commands/flashcardCommands';
import { getMaxContentChars } from '../src/services/tokenLimits';

// ─── Mock plugin ────────────────────────────────────────────────────

function createMockPlugin(opts?: {
    serviceType?: 'cloud' | 'local';
    cloudServiceType?: string;
    fileContents?: Record<string, string>;
}) {
    const fileContents = opts?.fileContents ?? {};

    return {
        app: {
            vault: {
                read: vi.fn(async (file: { path: string }) => {
                    return fileContents[file.path] ?? '';
                })
            },
            workspace: {
                getActiveFile: vi.fn(() => null),
                getActiveViewOfType: vi.fn(() => null)
            }
        },
        settings: {
            serviceType: opts?.serviceType ?? 'cloud',
            cloudServiceType: opts?.cloudServiceType ?? 'openai',
            flashcardProvider: 'main',
            flashcardModel: ''
        },
        secretStorageService: {
            isAvailable: vi.fn(() => false)
        },
        llmService: {
            summarizeText: vi.fn()
        },
        t: {
            messages: {},
            modals: { flashcardExport: {} }
        }
    } as any;
}

// ─── assembleMultiNoteContent ───────────────────────────────────────

describe('assembleMultiNoteContent', () => {
    it('should concatenate notes with headers and separators', async () => {
        const plugin = createMockPlugin({
            fileContents: {
                'notes/a.md': 'Content A',
                'notes/b.md': 'Content B'
            }
        });

        const notes = [
            createTFile('notes/a.md'),
            createTFile('notes/b.md')
        ];

        const result = await assembleMultiNoteContent(plugin, notes);

        expect(result.content).toContain('## a');
        expect(result.content).toContain('Content A');
        expect(result.content).toContain('---');
        expect(result.content).toContain('## b');
        expect(result.content).toContain('Content B');
        expect(result.wasTruncated).toBe(false);
    });

    it('should truncate notes exceeding per-note budget', async () => {
        // OpenAI limit: getMaxContentChars('openai') ≈ (128000 - 500 - 2000) * 4 = 502000
        // With prompt overhead 3000, budget ≈ 499000
        // For 2 notes, perNoteBudget ≈ 249500
        const longContent = 'A'.repeat(300000); // Exceeds per-note budget

        const plugin = createMockPlugin({
            fileContents: {
                'notes/long.md': longContent,
                'notes/short.md': 'Short content'
            }
        });

        const notes = [
            createTFile('notes/long.md'),
            createTFile('notes/short.md')
        ];

        const result = await assembleMultiNoteContent(plugin, notes);

        expect(result.wasTruncated).toBe(true);
        expect(result.content).toContain('[...truncated]');
        // Second note should still be included
        expect(result.content).toContain('Short content');
    });

    it('should stop adding notes when total budget exceeded', async () => {
        // Use local provider with smaller limits
        // local: (8000 - 500 - 2000) * 4 = 22000 chars
        // With 3000 prompt overhead = 19000 budget
        const plugin = createMockPlugin({
            serviceType: 'local',
            cloudServiceType: 'local',
            fileContents: {
                'notes/a.md': 'A'.repeat(8000),
                'notes/b.md': 'B'.repeat(8000),
                'notes/c.md': 'C'.repeat(8000)
            }
        });

        const notes = [
            createTFile('notes/a.md'),
            createTFile('notes/b.md'),
            createTFile('notes/c.md')
        ];

        const result = await assembleMultiNoteContent(plugin, notes);

        expect(result.wasTruncated).toBe(true);
        // Not all notes will fit
        const budget = getMaxContentChars('local') - 3000;
        expect(result.content.length).toBeLessThanOrEqual(budget + 500); // Allow small overshoot from last note
    });

    it('should handle single note', async () => {
        const plugin = createMockPlugin({
            fileContents: { 'notes/only.md': 'Only note content' }
        });

        const notes = [createTFile('notes/only.md')];
        const result = await assembleMultiNoteContent(plugin, notes);

        expect(result.content).toContain('## only');
        expect(result.content).toContain('Only note content');
        expect(result.wasTruncated).toBe(false);
        // Should not have separator for single note
        expect(result.content).not.toContain('---');
    });

    it('should handle empty notes', async () => {
        const plugin = createMockPlugin({
            fileContents: {
                'notes/empty.md': '',
                'notes/has-content.md': 'Some content'
            }
        });

        const notes = [
            createTFile('notes/empty.md'),
            createTFile('notes/has-content.md')
        ];

        const result = await assembleMultiNoteContent(plugin, notes);
        expect(result.content).toContain('Some content');
    });

    it('should always include at least the first note even if it exceeds budget', async () => {
        // local budget ≈ 19000 chars. Single huge note should still be included (truncated).
        const plugin = createMockPlugin({
            serviceType: 'local',
            cloudServiceType: 'local',
            fileContents: {
                'notes/huge.md': 'X'.repeat(50000)
            }
        });

        const notes = [createTFile('notes/huge.md')];
        const result = await assembleMultiNoteContent(plugin, notes);

        // Must have content (not empty), even though it exceeds budget
        expect(result.content.length).toBeGreaterThan(0);
        expect(result.content).toContain('## huge');
        expect(result.wasTruncated).toBe(true);
        expect(result.content).toContain('[...truncated]');
    });

    it('should use provider-specific limits', async () => {
        // Claude has much larger limits than local
        const claudePlugin = createMockPlugin({ cloudServiceType: 'claude' });
        const localPlugin = createMockPlugin({ serviceType: 'local' });

        const claudeLimit = getMaxContentChars('claude');
        const localLimit = getMaxContentChars('local');

        // Claude should have significantly more budget
        expect(claudeLimit).toBeGreaterThan(localLimit * 10);
    });
});

// ─── looksLikeProse ─────────────────────────────────────────────────

describe('looksLikeProse', () => {
    it('should return true for refusal text without commas', () => {
        expect(looksLikeProse("I can't generate flashcards because the provided content is empty.")).toBe(true);
    });

    it('should return true for explanation text', () => {
        expect(looksLikeProse("The note does not contain enough material to create flashcards.")).toBe(true);
    });

    it('should return false for valid CSV with commas', () => {
        expect(looksLikeProse('"What is 2+2?","4"')).toBe(false);
    });

    it('should return false for unquoted CSV', () => {
        expect(looksLikeProse('What is the capital of France?,Paris')).toBe(false);
    });

    it('should handle empty string', () => {
        expect(looksLikeProse('')).toBe(true);
    });

    it('should check first non-empty line', () => {
        expect(looksLikeProse('\n\n"Q1?","A1"\n"Q2?","A2"')).toBe(false);
    });
});
