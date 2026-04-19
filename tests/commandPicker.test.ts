/**
 * Tests for Command Picker Modal
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

describe('Command Picker', () => {
    describe('buildCommandCategories', () => {
        const mockTranslations = en;
        const mockExecuteCommand = vi.fn();

        it('should return all expected categories', () => {
            const categories = buildCommandCategories(mockTranslations, mockExecuteCommand);
            const categoryIds = categories.map(c => c.id);
            expect(categoryIds).toEqual(['active-note', 'capture', 'vault', 'tools']);
        });

        it('should have correct category names from i18n', () => {
            const categories = buildCommandCategories(mockTranslations, mockExecuteCommand);
            const categoryNames = categories.map(c => c.name);
            expect(categoryNames).toEqual([
                mockTranslations.modals.commandPicker.categoryActiveNote,
                mockTranslations.modals.commandPicker.categoryCapture,
                mockTranslations.modals.commandPicker.categoryVault,
                mockTranslations.modals.commandPicker.categoryTools,
            ]);
        });

        it('active note should contain expected sub-groups', () => {
            const categories = buildCommandCategories(mockTranslations, mockExecuteCommand);
            const activeNote = categories.find(c => c.id === 'active-note');

            expect(activeNote).toBeDefined();
            const ids = activeNote!.commands.map(c => c.id);
            expect(ids).toEqual(['refine-group', 'quick-peek', 'export-group', 'maps-group', 'pending-group']);

            const maps = activeNote!.commands.find(c => c.id === 'maps-group');
            expect(maps?.subCommands?.map(c => c.id)).toEqual([
                'build-investigation-canvas',
                'build-context-canvas',
                'find-related',
                'insert-related-notes'
            ]);
        });

        it('capture should contain expected commands', () => {
            const categories = buildCommandCategories(mockTranslations, mockExecuteCommand);
            const capture = categories.find(c => c.id === 'capture');
            const ids = capture!.commands.map(c => c.id);
            expect(ids).toEqual(['smart-summarize', 'create-meeting-minutes', 'record-audio', 'web-reader', 'research-web', 'kindle-sync', 'newsletter-fetch', 'new-sketch']);
        });

        it('vault should contain expected sub-groups', () => {
            const categories = buildCommandCategories(mockTranslations, mockExecuteCommand);
            const vault = categories.find(c => c.id === 'vault');

            expect(vault).toBeDefined();
            const ids = vault!.commands.map(c => c.id);
            expect(ids).toEqual(['ask-search-group', 'visualize-group', 'find-embeds']);

            const askSearch = vault!.commands.find(c => c.id === 'ask-search-group');
            expect(askSearch?.subCommands?.map(c => c.id)).toEqual([
                'chat-with-ai',
                'semantic-search'
            ]);

            const visualize = vault!.commands.find(c => c.id === 'visualize-group');
            expect(visualize?.subCommands?.map(c => c.id)).toEqual([
                'build-cluster-canvas',
                'show-tag-network',
                'create-dashboard',
                'collect-all-tags'
            ]);
        });

        it('tools should contain notebooklm group', () => {
            const categories = buildCommandCategories(mockTranslations, mockExecuteCommand);
            const tools = categories.find(c => c.id === 'tools');
            const ids = tools!.commands.map(c => c.id);
            expect(ids).toEqual(['notebooklm-group']);

            const notebookGroup = tools!.commands.find(c => c.id === 'notebooklm-group');
            expect(notebookGroup?.subCommands?.map(c => c.id)).toEqual([
                'notebooklm-export',
                'notebooklm-toggle',
                'notebooklm-clear',
                'notebooklm-open-folder'
            ]);
        });

        it('vault should contain find-embeds as standalone (flattened from single-child group)', () => {
            const categories = buildCommandCategories(mockTranslations, mockExecuteCommand);
            const vault = categories.find(c => c.id === 'vault');
            const findEmbeds = vault!.commands.find(c => c.id === 'find-embeds');
            expect(findEmbeds).toBeDefined();
            expect(findEmbeds?.subCommands).toBeUndefined();
        });

        it('refine group should contain tag, enhance, translate, clear, digitise, edit-mermaid', () => {
            const categories = buildCommandCategories(mockTranslations, mockExecuteCommand);
            const refine = categories
                .find(c => c.id === 'active-note')!
                .commands.find(c => c.id === 'refine-group')!;
            expect(refine.subCommands?.map(c => c.id)).toEqual([
                'smart-tag',
                'enhance-note',
                'smart-translate',
                'clear-tags',
                'digitise-image',
                'edit-mermaid-diagram',
                'presentation-chat'
            ]);
        });

        it('should have expected total leaf command count', () => {
            const categories = buildCommandCategories(mockTranslations, mockExecuteCommand);
            const leafCount = categories.reduce((sum, category) => sum + countLeafCommands(category.commands), 0);
            expect(leafCount).toBe(38);
        });

        it('should include the expected unique command IDs across all leaf callbacks', () => {
            const categories = buildCommandCategories(mockTranslations, mockExecuteCommand);
            const leafCommands = categories.flatMap(category => collectLeafCommands(category.commands));

            mockExecuteCommand.mockClear();
            leafCommands.forEach(command => command.callback());

            const uniqueExecutedCommands = new Set(mockExecuteCommand.mock.calls.map(call => call[0]));
            expect(Array.from(uniqueExecutedCommands).sort((a, b) => a.localeCompare(b))).toEqual([
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
                'ai-organiser:ensure-note-structure',
                'ai-organiser:export-flashcards',
                'ai-organiser:export-minutes-docx',
                'ai-organiser:export-note',
                'ai-organiser:find-embeds',
                'ai-organiser:find-related',
                'ai-organiser:insert-related-notes',
                'ai-organiser:integrate-pending-content',
                'ai-organiser:kindle-sync',
                'ai-organiser:new-sketch',
                'ai-organiser:newsletter-fetch',
                'ai-organiser:notebooklm-clear-selection',
                'ai-organiser:notebooklm-export',
                'ai-organiser:notebooklm-open-export-folder',
                'ai-organiser:notebooklm-toggle-selection',
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
                'ai-organiser:web-reader',
            ]);
            expect(uniqueExecutedCommands.size).toBe(38);
        });
    });
});
