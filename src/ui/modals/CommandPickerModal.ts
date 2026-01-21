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
        return `${item.category} ${item.command.name}`;
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
                    id: 'generate-tags-for-current-note',
                    name: t.commands.generateTagsForCurrentNote,
                    icon: 'tag',
                    callback: () => executeCommand('ai-organiser:generate-tags-for-current-note')
                },
                {
                    id: 'generate-tags-for-current-folder',
                    name: t.commands.generateTagsForCurrentFolder,
                    icon: 'folder-tree',
                    callback: () => executeCommand('ai-organiser:generate-tags-for-current-folder')
                },
                {
                    id: 'generate-tags-for-vault',
                    name: t.commands.generateTagsForVault,
                    icon: 'vault',
                    callback: () => executeCommand('ai-organiser:generate-tags-for-vault')
                },
                {
                    id: 'clear-tags-for-current-note',
                    name: t.commands.clearTagsForCurrentNote,
                    icon: 'eraser',
                    callback: () => executeCommand('ai-organiser:clear-tags-for-current-note')
                },
                {
                    id: 'clear-tags-for-current-folder',
                    name: t.commands.clearTagsForCurrentFolder,
                    icon: 'folder-minus',
                    callback: () => executeCommand('ai-organiser:clear-tags-for-current-folder')
                },
                {
                    id: 'clear-tags-for-vault',
                    name: t.commands.clearTagsForVault,
                    icon: 'trash-2',
                    callback: () => executeCommand('ai-organiser:clear-tags-for-vault')
                }
            ]
        },
        {
            id: 'summarize',
            name: 'Summarize',
            icon: 'file-text',
            commands: [
                {
                    id: 'summarize-from-url',
                    name: t.commands.summarizeFromUrl,
                    icon: 'link',
                    callback: () => executeCommand('ai-organiser:summarize-from-url')
                },
                {
                    id: 'summarize-from-pdf',
                    name: t.commands.summarizeFromPdf,
                    icon: 'file-text',
                    callback: () => executeCommand('ai-organiser:summarize-from-pdf')
                },
                {
                    id: 'summarize-from-youtube',
                    name: t.commands.summarizeFromYouTube,
                    icon: 'youtube',
                    callback: () => executeCommand('ai-organiser:summarize-from-youtube')
                },
                {
                    id: 'summarize-from-audio',
                    name: t.commands.summarizeFromAudio,
                    icon: 'mic',
                    callback: () => executeCommand('ai-organiser:summarize-from-audio')
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
                },
                {
                    id: 'improve-note',
                    name: t.commands.improveNote,
                    icon: 'wand-2',
                    callback: () => executeCommand('ai-organiser:improve-note')
                },
                {
                    id: 'find-resources',
                    name: t.commands.findResources,
                    icon: 'search',
                    callback: () => executeCommand('ai-organiser:find-resources')
                }
            ]
        },
        {
            id: 'translate',
            name: 'Translate',
            icon: 'languages',
            commands: [
                {
                    id: 'translate-note',
                    name: t.commands.translateNote,
                    icon: 'languages',
                    callback: () => executeCommand('ai-organiser:translate-note')
                },
                {
                    id: 'translate-selection',
                    name: t.commands.translateSelection,
                    icon: 'text-cursor-input',
                    callback: () => executeCommand('ai-organiser:translate-selection')
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
                }
            ]
        }
    ];
}
