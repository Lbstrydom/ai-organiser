/**
 * Tests for Command Picker Modal — output-anchored taxonomy.
 *
 * Plan: docs/plans/command-picker-output-anchored*.md (5 docs, locked
 * after 3 GPT audit rounds + 3 Gemini final reviews — APPROVE).
 */

import { buildCommandCategories, type PickerCommand } from '../src/ui/modals/CommandPickerModal';
import { en } from '../src/i18n/en';

function countLeafCommands(commands: PickerCommand[]): number {
    return commands.reduce((total, command) => {
        if (!command.subCommands || command.subCommands.length === 0) {
            return total + 1;
        }
        return total + countLeafCommands(command.subCommands);
    }, 0);
}

function collectLeafCommands(commands: PickerCommand[]): PickerCommand[] {
    return commands.flatMap((command) => {
        if (!command.subCommands || command.subCommands.length === 0) {
            return [command];
        }
        return collectLeafCommands(command.subCommands);
    });
}

describe('Command Picker — output-anchored taxonomy', () => {
    const mockTranslations = en;
    const mockExecuteCommand = vi.fn();

    describe('buildCommandCategories — top-level structure', () => {
        it('returns the 5 locked categories in order', () => {
            const categories = buildCommandCategories(mockTranslations, mockExecuteCommand);
            expect(categories.map(c => c.id)).toEqual([
                'essentials', 'create', 'refine', 'find', 'manage',
            ]);
        });

        it('category names resolve through i18n', () => {
            const categories = buildCommandCategories(mockTranslations, mockExecuteCommand);
            expect(categories.map(c => c.name)).toEqual([
                en.modals.commandPicker.categoryEssentials,
                en.modals.commandPicker.categoryCreate,
                en.modals.commandPicker.categoryRefine,
                en.modals.commandPicker.categoryFind,
                en.modals.commandPicker.categoryManage,
            ]);
        });
    });

    describe('Essentials', () => {
        it('contains chat / search / quick-peek (canonical)', () => {
            const cats = buildCommandCategories(mockTranslations, mockExecuteCommand);
            const ess = cats.find(c => c.id === 'essentials')!;
            expect(ess.commands.map(c => c.id)).toEqual([
                'chat-with-ai', 'semantic-search', 'quick-peek',
            ]);
        });
        it('cross-listed entries declare canonicalCategoryId === "essentials"', () => {
            const cats = buildCommandCategories(mockTranslations, mockExecuteCommand);
            const ess = cats.find(c => c.id === 'essentials')!;
            for (const c of ess.commands) {
                expect(c.canonicalCategoryId).toBe('essentials');
            }
        });
    });

    describe('Create — flat 14 leaves, no sub-groups', () => {
        it('has 14 direct leaves with no subCommands', () => {
            const cats = buildCommandCategories(mockTranslations, mockExecuteCommand);
            const create = cats.find(c => c.id === 'create')!;
            expect(create.commands.length).toBe(14);
            expect(create.commands.every(c => !c.subCommands || c.subCommands.length === 0)).toBe(true);
        });
        it('exact leaf-id list matches the locked matrix', () => {
            const cats = buildCommandCategories(mockTranslations, mockExecuteCommand);
            const create = cats.find(c => c.id === 'create')!;
            expect(create.commands.map(c => c.id)).toEqual([
                'smart-summarize', 'create-meeting-minutes', 'smart-translate',
                'narrate-note', 'export-flashcards', 'export-note', 'export-minutes-docx',
                'smart-tag', 'presentation-chat', 'edit-mermaid-diagram', 'new-sketch',
                'build-investigation-canvas', 'build-context-canvas', 'build-cluster-canvas',
            ]);
        });
    });

    describe('Refine — cross-lists quick-peek', () => {
        it('contains 7 leaves; last is the cross-listed quick-peek', () => {
            const cats = buildCommandCategories(mockTranslations, mockExecuteCommand);
            const refine = cats.find(c => c.id === 'refine')!;
            expect(refine.commands.map(c => c.id)).toEqual([
                'enhance-note', 'integrate-pending-content', 'add-to-pending-integration',
                'resolve-pending-embeds', 'digitise-image', 'clear-tags',
                'quick-peek',
            ]);
        });
    });

    describe('Find — cross-lists chat + search', () => {
        it('contains 9 leaves; last 2 are cross-listed chat + search', () => {
            const cats = buildCommandCategories(mockTranslations, mockExecuteCommand);
            const find = cats.find(c => c.id === 'find')!;
            expect(find.commands.map(c => c.id)).toEqual([
                'web-reader', 'research-web', 'find-related', 'insert-related-notes',
                'find-embeds', 'show-tag-network', 'collect-all-tags',
                'chat-with-ai', 'semantic-search',
            ]);
        });
    });

    describe('Manage — admin + recurring fetches', () => {
        it('contains all expected leaves incl newly-surfaced migration', () => {
            const cats = buildCommandCategories(mockTranslations, mockExecuteCommand);
            const manage = cats.find(c => c.id === 'manage')!;
            expect(manage.commands.map(c => c.id)).toEqual([
                'kindle-sync', 'newsletter-fetch', 'record-audio', 'play-narration',
                'upgrade-metadata', 'upgrade-folder-metadata',
                'create-bases-dashboard', 'notebooklm-export',
            ]);
        });
    });

    describe('Cross-listing identity', () => {
        it('cross-listed commands share callback identity (same object)', () => {
            const cats = buildCommandCategories(mockTranslations, mockExecuteCommand);
            const ess = cats.find(c => c.id === 'essentials')!;
            const find = cats.find(c => c.id === 'find')!;
            const refine = cats.find(c => c.id === 'refine')!;
            const essChat = ess.commands.find(c => c.id === 'chat-with-ai')!;
            const findChat = find.commands.find(c => c.id === 'chat-with-ai')!;
            expect(essChat).toBe(findChat);

            const essPeek = ess.commands.find(c => c.id === 'quick-peek')!;
            const refinePeek = refine.commands.find(c => c.id === 'quick-peek')!;
            expect(essPeek).toBe(refinePeek);
        });
    });

    describe('requires field — every leaf has a valid kind', () => {
        const VALID = new Set(['none', 'active-note', 'selection', 'vault', 'semantic-search']);
        it('every leaf declares a known requires value', () => {
            const cats = buildCommandCategories(mockTranslations, mockExecuteCommand);
            const leaves = cats.flatMap(c => collectLeafCommands(c.commands));
            for (const l of leaves) {
                expect(typeof l.requires).toBe('string');
                expect(VALID.has(l.requires!)).toBe(true);
            }
        });
        it('semantic-search command requires "semantic-search"', () => {
            const cats = buildCommandCategories(mockTranslations, mockExecuteCommand);
            const ess = cats.find(c => c.id === 'essentials')!;
            const search = ess.commands.find(c => c.id === 'semantic-search')!;
            expect(search.requires).toBe('semantic-search');
        });
        it('notebooklm-export requires "vault" (Gemini-G1 fix)', () => {
            const cats = buildCommandCategories(mockTranslations, mockExecuteCommand);
            const manage = cats.find(c => c.id === 'manage')!;
            const nbExport = manage.commands.find(c => c.id === 'notebooklm-export')!;
            expect(nbExport.requires).toBe('vault');
        });
    });

    describe('legacyHomes — backward-compat alias derivation', () => {
        it('moved commands declare legacyHomes (preserves search vocabulary)', () => {
            const cats = buildCommandCategories(mockTranslations, mockExecuteCommand);
            const create = cats.find(c => c.id === 'create')!;
            const narrate = create.commands.find(c => c.id === 'narrate-note')!;
            // narrate-note moved out of Active Note → Export
            expect(narrate.legacyHomes).toContain('active-note-export');
            // Aliases should now include "export" + "active note"
            expect(narrate.aliases).toContain('export');
            expect(narrate.aliases).toContain('active note');
        });
        it('play-narration also has active-note-export legacy home (Gemini-G4 — was missing under manual approach)', () => {
            const cats = buildCommandCategories(mockTranslations, mockExecuteCommand);
            const manage = cats.find(c => c.id === 'manage')!;
            const play = manage.commands.find(c => c.id === 'play-narration')!;
            expect(play.legacyHomes).toContain('active-note-export');
            expect(play.aliases).toContain('export');
        });
    });

    describe('counts', () => {
        it('total picker rows = 41 (38 unique + 3 cross-listings)', () => {
            const cats = buildCommandCategories(mockTranslations, mockExecuteCommand);
            const leafCount = cats.reduce((sum, cat) => sum + countLeafCommands(cat.commands), 0);
            expect(leafCount).toBe(41);
        });
        it('unique command IDs = 38', () => {
            const cats = buildCommandCategories(mockTranslations, mockExecuteCommand);
            const leaves = cats.flatMap(c => collectLeafCommands(c.commands));
            const uniqueIds = new Set(leaves.map(l => l.id));
            expect(uniqueIds.size).toBe(38);
        });

        it('alphabetised ai-organiser:* callbacks (38 unique)', () => {
            const cats = buildCommandCategories(mockTranslations, mockExecuteCommand);
            const leaves = cats.flatMap(c => collectLeafCommands(c.commands));
            mockExecuteCommand.mockClear();
            // Each callback may be present multiple times via cross-listing —
            // calling once via Set keeps the test about unique callbacks fired.
            const seen = new Set<PickerCommand>();
            for (const leaf of leaves) {
                if (seen.has(leaf)) continue;
                seen.add(leaf);
                leaf.callback();
            }
            const unique = new Set(mockExecuteCommand.mock.calls.map(call => call[0]));
            expect(Array.from(unique).sort((a, b) => String(a).localeCompare(String(b)))).toEqual([
                'ai-organiser:add-to-pending-integration',
                'ai-organiser:build-cluster-canvas',
                'ai-organiser:build-context-canvas',
                'ai-organiser:build-investigation-canvas',
                'ai-organiser:chat-with-ai',
                'ai-organiser:clear-tags',
                'ai-organiser:collect-all-tags',
                'ai-organiser:create-bases-dashboard',
                'ai-organiser:create-meeting-minutes',
                'ai-organiser:digitise-image',
                'ai-organiser:edit-mermaid-diagram',
                'ai-organiser:enhance-note',
                'ai-organiser:export-flashcards',
                'ai-organiser:export-minutes-docx',
                'ai-organiser:export-note',
                'ai-organiser:find-embeds',
                'ai-organiser:find-related',
                'ai-organiser:insert-related-notes',
                'ai-organiser:integrate-pending-content',
                'ai-organiser:kindle-sync',
                'ai-organiser:narrate-note',
                'ai-organiser:new-sketch',
                'ai-organiser:newsletter-fetch',
                'ai-organiser:notebooklm-export',
                'ai-organiser:play-narration',
                'ai-organiser:presentation-chat',
                'ai-organiser:quick-peek',
                'ai-organiser:record-audio',
                'ai-organiser:research-web',
                'ai-organiser:resolve-pending-embeds',
                'ai-organiser:semantic-search',
                'ai-organiser:show-tag-network',
                'ai-organiser:smart-summarize',
                'ai-organiser:smart-tag',
                'ai-organiser:smart-translate',
                'ai-organiser:upgrade-folder-metadata',
                'ai-organiser:upgrade-metadata',
                'ai-organiser:web-reader',
            ]);
            expect(unique.size).toBe(38);
        });
    });
});
