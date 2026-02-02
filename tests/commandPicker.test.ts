/**
 * Tests for Command Picker Modal
 *
 * Integration tests to verify:
 * - All expected categories exist
 * - Each category contains expected commands
 * - Command-to-i18n key mappings are correct
 */

import { buildCommandCategories } from '../src/ui/modals/CommandPickerModal';
import type { Translations } from '../src/i18n/types';

// Create a minimal mock translations object for testing
function createMockTranslations(): Translations {
    return {
        commands: {
            summarize: 'Summarize',
            summarizeSmart: 'Smart Summarize',
            summarizeFromUrl: 'Summarize from URL',
            summarizeFromPdf: 'Summarize from PDF',
            summarizeFromYouTube: 'Summarize from YouTube',
            summarizeFromAudio: 'Summarize from Audio',
            createMeetingMinutes: 'Create Meeting Minutes',
            notebookLMExport: 'NotebookLM: Export Source Pack',
            enhance: 'Enhance',
            improveNote: 'Improve Note',
            generateMermaidDiagram: 'Generate Mermaid Diagram',
            findResources: 'Find Resources',
            exportFlashcards: 'Export Flashcards',
            translate: 'Translate',
            translateNote: 'Translate Note',
            translateSelection: 'Translate Selection',
            highlightSelection: 'Highlight Selection',
            removeHighlight: 'Remove Highlight',
            tag: 'Tag',
            generateTagsForCurrentNote: 'Generate Tags for Current Note',
            generateTagsForCurrentFolder: 'Generate Tags for Folder',
            generateTagsForVault: 'Generate Tags for Vault',
            clearTags: 'Clear Tags',
            clearTagsForCurrentNote: 'Clear Tags for Note',
            clearTagsForCurrentFolder: 'Clear Tags for Folder',
            clearTagsForVault: 'Clear Tags for Vault',
            upgradeToBases: 'Upgrade to Bases metadata',
            upgradeFolderToBases: 'Upgrade folder to Bases metadata',
            createBasesDashboard: 'Create Bases Dashboard',
            searchSemanticVault: 'Semantic Search',
            showRelatedNotes: 'Show Related Notes',
            chatWithVault: 'Chat with Vault',
            askAboutCurrentNote: 'Ask Question About Current Note',
            chatAboutHighlights: 'Chat about highlights',
            insertRelatedNotes: 'Insert Related Notes',
            manageIndex: 'Manage Index',
            buildSemanticIndex: 'Build Index',
            updateSemanticIndex: 'Update Index',
            clearSemanticIndex: 'Clear Index',
            showTagNetwork: 'Show Tag Network',
            collectAllTags: 'Collect All Tags',
            addToPendingIntegration: 'Add to Pending Integration',
            integratePendingContent: 'Integrate Pending Content',
            resolvePendingEmbeds: 'Resolve Pending Embeds',
            notebookLMToggle: 'NotebookLM: Toggle Selection',
            notebookLMClear: 'NotebookLM: Clear Selection',
            notebookLMOpenFolder: 'NotebookLM: Open Export Folder',
            recordAudio: 'Record Audio',
            buildInvestigationCanvas: 'Build Investigation Board',
            buildContextCanvas: 'Build Context Board',
            buildClusterCanvas: 'Build Cluster Board',
        },
        modals: {
            commandPicker: {
                placeholder: 'Search commands...',
                navigateHint: 'to navigate',
                selectHint: 'to select',
                closeHint: 'to close',
                categoryCreate: 'Create',
                categoryEnhance: 'Enhance',
                categoryOrganize: 'Organize',
                categoryDiscover: 'Discover',
                groupExport: 'Export',
                groupPending: 'Pending Integration',
                groupNotebookLM: 'NotebookLM',
                groupHighlight: 'Highlight',
                groupTags: 'Tags',
                groupAskAI: 'Ask AI',
                groupFindNotes: 'Find Notes',
                groupCanvas: 'Canvas',
            },
        },
    } as unknown as Translations;
}

describe('Command Picker', () => {
    describe('buildCommandCategories', () => {
        const mockTranslations = createMockTranslations();
        const mockExecuteCommand = vi.fn();

        it('should return all expected categories', () => {
            const categories = buildCommandCategories(mockTranslations, mockExecuteCommand);

            const categoryIds = categories.map(c => c.id);
            expect(categoryIds).toEqual(['create', 'enhance', 'organize', 'discover']);
        });

        it('should have correct category names from i18n', () => {
            const categories = buildCommandCategories(mockTranslations, mockExecuteCommand);

            const categoryNames = categories.map(c => c.name);
            expect(categoryNames).toEqual([
                'Create',
                'Enhance',
                'Organize',
                'Discover'
            ]);
        });

        it('should have icons for all categories', () => {
            const categories = buildCommandCategories(mockTranslations, mockExecuteCommand);

            for (const category of categories) {
                expect(category.icon).toBeTruthy();
                expect(typeof category.icon).toBe('string');
            }
        });

        describe('Create category', () => {
            it('should contain expected commands', () => {
                const categories = buildCommandCategories(mockTranslations, mockExecuteCommand);
                const createCategory = categories.find(c => c.id === 'create');

                expect(createCategory).toBeDefined();
                const commandIds = createCategory!.commands.map(c => c.id);
                expect(commandIds).toContain('smart-summarize');
                expect(commandIds).toContain('create-meeting-minutes');
                expect(commandIds).toContain('record-audio');
                expect(commandIds).toContain('export-group');

                // Verify Export group contains sub-commands
                const exportGroup = createCategory!.commands.find(c => c.id === 'export-group');
                expect(exportGroup).toBeDefined();
                expect(exportGroup!.subCommands).toBeDefined();
                const subIds = exportGroup!.subCommands!.map(c => c.id);
                expect(subIds).toContain('export-note');
                expect(subIds).toContain('export-flashcards');
            });
        });

        describe('Enhance category', () => {
            it('should contain expected commands', () => {
                const categories = buildCommandCategories(mockTranslations, mockExecuteCommand);
                const enhanceCategory = categories.find(c => c.id === 'enhance');

                expect(enhanceCategory).toBeDefined();
                const commandIds = enhanceCategory!.commands.map(c => c.id);
                expect(commandIds).toContain('enhance-note');
                expect(commandIds).toContain('smart-translate');
                expect(commandIds).toContain('create-dashboard');
                expect(commandIds).toContain('pending-group');

                // Highlight group removed — highlight/unhighlight now accessible via right-click context menu
                expect(commandIds).not.toContain('highlight-group');

                // Verify Pending group contains sub-commands
                const pendingGroup = enhanceCategory!.commands.find(c => c.id === 'pending-group');
                expect(pendingGroup).toBeDefined();
                expect(pendingGroup!.subCommands).toBeDefined();
                const pendingSubIds = pendingGroup!.subCommands!.map(c => c.id);
                expect(pendingSubIds).toContain('add-to-pending');
                expect(pendingSubIds).toContain('integrate-pending');
                expect(pendingSubIds).toContain('resolve-embeds');
            });
        });

        describe('Organize category', () => {
            it('should contain expected commands', () => {
                const categories = buildCommandCategories(mockTranslations, mockExecuteCommand);
                const organizeCategory = categories.find(c => c.id === 'organize');

                expect(organizeCategory).toBeDefined();
                const commandIds = organizeCategory!.commands.map(c => c.id);
                expect(commandIds).toContain('tags-group');
                expect(commandIds).toContain('notebooklm-group');
                expect(commandIds).not.toContain('bases-group');

                // Verify Tags group contains sub-commands
                const tagsGroup = organizeCategory!.commands.find(c => c.id === 'tags-group');
                expect(tagsGroup).toBeDefined();
                expect(tagsGroup!.subCommands).toBeDefined();
                const tagSubIds = tagsGroup!.subCommands!.map(c => c.id);
                expect(tagSubIds).toContain('smart-tag');
                expect(tagSubIds).toContain('clear-tags');
                expect(tagSubIds).toContain('show-tag-network');
                expect(tagSubIds).toContain('collect-all-tags');

                // Verify NotebookLM group contains sub-commands
                const nlmGroup = organizeCategory!.commands.find(c => c.id === 'notebooklm-group');
                expect(nlmGroup).toBeDefined();
                expect(nlmGroup!.subCommands).toBeDefined();
                const nlmSubIds = nlmGroup!.subCommands!.map(c => c.id);
                expect(nlmSubIds).toContain('notebooklm-export');
                expect(nlmSubIds).toContain('notebooklm-toggle');
                expect(nlmSubIds).toContain('notebooklm-clear');
                expect(nlmSubIds).toContain('notebooklm-open-folder');
            });
        });

        describe('Discover category', () => {
            it('should contain expected groups', () => {
                const categories = buildCommandCategories(mockTranslations, mockExecuteCommand);
                const discoverCategory = categories.find(c => c.id === 'discover');

                expect(discoverCategory).toBeDefined();
                const commandIds = discoverCategory!.commands.map(c => c.id);
                expect(commandIds).toContain('ask-ai-group');
                expect(commandIds).toContain('find-notes-group');
                expect(commandIds).toContain('canvas-group');
                expect(commandIds).toHaveLength(3); // pure user-mode, no admin items

                // Verify Ask AI group
                const askAIGroup = discoverCategory!.commands.find(c => c.id === 'ask-ai-group');
                expect(askAIGroup).toBeDefined();
                expect(askAIGroup!.subCommands).toBeDefined();
                const askSubIds = askAIGroup!.subCommands!.map(c => c.id);
                expect(askSubIds).toContain('chat-with-vault');
                expect(askSubIds).toContain('ask-about-current-note');
                expect(askSubIds).toContain('chat-about-highlights');
                expect(askSubIds).toHaveLength(3);

                // Verify Find Notes group
                const findGroup = discoverCategory!.commands.find(c => c.id === 'find-notes-group');
                expect(findGroup).toBeDefined();
                expect(findGroup!.subCommands).toBeDefined();
                const findSubIds = findGroup!.subCommands!.map(c => c.id);
                expect(findSubIds).toContain('semantic-search');
                expect(findSubIds).toContain('find-related');
                expect(findSubIds).toContain('insert-related-notes');

                // Verify Canvas group
                const canvasGroup = discoverCategory!.commands.find(c => c.id === 'canvas-group');
                expect(canvasGroup).toBeDefined();
                expect(canvasGroup!.subCommands).toBeDefined();
                const canvasSubIds = canvasGroup!.subCommands!.map(c => c.id);
                expect(canvasSubIds).toContain('build-investigation-canvas');
                expect(canvasSubIds).toContain('build-context-canvas');
                expect(canvasSubIds).toContain('build-cluster-canvas');
            });
        });

        it('should have callbacks that call executeCommand with correct command IDs', () => {
            const categories = buildCommandCategories(mockTranslations, mockExecuteCommand);

            // Find and execute a command
            const createCategory = categories.find(c => c.id === 'create')!;
            const summarizeCommand = createCategory.commands.find(c => c.id === 'smart-summarize')!;

            summarizeCommand.callback();
            expect(mockExecuteCommand).toHaveBeenCalledWith('ai-organiser:smart-summarize');
        });

        it('all commands should have icons', () => {
            const categories = buildCommandCategories(mockTranslations, mockExecuteCommand);

            for (const category of categories) {
                for (const command of category.commands) {
                    expect(command.icon, `Command ${command.id} should have an icon`).toBeTruthy();
                }
            }
        });

        it('all commands should have names from i18n', () => {
            const categories = buildCommandCategories(mockTranslations, mockExecuteCommand);

            for (const category of categories) {
                for (const command of category.commands) {
                    expect(command.name, `Command ${command.id} should have a name`).toBeTruthy();
                    expect(typeof command.name).toBe('string');
                }
            }
        });
    });
});
