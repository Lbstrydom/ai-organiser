/**
 * Tests for Command Picker Modal
 *
 * Integration tests to verify:
 * - All expected categories exist
 * - Each category contains expected commands
 * - Command-to-i18n key mappings are correct
 */

import { describe, it, expect, vi } from 'vitest';
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
            generateFromEmbedded: 'Generate from Embedded',
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
                categorySearch: 'Search',
                categoryAnalyze: 'Analyze',
                categoryIntegrate: 'Integrate',
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
            expect(categoryIds).toEqual(['create', 'enhance', 'organize', 'search', 'analyze', 'integrate']);
        });

        it('should have correct category names from i18n', () => {
            const categories = buildCommandCategories(mockTranslations, mockExecuteCommand);

            const categoryNames = categories.map(c => c.name);
            expect(categoryNames).toEqual([
                'Create',
                'Enhance',
                'Organize',
                'Search',
                'Analyze',
                'Integrate'
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
                expect(commandIds).toContain('generate-from-embedded');
                expect(commandIds).toContain('notebooklm-export');
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
                expect(commandIds).toContain('highlight-selection');
                expect(commandIds).toContain('remove-highlight');
            });
        });

        describe('Organize category', () => {
            it('should contain expected commands', () => {
                const categories = buildCommandCategories(mockTranslations, mockExecuteCommand);
                const organizeCategory = categories.find(c => c.id === 'organize');

                expect(organizeCategory).toBeDefined();
                const commandIds = organizeCategory!.commands.map(c => c.id);
                expect(commandIds).toContain('smart-tag');
                expect(commandIds).toContain('clear-tags');
                expect(commandIds).toContain('upgrade-metadata');
                expect(commandIds).toContain('upgrade-folder-metadata');
                expect(commandIds).toContain('create-dashboard');
            });
        });

        describe('Search category', () => {
            it('should contain expected commands', () => {
                const categories = buildCommandCategories(mockTranslations, mockExecuteCommand);
                const searchCategory = categories.find(c => c.id === 'search');

                expect(searchCategory).toBeDefined();
                const commandIds = searchCategory!.commands.map(c => c.id);
                expect(commandIds).toContain('semantic-search');
                expect(commandIds).toContain('find-related');
                expect(commandIds).toContain('chat-with-vault');
                expect(commandIds).toContain('ask-about-current-note');
                expect(commandIds).toContain('insert-related-notes');
                expect(commandIds).toContain('manage-index');
            });
        });

        describe('Analyze category', () => {
            it('should contain expected commands', () => {
                const categories = buildCommandCategories(mockTranslations, mockExecuteCommand);
                const analyzeCategory = categories.find(c => c.id === 'analyze');

                expect(analyzeCategory).toBeDefined();
                const commandIds = analyzeCategory!.commands.map(c => c.id);
                expect(commandIds).toContain('show-tag-network');
                expect(commandIds).toContain('collect-all-tags');
            });
        });

        describe('Integrate category', () => {
            it('should contain expected commands', () => {
                const categories = buildCommandCategories(mockTranslations, mockExecuteCommand);
                const integrateCategory = categories.find(c => c.id === 'integrate');

                expect(integrateCategory).toBeDefined();
                const commandIds = integrateCategory!.commands.map(c => c.id);
                expect(commandIds).toContain('add-to-pending');
                expect(commandIds).toContain('integrate-pending');
                expect(commandIds).toContain('resolve-embeds');
                expect(commandIds).toContain('notebooklm-toggle');
                expect(commandIds).toContain('notebooklm-clear');
                expect(commandIds).toContain('notebooklm-open-folder');
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
