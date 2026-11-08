/**
 * Tests for the Command Picker layout.
 *
 * Plan: docs/plans/navigation-discoverability.md (decision 4). Top level = Pinned, All actions,
 * Setup and tools (For this context and Jobs arrive in later phases). Stages are the All actions
 * filter and each row's chip, not top-level categories.
 */

import { buildCommandCategories, AVAILABLE_GROUP_ID, type PickerCommand } from '../src/ui/modals/CommandPickerModal';
import { ACTIONS } from '../src/core/actionRegistry';
import { WORKFLOW_STAGES } from '../src/core/workflowStages';
import type { FeatureId } from '../src/core/features';
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

describe('Command Picker — five-section layout', () => {
    const mockTranslations = en;
    const mockExecuteCommand = vi.fn();

    describe('buildCommandCategories — top-level structure', () => {
        it('returns Pinned, All actions and Setup and tools, in order', () => {
            const categories = buildCommandCategories(mockTranslations, mockExecuteCommand);
            expect(categories.map(c => c.id)).toEqual(['pinned', 'all', 'setup']);
        });

        it('section names resolve through i18n', () => {
            const categories = buildCommandCategories(mockTranslations, mockExecuteCommand);
            expect(categories.map(c => c.name)).toEqual([
                en.modals.commandPicker.categoryPinned,
                en.modals.commandPicker.categoryAll,
                en.modals.commandPicker.categorySetup,
            ]);
        });

        it('has no nested groups when every feature is on: any action is two clicks away', () => {
            const categories = buildCommandCategories(mockTranslations, mockExecuteCommand);
            for (const cat of categories) for (const c of cat.commands) expect(c.subCommands, c.id).toBeUndefined();
        });
    });

    describe('All actions and Setup and tools', () => {
        const cats = buildCommandCategories(mockTranslations, mockExecuteCommand);
        const all = cats.find(c => c.id === 'all')!;
        const setup = cats.find(c => c.id === 'setup')!;

        it('All actions holds every daily action, Setup and tools every setup and tool action', () => {
            expect(all.commands.map(c => c.id).sort()).toEqual(ACTIONS.filter(a => a.kind === 'daily').map(a => a.id).sort());
            expect(setup.commands.map(c => c.id).sort()).toEqual(ACTIONS.filter(a => a.kind !== 'daily').map(a => a.id).sort());
        });

        it('All actions is ordered by stage, then registry order', () => {
            const order = all.commands.map(c => WORKFLOW_STAGES.indexOf(c.stage!));
            expect([...order].sort((a, b) => a - b)).toEqual(order);
        });

        it('the lost moments are each one click inside a section', () => {
            const ids = (c: { commands: PickerCommand[] }) => c.commands.map(x => x.id);
            expect(ids(all)).toContain('sweep-inbox');
            expect(ids(all)).toContain('edit-ai-workspace');
            expect(ids(setup)).toContain('open-ai-workspaces-settings');
            expect(ids(setup)).toContain('open-process');
            expect(ids(setup)).toContain('setup-inbox-sweep');
        });

        it('a stage name finds its actions (it is a search word on every row)', () => {
            const sweep = all.commands.find(c => c.id === 'sweep-inbox')!;
            expect(sweep.aliases).toContain(en.workflowStages.refine);
        });
    });

    describe('Available to turn on', () => {
        const off = (...features: FeatureId[]) => (f: FeatureId) => !features.includes(f);

        it('lists the actions of off features in one group at the end of All actions', () => {
            const onActivate = vi.fn();
            const cats = buildCommandCategories(mockTranslations, mockExecuteCommand, [], { isEnabled: off('inbox-sweep'), onActivate });
            const all = cats.find(c => c.id === 'all')!;
            const group = all.commands[all.commands.length - 1];
            expect(group.id).toBe(AVAILABLE_GROUP_ID);
            expect(group.subCommands!.map(c => c.id).sort()).toEqual(['setup-inbox-sweep', 'sweep-inbox']);
            expect(group.name).toBe(`${en.modals.commandPicker.availableTitle} (2)`);
            expect(all.commands.map(c => c.id)).not.toContain('sweep-inbox');
            expect(cats.find(c => c.id === 'setup')!.commands.map(c => c.id)).not.toContain('setup-inbox-sweep');
        });

        it('choosing an off action opens activation and never runs the command', () => {
            const onActivate = vi.fn();
            const exec = vi.fn();
            const cats = buildCommandCategories(mockTranslations, exec, [], { isEnabled: off('inbox-sweep'), onActivate });
            const sweep = cats.find(c => c.id === 'all')!.commands.find(c => c.id === AVAILABLE_GROUP_ID)!.subCommands!.find(c => c.id === 'sweep-inbox')!;
            expect(sweep.featureOff).toBe(true);
            void sweep.callback();
            expect(onActivate).toHaveBeenCalledWith('sweep-inbox');
            expect(exec).not.toHaveBeenCalled();
        });

        it('with every feature on there is no Available group', () => {
            const cats = buildCommandCategories(mockTranslations, mockExecuteCommand, [], { isEnabled: () => true });
            expect(cats.find(c => c.id === 'all')!.commands.map(c => c.id)).not.toContain(AVAILABLE_GROUP_ID);
        });

        it('a ready leaf is never marked off', () => {
            const cats = buildCommandCategories(mockTranslations, mockExecuteCommand, [], { isEnabled: off('inbox-sweep') });
            for (const c of cats.find(x => x.id === 'all')!.commands) if (c.id !== AVAILABLE_GROUP_ID) expect(c.featureOff, c.id).toBeUndefined();
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
            const all = cats.find(c => c.id === 'all')!;
            const pinnedNarrate = pinned.commands.find(c => c.id === 'narrate-note')!;
            const allNarrate = all.commands.find(c => c.id === 'narrate-note')!;
            expect(pinnedNarrate).toBe(allNarrate);
        });

        it('silently skips unknown IDs', () => {
            const cats = buildCommandCategories(
                mockTranslations, mockExecuteCommand,
                ['narrate-note', 'made-up-command', 'smart-tag'],
            );
            const pinned = cats.find(c => c.id === 'pinned')!;
            expect(pinned.commands.map(c => c.id)).toEqual(['narrate-note', 'smart-tag']);
        });

        it('finds any action by id (e.g. smart-summarize)', () => {
            const cats = buildCommandCategories(
                mockTranslations, mockExecuteCommand, ['smart-summarize'],
            );
            const pinned = cats.find(c => c.id === 'pinned')!;
            expect(pinned.commands.map(c => c.id)).toEqual(['smart-summarize']);
        });
    });

    describe('Cross-listing identity', () => {
        it('default Pinned leaves are the same objects as their All actions rows', () => {
            const cats = buildCommandCategories(mockTranslations, mockExecuteCommand);
            const pinned = cats.find(c => c.id === 'pinned')!;
            const all = cats.find(c => c.id === 'all')!;
            for (const id of ['chat-with-ai', 'quick-peek', 'semantic-search']) {
                expect(pinned.commands.find(c => c.id === id), id).toBe(all.commands.find(c => c.id === id));
            }
        });

        it('the Minutes leaf still carries the transcribe aliases (Plan F3 preserved)', () => {
            const cats = buildCommandCategories(mockTranslations, mockExecuteCommand);
            const minutes = cats.find(c => c.id === 'all')!.commands.find(c => c.id === 'create-meeting-minutes')!;
            expect(minutes.aliases?.some(a => /transcri/i.test(a))).toBe(true);
        });
    });

    describe('requires field — every leaf has a valid kind', () => {
        const VALID = new Set(['none', 'active-note', 'selection', 'vault', 'semantic-search', 'mp3-file']);
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
            const nbExport = cats.find(c => c.id === 'all')!.commands.find(c => c.id === 'notebooklm-export')!;
            expect(nbExport.requires).toBe('vault');
        });
    });

    describe('legacyHomes — backward-compat alias derivation', () => {
        it('moved commands declare legacyHomes (preserves search vocabulary)', () => {
            const cats = buildCommandCategories(mockTranslations, mockExecuteCommand);
            const narrate = cats.find(c => c.id === 'all')!.commands.find(c => c.id === 'narrate-note')!;
            expect(narrate.legacyHomes).toContain('active-note-export');
            expect(narrate.aliases).toContain('export');
            expect(narrate.aliases).toContain('active note');
        });
        it('play-narration keeps its active-note-export legacy home', () => {
            const cats = buildCommandCategories(mockTranslations, mockExecuteCommand);
            const play = cats.find(c => c.id === 'all')!.commands.find(c => c.id === 'play-narration')!;
            expect(play.legacyHomes).toContain('active-note-export');
            expect(play.aliases).toContain('export');
        });
    });

    describe('counts', () => {
        it('total picker rows = 93 (90 unique + 3 Pinned cross-listings)', () => {
            const cats = buildCommandCategories(mockTranslations, mockExecuteCommand);
            const leafCount = cats.reduce((sum, cat) => sum + countLeafCommands(cat.commands), 0);
            expect(leafCount).toBe(93);
        });
        it('unique command IDs = 90', () => {
            const cats = buildCommandCategories(mockTranslations, mockExecuteCommand);
            const leaves = cats.flatMap(c => collectLeafCommands(c.commands));
            const uniqueIds = new Set(leaves.map(l => l.id));
            expect(uniqueIds.size).toBe(90);
        });
        it('alphabetised ai-organiser:* callbacks (90 unique)', () => {
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
                'ai-organiser:adopt-project',
                'ai-organiser:build-agent-index',
                'ai-organiser:build-cluster-canvas',
                'ai-organiser:build-context-canvas',
                'ai-organiser:build-investigation-canvas',
                'ai-organiser:build-presentation-from-storyline',
                'ai-organiser:chat-with-ai',
                'ai-organiser:check-agent-index',
                'ai-organiser:check-cloud-inventories',
                'ai-organiser:clear-tags',
                'ai-organiser:collect-all-tags',
                'ai-organiser:copy-agent-instructions',
                'ai-organiser:copy-ai-instructions',
                'ai-organiser:copy-claude-permissions',
                'ai-organiser:copy-combined-google-script',
                'ai-organiser:create-ai-context-pack',
                'ai-organiser:create-bases-dashboard',
                'ai-organiser:create-meeting-minutes',
                'ai-organiser:digitise-image',
                'ai-organiser:drop-selection-pending',
                'ai-organiser:edit-ai-workspace',
                'ai-organiser:edit-mermaid-diagram',
                'ai-organiser:enhance-note',
                'ai-organiser:ensure-note-structure',
                'ai-organiser:export-flashcards',
                'ai-organiser:export-minutes-docx',
                'ai-organiser:export-note',
                'ai-organiser:export-vault-map',
                'ai-organiser:find-embeds',
                'ai-organiser:find-related',
                'ai-organiser:insert-onedrive-link',
                'ai-organiser:insert-related-notes',
                'ai-organiser:integrate-pending-content',
                'ai-organiser:kindle-sync',
                'ai-organiser:make-google-task',
                'ai-organiser:manage-index',
                'ai-organiser:narrate-note',
                'ai-organiser:new-sketch',
                'ai-organiser:newsletter-audio',
                'ai-organiser:newsletter-fetch',
                'ai-organiser:newsletter-mark-brief-read',
                'ai-organiser:newsletter-mark-catchup-listened',
                'ai-organiser:newsletter-mark-caught-up',
                'ai-organiser:newsletter-regenerate-audio',
                'ai-organiser:notebooklm-clear-selection',
                'ai-organiser:notebooklm-export',
                'ai-organiser:notebooklm-open-export-folder',
                'ai-organiser:notebooklm-toggle-selection',
                'ai-organiser:open-agent-connectors',
                'ai-organiser:open-ai-workspaces-settings',
                'ai-organiser:open-process',
                'ai-organiser:open-project',
                'ai-organiser:open-upkeep-review',
                'ai-organiser:open-welcome',
                'ai-organiser:play-narration',
                'ai-organiser:presentation-chat',
                'ai-organiser:process-capture-inbox',
                'ai-organiser:quick-add-text-pending',
                'ai-organiser:quick-add-url-pending',
                'ai-organiser:quick-peek',
                'ai-organiser:record-audio',
                'ai-organiser:refresh-ai-live-pack',
                'ai-organiser:refresh-cloud-inventories',
                'ai-organiser:refresh-onedrive-embed',
                'ai-organiser:refresh-task-status',
                'ai-organiser:research-web',
                'ai-organiser:resolve-pending-embeds',
                'ai-organiser:resume-offload',
                'ai-organiser:review-ai-handback',
                'ai-organiser:review-captures',
                'ai-organiser:run-vault-upkeep',
                'ai-organiser:semantic-search',
                'ai-organiser:send-tasks-to-google',
                'ai-organiser:setup-agent-index',
                'ai-organiser:setup-capture-inbox',
                'ai-organiser:setup-cloud-inventory',
                'ai-organiser:setup-google-tasks',
                'ai-organiser:setup-inbox-sweep',
                'ai-organiser:setup-vault-upkeep',
                'ai-organiser:show-tag-network',
                'ai-organiser:smart-summarize',
                'ai-organiser:smart-tag',
                'ai-organiser:smart-translate',
                'ai-organiser:sweep-inbox',
                'ai-organiser:transcribe-audio',
                'ai-organiser:upgrade-folder-metadata',
                'ai-organiser:upgrade-metadata',
                'ai-organiser:web-reader',
                'ai-organiser:write-agent-instructions',
            ]);
            expect(unique.size).toBe(90);
        });
    });
});

describe('For this context', () => {
    it('comes first, names the target, and runs the items as given', () => {
        const run = vi.fn();
        const cats = buildCommandCategories(en, vi.fn(), [], { context: { label: 'Team sync.m4a', items: [{ id: 'transcribe-audio', title: 'Transcribe audio', icon: 'mic', run }] } });
        expect(cats[0].id).toBe('context');
        expect(cats[0].name).toBe('For: Team sync.m4a');
        const row = cats[0].commands[0];
        expect(row.contextItem).toBe(true);
        expect(row.stage).toBe('create');
        void row.callback();
        expect(run).toHaveBeenCalled();
    });

    it('is absent with no items', () => {
        const cats = buildCommandCategories(en, vi.fn(), [], { context: { label: 'x', items: [] } });
        expect(cats.map((c) => c.id)).toEqual(['pinned', 'all', 'setup']);
    });
});
