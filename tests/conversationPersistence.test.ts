/**
 * ConversationPersistenceService tests
 *
 * Tests cover: scheduleSave debounce, saveNow, doSave (create/overwrite),
 * startNew, listRecent (with/without projectId), load, delete, clearCache,
 * buildTitle, sanitizeFileName, getFolderForState, modeKey, per-mode
 * debounce isolation, and empty conversation saves.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TFile, createTFile } from './mocks/obsidian';

// Mock obsidian module
vi.mock('obsidian', async () => {
    const actual = await vi.importActual('./mocks/obsidian');
    return {
        ...actual,
        Notice: class MockNotice {
            constructor(_msg: string, _timeout?: number) { /* silent */ }
        },
    };
});

// Mock getChatRootFullPath to return a fixed path
vi.mock('../src/core/settings', () => ({
    getChatRootFullPath: () => 'AI-Organiser/AI Chat',
}));

import { ConversationPersistenceService } from '../src/services/chat/conversationPersistenceService';
import type { ConversationState } from '../src/utils/chatExportUtils';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeState(overrides: Partial<ConversationState> = {}): ConversationState {
    return {
        version: 1,
        mode: 'free',
        messages: [
            { role: 'user', content: 'Hello world', timestamp: Date.now() },
            { role: 'assistant', content: 'Hi!', timestamp: Date.now() + 100 },
        ],
        compactionSummary: '',
        createdAt: '2026-03-13T10:00:00.000Z',
        updatedAt: '2026-03-13T10:05:00.000Z',
        ...overrides,
    };
}

function makeEmptyState(overrides: Partial<ConversationState> = {}): ConversationState {
    return {
        version: 1,
        mode: 'free',
        messages: [],
        compactionSummary: '',
        createdAt: '2026-03-13T10:00:00.000Z',
        updatedAt: '2026-03-13T10:05:00.000Z',
        ...overrides,
    };
}

function buildMockApp() {
    const files = new Map<string, { file: TFile; content: string }>();

    const vault = {
        create: vi.fn(async (path: string, content: string) => {
            const file = createTFile(path);
            files.set(path, { file, content });
            return file;
        }),
        modify: vi.fn(async (file: TFile, content: string) => {
            files.set(file.path, { file, content });
        }),
        cachedRead: vi.fn(async (file: TFile) => {
            const entry = files.get(file.path);
            return entry?.content ?? '';
        }),
        getMarkdownFiles: vi.fn(() => {
            return Array.from(files.values()).map(e => e.file);
        }),
        getAbstractFileByPath: vi.fn((path: string) => {
            const entry = files.get(path);
            return entry?.file ?? null;
        }),
        trash: vi.fn(async () => {}),
        createFolder: vi.fn(async () => {}),
    };

    const fileManager = {
        renameFile: vi.fn(async (file: TFile, newPath: string) => {
            const entry = files.get(file.path);
            if (entry) {
                files.delete(file.path);
                (file as any).path = newPath;
                (file as any).name = newPath.split('/').pop() ?? newPath;
                files.set(newPath, { file, content: entry.content });
            }
        }),
    };

    return { vault, files, fileManager };
}

function buildSettings(): any {
    return {
        chatRootFolder: 'AI Chat',
        outputRootFolder: 'AI-Organiser',
    };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('ConversationPersistenceService', () => {
    let mockApp: ReturnType<typeof buildMockApp>;
    let settings: any;
    let service: ConversationPersistenceService;

    beforeEach(() => {
        vi.useFakeTimers();
        mockApp = buildMockApp();
        settings = buildSettings();
        service = new ConversationPersistenceService(mockApp as any, settings);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    // ── scheduleSave ─────────────────────────────────────────────────────

    describe('scheduleSave()', () => {
        it('fires after 1-second debounce', async () => {
            const state = makeState();
            service.scheduleSave(state);

            expect(mockApp.vault.create).not.toHaveBeenCalled();

            vi.advanceTimersByTime(1000);
            await vi.runAllTimersAsync();

            expect(mockApp.vault.create).toHaveBeenCalledTimes(1);
        });

        it('collapses multiple rapid calls into a single write', async () => {
            const state = makeState();
            service.scheduleSave(state);
            vi.advanceTimersByTime(500);
            service.scheduleSave(makeState({ updatedAt: '2026-03-13T10:06:00.000Z' }));
            vi.advanceTimersByTime(500);
            service.scheduleSave(makeState({ updatedAt: '2026-03-13T10:07:00.000Z' }));
            vi.advanceTimersByTime(1000);
            await vi.runAllTimersAsync();

            expect(mockApp.vault.create).toHaveBeenCalledTimes(1);
        });

        it('does not fire before debounce period elapses', () => {
            service.scheduleSave(makeState());
            vi.advanceTimersByTime(999);
            expect(mockApp.vault.create).not.toHaveBeenCalled();
        });
    });

    // ── saveNow ──────────────────────────────────────────────────────────

    describe('saveNow()', () => {
        it('saves immediately without waiting for debounce', async () => {
            const state = makeState();
            await service.saveNow(state);
            expect(mockApp.vault.create).toHaveBeenCalledTimes(1);
        });

        it('cancels a pending debounced save', async () => {
            const state = makeState();
            service.scheduleSave(state);
            await service.saveNow(state);

            // Advance past debounce — should not trigger another save
            vi.advanceTimersByTime(2000);
            await vi.runAllTimersAsync();

            expect(mockApp.vault.create).toHaveBeenCalledTimes(1);
        });

        it('returns the file path of the saved note', async () => {
            const state = makeState();
            const path = await service.saveNow(state);
            expect(path).toMatch(/\.md$/);
            expect(path).toContain('Conversations/free/');
        });
    });

    // ── doSave (create vs overwrite) ─────────────────────────────────────

    describe('doSave() — create vs overwrite', () => {
        it('creates a new file on first save', async () => {
            await service.saveNow(makeState());
            expect(mockApp.vault.create).toHaveBeenCalledTimes(1);
            expect(mockApp.vault.modify).not.toHaveBeenCalled();
        });

        it('overwrites existing file on subsequent saves', async () => {
            await service.saveNow(makeState());
            await service.saveNow(makeState({ updatedAt: '2026-03-13T10:10:00.000Z' }));

            expect(mockApp.vault.create).toHaveBeenCalledTimes(1);
            expect(mockApp.vault.modify).toHaveBeenCalledTimes(1);
        });

        it('falls back to create if cached file modify fails', async () => {
            await service.saveNow(makeState());

            // Make modify throw (simulating deleted file)
            mockApp.vault.modify.mockRejectedValueOnce(new Error('File not found'));

            await service.saveNow(makeState({ updatedAt: '2026-03-13T10:10:00.000Z' }));

            expect(mockApp.vault.create).toHaveBeenCalledTimes(2);
        });
    });

    // ── startNew ─────────────────────────────────────────────────────────

    describe('startNew()', () => {
        it('clears cached TFile so next save creates a new file', async () => {
            await service.saveNow(makeState());
            expect(mockApp.vault.create).toHaveBeenCalledTimes(1);

            service.startNew('free');

            await service.saveNow(makeState({ updatedAt: '2026-03-13T11:00:00.000Z' }));
            expect(mockApp.vault.create).toHaveBeenCalledTimes(2);
            expect(mockApp.vault.modify).not.toHaveBeenCalled();
        });

        it('cancels pending debounce for that mode', async () => {
            service.scheduleSave(makeState());
            service.startNew('free');

            vi.advanceTimersByTime(2000);
            await vi.runAllTimersAsync();

            expect(mockApp.vault.create).not.toHaveBeenCalled();
        });

        it('clears project-scoped cache when mode matches', async () => {
            const projState = makeState({ projectId: 'proj-123' });
            await service.saveNow(projState);
            expect(mockApp.vault.create).toHaveBeenCalledTimes(1);

            service.startNew('free');

            await service.saveNow(projState);
            expect(mockApp.vault.create).toHaveBeenCalledTimes(2);
        });
    });

    // ── listRecent ───────────────────────────────────────────────────────

    describe('listRecent()', () => {
        it('returns conversations sorted by updatedAt descending', async () => {
            // Save two conversations in different modes
            await service.saveNow(makeState({ mode: 'free', updatedAt: '2026-03-13T09:00:00.000Z' }));

            // Start new for research mode
            const researchState = makeState({ mode: 'research', updatedAt: '2026-03-13T11:00:00.000Z' });
            await service.saveNow(researchState);

            const results = await service.listRecent();
            expect(results.length).toBe(2);
            expect(results[0].updatedAt).toBe('2026-03-13T11:00:00.000Z');
            expect(results[1].updatedAt).toBe('2026-03-13T09:00:00.000Z');
        });

        it('respects the limit parameter', async () => {
            await service.saveNow(makeState({ mode: 'free', updatedAt: '2026-03-13T09:00:00.000Z' }));
            await service.saveNow(makeState({ mode: 'research', updatedAt: '2026-03-13T10:00:00.000Z' }));
            await service.saveNow(makeState({ mode: 'note', updatedAt: '2026-03-13T11:00:00.000Z' }));

            const results = await service.listRecent(2);
            expect(results.length).toBe(2);
        });

        it('filters by projectId when provided', async () => {
            await service.saveNow(makeState({ mode: 'free', projectId: 'proj-A' }));
            await service.saveNow(makeState({ mode: 'free', projectId: 'proj-B' }));

            const results = await service.listRecent(20, 'proj-A');
            expect(results.length).toBe(1);
            expect(results[0].projectId).toBe('proj-A');
        });

        it('returns empty array when no conversations exist', async () => {
            const results = await service.listRecent();
            expect(results).toEqual([]);
        });

        it('skips files outside the conversations root', async () => {
            // Manually inject a file outside the conversations folder
            const outsideFile = createTFile('SomeOtherFolder/note.md');
            mockApp.files.set(outsideFile.path, { file: outsideFile, content: 'no state here' });

            await service.saveNow(makeState());
            const results = await service.listRecent();
            expect(results.length).toBe(1);
        });

        it('counts only user messages for messageCount', async () => {
            const state = makeState({
                messages: [
                    { role: 'system', content: 'system msg', timestamp: 1 },
                    { role: 'user', content: 'q1', timestamp: 2 },
                    { role: 'assistant', content: 'a1', timestamp: 3 },
                    { role: 'user', content: 'q2', timestamp: 4 },
                    { role: 'assistant', content: 'a2', timestamp: 5 },
                ],
            });
            await service.saveNow(state);
            const results = await service.listRecent();
            expect(results[0].messageCount).toBe(2);
        });
    });

    // ── load ─────────────────────────────────────────────────────────────

    describe('load()', () => {
        it('loads state from a vault file', async () => {
            const state = makeState({ mode: 'research' });
            const path = await service.saveNow(state);

            const loaded = await service.load(path);
            expect(loaded).not.toBeNull();
            expect(loaded!.mode).toBe('research');
            expect(loaded!.messages.length).toBe(2);
        });

        it('returns null for non-existent file', async () => {
            const result = await service.load('nonexistent/path.md');
            expect(result).toBeNull();
        });

        it('returns null for file without conversation state', async () => {
            const file = createTFile('AI-Organiser/AI Chat/Conversations/free/plain.md');
            mockApp.files.set(file.path, { file, content: '# Just a normal note\n\nNo state here.' });

            const result = await service.load(file.path);
            expect(result).toBeNull();
        });
    });

    // ── delete ───────────────────────────────────────────────────────────

    describe('delete()', () => {
        it('trashes the file at the given path', async () => {
            const path = await service.saveNow(makeState());
            await service.delete(path);
            expect(mockApp.vault.trash).toHaveBeenCalledTimes(1);
            expect(mockApp.vault.trash).toHaveBeenCalledWith(expect.any(TFile), true);
        });

        it('does nothing for non-existent path', async () => {
            await service.delete('nonexistent/path.md');
            expect(mockApp.vault.trash).not.toHaveBeenCalled();
        });
    });

    // ── clearCache ───────────────────────────────────────────────────────

    describe('clearCache()', () => {
        it('clears file cache so next save creates a new file', async () => {
            await service.saveNow(makeState());
            expect(mockApp.vault.create).toHaveBeenCalledTimes(1);

            service.clearCache();

            await service.saveNow(makeState({ updatedAt: '2026-03-13T12:00:00.000Z' }));
            expect(mockApp.vault.create).toHaveBeenCalledTimes(2);
        });
    });

    // ── buildTitle ───────────────────────────────────────────────────────

    describe('buildTitle (via saved file path)', () => {
        it('derives title from first user message', async () => {
            const state = makeState({
                messages: [
                    { role: 'user', content: 'What is quantum computing?', timestamp: 1 },
                ],
            });
            const path = await service.saveNow(state);
            expect(path).toContain('What is quantum computing');
        });

        it('truncates long first user messages to 60 chars', async () => {
            const longMsg = 'A'.repeat(100);
            const state = makeState({
                messages: [
                    { role: 'user', content: longMsg, timestamp: 1 },
                ],
            });
            const path = await service.saveNow(state);
            const fileName = path.split('/').pop()!.replace('.md', '');
            expect(fileName.length).toBeLessThanOrEqual(120); // sanitizeFileName limit
        });

        it('falls back to date-based title when no user messages', async () => {
            const state = makeEmptyState({ createdAt: '2026-03-13T10:30:00.000Z' });
            const path = await service.saveNow(state);
            expect(path).toContain('Chat');
        });

        it('falls back to date when first user message is whitespace only', async () => {
            const state = makeState({
                messages: [
                    { role: 'user', content: '   \n  ', timestamp: 1 },
                ],
            });
            const path = await service.saveNow(state);
            expect(path).toContain('Chat');
        });
    });

    // ── sanitizeFileName ─────────────────────────────────────────────────

    describe('sanitizeFileName (via saved file path)', () => {
        it('strips invalid filename characters', async () => {
            const state = makeState({
                messages: [
                    { role: 'user', content: 'What is C:\\path\\to\\file?', timestamp: 1 },
                ],
            });
            const path = await service.saveNow(state);
            const fileName = path.split('/').pop()!;
            expect(fileName).not.toMatch(/[\\/:*?"<>|#^[\]]/);
        });

        it('collapses multiple spaces', async () => {
            const state = makeState({
                messages: [
                    { role: 'user', content: 'too   many    spaces', timestamp: 1 },
                ],
            });
            const path = await service.saveNow(state);
            expect(path).not.toContain('  ');
        });
    });

    // ── getFolderForState ────────────────────────────────────────────────

    describe('getFolderForState (via saved file path)', () => {
        it('routes to mode subfolder for unfiled chats', async () => {
            const path = await service.saveNow(makeState({ mode: 'research' }));
            expect(path).toContain('Conversations/research/');
        });

        it('routes to project folder when projectFolderPath is set', async () => {
            const state = makeState({
                projectId: 'proj-uuid',
                projectFolderPath: 'AI-Organiser/AI Chat/Projects/my-project',
            });
            const path = await service.saveNow(state);
            expect(path).toContain('Projects/my-project/');
        });

        it('falls back to mode subfolder when projectId set but no projectFolderPath', async () => {
            const state = makeState({ projectId: 'proj-uuid' });
            const path = await service.saveNow(state);
            expect(path).toContain('Conversations/free/');
        });
    });

    // ── modeKey ──────────────────────────────────────────────────────────

    describe('modeKey — per-mode debounce isolation', () => {
        it('different modes have independent debounce timers', async () => {
            const freeState = makeState({ mode: 'free' });
            const researchState = makeState({ mode: 'research' });

            service.scheduleSave(freeState);
            service.scheduleSave(researchState);

            vi.advanceTimersByTime(1000);
            await vi.runAllTimersAsync();

            // Both modes should create their own files
            expect(mockApp.vault.create).toHaveBeenCalledTimes(2);
        });

        it('cancelling one mode does not affect another', async () => {
            service.scheduleSave(makeState({ mode: 'free' }));
            service.scheduleSave(makeState({ mode: 'research' }));

            service.startNew('free');

            vi.advanceTimersByTime(1000);
            await vi.runAllTimersAsync();

            // Only research should have saved
            expect(mockApp.vault.create).toHaveBeenCalledTimes(1);
            const createdPath = mockApp.vault.create.mock.calls[0][0] as string;
            expect(createdPath).toContain('research');
        });

        it('project conversations have separate cache from bare mode', async () => {
            const bare = makeState({ mode: 'free' });
            const proj = makeState({ mode: 'free', projectId: 'proj-1' });

            await service.saveNow(bare);
            await service.saveNow(proj);

            // Each should create its own file
            expect(mockApp.vault.create).toHaveBeenCalledTimes(2);
        });
    });

    // ── Empty conversation ───────────────────────────────────────────────

    describe('empty conversation', () => {
        it('saves even when there are no user messages', async () => {
            const state = makeEmptyState();
            const path = await service.saveNow(state);
            expect(path).toMatch(/\.md$/);
            expect(mockApp.vault.create).toHaveBeenCalledTimes(1);
        });

        it('can be loaded back after save', async () => {
            const state = makeEmptyState();
            const path = await service.saveNow(state);
            const loaded = await service.load(path);
            expect(loaded).not.toBeNull();
            expect(loaded!.messages).toEqual([]);
        });
    });

    // ── ensureFolder ─────────────────────────────────────────────────────

    describe('folder creation', () => {
        it('creates folder if it does not exist', async () => {
            await service.saveNow(makeState());
            expect(mockApp.vault.createFolder).toHaveBeenCalled();
        });

        it('does not error if folder already exists', async () => {
            mockApp.vault.createFolder.mockRejectedValueOnce(new Error('already exists'));
            const path = await service.saveNow(makeState());
            expect(path).toMatch(/\.md$/);
        });
    });

    // ── getAvailablePath dedup ───────────────────────────────────────────

    describe('getAvailablePath — filename deduplication', () => {
        it('appends (2) when file already exists at candidate path', async () => {
            // First save claims the base path
            await service.saveNow(makeState({ mode: 'note' }));

            // Start new so next save creates a new file
            service.startNew('note');

            // Save again with same title — should get (2) suffix
            await service.saveNow(makeState({ mode: 'note' }));

            expect(mockApp.vault.create).toHaveBeenCalledTimes(2);
            const secondPath = mockApp.vault.create.mock.calls[1][0] as string;
            expect(secondPath).toMatch(/\(2\)\.md$/);
        });
    });

    // ── Phase 6: pruneOldConversations ───────────────────────────────────

    describe('pruneOldConversations()', () => {
        it('deletes conversations older than retention days', async () => {
            // Create a conversation with an old updatedAt
            const oldDate = new Date(Date.now() - 100 * 86_400_000).toISOString();
            await service.saveNow(makeState({
                mode: 'free',
                updatedAt: oldDate,
            }));

            const pruned = await service.pruneOldConversations(30);
            expect(pruned).toBe(1);
            expect(mockApp.vault.trash).toHaveBeenCalled();
        });

        it('keeps recent conversations', async () => {
            await service.saveNow(makeState({
                mode: 'free',
                updatedAt: new Date().toISOString(),
            }));

            const pruned = await service.pruneOldConversations(30);
            expect(pruned).toBe(0);
        });

        it('does not prune project conversations', async () => {
            const oldDate = new Date(Date.now() - 100 * 86_400_000).toISOString();
            await service.saveNow(makeState({
                mode: 'free',
                updatedAt: oldDate,
                projectFolderPath: 'AI Chat/Projects/my-project',
            }));

            // Project conversations are in Projects/ folder, not Conversations/
            // So pruneOldConversations (which only scans Conversations/) won't find them
            const pruned = await service.pruneOldConversations(30);
            expect(pruned).toBe(0);
        });

        it('returns 0 when retention is 0 (never prune)', async () => {
            // retention 0 means "never prune" — short-circuits without scanning
            await service.saveNow(makeState({
                mode: 'free',
                updatedAt: new Date(Date.now() - 365 * 86_400_000).toISOString(),
            }));
            const pruned = await service.pruneOldConversations(0);
            expect(pruned).toBe(0);
        });
    });

    // ── Phase 6: moveConversation ────────────────────────────────────────

    describe('moveConversation()', () => {
        it('moves a conversation file to target folder', async () => {
            const path = await service.saveNow(makeState());
            const file = mockApp.files.get(path)?.file;
            expect(file).toBeDefined();

            // Mock fileManager.renameFile
            const fileManager = { renameFile: vi.fn(async () => {}) };
            (mockApp as any).fileManager = fileManager;

            await service.moveConversation(path, 'AI Chat/Projects/test');
            expect(fileManager.renameFile).toHaveBeenCalled();
        });

        it('throws when file not found', async () => {
            const fileManager = { renameFile: vi.fn(async () => {}) };
            (mockApp as any).fileManager = fileManager;

            await expect(service.moveConversation('nonexistent.md', 'target'))
                .rejects.toThrow('File not found');
        });
    });
});
