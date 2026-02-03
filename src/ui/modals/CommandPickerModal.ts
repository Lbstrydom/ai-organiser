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
    /** If present, clicking opens a sub-picker with these commands instead of executing callback */
    subCommands?: PickerCommand[];
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

        this.setPlaceholder(t.modals.commandPicker.placeholder);
        this.setInstructions([
            { command: 'up/down', purpose: t.modals.commandPicker.navigateHint },
            { command: 'enter', purpose: t.modals.commandPicker.selectHint },
            { command: 'esc', purpose: t.modals.commandPicker.closeHint }
        ]);

        // Add custom class for styling
        this.modalEl.addClass('command-picker-modal');
    }

    getItems(): CommandItem[] {
        return this.items;
    }

    getItemText(item: CommandItem): string {
        const aliasText = item.command.aliases ? item.command.aliases.join(' ') : '';
        return `${item.category} ${item.command.name} ${aliasText}`.trim();
    }

    renderSuggestion(fuzzyMatch: FuzzyMatch<CommandItem>, el: HTMLElement): void {
        const item = fuzzyMatch.item;
        el.addClass('command-picker-item');
        el.setAttribute('data-category', item.categoryId);

        const iconEl = el.createEl('span', { cls: 'command-picker-icon' });
        this.renderIcon(iconEl, item.command.icon);

        const textEl = el.createEl('div', { cls: 'command-picker-text' });
        textEl.createEl('span', {
            text: item.command.name,
            cls: 'command-picker-name'
        });

        if (item.command.subCommands && item.command.subCommands.length > 0) {
            const chevronEl = el.createEl('span', { cls: 'command-picker-chevron' });
            this.renderIcon(chevronEl, 'chevron-right');
        }

        el.createEl('span', {
            text: item.category,
            cls: 'command-picker-category'
        });
    }

    onChooseItem(item: CommandItem, evt: MouseEvent | KeyboardEvent): void {
        const cmd = item.command;

        if (cmd.subCommands && cmd.subCommands.length > 0) {
            const subCategory: CommandCategory = {
                id: item.categoryId + '-sub',
                name: cmd.name,
                icon: cmd.icon,
                commands: cmd.subCommands
            };
            const subModal = new CommandPickerModal(this.app, this.t, [subCategory]);
            subModal.open();
            const currentQuery = this.inputEl?.value || '';
            if (currentQuery) {
                subModal.inputEl.value = currentQuery;
                subModal.inputEl.dispatchEvent(new Event('input'));
            }
            return;
        }

        try {
            const result = cmd.callback();
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
 * Build command categories from the plugin's registered commands.
 */
export function buildCommandCategories(
    t: Translations,
    executeCommand: (commandId: string) => void
): CommandCategory[] {
    const summarizeAliases = [
        t.commands.summarizeSmart,
        t.commands.summarizeFromUrl,
        t.commands.summarizeFromPdf,
        t.commands.summarizeFromYouTube,
        t.commands.summarizeFromAudio,
        'youtube',
        'pdf',
        'url',
        'audio',
        'video',
        'web'
    ];
    const relatedAliases = ['related', 'similar', 'connections', 'linked'];

    return [
        {
            id: 'active-note',
            name: t.modals.commandPicker.categoryActiveNote,
            icon: 'file-edit',
            commands: [
                {
                    id: 'maps-group',
                    name: t.modals.commandPicker.groupMaps,
                    icon: 'network',
                    aliases: ['maps', 'connections', 'investigation', 'context', 'related', 'canvas'],
                    callback: () => {},
                    subCommands: [
                        {
                            id: 'build-investigation-canvas',
                            name: t.commands.mapRelatedConcepts,
                            icon: 'network',
                            aliases: ['investigation', 'concepts', ...relatedAliases],
                            callback: () => executeCommand('ai-organiser:build-investigation-canvas')
                        },
                        {
                            id: 'build-context-canvas',
                            name: t.commands.mapAttachments,
                            icon: 'git-branch',
                            aliases: ['context', 'attachments', 'sources', 'links', 'references'],
                            callback: () => executeCommand('ai-organiser:build-context-canvas')
                        },
                        {
                            id: 'find-related',
                            name: t.commands.showRelatedNotes,
                            icon: 'link-2',
                            aliases: relatedAliases,
                            callback: () => executeCommand('ai-organiser:find-related')
                        },
                        {
                            id: 'insert-related-notes',
                            name: t.commands.insertRelatedNotes,
                            icon: 'copy-plus',
                            aliases: ['insert', 'embed', ...relatedAliases],
                            callback: () => executeCommand('ai-organiser:insert-related-notes')
                        }
                    ]
                },
                {
                    id: 'refine-group',
                    name: t.modals.commandPicker.groupRefine,
                    icon: 'sparkles',
                    aliases: ['refine', 'improve', 'translate', 'tag', 'summarize'],
                    callback: () => {},
                    subCommands: [
                        {
                            id: 'smart-tag',
                            name: t.commands.generateTagsForCurrentNote,
                            icon: 'tag',
                            aliases: [t.commands.tag, 'categorize', 'label'],
                            callback: () => executeCommand('ai-organiser:smart-tag')
                        },
                        {
                            id: 'enhance-note',
                            name: t.commands.improveNote,
                            icon: 'wand-2',
                            aliases: [t.commands.enhance, t.commands.findResources, t.commands.generateMermaidDiagram, 'rewrite'],
                            callback: () => executeCommand('ai-organiser:enhance-note')
                        },
                        {
                            id: 'summarize-note',
                            name: t.commands.summarizeNote,
                            icon: 'file-text',
                            aliases: summarizeAliases,
                            callback: () => executeCommand('ai-organiser:smart-summarize')
                        },
                        {
                            id: 'smart-translate',
                            name: t.commands.translate,
                            icon: 'languages',
                            aliases: [t.commands.translateNote, t.commands.translateSelection, 'language', 'convert'],
                            callback: () => executeCommand('ai-organiser:smart-translate')
                        },
                        {
                            id: 'clear-tags',
                            name: t.commands.clearTags,
                            icon: 'eraser',
                            aliases: [t.commands.clearTagsForCurrentNote, t.commands.clearTagsForCurrentFolder, t.commands.clearTagsForVault, 'remove'],
                            callback: () => executeCommand('ai-organiser:clear-tags')
                        }
                    ]
                },
                {
                    id: 'pending-group',
                    name: t.modals.commandPicker.groupPending,
                    icon: 'inbox',
                    aliases: ['pending', 'add', 'integrate', 'merge', 'embeds', 'resolve', 'extract'],
                    callback: () => {},
                    subCommands: [
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
                        }
                    ]
                },
                {
                    id: 'export-group',
                    name: t.modals.commandPicker.groupExport,
                    icon: 'file-output',
                    aliases: ['export', 'pdf', 'docx', 'pptx', 'word', 'powerpoint', 'flashcards', 'anki', 'brainscape', 'cards', 'study'],
                    callback: () => {},
                    subCommands: [
                        {
                            id: 'export-note',
                            name: t.commands.exportNote,
                            icon: 'file-output',
                            aliases: ['export', 'pdf', 'docx', 'pptx', 'word', 'powerpoint'],
                            callback: () => executeCommand('ai-organiser:export-note')
                        },
                        {
                            id: 'export-flashcards',
                            name: t.commands.exportFlashcards,
                            icon: 'layers',
                            aliases: ['flashcards', 'anki', 'brainscape', 'cards', 'study', 'quiz'],
                            callback: () => executeCommand('ai-organiser:export-flashcards')
                        }
                    ]
                }
            ]
        },
        {
            id: 'capture',
            name: t.modals.commandPicker.categoryCapture,
            icon: 'plus-circle',
            commands: [
                {
                    id: 'summarize-web',
                    name: t.commands.summarizeWebYouTube,
                    icon: 'link',
                    aliases: summarizeAliases,
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
                    id: 'record-audio',
                    name: t.commands.recordAudio,
                    icon: 'mic',
                    aliases: ['record', 'voice', 'dictate', 'audio', 'microphone', 'memo'],
                    callback: () => executeCommand('ai-organiser:record-audio')
                }
            ]
        },
        {
            id: 'vault',
            name: t.modals.commandPicker.categoryVault,
            icon: 'brain',
            commands: [
                {
                    id: 'chat-with-ai',
                    name: t.commands.chatWithAI,
                    icon: 'message-circle',
                    aliases: ['ask', 'question', 'chat', 'rag', 'vault', 'passages'],
                    callback: () => executeCommand('ai-organiser:chat-with-ai')
                },
                {
                    id: 'semantic-search',
                    name: t.commands.searchSemanticVault,
                    icon: 'search',
                    aliases: ['semantic', 'search', 'find', 'query', 'lookup'],
                    callback: () => executeCommand('ai-organiser:semantic-search')
                },
                {
                    id: 'build-cluster-canvas',
                    name: t.commands.groupNotesByTag,
                    icon: 'boxes',
                    aliases: ['cluster', 'group', 'tag', 'organize'],
                    callback: () => executeCommand('ai-organiser:build-cluster-canvas')
                },
                {
                    id: 'show-tag-network',
                    name: t.commands.visualizeTagGraph,
                    icon: 'network',
                    aliases: ['graph', 'visualization', 'map', 'tags'],
                    callback: () => executeCommand('ai-organiser:show-tag-network')
                },
                {
                    id: 'create-dashboard',
                    name: t.commands.createBasesDashboard,
                    icon: 'layout-dashboard',
                    aliases: ['bases', 'dashboard', 'view'],
                    callback: () => executeCommand('ai-organiser:create-bases-dashboard')
                }
            ]
        },
        {
            id: 'tools',
            name: t.modals.commandPicker.categoryTools,
            icon: 'settings',
            commands: [
                {
                    id: 'notebooklm-group',
                    name: t.modals.commandPicker.groupNotebookLM,
                    icon: 'book-open',
                    aliases: ['notebooklm', 'export', 'pack', 'toggle', 'select', 'clear', 'folder'],
                    callback: () => {},
                    subCommands: [
                        {
                            id: 'notebooklm-export',
                            name: t.commands.notebookLMExport,
                            icon: 'file-output',
                            aliases: ['notebooklm', 'export', 'pdf', 'pack'],
                            callback: () => executeCommand('ai-organiser:notebooklm-export')
                        },
                        {
                            id: 'notebooklm-toggle',
                            name: t.commands.notebookLMToggle,
                            icon: 'bookmark-plus',
                            aliases: ['notebooklm', 'toggle', 'select'],
                            callback: () => executeCommand('ai-organiser:notebooklm-toggle-selection')
                        },
                        {
                            id: 'notebooklm-clear',
                            name: t.commands.notebookLMClear,
                            icon: 'x-circle',
                            aliases: ['notebooklm', 'clear', 'selection'],
                            callback: () => executeCommand('ai-organiser:notebooklm-clear-selection')
                        },
                        {
                            id: 'notebooklm-open-folder',
                            name: t.commands.notebookLMOpenFolder,
                            icon: 'folder-open',
                            aliases: ['notebooklm', 'export', 'folder'],
                            callback: () => executeCommand('ai-organiser:notebooklm-open-export-folder')
                        }
                    ]
                },
                {
                    id: 'collect-all-tags',
                    name: t.commands.collectAllTags,
                    icon: 'list-tree',
                    aliases: ['export', 'list', 'all tags'],
                    callback: () => executeCommand('ai-organiser:collect-all-tags')
                }
            ]
        }
    ];
}
