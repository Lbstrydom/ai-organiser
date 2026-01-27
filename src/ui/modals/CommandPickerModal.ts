/**
 * Command Picker Modal
 * A unified modal for accessing all AI Organiser commands organized by category
 * Uses FuzzySuggestModal for fuzzy search functionality
 */

import { App, FuzzySuggestModal, FuzzyMatch, Notice, setIcon } from 'obsidian';
import { Translations } from '../../i18n/types';

export interface CommandCategory {
    id: string;
    name: string;
    icon: string;
    commands: PickerCommand[];
}

export interface PickerCommand {
    id: string;
    name: string;
    icon: string;
    description?: string;
    aliases?: string[];
    callback: () => void | Promise<void>;
}

interface CommandItem {
    category: string;
    categoryIcon: string;
    categoryId: string;
    command: PickerCommand;
}

export class CommandPickerModal extends FuzzySuggestModal<CommandItem> {
    private categories: CommandCategory[];
    private items: CommandItem[];
    private t: Translations;

    constructor(app: App, t: Translations, categories: CommandCategory[]) {
        super(app);
        this.t = t;
        this.categories = categories;
        this.items = this.buildItems();

        this.setPlaceholder(t.modals.commandPicker?.placeholder || 'Search commands...');
        this.setInstructions([
            { command: '↑↓', purpose: t.modals.commandPicker?.navigateHint || 'to navigate' },
            { command: '↵', purpose: t.modals.commandPicker?.selectHint || 'to select' },
            { command: 'esc', purpose: t.modals.commandPicker?.closeHint || 'to close' }
        ]);

        // Add custom class for styling
        this.modalEl.addClass('command-picker-modal');
    }

    getItems(): CommandItem[] {
        return this.items;
    }

    getItemText(item: CommandItem): string {
        // Include category in search text for better filtering
        const aliasText = item.command.aliases ? item.command.aliases.join(' ') : '';
        return `${item.category} ${item.command.name} ${aliasText}`.trim();
    }

    renderSuggestion(fuzzyMatch: FuzzyMatch<CommandItem>, el: HTMLElement): void {
        const item = fuzzyMatch.item;
        el.addClass('command-picker-item');
        el.setAttribute('data-category', item.categoryId);

        // Icon container
        const iconEl = el.createEl('span', { cls: 'command-picker-icon' });
        this.renderIcon(iconEl, item.command.icon);

        // Text container
        const textEl = el.createEl('div', { cls: 'command-picker-text' });
        textEl.createEl('span', {
            text: item.command.name,
            cls: 'command-picker-name'
        });

        // Category badge
        el.createEl('span', {
            text: item.category,
            cls: 'command-picker-category'
        });
    }

    onChooseItem(item: CommandItem, evt: MouseEvent | KeyboardEvent): void {
        try {
            const result = item.command.callback();
            if (result instanceof Promise) {
                result.catch((error) => {
                    console.error('[AI Organiser] Command error:', error);
                    new Notice(`Command failed: ${error.message || 'Unknown error'}`);
                });
            }
        } catch (error) {
            console.error('[AI Organiser] Command error:', error);
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            new Notice(`Command failed: ${errorMessage}`);
        }
    }

    private buildItems(): CommandItem[] {
        const items: CommandItem[] = [];

        for (const category of this.categories) {
            for (const command of category.commands) {
                items.push({
                    category: category.name,
                    categoryIcon: category.icon,
                    categoryId: category.id,
                    command
                });
            }
        }

        return items;
    }

    private renderIcon(container: HTMLElement, iconName: string): void {
        const iconEl = container.createEl('span');
        iconEl.addClass('command-picker-icon-svg');
        setIcon(iconEl, iconName);
    }
}

/**
 * Build command categories from the plugin's registered commands
 *
 * Categories organized by user workflow (Gestalt principles):
 * 1. Create - Capture new content from external sources
 * 2. Enhance - Improve and augment existing notes
 * 3. Organize - Structure and categorize content
 * 4. Search - Discover and explore your vault
 * 5. Analyze - Insights and visualizations
 */
export function buildCommandCategories(
    t: Translations,
    executeCommand: (commandId: string) => void
): CommandCategory[] {
    return [
        // === CREATE: Capture content from external sources ===
        {
            id: 'create',
            name: t.modals.commandPicker?.categoryCreate || 'Create',
            icon: 'file-plus',
            commands: [
                {
                    id: 'smart-summarize',
                    name: t.commands.summarize || t.commands.summarizeSmart || 'Summarize',
                    icon: 'link',
                    aliases: [
                        t.commands.summarizeSmart,
                        t.commands.summarizeFromUrl,
                        t.commands.summarizeFromPdf,
                        t.commands.summarizeFromYouTube,
                        t.commands.summarizeFromAudio,
                        'YouTube',
                        'PDF',
                        'URL',
                        'Audio',
                        'video',
                        'web'
                    ],
                    callback: () => executeCommand('ai-organiser:smart-summarize')
                },
                {
                    id: 'create-meeting-minutes',
                    name: t.commands.createMeetingMinutes,
                    icon: 'clipboard-list',
                    aliases: ['meeting', 'minutes', 'transcript', 'notes'],
                    callback: () => executeCommand('ai-organiser:create-meeting-minutes')
                },
                {
                    id: 'generate-from-embedded',
                    name: t.commands.generateFromEmbedded,
                    icon: 'file-symlink',
                    aliases: ['embedded', 'linked', 'generate'],
                    callback: () => executeCommand('ai-organiser:generate-from-embedded')
                },
                {
                    id: 'notebooklm-export',
                    name: t.commands?.notebookLMExport || 'NotebookLM: Export Source Pack',
                    icon: 'file-output',
                    aliases: ['notebooklm', 'export', 'pdf', 'pack'],
                    callback: () => executeCommand('ai-organiser:notebooklm-export')
                }
            ]
        },
        // === ENHANCE: Improve existing notes ===
        {
            id: 'enhance',
            name: t.modals.commandPicker?.categoryEnhance || 'Enhance',
            icon: 'sparkles',
            commands: [
                {
                    id: 'enhance-note',
                    name: t.commands.enhance || t.commands.improveNote,
                    icon: 'wand-2',
                    aliases: [
                        t.commands.improveNote,
                        t.commands.generateMermaidDiagram,
                        t.commands.findResources,
                        t.commands.exportFlashcards,
                        'improve',
                        'rewrite',
                        'diagram',
                        'mermaid',
                        'resources',
                        'flashcards'
                    ],
                    callback: () => executeCommand('ai-organiser:enhance-note')
                },
                {
                    id: 'smart-translate',
                    name: t.commands.translate || t.commands.translateNote,
                    icon: 'languages',
                    aliases: [
                        t.commands.translateNote,
                        t.commands.translateSelection,
                        'language',
                        'convert'
                    ],
                    callback: () => executeCommand('ai-organiser:smart-translate')
                },
                {
                    id: 'highlight-selection',
                    name: t.commands?.highlightSelection || 'Highlight selection',
                    icon: 'highlighter',
                    aliases: ['highlight', 'color', 'mark'],
                    callback: () => executeCommand('ai-organiser:highlight-selection')
                },
                {
                    id: 'remove-highlight',
                    name: t.commands?.removeHighlight || 'Remove highlight',
                    icon: 'eraser',
                    aliases: ['remove', 'clear', 'unhighlight'],
                    callback: () => executeCommand('ai-organiser:remove-highlight')
                }
            ]
        },
        // === ORGANIZE: Structure and categorize ===
        {
            id: 'organize',
            name: t.modals.commandPicker?.categoryOrganize || 'Organize',
            icon: 'folder-tree',
            commands: [
                {
                    id: 'smart-tag',
                    name: t.commands.tag || t.commands.generateTagsForCurrentNote,
                    icon: 'tag',
                    aliases: [
                        t.commands.generateTagsForCurrentNote,
                        t.commands.generateTagsForCurrentFolder,
                        t.commands.generateTagsForVault,
                        'categorize',
                        'label'
                    ],
                    callback: () => executeCommand('ai-organiser:smart-tag')
                },
                {
                    id: 'clear-tags',
                    name: t.commands.clearTags || t.commands.clearTagsForCurrentNote,
                    icon: 'eraser',
                    aliases: [
                        t.commands.clearTagsForCurrentNote,
                        t.commands.clearTagsForCurrentFolder,
                        t.commands.clearTagsForVault,
                        'remove',
                        'delete'
                    ],
                    callback: () => executeCommand('ai-organiser:clear-tags')
                },
                {
                    id: 'upgrade-metadata',
                    name: t.commands?.upgradeToBases || 'Upgrade to Bases metadata',
                    icon: 'database',
                    aliases: ['bases', 'migrate', 'metadata', 'upgrade'],
                    callback: () => executeCommand('ai-organiser:upgrade-metadata')
                },
                {
                    id: 'upgrade-folder-metadata',
                    name: t.commands?.upgradeFolderToBases || 'Upgrade folder to Bases metadata',
                    icon: 'database',
                    aliases: ['bases', 'folder', 'migrate'],
                    callback: () => executeCommand('ai-organiser:upgrade-folder-metadata')
                },
                {
                    id: 'create-dashboard',
                    name: t.commands?.createBasesDashboard || 'Create Bases dashboard',
                    icon: 'layout-dashboard',
                    aliases: ['bases', 'dashboard', 'view'],
                    callback: () => executeCommand('ai-organiser:create-bases-dashboard')
                }
            ]
        },
        // === SEARCH: Discover and explore ===
        {
            id: 'search',
            name: t.modals.commandPicker?.categorySearch || 'Search',
            icon: 'search',
            commands: [
                {
                    id: 'semantic-search',
                    name: t.commands.searchSemanticVault,
                    icon: 'search',
                    aliases: ['find', 'query', 'lookup'],
                    callback: () => executeCommand('ai-organiser:semantic-search')
                },
                {
                    id: 'find-related',
                    name: t.commands.showRelatedNotes,
                    icon: 'link-2',
                    aliases: ['similar', 'connections', 'linked'],
                    callback: () => executeCommand('ai-organiser:find-related')
                },
                {
                    id: 'chat-with-vault',
                    name: t.commands.chatWithVault,
                    icon: 'message-circle',
                    aliases: ['ask', 'question', 'chat', 'RAG'],
                    callback: () => executeCommand('ai-organiser:chat-with-vault')
                },
                {
                    id: 'ask-about-current-note',
                    name: t.commands.askAboutCurrentNote,
                    icon: 'message-square-text',
                    aliases: ['ask', 'current note', 'analyze'],
                    callback: () => executeCommand('ai-organiser:ask-about-current-note')
                },
                {
                    id: 'insert-related-notes',
                    name: t.commands.insertRelatedNotes,
                    icon: 'copy-plus',
                    aliases: ['insert', 'embed', 'related'],
                    callback: () => executeCommand('ai-organiser:insert-related-notes')
                },
                {
                    id: 'manage-index',
                    name: t.commands.manageIndex,
                    icon: 'database',
                    aliases: [
                        t.commands.buildSemanticIndex,
                        t.commands.updateSemanticIndex,
                        t.commands.clearSemanticIndex,
                        'index',
                        'rebuild'
                    ],
                    callback: () => executeCommand('ai-organiser:manage-index')
                }
            ]
        },
        // === ANALYZE: Insights and visualizations ===
        {
            id: 'analyze',
            name: t.modals.commandPicker?.categoryAnalyze || 'Analyze',
            icon: 'bar-chart-2',
            commands: [
                {
                    id: 'show-tag-network',
                    name: t.commands.showTagNetwork,
                    icon: 'network',
                    aliases: ['graph', 'visualization', 'map'],
                    callback: () => executeCommand('ai-organiser:show-tag-network')
                },
                {
                    id: 'collect-all-tags',
                    name: t.commands.collectAllTags,
                    icon: 'list-tree',
                    aliases: ['export', 'list', 'all tags'],
                    callback: () => executeCommand('ai-organiser:collect-all-tags')
                }
            ]
        },
        // === INTEGRATE: Combine and manage content ===
        {
            id: 'integrate',
            name: t.modals.commandPicker?.categoryIntegrate || 'Integrate',
            icon: 'git-merge',
            commands: [
                {
                    id: 'add-to-pending',
                    name: t.commands.addToPendingIntegration,
                    icon: 'plus-circle',
                    aliases: ['pending', 'add', 'integration'],
                    callback: () => executeCommand('ai-organiser:add-to-pending-integration')
                },
                {
                    id: 'integrate-pending',
                    name: t.commands.integratePendingContent,
                    icon: 'git-merge',
                    aliases: ['integrate', 'merge', 'pending'],
                    callback: () => executeCommand('ai-organiser:integrate-pending-content')
                },
                {
                    id: 'resolve-embeds',
                    name: t.commands.resolvePendingEmbeds,
                    icon: 'scan-text',
                    aliases: ['embeds', 'resolve', 'extract'],
                    callback: () => executeCommand('ai-organiser:resolve-pending-embeds')
                },
                {
                    id: 'notebooklm-toggle',
                    name: t.commands?.notebookLMToggle || 'NotebookLM: Toggle Selection',
                    icon: 'bookmark-plus',
                    aliases: ['notebooklm', 'toggle', 'select'],
                    callback: () => executeCommand('ai-organiser:notebooklm-toggle-selection')
                },
                {
                    id: 'notebooklm-clear',
                    name: t.commands?.notebookLMClear || 'NotebookLM: Clear Selection',
                    icon: 'x-circle',
                    aliases: ['notebooklm', 'clear', 'selection'],
                    callback: () => executeCommand('ai-organiser:notebooklm-clear-selection')
                },
                {
                    id: 'notebooklm-open-folder',
                    name: t.commands?.notebookLMOpenFolder || 'NotebookLM: Open Export Folder',
                    icon: 'folder-open',
                    aliases: ['notebooklm', 'export', 'folder'],
                    callback: () => executeCommand('ai-organiser:notebooklm-open-export-folder')
                }
            ]
        }
    ];
}
