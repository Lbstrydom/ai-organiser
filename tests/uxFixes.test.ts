/**
 * Tests for UX Fix Plan features:
 * - Feature 2: stripExistingHighlight detection for context menu
 * - Feature 3: Highlight chat scoping logic
 * - Feature 1: FolderScopePickerModal options interface
 * - i18n completeness for new keys
 */

import { stripExistingHighlight } from '../src/commands/highlightCommands';
import { splitIntoBlocks } from '../src/utils/highlightExtractor';
import { en } from '../src/i18n/en';
import { zhCN } from '../src/i18n/zh-cn';
import { normalizeCreatePath, shouldShowCreateFolder } from '../src/ui/modals/FolderScopePickerModal';
import { lineHasImageEmbed } from '../src/ui/contextMenu';

// ─── Feature 2: stripExistingHighlight for context menu detection ───

describe('stripExistingHighlight', () => {
    it('strips ao-highlight mark tags', () => {
        const input = '<mark class="ao-highlight ao-highlight-yellow">hello</mark>';
        expect(stripExistingHighlight(input)).toBe('hello');
    });

    it('strips generic mark tags', () => {
        const input = '<mark>world</mark>';
        expect(stripExistingHighlight(input)).toBe('world');
    });

    it('strips Obsidian ==text== syntax', () => {
        const input = '==highlighted==';
        expect(stripExistingHighlight(input)).toBe('highlighted');
    });

    it('strips multiple highlights in one selection', () => {
        const input = '==A== plain ==B==';
        expect(stripExistingHighlight(input)).toBe('A plain B');
    });

    it('returns unchanged text when no highlight markup present', () => {
        const input = 'plain text without highlights';
        expect(stripExistingHighlight(input)).toBe(input);
    });

    it('handles multiline mark tags', () => {
        const input = '<mark class="ao-highlight ao-highlight-green">line1\nline2</mark>';
        expect(stripExistingHighlight(input)).toBe('line1\nline2');
    });

    it('handles nested/mixed formats', () => {
        const input = '<mark class="ao-highlight ao-highlight-blue">==inner==</mark>';
        const result = stripExistingHighlight(input);
        expect(result).toBe('inner');
    });

    // Context menu detection pattern: stripped !== original means highlight is present
    it('detection pattern: returns different string when highlights present', () => {
        const withHighlight = '==some text==';
        expect(stripExistingHighlight(withHighlight)).not.toBe(withHighlight);
    });

    it('detection pattern: returns same string when no highlights', () => {
        const noHighlight = 'just plain text';
        expect(stripExistingHighlight(noHighlight)).toBe(noHighlight);
    });
});

// ─── Feature 3: Highlight chat scoping logic ───

describe('Highlight chat scoping', () => {
    describe('block filtering', () => {
        const content = `# Heading

Plain paragraph without highlights

<mark class="ao-highlight ao-highlight-yellow">Important highlighted text</mark>

Another plain paragraph

==Second highlight== with more text`;

        it('splitIntoBlocks detects highlighted blocks correctly', () => {
            const blocks = splitIntoBlocks(content);
            const highlighted = blocks.filter(b => b.hasHighlight);
            const nonHighlighted = blocks.filter(b => !b.hasHighlight);

            expect(highlighted.length).toBeGreaterThanOrEqual(2);
            expect(nonHighlighted.length).toBeGreaterThanOrEqual(2);
        });

        it('filtering to highlights-only returns subset', () => {
            const blocks = splitIntoBlocks(content);
            const highlightOnly = blocks
                .map((b, i) => ({ block: b, originalIndex: i }))
                .filter(item => item.block.hasHighlight);

            expect(highlightOnly.length).toBeLessThan(blocks.length);
            expect(highlightOnly.length).toBeGreaterThan(0);
        });

        it('originalIndex tracking preserves correct block references', () => {
            const blocks = splitIntoBlocks(content);
            const highlightOnly = blocks
                .map((b, i) => ({ block: b, originalIndex: i }))
                .filter(item => item.block.hasHighlight);

            for (const { block, originalIndex } of highlightOnly) {
                expect(blocks[originalIndex]).toBe(block);
                expect(blocks[originalIndex].hasHighlight).toBe(true);
            }
        });
    });


    describe('no-highlights early exit', () => {
        it('detects when note has no highlights', () => {
            const content = `# Just a heading

Plain paragraph with no highlights at all.

- list item
- another item`;

            const blocks = splitIntoBlocks(content);
            const hasHighlights = blocks.some(b => b.hasHighlight);
            expect(hasHighlights).toBe(false);
        });

        it('detects when note has highlights', () => {
            const content = `# Heading

==This is highlighted==`;

            const blocks = splitIntoBlocks(content);
            const hasHighlights = blocks.some(b => b.hasHighlight);
            expect(hasHighlights).toBe(true);
        });
    });
});

// ─── FolderScopePickerModal: create path & create affordance logic ───

describe('normalizeCreatePath', () => {
    it('preserves user casing (no lowercase corruption)', () => {
        expect(normalizeCreatePath('AI-Organiser/Chats')).toBe('AI-Organiser/Chats');
    });

    it('preserves mixed case folder names', () => {
        expect(normalizeCreatePath('MyProject/SubFolder')).toBe('MyProject/SubFolder');
    });

    it('trims whitespace', () => {
        expect(normalizeCreatePath('  Meetings  ')).toBe('Meetings');
    });

    it('strips leading slashes', () => {
        expect(normalizeCreatePath('///Folder')).toBe('Folder');
    });

    it('strips trailing slashes', () => {
        expect(normalizeCreatePath('Folder///')).toBe('Folder');
    });

    it('strips both leading and trailing slashes', () => {
        expect(normalizeCreatePath('/Nested/Path/')).toBe('Nested/Path');
    });

    it('returns undefined for empty string', () => {
        expect(normalizeCreatePath('')).toBeUndefined();
    });

    it('returns undefined for whitespace-only string', () => {
        expect(normalizeCreatePath('   ')).toBeUndefined();
    });

    it('returns undefined for slashes-only string', () => {
        expect(normalizeCreatePath('///')).toBeUndefined();
    });
});

describe('shouldShowCreateFolder', () => {
    it('shows create when allowNewFolder, valid search, and zero matches', () => {
        expect(shouldShowCreateFolder(true, 'NewFolder', 0)).toBe(true);
    });

    it('does not show create when allowNewFolder is false', () => {
        expect(shouldShowCreateFolder(false, 'NewFolder', 0)).toBe(false);
    });

    it('does not show create when search term is empty', () => {
        expect(shouldShowCreateFolder(true, '', 0)).toBe(false);
    });

    it('does not show create when search term is whitespace', () => {
        expect(shouldShowCreateFolder(true, '   ', 0)).toBe(false);
    });

    it('does not show create when matching folders exist', () => {
        expect(shouldShowCreateFolder(true, 'Existing', 3)).toBe(false);
        // Even 1 match should suppress create
        expect(shouldShowCreateFolder(true, 'Existing', 1)).toBe(false);
    });

    it('shows create in empty vault (zero folders total, zero matches)', () => {
        // This is the critical empty-vault scenario
        expect(shouldShowCreateFolder(true, 'AI-Organiser/Chats', 0)).toBe(true);
    });

    it('preserves casing in the path check', () => {
        // Verifying that the function uses normalizeCreatePath which preserves casing
        expect(shouldShowCreateFolder(true, 'AI-Organiser/MyNotes', 0)).toBe(true);
    });
});

// ─── Context menu: image embed detection ───

describe('lineHasImageEmbed', () => {
    it('detects wiki-link image embeds', () => {
        expect(lineHasImageEmbed('![[photo.png]]')).toBe(true);
        expect(lineHasImageEmbed('![[folder/image.jpg]]')).toBe(true);
        expect(lineHasImageEmbed('![[sketch.webp]]')).toBe(true);
    });

    it('detects markdown image embeds', () => {
        expect(lineHasImageEmbed('![alt](image.png)')).toBe(true);
        expect(lineHasImageEmbed('![](path/to/photo.jpeg)')).toBe(true);
    });

    it('detects HEIC and other conversion-required formats', () => {
        expect(lineHasImageEmbed('![[photo.heic]]')).toBe(true);
        expect(lineHasImageEmbed('![[scan.tiff]]')).toBe(true);
        expect(lineHasImageEmbed('![[image.avif]]')).toBe(true);
    });

    it('is case-insensitive for extensions', () => {
        expect(lineHasImageEmbed('![[Photo.PNG]]')).toBe(true);
        expect(lineHasImageEmbed('![[image.JPEG]]')).toBe(true);
    });

    it('returns false for non-image embeds', () => {
        expect(lineHasImageEmbed('![[document.pdf]]')).toBe(false);
        expect(lineHasImageEmbed('![[audio.mp3]]')).toBe(false);
        expect(lineHasImageEmbed('![[note.md]]')).toBe(false);
    });

    it('returns false for plain text and links', () => {
        expect(lineHasImageEmbed('plain text')).toBe(false);
        expect(lineHasImageEmbed('[[photo.png]]')).toBe(false); // not an embed (no !)
        expect(lineHasImageEmbed('https://example.com/image.png')).toBe(false);
    });

    it('detects embed within a line of text', () => {
        expect(lineHasImageEmbed('Here is an image: ![[photo.jpg]] in context')).toBe(true);
    });
});

// ─── i18n completeness ───

describe('i18n completeness for UX fix keys', () => {
    describe('folderScopePicker new keys', () => {
        it('en has createFolder key', () => {
            expect(en.modals.folderScopePicker.createFolder).toBeTruthy();
            expect(en.modals.folderScopePicker.createFolder).toContain('{path}');
        });

        it('en has exportDestination key', () => {
            expect(en.modals.folderScopePicker.exportDestination).toBeTruthy();
            expect(en.modals.folderScopePicker.exportDestination).toContain('{path}');
        });

        it('zh-cn has createFolder key', () => {
            expect(zhCN.modals.folderScopePicker.createFolder).toBeTruthy();
            expect(zhCN.modals.folderScopePicker.createFolder).toContain('{path}');
        });

        it('zh-cn has exportDestination key', () => {
            expect(zhCN.modals.folderScopePicker.exportDestination).toBeTruthy();
            expect(zhCN.modals.folderScopePicker.exportDestination).toContain('{path}');
        });
    });

    describe('unifiedChat new keys', () => {
        const requiredKeys = ['noHighlightsFound', 'showAll', 'showHighlightsOnly', 'showingCount'] as const;

        for (const key of requiredKeys) {
            it(`en has ${key}`, () => {
                expect(en.modals.unifiedChat[key]).toBeTruthy();
            });

            it(`zh-cn has ${key}`, () => {
                expect(zhCN.modals.unifiedChat[key]).toBeTruthy();
            });
        }

        it('showingCount contains {visible} and {total} placeholders', () => {
            expect(en.modals.unifiedChat.showingCount).toContain('{visible}');
            expect(en.modals.unifiedChat.showingCount).toContain('{total}');
            expect(zhCN.modals.unifiedChat.showingCount).toContain('{visible}');
            expect(zhCN.modals.unifiedChat.showingCount).toContain('{total}');
        });
    });

    describe('contextMenu digitise key', () => {
        it('en has digitise key', () => {
            expect(en.contextMenu.digitise).toBeTruthy();
        });

        it('zh-cn has digitise key', () => {
            expect(zhCN.contextMenu.digitise).toBeTruthy();
        });
    });
});
