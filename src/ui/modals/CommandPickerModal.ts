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

        // Sub-command chevron indicator
        if (item.command.subCommands && item.command.subCommands.length > 0) {
            const chevronEl = el.createEl('span', { cls: 'command-picker-chevron' });
            this.renderIcon(chevronEl, 'chevron-right');
        }

        // Category badge
        el.createEl('span', {
            text: item.category,
            cls: 'command-picker-category'
        });
    }

    onChooseItem(item: CommandItem, evt: MouseEvent | KeyboardEvent): void {
        const cmd = item.command;

        // If this is a group parent, open sub-picker with its children
        if (cmd.subCommands && cmd.subCommands.length > 0) {
            const subCategory: CommandCategory = {
                id: item.categoryId + '-sub',
                name: cmd.name,
                icon: cmd.icon,
                commands: cmd.subCommands
            };
            const subModal = new CommandPickerModal(this.app, this.t, [subCategory]);
            subModal.open();
            // Pass current search query to sub-modal for power-user flow
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
 * Build command categories from the plugin's registered commands
 *
 * Categories organized by user workflow (Gestalt principles):
 * 1. Create - Capture new content from external sources (Export group)
 * 2. Enhance - Improve and augment existing notes (Highlight group, Pending group)
 * 3. Organize - Structure and categorize content (Tags, Bases, NotebookLM groups)
 * 4. Discover - Explore vault with AI chat and semantic search
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
                    id: 'record-audio',
                    name: t.commands?.recordAudio || 'Record Audio',
                    icon: 'mic',
                    aliases: ['record', 'voice', 'dictate', 'audio', 'microphone', 'memo'],
                    callback: () => executeCommand('ai-organiser:record-audio')
                },
                {
                    id: 'export-group',
                    name: t.modals.commandPicker?.groupExport || 'Export',
                    icon: 'file-output',
                    aliases: ['export', 'pdf', 'docx', 'pptx', 'word', 'powerpoint', 'flashcards', 'anki', 'brainscape', 'cards', 'study'],
                    callback: () => {},
                    subCommands: [
                        {
                            id: 'export-note',
                            name: t.commands?.exportNote || 'Export Note',
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
                        'improve',
                        'rewrite',
                        'diagram',
                        'mermaid',
                        'resources'
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
                    id: 'create-dashboard',
                    name: t.commands?.createBasesDashboard || 'Create Bases dashboard',
                    icon: 'layout-dashboard',
                    aliases: ['bases', 'dashboard', 'view'],
                    callback: () => executeCommand('ai-organiser:create-bases-dashboard')
                },
                {
                    id: 'highlight-group',
                    name: t.modals.commandPicker?.groupHighlight || 'Highlight',
                    icon: 'highlighter',
                    aliases: ['highlight', 'color', 'mark', 'remove', 'clear', 'unhighlight', 'eraser'],
                    callback: () => {},
                    subCommands: [
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
                {
                    id: 'pending-group',
                    name: t.modals.commandPicker?.groupPending || 'Pending Integration',
                    icon: 'git-merge',
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
                    id: 'tags-group',
                    name: t.modals.commandPicker?.groupTags || 'Tags',
                    icon: 'tag',
                    aliases: ['tag', 'categorize', 'label', 'clear', 'remove', 'delete', 'network', 'graph', 'export', 'list', 'all tags', 'visualization'],
                    callback: () => {},
                    subCommands: [
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
                {
                    id: 'notebooklm-group',
                    name: t.modals.commandPicker?.groupNotebookLM || 'NotebookLM',
                    icon: 'file-output',
                    aliases: ['notebooklm', 'export', 'pack', 'toggle', 'select', 'clear', 'folder'],
                    callback: () => {},
                    subCommands: [
                        {
                            id: 'notebooklm-export',
                            name: t.commands?.notebookLMExport || 'NotebookLM: Export Source Pack',
                            icon: 'file-output',
                            aliases: ['notebooklm', 'export', 'pdf', 'pack'],
                            callback: () => executeCommand('ai-organiser:notebooklm-export')
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
            ]
        },
        // === DISCOVER: Explore vault with AI chat and semantic search ===
        {
            id: 'discover',
            name: t.modals.commandPicker?.categoryDiscover || 'Discover',
            icon: 'compass',
            commands: [
                {
                    id: 'ask-ai-group',
                    name: t.modals.commandPicker?.groupAskAI || 'Ask AI',
                    icon: 'message-circle',
                    aliases: ['ask', 'question', 'chat', 'RAG', 'current note', 'analyze'],
                    callback: () => {},
                    subCommands: [
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
                            id: 'chat-about-highlights',
                            name: t.commands.chatAboutHighlights,
                            icon: 'message-square-quote',
                            aliases: ['highlight', 'chat', 'discuss', 'passages', 'selected', 'focus'],
                            callback: () => executeCommand('ai-organiser:chat-about-highlights')
                        }
                    ]
                },
                {
                    id: 'find-notes-group',
                    name: t.modals.commandPicker?.groupFindNotes || 'Find Notes',
                    icon: 'search',
                    aliases: ['find', 'query', 'lookup', 'similar', 'connections', 'linked', 'insert', 'embed', 'related', 'semantic', 'search'],
                    callback: () => {},
                    subCommands: [
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
                            id: 'insert-related-notes',
                            name: t.commands.insertRelatedNotes,
                            icon: 'copy-plus',
                            aliases: ['insert', 'embed', 'related'],
                            callback: () => executeCommand('ai-organiser:insert-related-notes')
                        }
                    ]
                },
                {
                    id: 'canvas-group',
                    name: t.modals.commandPicker?.groupCanvas || 'Canvas',
                    icon: 'layout-grid',
                    aliases: ['canvas', 'board', 'investigation', 'context', 'cluster', 'visualize', 'map', 'diagram'],
                    callback: () => {},
                    subCommands: [
                        {
                            id: 'build-investigation-canvas',
                            name: t.commands.buildInvestigationCanvas,
                            icon: 'network',
                            aliases: ['investigation', 'related', 'semantic', 'explore'],
                            callback: () => executeCommand('ai-organiser:build-investigation-canvas')
                        },
                        {
                            id: 'build-context-canvas',
                            name: t.commands.buildContextCanvas,
                            icon: 'git-branch',
                            aliases: ['context', 'sources', 'links', 'references'],
                            callback: () => executeCommand('ai-organiser:build-context-canvas')
                        },
                        {
                            id: 'build-cluster-canvas',
                            name: t.commands.buildClusterCanvas,
                            icon: 'boxes',
                            aliases: ['cluster', 'group', 'tag', 'organize'],
                            callback: () => executeCommand('ai-organiser:build-cluster-canvas')
                        }
                    ]
                }
            ]
        }
    ];
}
