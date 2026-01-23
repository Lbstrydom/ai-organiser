/**
 * Folder Scope Picker Modal
 * Allows users to select a root folder to constrain AI suggestions
 */

import { App, Modal, ButtonComponent, TFolder } from 'obsidian';
import AIOrganiserPlugin from '../../main';
import { getAllFolders, buildFolderTree, FolderTreeNode } from '../../utils/folderContextUtils';

export interface FolderScopePickerOptions {
    /** Modal title (defaults to i18n key) */
    title?: string;
    /** Helper description text */
    description?: string;
    /** Show "Use entire vault" option (default: true) */
    allowSkip?: boolean;
    /** Pre-select a folder path */
    defaultFolder?: string;
    /** Callback when folder is selected (null = use entire vault) */
    onSelect: (folderPath: string | null) => void;
}

export class FolderScopePickerModal extends Modal {
    private options: FolderScopePickerOptions;
    private selectedFolder: string | null = null;
    private searchInput!: HTMLInputElement;
    private folderListEl!: HTMLElement;
    private selectButton!: ButtonComponent;
    private allFolders: TFolder[] = [];
    private folderTree: FolderTreeNode[] = [];
    private searchTerm: string = '';

    constructor(
        app: App,
        private plugin: AIOrganiserPlugin,
        options: FolderScopePickerOptions
    ) {
        super(app);
        this.options = {
            allowSkip: true,
            ...options
        };
        this.selectedFolder = options.defaultFolder || null;
    }

    onOpen(): void {
        const { contentEl } = this;

        // Load folders
        this.allFolders = getAllFolders(this.app);
        this.folderTree = buildFolderTree(this.app);

        // Set container styles
        contentEl.addClass('ai-organiser-folder-picker');
        contentEl.style.padding = '20px';
        contentEl.style.width = '400px';
        contentEl.style.maxWidth = '90vw';
        contentEl.style.margin = '0 auto';

        // Modal title
        const t = this.plugin.t.modals?.folderScopePicker;
        const titleEl = contentEl.createEl('h2', {
            text: this.options.title || t?.title || 'Select Folder Scope',
            cls: 'folder-picker-title'
        });
        titleEl.style.marginTop = '0';
        titleEl.style.marginBottom = '10px';
        titleEl.style.color = 'var(--text-normal)';
        titleEl.style.borderBottom = '1px solid var(--background-modifier-border)';
        titleEl.style.paddingBottom = '10px';

        // Description
        const descEl = contentEl.createEl('p', {
            text: this.options.description || t?.description || 'Choose a root folder to constrain AI suggestions within your organizational structure.',
            cls: 'folder-picker-description'
        });
        descEl.style.margin = '10px 0 15px';
        descEl.style.color = 'var(--text-muted)';
        descEl.style.fontSize = '14px';

        // Search input
        const searchContainer = contentEl.createDiv({ cls: 'folder-picker-search' });
        searchContainer.style.marginBottom = '12px';

        this.searchInput = searchContainer.createEl('input', {
            type: 'text',
            placeholder: t?.searchPlaceholder || 'Search folders...',
            cls: 'folder-picker-search-input'
        });
        this.searchInput.style.width = '100%';
        this.searchInput.style.padding = '8px 12px';
        this.searchInput.style.fontSize = '14px';
        this.searchInput.style.border = '1px solid var(--background-modifier-border)';
        this.searchInput.style.borderRadius = '4px';
        this.searchInput.style.backgroundColor = 'var(--background-primary)';

        this.searchInput.addEventListener('input', () => {
            this.searchTerm = this.searchInput.value.toLowerCase();
            this.renderFolderList();
        });

        // Folder list container
        this.folderListEl = contentEl.createDiv({ cls: 'folder-list' });
        this.folderListEl.style.maxHeight = '300px';
        this.folderListEl.style.overflowY = 'auto';
        this.folderListEl.style.border = '1px solid var(--background-modifier-border)';
        this.folderListEl.style.borderRadius = '6px';
        this.folderListEl.style.marginBottom = '16px';
        this.folderListEl.style.backgroundColor = 'var(--background-secondary)';

        this.renderFolderList();

        // Button container
        const buttonContainer = contentEl.createDiv({ cls: 'folder-picker-buttons' });
        buttonContainer.style.display = 'flex';
        buttonContainer.style.justifyContent = 'space-between';
        buttonContainer.style.marginTop = '16px';
        buttonContainer.style.paddingTop = '16px';
        buttonContainer.style.borderTop = '1px solid var(--background-modifier-border)';

        // Left side: "Use entire vault" button (if allowed)
        const leftButtons = buttonContainer.createDiv();
        if (this.options.allowSkip) {
            const skipButton = new ButtonComponent(leftButtons)
                .setButtonText(t?.useEntireVault || 'Use entire vault')
                .onClick(() => {
                    this.options.onSelect(null);
                    this.close();
                });
            skipButton.buttonEl.style.backgroundColor = 'var(--background-secondary)';
        }

        // Right side: Cancel and Select buttons
        const rightButtons = buttonContainer.createDiv();
        rightButtons.style.display = 'flex';
        rightButtons.style.gap = '10px';

        new ButtonComponent(rightButtons)
            .setButtonText(this.plugin.t.modals?.cancelButton || 'Cancel')
            .onClick(() => {
                this.close();
            });

        this.selectButton = new ButtonComponent(rightButtons)
            .setButtonText(t?.selectButton || 'Select')
            .setCta()
            .onClick(() => {
                this.options.onSelect(this.selectedFolder);
                this.close();
            });

        // Disable select button if no folder selected
        if (!this.selectedFolder) {
            this.selectButton.setDisabled(true);
        }
    }

    private renderFolderList(): void {
        this.folderListEl.empty();

        const t = this.plugin.t.modals?.folderScopePicker;

        if (this.allFolders.length === 0) {
            const emptyEl = this.folderListEl.createDiv({ cls: 'folder-list-empty' });
            emptyEl.style.padding = '20px';
            emptyEl.style.textAlign = 'center';
            emptyEl.style.color = 'var(--text-muted)';
            emptyEl.textContent = t?.noFoldersFound || 'No folders found';
            return;
        }

        // Filter folders based on search term
        let filteredFolders: TFolder[];
        if (this.searchTerm) {
            filteredFolders = this.allFolders.filter(folder =>
                folder.path.toLowerCase().includes(this.searchTerm) ||
                folder.name.toLowerCase().includes(this.searchTerm)
            );
        } else {
            filteredFolders = this.allFolders;
        }

        if (filteredFolders.length === 0) {
            const emptyEl = this.folderListEl.createDiv({ cls: 'folder-list-empty' });
            emptyEl.style.padding = '20px';
            emptyEl.style.textAlign = 'center';
            emptyEl.style.color = 'var(--text-muted)';
            emptyEl.textContent = t?.noFoldersFound || 'No folders found';
            return;
        }

        // Render folders
        if (this.searchTerm) {
            // Flat list when searching
            for (const folder of filteredFolders) {
                this.renderFolderItem(folder, 0);
            }
        } else {
            // Tree view when not searching
            this.renderFolderTreeNodes(this.folderTree);
        }
    }

    private renderFolderTreeNodes(nodes: FolderTreeNode[]): void {
        for (const node of nodes) {
            this.renderFolderItem(node.folder, node.depth);
            if (node.children.length > 0) {
                this.renderFolderTreeNodes(node.children);
            }
        }
    }

    private renderFolderItem(folder: TFolder, depth: number): void {
        const isSelected = this.selectedFolder === folder.path;
        const isTopLevel = depth === 0;

        const itemEl = this.folderListEl.createDiv({ cls: `folder-item ${isTopLevel ? 'folder-item-top' : 'folder-item-nested'}` });
        itemEl.style.padding = '8px 12px';
        itemEl.style.paddingLeft = `${12 + depth * 16}px`;
        itemEl.style.cursor = 'pointer';
        itemEl.style.display = 'flex';
        itemEl.style.alignItems = 'center';
        itemEl.style.gap = '8px';
        itemEl.style.borderBottom = '1px solid var(--background-modifier-border)';

        // Visual hierarchy: top-level folders are bolder
        if (isTopLevel) {
            itemEl.style.fontWeight = '600';
        } else {
            itemEl.style.color = 'var(--text-muted)';
        }

        if (isSelected) {
            itemEl.addClass('selected');
            itemEl.style.backgroundColor = 'var(--interactive-accent)';
            itemEl.style.color = 'var(--text-on-accent)';
        }

        // Hover effect
        itemEl.addEventListener('mouseenter', () => {
            if (!isSelected) {
                itemEl.style.backgroundColor = 'var(--background-modifier-hover)';
                // Brighten nested folders on hover
                if (!isTopLevel) {
                    itemEl.style.color = 'var(--text-normal)';
                }
            }
        });
        itemEl.addEventListener('mouseleave', () => {
            if (!isSelected) {
                itemEl.style.backgroundColor = '';
                // Restore muted color for nested folders
                if (!isTopLevel) {
                    itemEl.style.color = 'var(--text-muted)';
                }
            }
        });

        // Folder icon
        const iconEl = itemEl.createSpan({ cls: 'folder-item-icon' });
        iconEl.style.fontSize = '14px';
        iconEl.innerHTML = this.getFolderIcon();

        // Folder name (show full path when searching, just name otherwise)
        const nameEl = itemEl.createSpan({ cls: 'folder-item-name' });
        nameEl.style.flex = '1';
        nameEl.style.overflow = 'hidden';
        nameEl.style.textOverflow = 'ellipsis';
        nameEl.style.whiteSpace = 'nowrap';

        if (this.searchTerm) {
            // Show full path with search term highlighted
            const pathLower = folder.path.toLowerCase();
            const index = pathLower.indexOf(this.searchTerm);
            if (index >= 0) {
                const before = folder.path.substring(0, index);
                const match = folder.path.substring(index, index + this.searchTerm.length);
                const after = folder.path.substring(index + this.searchTerm.length);

                if (before) nameEl.createSpan({ text: before });
                const highlightEl = nameEl.createSpan({ text: match, cls: 'search-highlight' });
                highlightEl.style.backgroundColor = isSelected ? 'var(--text-on-accent)' : 'var(--text-highlight-bg)';
                highlightEl.style.color = isSelected ? 'var(--interactive-accent)' : 'inherit';
                highlightEl.style.borderRadius = '2px';
                if (after) nameEl.createSpan({ text: after });
            } else {
                nameEl.textContent = folder.path;
            }
        } else {
            nameEl.textContent = folder.name;
        }

        // Click handler
        itemEl.addEventListener('click', () => {
            this.selectFolder(folder.path);
        });
    }

    private selectFolder(folderPath: string): void {
        this.selectedFolder = folderPath;
        this.renderFolderList();

        // Enable the select button
        if (this.selectButton) {
            this.selectButton.setDisabled(false);
        }
    }

    private getFolderIcon(): string {
        // Simple folder SVG icon
        return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>`;
    }

    onClose(): void {
        this.contentEl.empty();
    }
}
