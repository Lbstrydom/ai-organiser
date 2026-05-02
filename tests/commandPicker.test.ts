/**
 * Tests for Command Picker Modal — output-anchored taxonomy.
 *
 * Plan: docs/completed/command-picker-output-anchored*.md (5 docs, locked
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

    describe('Essentials — user-configurable favourites (2026-05-02)', () => {
        it('uses default chat/search/quick-peek when no custom selection', () => {
            const cats = buildCommandCategories(mockTranslations, mockExecuteCommand);
            const ess = cats.find(c => c.id === 'essentials')!;
            expect(ess.commands.map(c => c.id)).toEqual([
                'chat-with-ai', 'semantic-search', 'quick-peek',
            ]);
        });

        it('replaces defaults with user selection (any IDs across the tree)', () => {
            // User pins narrate-note + smart-tag — non-cross-listed picks.
            const cats = buildCommandCategories(
                mockTranslations, mockExecuteCommand, ['narrate-note', 'smart-tag'],
            );
            const ess = cats.find(c => c.id === 'essentials')!;
            expect(ess.commands.map(c => c.id)).toEqual(['narrate-note', 'smart-tag']);
        });

        it('caps user selection at 5 commands', () => {
            const cats = buildCommandCategories(
                mockTranslations, mockExecuteCommand,
                ['chat-with-ai', 'semantic-search', 'quick-peek',
                 'narrate-note', 'smart-tag', 'kindle-sync', 'export-flashcards'],
            );
            const ess = cats.find(c => c.id === 'essentials')!;
            expect(ess.commands.length).toBe(5);
        });

        it('preserves cross-listing object identity for promoted leaves', () => {
            const cats = buildCommandCategories(
                mockTranslations, mockExecuteCommand, ['narrate-note'],
            );
            const ess = cats.find(c => c.id === 'essentials')!;
            const create = cats.find(c => c.id === 'create')!;
            const essNarrate = ess.commands.find(c => c.id === 'narrate-note')!;
            const createNarrate = create.commands.find(c => c.id === 'narrate-note')!;
            // Same object → search dedup will treat them as one command.
            expect(essNarrate).toBe(createNarrate);
        });

        it('silently skips unknown IDs', () => {
            const cats = buildCommandCategories(
                mockTranslations, mockExecuteCommand,
                ['narrate-note', 'made-up-command', 'smart-tag'],
            );
            const ess = cats.find(c => c.id === 'essentials')!;
            expect(ess.commands.map(c => c.id)).toEqual(['narrate-note', 'smart-tag']);
        });

        it('finds leaves nested in sub-groups (e.g. Create → Write → smart-summarize)', () => {
            const cats = buildCommandCategories(
                mockTranslations, mockExecuteCommand, ['smart-summarize'],
            );
            const ess = cats.find(c => c.id === 'essentials')!;
            expect(ess.commands.map(c => c.id)).toEqual(['smart-summarize']);
        });
    });

    describe('Essentials (cross-listing default)', () => {
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

    describe('Create — verb-anchored sub-groups + 3 direct leaves', () => {
        it('has 2 sub-groups (Write, Visualise) + 3 direct leaves on first expansion', () => {
            const cats = buildCommandCategories(mockTranslations, mockExecuteCommand);
            const create = cats.find(c => c.id === 'create')!;
            expect(create.commands.map(c => c.id)).toEqual([
                'create-write', 'create-visualise',
                'narrate-note', 'export-flashcards', 'smart-tag',
            ]);
        });
        it('Write sub-group contains the 5 written-output commands', () => {
            const cats = buildCommandCategories(mockTranslations, mockExecuteCommand);
            const create = cats.find(c => c.id === 'create')!;
            const write = create.commands.find(c => c.id === 'create-write')!;
            expect(write.subCommands?.map(c => c.id)).toEqual([
                'smart-summarize', 'create-meeting-minutes', 'smart-translate',
                'export-note', 'export-minutes-docx',
            ]);
        });
        it('Visualise sub-group contains the 6 visual-output commands', () => {
            const cats = buildCommandCategories(mockTranslations, mockExecuteCommand);
            const create = cats.find(c => c.id === 'create')!;
            const visualise = create.commands.find(c => c.id === 'create-visualise')!;
            expect(visualise.subCommands?.map(c => c.id)).toEqual([
                'presentation-chat', 'edit-mermaid-diagram', 'new-sketch',
                'build-investigation-canvas', 'build-context-canvas', 'build-cluster-canvas',
            ]);
        });
    });

    describe('Refine — Pending sub-group + cross-listed quick-peek', () => {
        it('first-expansion has 5 rows: improve, Pending sub-group, digitise, clear-tags, peek', () => {
            const cats = buildCommandCategories(mockTranslations, mockExecuteCommand);
            const refine = cats.find(c => c.id === 'refine')!;
            expect(refine.commands.map(c => c.id)).toEqual([
                'enhance-note', 'refine-pending', 'digitise-image', 'clear-tags', 'quick-peek',
            ]);
        });
        it('Process pending sub-group contains the 3 pending commands', () => {
            const cats = buildCommandCategories(mockTranslations, mockExecuteCommand);
            const refine = cats.find(c => c.id === 'refine')!;
            const pending = refine.commands.find(c => c.id === 'refine-pending')!;
            expect(pending.subCommands?.map(c => c.id)).toEqual([
                'integrate-pending-content', 'add-to-pending-integration', 'resolve-pending-embeds',
            ]);
        });
    });

    describe('Find — cross-lists chat + search at top, sub-groups below', () => {
        it('contains chat + search at top, then Discover + Audit sub-groups', () => {
            const cats = buildCommandCategories(mockTranslations, mockExecuteCommand);
            const find = cats.find(c => c.id === 'find')!;
            expect(find.commands.map(c => c.id)).toEqual([
                'chat-with-ai', 'semantic-search',
                'find-discover', 'find-audit',
            ]);
        });
        it('Discover sub-group contains web/research/related commands', () => {
            const cats = buildCommandCategories(mockTranslations, mockExecuteCommand);
            const find = cats.find(c => c.id === 'find')!;
            const discover = find.commands.find(c => c.id === 'find-discover')!;
            expect(discover.subCommands?.map(c => c.id)).toEqual([
                'web-reader', 'research-web', 'find-related', 'insert-related-notes',
            ]);
        });
        it('Audit sub-group contains the vault inspection commands', () => {
            const cats = buildCommandCategories(mockTranslations, mockExecuteCommand);
            const find = cats.find(c => c.id === 'find')!;
            const audit = find.commands.find(c => c.id === 'find-audit')!;
            expect(audit.subCommands?.map(c => c.id)).toEqual([
                'find-embeds', 'show-tag-network', 'collect-all-tags',
            ]);
        });
    });

    describe('Manage — 3 sub-groups + 1 direct leaf', () => {
        it('first-expansion has 4 rows: Sync, Audio, Bases sub-groups + NotebookLM leaf', () => {
            const cats = buildCommandCategories(mockTranslations, mockExecuteCommand);
            const manage = cats.find(c => c.id === 'manage')!;
            expect(manage.commands.map(c => c.id)).toEqual([
                'manage-sync', 'manage-audio', 'manage-bases', 'notebooklm-export',
            ]);
        });
        it('Sync sub-group contains kindle-sync + newsletter-fetch', () => {
            const cats = buildCommandCategories(mockTranslations, mockExecuteCommand);
            const manage = cats.find(c => c.id === 'manage')!;
            const sync = manage.commands.find(c => c.id === 'manage-sync')!;
            expect(sync.subCommands?.map(c => c.id)).toEqual(['kindle-sync', 'newsletter-fetch']);
        });
        it('Audio admin sub-group contains record + play', () => {
            const cats = buildCommandCategories(mockTranslations, mockExecuteCommand);
            const manage = cats.find(c => c.id === 'manage')!;
            const audio = manage.commands.find(c => c.id === 'manage-audio')!;
            expect(audio.subCommands?.map(c => c.id)).toEqual(['record-audio', 'play-narration']);
        });
        it('Bases sub-group contains migration + dashboard commands', () => {
            const cats = buildCommandCategories(mockTranslations, mockExecuteCommand);
            const manage = cats.find(c => c.id === 'manage')!;
            const bases = manage.commands.find(c => c.id === 'manage-bases')!;
            expect(bases.subCommands?.map(c => c.id)).toEqual([
                'upgrade-metadata', 'upgrade-folder-metadata', 'create-bases-dashboard',
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
            // play-narration now lives under the Audio admin sub-group
            const audio = manage.commands.find(c => c.id === 'manage-audio')!;
            const play = audio.subCommands!.find(c => c.id === 'play-narration')!;
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
