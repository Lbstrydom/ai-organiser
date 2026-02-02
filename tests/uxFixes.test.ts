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
import type { FolderScopePickerOptions } from '../src/ui/modals/FolderScopePickerModal';

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

    describe('selection-state rules', () => {
        it('auto-deselect non-highlighted blocks on toggle-back', () => {
            const blocks = splitIntoBlocks(`Plain text

<mark class="ao-highlight ao-highlight-yellow">Highlighted</mark>

More plain text`);

            // Simulate: user selects all blocks while "show all" is on
            const selectedIndices = new Set<number>();
            blocks.forEach((_b, i) => selectedIndices.add(i));

            // Toggle back to "highlights only" — auto-deselect non-highlighted
            const toRemove = Array.from(selectedIndices).filter(idx => !blocks[idx].hasHighlight);
            for (const idx of toRemove) {
                selectedIndices.delete(idx);
            }

            // Only highlighted blocks should remain selected
            for (const idx of selectedIndices) {
                expect(blocks[idx].hasHighlight).toBe(true);
            }
        });

        it('highlighted selections survive toggle-back', () => {
            const blocks = splitIntoBlocks(`<mark class="ao-highlight ao-highlight-yellow">First highlight</mark>

Plain text

==Second highlight==`);

            const selectedIndices = new Set<number>();
            blocks.forEach((b, i) => {
                if (b.hasHighlight) selectedIndices.add(i);
            });

            const beforeCount = selectedIndices.size;

            // Toggle back — should not remove highlighted selections
            const toRemove = Array.from(selectedIndices).filter(idx => !blocks[idx].hasHighlight);
            for (const idx of toRemove) {
                selectedIndices.delete(idx);
            }

            expect(selectedIndices.size).toBe(beforeCount);
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

// ─── Feature 1: FolderScopePickerModal options interface ───

describe('FolderScopePickerOptions interface', () => {
    it('supports confirmButtonText option', () => {
        const options: FolderScopePickerOptions = {
            onSelect: () => {},
            confirmButtonText: 'Export'
        };
        expect(options.confirmButtonText).toBe('Export');
    });

    it('supports allowNewFolder option', () => {
        const options: FolderScopePickerOptions = {
            onSelect: () => {},
            allowNewFolder: true
        };
        expect(options.allowNewFolder).toBe(true);
    });

    it('supports resolvePreview callback', () => {
        const resolver = (path: string) => `AI-Organiser/${path}`;
        const options: FolderScopePickerOptions = {
            onSelect: () => {},
            resolvePreview: resolver
        };
        expect(options.resolvePreview!('Chats')).toBe('AI-Organiser/Chats');
    });

    it('all new options are optional (backward compat)', () => {
        const options: FolderScopePickerOptions = {
            onSelect: () => {}
        };
        expect(options.confirmButtonText).toBeUndefined();
        expect(options.allowNewFolder).toBeUndefined();
        expect(options.resolvePreview).toBeUndefined();
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

    describe('highlightChat new keys', () => {
        const requiredKeys = ['noHighlightsFound', 'showAllPassages', 'showHighlightsOnly', 'showingCount'] as const;

        for (const key of requiredKeys) {
            it(`en has ${key}`, () => {
                expect(en.highlightChat[key]).toBeTruthy();
            });

            it(`zh-cn has ${key}`, () => {
                expect(zhCN.highlightChat[key]).toBeTruthy();
            });
        }

        it('showingCount contains {visible} and {total} placeholders', () => {
            expect(en.highlightChat.showingCount).toContain('{visible}');
            expect(en.highlightChat.showingCount).toContain('{total}');
            expect(zhCN.highlightChat.showingCount).toContain('{visible}');
            expect(zhCN.highlightChat.showingCount).toContain('{total}');
        });
    });
});
