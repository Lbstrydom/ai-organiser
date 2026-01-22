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

        this.setPlaceholder('Search commands...');
        this.setInstructions([
            { command: '↑↓', purpose: 'to navigate' },
            { command: '↵', purpose: 'to select' },
            { command: 'esc', purpose: 'to close' }
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
 */
export function buildCommandCategories(
    t: Translations,
    executeCommand: (commandId: string) => void
): CommandCategory[] {
    return [
        {
            id: 'tagging',
            name: 'Tagging',
            icon: 'tag',
            commands: [
                {
                    id: 'smart-tag',
                    name: t.commands.tag || t.commands.generateTagsForCurrentNote,
                    icon: 'tag',
                    aliases: [
                        t.commands.generateTagsForCurrentNote,
                        t.commands.generateTagsForCurrentFolder,
                        t.commands.generateTagsForVault
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
                        t.commands.clearTagsForVault
                    ],
                    callback: () => executeCommand('ai-organiser:clear-tags')
                }
            ]
        },
        {
            id: 'summarize',
            name: 'Summarize',
            icon: 'file-text',
            commands: [
                {
                    id: 'smart-summarize',
                    name: t.commands.summarize || t.commands.summarizeSmart || 'Summarize',
                    icon: 'file-text',
                    aliases: [
                        t.commands.summarizeSmart,
                        t.commands.summarizeFromUrl,
                        t.commands.summarizeFromPdf,
                        t.commands.summarizeFromYouTube,
                        t.commands.summarizeFromAudio,
                        'YouTube',
                        'PDF',
                        'URL',
                        'Audio'
                    ],
                    callback: () => executeCommand('ai-organiser:smart-summarize')
                }
            ]
        },
        {
            id: 'enhance',
            name: 'Enhance',
            icon: 'sparkles',
            commands: [
                {
                    id: 'enhance-note',
                    name: t.commands.enhance || t.commands.improveNote,
                    icon: 'sparkles',
                    aliases: [
                        t.commands.improveNote,
                        t.commands.generateMermaidDiagram,
                        t.commands.findResources,
                        t.commands.exportFlashcards
                    ],
                    callback: () => executeCommand('ai-organiser:enhance-note')
                }
            ]
        },
        {
            id: 'smart-notes',
            name: 'Smart Notes',
            icon: 'sparkles',
            commands: [
                {
                    id: 'generate-from-embedded',
                    name: t.commands.generateFromEmbedded,
                    icon: 'file-plus',
                    callback: () => executeCommand('ai-organiser:generate-from-embedded')
                }
            ]
        },
        {
            id: 'translate',
            name: 'Translate',
            icon: 'languages',
            commands: [
                {
                    id: 'smart-translate',
                    name: t.commands.translate || t.commands.translateNote,
                    icon: 'languages',
                    aliases: [
                        t.commands.translateNote,
                        t.commands.translateSelection
                    ],
                    callback: () => executeCommand('ai-organiser:smart-translate')
                }
            ]
        },
        {
            id: 'semantic-search',
            name: 'Semantic Search',
            icon: 'search',
            commands: [
                {
                    id: 'semantic-search',
                    name: t.commands.searchSemanticVault,
                    icon: 'search',
                    callback: () => executeCommand('ai-organiser:semantic-search')
                },
                {
                    id: 'find-related',
                    name: t.commands.showRelatedNotes,
                    icon: 'git-branch',
                    callback: () => executeCommand('ai-organiser:find-related')
                },
                {
                    id: 'manage-index',
                    name: t.commands.manageIndex,
                    icon: 'database',
                    aliases: [
                        t.commands.buildSemanticIndex,
                        t.commands.updateSemanticIndex,
                        t.commands.clearSemanticIndex
                    ],
                    callback: () => executeCommand('ai-organiser:manage-index')
                }
            ]
        },
        {
            id: 'utilities',
            name: 'Utilities',
            icon: 'wrench',
            commands: [
                {
                    id: 'collect-all-tags',
                    name: t.commands.collectAllTags,
                    icon: 'list',
                    callback: () => executeCommand('ai-organiser:collect-all-tags')
                },
                {
                    id: 'show-tag-network',
                    name: t.commands.showTagNetwork,
                    icon: 'git-branch',
                    callback: () => executeCommand('ai-organiser:show-tag-network')
                },
                {
                    id: 'chat-with-vault',
                    name: t.commands.chatWithVault,
                    icon: 'message-circle',
                    callback: () => executeCommand('ai-organiser:chat-with-vault')
                }
            ]
        }
    ];
}
