/**
 * Tests for ChatSearchService — conversation search, content extraction, and excerpt building.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { App, TFile } from 'obsidian';
import type { AIOrganiserSettings } from '../src/core/settings';
import { ChatSearchService } from '../src/services/chat/chatSearchService';

/* ---------- Fixtures ---------- */

const SAMPLE_CONVERSATION = [
    '---',
    'tags:',
    '  - ai-chat',
    '  - ai-chat/free',
    'created: 2026-04-07',
    'chat_mode: free',
    'project_id: "uuid-123"',
    '---',
    '',
    '# Budget planning discussion',
    '',
    '**You** (10:30):',
    'We need to discuss the Q2 budget allocation',
    '',
    '---',
    '',
    '**Assistant** (10:31):',
    "I'd suggest allocating 30% to marketing",
    '',
    '---',
    '',
    '<!-- chat-state-b64:eyJ2ZXJzaW9uIjoxLCJtb2RlIjoiZnJlZSJ9 -->',
].join('\n');

const RESEARCH_CONVERSATION = [
    '---',
    'tags:',
    '  - ai-chat',
    '  - ai-chat/research',
    'created: 2026-04-05',
    'chat_mode: research',
    '---',
    '',
    '# Climate research notes',
    '',
    '**You** (14:00):',
    'What are the latest findings on carbon capture technology?',
    '',
    '---',
    '',
    '**Assistant** (14:01):',
    'Recent studies show promising developments in direct air capture',
    '',
    '---',
    '',
    '<!-- chat-state-b64:eyJ2ZXJzaW9uIjoxLCJtb2RlIjoicmVzZWFyY2gifQ== -->',
].join('\n');

const OLD_CONVERSATION = [
    '---',
    'tags:',
    '  - ai-chat',
    '  - ai-chat/free',
    'created: 2025-12-01',
    'chat_mode: free',
    '---',
    '',
    '# Old topic from last year',
    '',
    '**You** (09:00):',
    'This is an older conversation about project planning',
    '',
    '---',
    '',
    '**Assistant** (09:01):',
    'Let me help with project planning',
    '',
    '---',
    '',
    '<!-- chat-state-b64:eyJ2ZXJzaW9uIjoxfQ== -->',
].join('\n');

const NO_FRONTMATTER_CONTENT = [
    '# Quick chat',
    '',
    '**You** (11:00):',
    'Just a quick question about testing',
    '',
    '---',
    '',
    '**Assistant** (11:01):',
    'Sure, happy to help with testing',
].join('\n');

const NO_STATE_BLOB_CONTENT = [
    '---',
    'tags:',
    '  - ai-chat',
    '  - ai-chat/free',
    'created: 2026-04-06',
    'chat_mode: free',
    '---',
    '',
    '# Simple chat without state',
    '',
    '**You** (12:00):',
    'Hello world',
    '',
    '---',
    '',
    '**Assistant** (12:01):',
    'Hi there!',
].join('\n');

/* ---------- Helpers ---------- */

function makeMockFile(path: string, mtime: number): TFile {
    return {
        path,
        basename: path.split('/').pop()?.replace('.md', '') ?? '',
        extension: 'md',
        stat: { mtime, ctime: mtime, size: 1000 },
        vault: {},
        name: path.split('/').pop() ?? '',
    } as unknown as TFile;
}

function createMockApp(files: TFile[], contentMap: Record<string, string>): App {
    return {
        vault: {
            getMarkdownFiles: vi.fn().mockReturnValue(files),
            cachedRead: vi.fn().mockImplementation(async (file: TFile) => {
                return contentMap[file.path] ?? '';
            }),
        },
    } as unknown as App;
}

function createMockSettings(overrides: Partial<AIOrganiserSettings> = {}): AIOrganiserSettings {
    return {
        pluginFolder: 'AI-Organiser',
        chatRootFolder: 'AI Chat',
        outputRootFolder: '',
        ...overrides,
    } as AIOrganiserSettings;
}

/* ---------- Tests ---------- */

describe('ChatSearchService', () => {
    let service: ChatSearchService;
    let mockApp: App;
    const mockSettings = createMockSettings();

    beforeEach(() => {
        mockApp = createMockApp([], {});
        service = new ChatSearchService(mockApp, mockSettings);
    });

    /* ======== extractSearchableContent ======== */

    describe('extractSearchableContent', () => {
        it('strips YAML frontmatter', () => {
            const result = service.extractSearchableContent(SAMPLE_CONVERSATION);
            expect(result).not.toContain('tags:');
            expect(result).not.toContain('ai-chat');
            expect(result).not.toContain('chat_mode: free');
            expect(result).not.toContain('project_id');
        });

        it('strips base64 state blob', () => {
            const result = service.extractSearchableContent(SAMPLE_CONVERSATION);
            expect(result).not.toContain('chat-state-b64');
            expect(result).not.toContain('eyJ2ZXJzaW9uIjoxLCJtb2RlIjoiZnJlZSJ9');
        });

        it('preserves message content', () => {
            const result = service.extractSearchableContent(SAMPLE_CONVERSATION);
            expect(result).toContain('Q2 budget allocation');
            expect(result).toContain('30% to marketing');
            expect(result).toContain('Budget planning discussion');
        });

        it('handles missing frontmatter gracefully', () => {
            const result = service.extractSearchableContent(NO_FRONTMATTER_CONTENT);
            expect(result).toContain('quick question about testing');
            expect(result).toContain('happy to help with testing');
        });

        it('handles missing state blob gracefully', () => {
            const result = service.extractSearchableContent(NO_STATE_BLOB_CONTENT);
            expect(result).toContain('Hello world');
            expect(result).toContain('Hi there!');
        });

        it('returns empty string for empty input', () => {
            const result = service.extractSearchableContent('');
            expect(result).toBe('');
        });
    });

    /* ======== buildExcerpt ======== */

    describe('buildExcerpt', () => {
        const longContent = 'The quick brown fox jumps over the lazy dog. ' +
            'Budget allocation for Q2 requires careful planning. ' +
            'We should consider all departments equally.';

        it('highlights matching term in context', () => {
            const segments = service.buildExcerpt(longContent, 'budget');
            const highlighted = segments.filter(s => s.highlight);
            expect(highlighted).toHaveLength(1);
            expect(highlighted[0].text.toLowerCase()).toContain('budget');
        });

        it('returns 3 segments: before, match, after', () => {
            const segments = service.buildExcerpt(longContent, 'Budget');
            expect(segments).toHaveLength(3);
            expect(segments[0].highlight).toBe(false);  // before
            expect(segments[1].highlight).toBe(true);   // match
            expect(segments[2].highlight).toBe(false);   // after
        });

        it('performs case-insensitive matching', () => {
            const segments = service.buildExcerpt(longContent, 'BUDGET');
            const highlighted = segments.filter(s => s.highlight);
            expect(highlighted).toHaveLength(1);
            // The highlighted text comes from the original content (original case)
            expect(highlighted[0].text).toBe('Budget');
        });

        it('returns first 200 chars with no highlight when no match', () => {
            const segments = service.buildExcerpt(longContent, 'xyznonexistent');
            expect(segments).toHaveLength(1);
            expect(segments[0].highlight).toBe(false);
            expect(segments[0].text.length).toBeLessThanOrEqual(200);
        });

        it('handles match at start of content', () => {
            const content = 'Budget is the main topic here';
            const segments = service.buildExcerpt(content, 'Budget');
            // No before-text since match is at index 0
            expect(segments[0].highlight).toBe(true);
            expect(segments[0].text).toBe('Budget');
        });

        it('handles match at end of content', () => {
            const content = 'We need to review the budget';
            const segments = service.buildExcerpt(content, 'budget');
            const highlighted = segments.filter(s => s.highlight);
            expect(highlighted).toHaveLength(1);
            expect(highlighted[0].text).toBe('budget');
            // After segment should be empty or absent (no trailing '...')
            const afterSegments = segments.slice(segments.findIndex(s => s.highlight) + 1);
            if (afterSegments.length > 0) {
                expect(afterSegments[0].text).not.toContain('...');
            }
        });

        it('respects custom contextChars parameter', () => {
            const segments = service.buildExcerpt(longContent, 'Budget', 10);
            const allText = segments.map(s => s.text).join('');
            // With context=10, total text should be much shorter than full content
            expect(allText.length).toBeLessThan(longContent.length);
        });
    });

    /* ======== search (integrated — mock vault) ======== */

    describe('search', () => {
        const now = new Date('2026-04-07T12:00:00Z').getTime();

        const budgetFile = makeMockFile(
            'AI-Organiser/AI Chat/free/budget-planning.md',
            now,
        );
        const researchFile = makeMockFile(
            'AI-Organiser/AI Chat/research/climate-research.md',
            now - 2 * 24 * 60 * 60 * 1000, // 2 days ago
        );
        const oldFile = makeMockFile(
            'AI-Organiser/AI Chat/free/old-topic.md',
            new Date('2025-12-01T12:00:00Z').getTime(),
        );

        const contentMap: Record<string, string> = {
            [budgetFile.path]: SAMPLE_CONVERSATION,
            [researchFile.path]: RESEARCH_CONVERSATION,
            [oldFile.path]: OLD_CONVERSATION,
        };

        beforeEach(() => {
            vi.useFakeTimers();
            vi.setSystemTime(now);
            mockApp = createMockApp([budgetFile, researchFile, oldFile], contentMap);
            service = new ChatSearchService(mockApp, mockSettings);
        });

        afterEach(() => {
            vi.useRealTimers();
        });

        it('finds conversations matching keyword', async () => {
            const result = await service.search('budget', {});
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.value.length).toBeGreaterThanOrEqual(1);
            expect(result.value.some(r => r.filePath === budgetFile.path)).toBe(true);
            // Research conversation should not match 'budget'
            expect(result.value.some(r => r.filePath === researchFile.path)).toBe(false);
        });

        it('filters by mode', async () => {
            const result = await service.search('', { mode: 'research' });
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.value.length).toBe(1);
            expect(result.value[0].mode).toBe('research');
            expect(result.value[0].filePath).toBe(researchFile.path);
        });

        it('filters by dateRange', async () => {
            const result = await service.search('', { dateRange: 'week' });
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            // Old conversation (2025-12-01) should be excluded
            expect(result.value.some(r => r.filePath === oldFile.path)).toBe(false);
            // Recent conversations should be included
            expect(result.value.some(r => r.filePath === budgetFile.path)).toBe(true);
        });

        it('returns empty array for no matches', async () => {
            const result = await service.search('xyznonexistentterm123', {});
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.value).toEqual([]);
        });

        it('returns results sorted by updatedAt descending', async () => {
            const result = await service.search('', {});
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.value.length).toBeGreaterThanOrEqual(2);
            for (let i = 1; i < result.value.length; i++) {
                const prev = new Date(result.value[i - 1].updatedAt).getTime();
                const curr = new Date(result.value[i].updatedAt).getTime();
                expect(prev).toBeGreaterThanOrEqual(curr);
            }
        });
    });

    /* ======== clearCache ======== */

    describe('clearCache', () => {
        it('clears internal cache without error', () => {
            service.clearCache();
            // Should not throw
            expect(() => service.clearCache()).not.toThrow();
        });

        it('subsequent search re-reads files after cache clear', async () => {
            const file = makeMockFile(
                'AI-Organiser/AI Chat/free/cached-test.md',
                Date.now(),
            );
            const contentMap = { [file.path]: SAMPLE_CONVERSATION };
            mockApp = createMockApp([file], contentMap);
            service = new ChatSearchService(mockApp, mockSettings);

            // First search populates cache
            await service.search('budget', {});
            const firstCallCount = (mockApp.vault.cachedRead as ReturnType<typeof vi.fn>).mock.calls.length;

            // Clear cache
            service.clearCache();

            // Second search should re-read files
            await service.search('budget', {});
            const secondCallCount = (mockApp.vault.cachedRead as ReturnType<typeof vi.fn>).mock.calls.length;

            expect(secondCallCount).toBeGreaterThan(firstCallCount);
        });
    });
});
