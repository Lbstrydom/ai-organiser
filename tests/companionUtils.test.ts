/**
 * Companion Utilities Tests
 * Tests for shouldIncludeCompanion predicate and processCompanionOutput file creation
 */

import { shouldIncludeCompanion, processCompanionOutput } from '../src/utils/companionUtils';
import { splitCompanionContent } from '../src/utils/responseParser';
import { STUDY_COMPANION_DELIMITER } from '../src/services/prompts/summaryPrompts';
import { TFile } from 'obsidian';

// ── Mocks ──

// Track Notice calls
const noticeMessages: string[] = [];
vi.mock('obsidian', async () => {
    const actual = await vi.importActual<Record<string, unknown>>('obsidian');
    return {
        ...actual,
        Notice: class MockNotice {
            constructor(msg: string) {
                noticeMessages.push(msg);
            }
        },
        TFile: class TFile {
            path: string;
            basename: string;
            parent: { path: string } | null;
            constructor(path: string, basename: string, parentPath: string | null) {
                this.path = path;
                this.basename = basename;
                this.parent = parentPath !== null ? { path: parentPath } : null;
            }
        },
    };
});

// Mock minutesUtils
vi.mock('../src/utils/minutesUtils', () => ({
    ensureFolderExists: vi.fn().mockResolvedValue(undefined),
    getAvailableFilePath: vi.fn().mockImplementation(
        (_vault: unknown, folderPath: string, fileName: string) =>
            Promise.resolve(folderPath ? `${folderPath}/${fileName}` : fileName)
    ),
}));

import { ensureFolderExists, getAvailableFilePath } from '../src/utils/minutesUtils';

// Helper to create a mock plugin
function createMockPlugin(overrides?: { createFails?: boolean }) {
    const createdFiles: { path: string; content: string }[] = [];
    return {
        plugin: {
            app: {
                vault: {
                    create: vi.fn().mockImplementation((path: string, content: string) => {
                        if (overrides?.createFails) {
                            return Promise.reject(new Error('Vault write failed'));
                        }
                        createdFiles.push({ path, content });
                        return Promise.resolve();
                    }),
                },
            },
            t: {
                messages: {
                    companionCreated: 'Study companion note created',
                    companionCreateFailed: 'Could not create companion note',
                },
            },
        } as any,
        createdFiles,
    };
}

// Helper to create a mock TFile
function createMockFile(path: string, basename: string, parentPath: string | null): TFile {
    return {
        path,
        basename,
        parent: parentPath !== null ? { path: parentPath } : null,
    } as any;
}

// ── Tests ──

describe('shouldIncludeCompanion', () => {
    it('returns true only when personaId is study AND includeCompanion is true', () => {
        expect(shouldIncludeCompanion('study', true)).toBe(true);
    });

    it('returns false for non-study persona even with includeCompanion true', () => {
        expect(shouldIncludeCompanion('default', true)).toBe(false);
        expect(shouldIncludeCompanion('executive', true)).toBe(false);
        expect(shouldIncludeCompanion('creative', true)).toBe(false);
    });

    it('returns false when includeCompanion is false or undefined regardless of persona', () => {
        expect(shouldIncludeCompanion('study', false)).toBe(false);
        expect(shouldIncludeCompanion('study', undefined)).toBe(false);
        expect(shouldIncludeCompanion(undefined, true)).toBe(false);
        expect(shouldIncludeCompanion(undefined, undefined)).toBe(false);
    });

    // Phase 5: enableStudyCompanion setting gate
    it('returns false when enableStudyCompanion setting is false, even with study + true', () => {
        expect(shouldIncludeCompanion('study', true, false)).toBe(false);
    });

    it('returns true when enableStudyCompanion setting is true with study + true', () => {
        expect(shouldIncludeCompanion('study', true, true)).toBe(true);
    });

    it('returns true when enableStudyCompanion is undefined (backward compat default)', () => {
        // Omitting the 3rd arg should not block — backward compat for callers that don't pass it
        expect(shouldIncludeCompanion('study', true, undefined)).toBe(true);
        expect(shouldIncludeCompanion('study', true)).toBe(true);
    });

    it('returns false for non-study even when enableStudyCompanion is true', () => {
        expect(shouldIncludeCompanion('default', true, true)).toBe(false);
        expect(shouldIncludeCompanion('executive', true, true)).toBe(false);
    });

    it('setting=false blocks companion regardless of other params', () => {
        expect(shouldIncludeCompanion('study', true, false)).toBe(false);
        expect(shouldIncludeCompanion('study', false, false)).toBe(false);
        expect(shouldIncludeCompanion('default', true, false)).toBe(false);
        expect(shouldIncludeCompanion(undefined, undefined, false)).toBe(false);
    });
});

describe('processCompanionOutput', () => {
    beforeEach(() => {
        noticeMessages.length = 0;
        vi.clearAllMocks();
    });

    it('creates companion file with correct content and frontmatter', async () => {
        const { plugin, createdFiles } = createMockPlugin();
        const file = createMockFile('Notes/My Note.md', 'My Note', 'Notes');

        const result = await processCompanionOutput(plugin, 'Companion explanation text', file);

        expect(result).toBe('Notes/My Note (Study Companion).md');
        expect(createdFiles).toHaveLength(1);
        expect(createdFiles[0].path).toBe('Notes/My Note (Study Companion).md');
        expect(createdFiles[0].content).toContain('---');
        expect(createdFiles[0].content).toContain('companion_to: "[[Notes/My Note.md|My Note]]"');
        expect(createdFiles[0].content).toContain('Companion explanation text');
    });

    it('returns null for undefined companion content', async () => {
        const { plugin } = createMockPlugin();
        const file = createMockFile('Note.md', 'Note', '');

        const result = await processCompanionOutput(plugin, undefined, file);

        expect(result).toBeNull();
    });

    it('returns null for empty string companion content', async () => {
        const { plugin } = createMockPlugin();
        const file = createMockFile('Note.md', 'Note', '');

        const result = await processCompanionOutput(plugin, '', file);

        expect(result).toBeNull();
    });

    it('returns null for whitespace-only companion content', async () => {
        const { plugin } = createMockPlugin();
        const file = createMockFile('Note.md', 'Note', '');

        const result = await processCompanionOutput(plugin, '   \n\t  ', file);

        expect(result).toBeNull();
    });

    it('uses getAvailableFilePath for collision handling', async () => {
        const { plugin } = createMockPlugin();
        const file = createMockFile('Folder/Note.md', 'Note', 'Folder');

        // Mock collision: return suffixed path
        vi.mocked(getAvailableFilePath).mockResolvedValueOnce('Folder/Note (Study Companion) 2.md');

        const result = await processCompanionOutput(plugin, 'Content', file);

        expect(result).toBe('Folder/Note (Study Companion) 2.md');
        expect(getAvailableFilePath).toHaveBeenCalledWith(
            expect.anything(),
            'Folder',
            'Note (Study Companion).md'
        );
    });

    it('returns null and shows error notice when vault.create fails', async () => {
        const { plugin } = createMockPlugin({ createFails: true });
        const file = createMockFile('Note.md', 'Note', '');

        const result = await processCompanionOutput(plugin, 'Content', file);

        expect(result).toBeNull();
        expect(noticeMessages).toContain('Could not create companion note');
    });

    it('uses full path in frontmatter wikilink for disambiguation', async () => {
        const { plugin, createdFiles } = createMockPlugin();
        const file = createMockFile('Deep/Nested/Folder/Note.md', 'Note', 'Deep/Nested/Folder');

        await processCompanionOutput(plugin, 'Content', file);

        expect(createdFiles[0].content).toContain(
            'companion_to: "[[Deep/Nested/Folder/Note.md|Note]]"'
        );
    });

    it('creates companion in same folder as original', async () => {
        const { plugin } = createMockPlugin();
        const file = createMockFile('Projects/Research.md', 'Research', 'Projects');

        await processCompanionOutput(plugin, 'Content', file);

        expect(ensureFolderExists).toHaveBeenCalledWith(expect.anything(), 'Projects');
        expect(getAvailableFilePath).toHaveBeenCalledWith(
            expect.anything(),
            'Projects',
            'Research (Study Companion).md'
        );
    });

    it('shows success notice on creation', async () => {
        const { plugin } = createMockPlugin();
        const file = createMockFile('Note.md', 'Note', '');

        await processCompanionOutput(plugin, 'Content', file);

        expect(noticeMessages).toContain('Study companion note created');
    });

    it('handles root-level files (null parent)', async () => {
        const { plugin } = createMockPlugin();
        const file = createMockFile('RootNote.md', 'RootNote', null);

        const result = await processCompanionOutput(plugin, 'Content', file);

        expect(result).toBe('RootNote (Study Companion).md');
        expect(ensureFolderExists).toHaveBeenCalledWith(expect.anything(), '');
    });
});

describe('Structured fallback safety net', () => {
    it('splitCompanionContent extracts companion from text containing delimiter', () => {
        const bodyWithDelimiter = `Main summary content here.

${STUDY_COMPANION_DELIMITER}
This is the companion explanation that was leaked into body_content.`;

        const result = splitCompanionContent(bodyWithDelimiter);

        expect(result.summary).toBe('Main summary content here.');
        expect(result.companion).toBe(
            'This is the companion explanation that was leaked into body_content.'
        );
    });

    it('splitCompanionContent returns full text when no delimiter present', () => {
        const plainBody = 'Just a regular summary without any companion.';

        const result = splitCompanionContent(plainBody);

        expect(result.summary).toBe(plainBody);
        expect(result.companion).toBeUndefined();
    });
});
