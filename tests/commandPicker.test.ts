/**
 * Tests for Command Picker Modal — unified workflow-stage taxonomy.
 *
 * Plan: docs/plans/unified-feature-taxonomy.md (audit-converged — GPT ×3 + Gemini APPROVE).
 * Categories = Pinned + the 5 workflow stages (capture/create/refine/find/maintain).
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

describe('Command Picker — unified workflow-stage taxonomy', () => {
    const mockTranslations = en;
    const mockExecuteCommand = vi.fn();

    describe('buildCommandCategories — top-level structure', () => {
        it('returns Pinned + the 5 workflow-stage categories in order', () => {
            const categories = buildCommandCategories(mockTranslations, mockExecuteCommand);
            expect(categories.map(c => c.id)).toEqual([
                'pinned', 'capture', 'create', 'refine', 'find', 'maintain',
            ]);
        });

        it('category names resolve through i18n (stages share t.workflowStages.*)', () => {
            const categories = buildCommandCategories(mockTranslations, mockExecuteCommand);
            expect(categories.map(c => c.name)).toEqual([
                en.modals.commandPicker.categoryPinned,
                en.workflowStages.capture,
                en.workflowStages.create,
                en.workflowStages.refine,
                en.workflowStages.find,
                en.workflowStages.maintain,
            ]);
        });
    });

    describe('Pinned — user-configurable favourites', () => {
        it('uses default chat/search/quick-peek when no custom selection', () => {
            const cats = buildCommandCategories(mockTranslations, mockExecuteCommand);
            const pinned = cats.find(c => c.id === 'pinned')!;
            expect(pinned.commands.map(c => c.id)).toEqual([
                'chat-with-ai', 'semantic-search', 'quick-peek',
            ]);
        });

        it('cross-listed entries declare canonicalCategoryId === "pinned"', () => {
            const cats = buildCommandCategories(mockTranslations, mockExecuteCommand);
            const pinned = cats.find(c => c.id === 'pinned')!;
            for (const c of pinned.commands) {
                expect(c.canonicalCategoryId).toBe('pinned');
            }
        });

        it('replaces defaults with user selection (any IDs across the tree)', () => {
            const cats = buildCommandCategories(
                mockTranslations, mockExecuteCommand, ['narrate-note', 'smart-tag'],
            );
            const pinned = cats.find(c => c.id === 'pinned')!;
            expect(pinned.commands.map(c => c.id)).toEqual(['narrate-note', 'smart-tag']);
        });

        it('caps user selection at 5 commands', () => {
            const cats = buildCommandCategories(
                mockTranslations, mockExecuteCommand,
                ['chat-with-ai', 'semantic-search', 'quick-peek',
                 'narrate-note', 'smart-tag', 'kindle-sync', 'export-flashcards'],
            );
            const pinned = cats.find(c => c.id === 'pinned')!;
            expect(pinned.commands.length).toBe(5);
        });

        it('preserves cross-listing object identity for promoted leaves', () => {
            const cats = buildCommandCategories(
                mockTranslations, mockExecuteCommand, ['narrate-note'],
            );
            const pinned = cats.find(c => c.id === 'pinned')!;
            const create = cats.find(c => c.id === 'create')!;
            const pinnedNarrate = pinned.commands.find(c => c.id === 'narrate-note')!;
            const createNarrate = create.commands.find(c => c.id === 'narrate-note')!;
            expect(pinnedNarrate).toBe(createNarrate);
        });

        it('silently skips unknown IDs', () => {
            const cats = buildCommandCategories(
                mockTranslations, mockExecuteCommand,
                ['narrate-note', 'made-up-command', 'smart-tag'],
            );
            const pinned = cats.find(c => c.id === 'pinned')!;
            expect(pinned.commands.map(c => c.id)).toEqual(['narrate-note', 'smart-tag']);
        });

        it('finds leaves nested in sub-groups (e.g. Create → Write → smart-summarize)', () => {
            const cats = buildCommandCategories(
                mockTranslations, mockExecuteCommand, ['smart-summarize'],
            );
            const pinned = cats.find(c => c.id === 'pinned')!;
            expect(pinned.commands.map(c => c.id)).toEqual(['smart-summarize']);
        });
    });

    describe('Capture — pulls new content in (flat, 6 leaves)', () => {
        it('contains research / web-reader / kindle / newsletter / record / onedrive-link', () => {
            const cats = buildCommandCategories(mockTranslations, mockExecuteCommand);
            const capture = cats.find(c => c.id === 'capture')!;
            expect(capture.commands.map(c => c.id)).toEqual([
                'research-web', 'web-reader', 'kindle-sync', 'newsletter-fetch', 'record-audio', 'insert-onedrive-link',
            ]);
        });
    });

    describe('Create — Write + Visualise sub-groups + 4 direct leaves', () => {
        it('first-expansion: 2 sub-groups + narrate / play / flashcards / tags', () => {
            const cats = buildCommandCategories(mockTranslations, mockExecuteCommand);
            const create = cats.find(c => c.id === 'create')!;
            expect(create.commands.map(c => c.id)).toEqual([
                'create-write', 'create-visualise',
                'narrate-note', 'play-narration', 'export-flashcards', 'smart-tag',
            ]);
        });
        it('Write sub-group contains the 6 written-output commands', () => {
            const cats = buildCommandCategories(mockTranslations, mockExecuteCommand);
            const write = cats.find(c => c.id === 'create')!.commands.find(c => c.id === 'create-write')!;
            expect(write.subCommands?.map(c => c.id)).toEqual([
                'smart-summarize', 'create-meeting-minutes', 'transcribe-audio',
                'smart-translate', 'export-note', 'export-minutes-docx',
            ]);
        });
        it('Minutes leaf still carries the transcribe aliases (Plan F3 preserved)', () => {
            const cats = buildCommandCategories(mockTranslations, mockExecuteCommand);
            const write = cats.find(c => c.id === 'create')!.commands.find(c => c.id === 'create-write')!;
            const minutes = write.subCommands?.find(c => c.id === 'create-meeting-minutes')!;
            expect(minutes.aliases).toEqual(expect.arrayContaining([
                'minutes', 'meeting', 'transcript', 'transcribe', 'audio', 'speech-to-text',
            ]));
        });
        it('Visualise sub-group contains the 7 visual-output commands', () => {
            const cats = buildCommandCategories(mockTranslations, mockExecuteCommand);
            const visualise = cats.find(c => c.id === 'create')!.commands.find(c => c.id === 'create-visualise')!;
            expect(visualise.subCommands?.map(c => c.id)).toEqual([
                'presentation-chat', 'build-presentation-from-storyline', 'edit-mermaid-diagram', 'new-sketch',
                'build-investigation-canvas', 'build-context-canvas', 'build-cluster-canvas',
            ]);
        });
    });

    describe('Refine — improve, Pending sub-group, digitise, clear-tags', () => {
        it('first-expansion has 5 rows (quick-peek moved to Find; refresh-onedrive-embed added)', () => {
            const cats = buildCommandCategories(mockTranslations, mockExecuteCommand);
            const refine = cats.find(c => c.id === 'refine')!;
            expect(refine.commands.map(c => c.id)).toEqual([
                'enhance-note', 'refine-pending', 'digitise-image', 'clear-tags', 'refresh-onedrive-embed',
            ]);
        });
        it('Process pending sub-group contains the 3 pending commands', () => {
            const cats = buildCommandCategories(mockTranslations, mockExecuteCommand);
            const pending = cats.find(c => c.id === 'refine')!.commands.find(c => c.id === 'refine-pending')!;
            expect(pending.subCommands?.map(c => c.id)).toEqual([
                'integrate-pending-content', 'add-to-pending-integration', 'resolve-pending-embeds',
            ]);
        });
    });

    describe('Find — search verbs over existing vault content (flat)', () => {
        it('contains chat + search (cross-listed) + related + quick-peek', () => {
            const cats = buildCommandCategories(mockTranslations, mockExecuteCommand);
            const find = cats.find(c => c.id === 'find')!;
            expect(find.commands.map(c => c.id)).toEqual([
                'chat-with-ai', 'semantic-search', 'find-related', 'insert-related-notes', 'quick-peek',
            ]);
        });
    });

    describe('Maintain — hygiene + admin (local tools)', () => {
        it('contains tag-network, collect-tags, find-embeds, Bases sub-group, notebooklm', () => {
            const cats = buildCommandCategories(mockTranslations, mockExecuteCommand);
            const maintain = cats.find(c => c.id === 'maintain')!;
            expect(maintain.commands.map(c => c.id)).toEqual([
                'show-tag-network', 'collect-all-tags', 'find-embeds', 'maintain-bases', 'notebooklm-export',
            ]);
        });
        it('Bases sub-group contains migration + dashboard commands', () => {
            const cats = buildCommandCategories(mockTranslations, mockExecuteCommand);
            const bases = cats.find(c => c.id === 'maintain')!.commands.find(c => c.id === 'maintain-bases')!;
            expect(bases.subCommands?.map(c => c.id)).toEqual([
                'upgrade-metadata', 'upgrade-folder-metadata', 'create-bases-dashboard',
            ]);
        });
    });

    describe('Cross-listing identity', () => {
        it('cross-listed commands share object identity across Pinned and Find', () => {
            const cats = buildCommandCategories(mockTranslations, mockExecuteCommand);
            const pinned = cats.find(c => c.id === 'pinned')!;
            const find = cats.find(c => c.id === 'find')!;
            const pinnedChat = pinned.commands.find(c => c.id === 'chat-with-ai')!;
            const findChat = find.commands.find(c => c.id === 'chat-with-ai')!;
            expect(pinnedChat).toBe(findChat);

            const pinnedPeek = pinned.commands.find(c => c.id === 'quick-peek')!;
            const findPeek = find.commands.find(c => c.id === 'quick-peek')!;
            expect(pinnedPeek).toBe(findPeek);
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
            const search = cats.find(c => c.id === 'pinned')!.commands.find(c => c.id === 'semantic-search')!;
            expect(search.requires).toBe('semantic-search');
        });
        it('notebooklm-export requires "vault"', () => {
            const cats = buildCommandCategories(mockTranslations, mockExecuteCommand);
            const nbExport = cats.find(c => c.id === 'maintain')!.commands.find(c => c.id === 'notebooklm-export')!;
            expect(nbExport.requires).toBe('vault');
        });
    });

    describe('legacyHomes — backward-compat alias derivation', () => {
        it('moved commands declare legacyHomes (preserves search vocabulary)', () => {
            const cats = buildCommandCategories(mockTranslations, mockExecuteCommand);
            const narrate = cats.find(c => c.id === 'create')!.commands.find(c => c.id === 'narrate-note')!;
            expect(narrate.legacyHomes).toContain('active-note-export');
            expect(narrate.aliases).toContain('export');
            expect(narrate.aliases).toContain('active note');
        });
        it('play-narration keeps its active-note-export legacy home', () => {
            const cats = buildCommandCategories(mockTranslations, mockExecuteCommand);
            const play = cats.find(c => c.id === 'create')!.commands.find(c => c.id === 'play-narration')!;
            expect(play.legacyHomes).toContain('active-note-export');
            expect(play.aliases).toContain('export');
        });
    });

    describe('counts', () => {
        it('total picker rows = 45 (42 unique + 3 cross-listings)', () => {
            const cats = buildCommandCategories(mockTranslations, mockExecuteCommand);
            const leafCount = cats.reduce((sum, cat) => sum + countLeafCommands(cat.commands), 0);
            expect(leafCount).toBe(45);
        });
        it('unique command IDs = 42', () => {
            const cats = buildCommandCategories(mockTranslations, mockExecuteCommand);
            const leaves = cats.flatMap(c => collectLeafCommands(c.commands));
            const uniqueIds = new Set(leaves.map(l => l.id));
            expect(uniqueIds.size).toBe(42);
        });
        it('alphabetised ai-organiser:* callbacks (42 unique)', () => {
            const cats = buildCommandCategories(mockTranslations, mockExecuteCommand);
            const leaves = cats.flatMap(c => collectLeafCommands(c.commands));
            mockExecuteCommand.mockClear();
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
                'ai-organiser:build-presentation-from-storyline',
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
                'ai-organiser:insert-onedrive-link',
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
                'ai-organiser:refresh-onedrive-embed',
                'ai-organiser:research-web',
                'ai-organiser:resolve-pending-embeds',
                'ai-organiser:semantic-search',
                'ai-organiser:show-tag-network',
                'ai-organiser:smart-summarize',
                'ai-organiser:smart-tag',
                'ai-organiser:smart-translate',
                'ai-organiser:transcribe-audio',
                'ai-organiser:upgrade-folder-metadata',
                'ai-organiser:upgrade-metadata',
                'ai-organiser:web-reader',
            ]);
            expect(unique.size).toBe(42);
        });
    });
});
