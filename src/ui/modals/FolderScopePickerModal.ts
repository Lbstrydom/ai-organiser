/**
 * Folder Scope Picker Modal
 * Allows users to select a root folder to constrain AI suggestions
 */

import { App, Modal, ButtonComponent, TFolder, normalizePath, setIcon } from 'obsidian';
import AIOrganiserPlugin from '../../main';
import { getAllFolders, buildFolderTree, FolderTreeNode } from '../../utils/folderContextUtils';
import { ensureFolderExists } from '../../utils/minutesUtils';

/**
 * Normalize a raw search term for folder creation, preserving original casing.
 * Strips leading/trailing slashes and trims whitespace.
 * Returns undefined if the result is empty.
 */
export function normalizeCreatePath(rawSearchTerm: string): string | undefined {
    const trimmed = rawSearchTerm.trim();
    if (!trimmed) return undefined;
    const normalized = trimmed.replaceAll(/(^\/+)|(\/+$)/g, '');
    return normalized.length > 0 ? normalized : undefined;
}

/**
 * Determine whether a "Create folder" affordance should be shown.
 * Only shows when allowNewFolder is enabled, there's a valid search term,
 * and no existing folders match the search.
 */
export function shouldShowCreateFolder(
    allowNewFolder: boolean,
    rawSearchTerm: string,
    matchingFolderCount: number
): boolean {
    if (!allowNewFolder) return false;
    const createPath = normalizeCreatePath(rawSearchTerm);
    return createPath !== undefined && matchingFolderCount === 0;
}

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
    /** Custom text for the select/confirm button (e.g. "Export") */
    confirmButtonText?: string;
    /** Allow creating new folders from search input (default: false) */
    allowNewFolder?: boolean;
    /** Callback to resolve a preview path shown inside the picker */
    resolvePreview?: (path: string) => string;
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
    private searchTermRaw: string = '';
    private previewEl!: HTMLElement;

    constructor(
        app: App,
        private plugin: AIOrganiserPlugin,
        options: FolderScopePickerOptions
    ) {
        super(app);
        this.options = {
            allowSkip: true,
            allowNewFolder: false,
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
        contentEl.addClass('ai-organiser-p-16');
        contentEl.setCssProps({ '--w': '400px' }); contentEl.addClass('ai-organiser-w-custom');
        contentEl.setCssProps({ '--max-w': '90vw' }); contentEl.addClass('ai-organiser-max-w-custom');
        contentEl.setCssProps({ '--margin': '0 auto' }); contentEl.addClass('ai-organiser-margin-custom');

        // Modal title
        const t = this.plugin.t.modals?.folderScopePicker;
        const titleEl = contentEl.createEl('h2', {
            text: this.options.title || t?.title || 'Select Folder Scope',
            cls: 'folder-picker-title'
        });
        titleEl.addClass('ai-organiser-mt-0');
        titleEl.addClass('ai-organiser-mb-10');
        titleEl.addClass('ai-organiser-text-normal');
        titleEl.addClass('ai-organiser-border-b');
        titleEl.addClass('ai-organiser-pb-8');

        // Description
        const descEl = contentEl.createEl('p', {
            text: this.options.description || t?.description || 'Choose a root folder to constrain AI suggestions within your organizational structure.',
            cls: 'folder-picker-description'
        });
        descEl.setCssProps({ '--margin': '10px 0 15px' }); descEl.addClass('ai-organiser-margin-custom');
        descEl.addClass('ai-organiser-text-muted');
        descEl.addClass('ai-organiser-text-lg');

        // Search input
        const searchContainer = contentEl.createDiv({ cls: 'folder-picker-search' });
        searchContainer.addClass('ai-organiser-mb-12');

        this.searchInput = searchContainer.createEl('input', {
            type: 'text',
            placeholder: t?.searchPlaceholder || 'Search folders...',
            cls: 'folder-picker-search-input'
        });
        this.searchInput.addClass('ai-organiser-w-full');
        this.searchInput.setCssProps({ '--pad': '8px 12px' }); this.searchInput.addClass('ai-organiser-pad-custom');
        this.searchInput.addClass('ai-organiser-text-lg');
        this.searchInput.addClass('ai-organiser-border');
        this.searchInput.addClass('ai-organiser-rounded');
        this.searchInput.addClass('ai-organiser-bg-primary');

        this.searchInput.addEventListener('input', () => {
            this.searchTermRaw = this.searchInput.value;
            this.searchTerm = this.searchInput.value.toLowerCase();
            this.renderFolderList();
        });

        // Folder list container
        this.folderListEl = contentEl.createDiv({ cls: 'folder-list' });
        this.folderListEl.setCssProps({ '--max-h': '300px' }); this.folderListEl.addClass('ai-organiser-max-h-custom');
        this.folderListEl.addClass('ai-organiser-overflow-y-auto');
        this.folderListEl.addClass('ai-organiser-border');
        this.folderListEl.addClass('ai-organiser-rounded-md');
        this.folderListEl.addClass('ai-organiser-mb-16');
        this.folderListEl.addClass('ai-organiser-bg-secondary');

        this.renderFolderList();

        // Resolved-path preview element
        this.previewEl = contentEl.createDiv({ cls: 'folder-picker-preview' });
        this.previewEl.setCssProps({ '--margin': '0 0 12px' }); this.previewEl.addClass('ai-organiser-margin-custom');
        this.previewEl.setCssProps({ '--pad': '6px 12px' }); this.previewEl.addClass('ai-organiser-pad-custom');
        this.previewEl.addClass('ai-organiser-text-base');
        this.previewEl.addClass('ai-organiser-text-muted');
        this.previewEl.addClass('ai-organiser-italic');
        this.updatePreview();

        // If defaultFolder doesn't exist in vault, prefill search with that path
        if (this.options.defaultFolder && this.options.allowNewFolder) {
            const exists = this.allFolders.some(f => f.path === this.options.defaultFolder);
            if (!exists) {
                this.searchInput.value = this.options.defaultFolder;
                this.searchTermRaw = this.options.defaultFolder;
                this.searchTerm = this.options.defaultFolder.toLowerCase();
                this.selectedFolder = null;
                this.renderFolderList();
            }
        }

        // Button container
        const buttonContainer = contentEl.createDiv({ cls: 'folder-picker-buttons' });
        buttonContainer.addClass('ai-organiser-flex-row');
        buttonContainer.addClass('ai-organiser-gap-8');
        buttonContainer.addClass('ai-organiser-mt-16');
        buttonContainer.setCssProps({ '--pad': '16px 0 0 0' }); buttonContainer.addClass('ai-organiser-pad-custom');
        buttonContainer.addClass('ai-organiser-border-t');

        // Left side: "Use entire vault" button (if allowed)
        const leftButtons = buttonContainer.createDiv();
        if (this.options.allowSkip) {
            const skipButton = new ButtonComponent(leftButtons)
                .setButtonText(t?.useEntireVault || 'Use entire vault')
                .onClick(() => {
                    this.options.onSelect(null);
                    this.close();
                });
            skipButton.buttonEl.addClass('ai-organiser-bg-secondary');
        }

        // Right side: Cancel and Select buttons
        const rightButtons = buttonContainer.createDiv();
        rightButtons.addClass('ai-organiser-flex-row', 'ai-organiser-gap-10');

        new ButtonComponent(rightButtons)
            .setButtonText(this.plugin.t.modals?.cancelButton || 'Cancel')
            .onClick(() => {
                this.close();
            });

        this.selectButton = new ButtonComponent(rightButtons)
            .setButtonText(this.options.confirmButtonText || t?.selectButton || 'Select')
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

    private getFilteredFolders(): TFolder[] {
        if (!this.searchTerm) return this.allFolders;
        return this.allFolders.filter(folder =>
            folder.path.toLowerCase().includes(this.searchTerm) ||
            folder.name.toLowerCase().includes(this.searchTerm)
        );
    }

    private getCreatePath(): string | undefined {
        if (!this.options.allowNewFolder) return undefined;
        return normalizeCreatePath(this.searchTermRaw);
    }

    private renderFolderList(): void {
        this.folderListEl.empty();

        const t = this.plugin.t.modals?.folderScopePicker;
        const filteredFolders = this.getFilteredFolders();
        let createPath: string | undefined;

        // "Create new folder" item only when no folders match the search
        // Uses searchTermRaw to preserve user casing (avoids lowercase path corruption)
        if (filteredFolders.length === 0) {
            createPath = this.getCreatePath();
            if (createPath) {
                this.renderCreateFolderItem(createPath);
            }
        }

        // Show empty state if no folders and no create affordance
        if (filteredFolders.length === 0 && !createPath) {
            const emptyEl = this.folderListEl.createDiv({ cls: 'folder-list-empty' });
            emptyEl.addClass('ai-organiser-p-16');
            emptyEl.addClass('ai-organiser-text-center');
            emptyEl.addClass('ai-organiser-text-muted');
            emptyEl.textContent = t?.noFoldersFound || 'No folders found';
        }

        // Render matching folders
        if (filteredFolders.length > 0) {
            if (this.searchTerm) {
                for (const folder of filteredFolders) {
                    this.renderFolderItem(folder, 0);
                }
            } else {
                this.renderFolderTreeNodes(this.folderTree);
            }
        }

        // Always update preview to reflect current state (fixes stale preview on search change)
        this.updatePreview(createPath);
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
        itemEl.setCssProps({ '--pad': '8px 12px' }); itemEl.addClass('ai-organiser-pad-custom');
        itemEl.style.paddingLeft = `${12 + depth * 16}px`;
        itemEl.addClass('ai-organiser-cursor-pointer');
        itemEl.addClass('ai-organiser-flex-center', 'ai-organiser-gap-8');
        itemEl.addClass('ai-organiser-border-b');

        // Visual hierarchy: top-level folders are bolder
        if (isTopLevel) {
            itemEl.addClass('ai-organiser-font-semibold');
        } else {
            itemEl.addClass('ai-organiser-text-muted');
        }

        if (isSelected) {
            itemEl.addClass('selected');
            itemEl.addClass('ai-organiser-bg-accent');
            itemEl.addClass('ai-organiser-text-on-accent');
        }

        // Hover effect
        itemEl.addEventListener('mouseenter', () => {
            if (!isSelected) {
                itemEl.setCssProps({ '--bg': 'var(--background-modifier-hover)' }); itemEl.addClass('ai-organiser-bg-custom');
                // Brighten nested folders on hover
                if (!isTopLevel) {
                    itemEl.addClass('ai-organiser-text-normal');
                }
            }
        });
        itemEl.addEventListener('mouseleave', () => {
            if (!isSelected) {
                itemEl.removeClass('ai-organiser-bg-accent', 'ai-organiser-bg-custom');
                // Restore muted color for nested folders
                if (!isTopLevel) {
                    itemEl.addClass('ai-organiser-text-muted');
                }
            }
        });

        // Folder icon
        const iconEl = itemEl.createSpan({ cls: 'folder-item-icon' });
        iconEl.addClass('ai-organiser-text-lg');
        setIcon(iconEl, 'folder');

        // Folder name (show full path when searching, just name otherwise)
        const nameEl = itemEl.createSpan({ cls: 'folder-item-name' });
        nameEl.addClass('ai-organiser-flex-1');
        nameEl.addClass('ai-organiser-overflow-hidden');
        nameEl.addClass('ai-organiser-truncate');
        nameEl.addClass('ai-organiser-truncate');

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
                highlightEl.addClass('ai-organiser-rounded');
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

    private renderCreateFolderItem(folderName: string): void {
        const t = this.plugin.t.modals?.folderScopePicker;
        const label = (t?.createFolder || 'Create new folder: "{path}"').replace('{path}', folderName);

        const itemEl = this.folderListEl.createDiv({ cls: 'folder-item folder-item-create' });
        itemEl.setCssProps({ '--pad': '8px 12px' }); itemEl.addClass('ai-organiser-pad-custom');
        itemEl.addClass('ai-organiser-cursor-pointer');
        itemEl.addClass('ai-organiser-flex-center', 'ai-organiser-gap-8');
        itemEl.addClass('ai-organiser-border-b');
        itemEl.addClass('ai-organiser-text-accent');
        itemEl.addClass('ai-organiser-font-semibold');

        const iconEl = itemEl.createSpan();
        iconEl.addClass('ai-organiser-text-lg');
        iconEl.textContent = '+';

        const nameEl = itemEl.createSpan({ text: label });
        nameEl.addClass('ai-organiser-flex-1');

        itemEl.addEventListener('mouseenter', () => {
            itemEl.setCssProps({ '--bg': 'var(--background-modifier-hover)' }); itemEl.addClass('ai-organiser-bg-custom');
        });
        itemEl.addEventListener('mouseleave', () => {
            itemEl.removeClass('ai-organiser-bg-accent', 'ai-organiser-bg-custom');
        });

        itemEl.addEventListener('click', () => { void (async () => {
            const normalized = normalizePath(folderName);
            // Validate: no invalid characters
            if (/[<>:"|?*]/.test(normalized)) {
                return;
            }
            try {
                await ensureFolderExists(this.app.vault, normalized);
                this.options.onSelect(normalized);
                this.close();
            } catch {
                // Folder creation failed silently — user can retry
            }
        })(); });
    }

    private selectFolder(folderPath: string): void {
        this.selectedFolder = folderPath;
        this.renderFolderList();
        this.updatePreview();

        // Enable the select button
        if (this.selectButton != null) {
            this.selectButton.setDisabled(false);
        }
    }

    private updatePreview(overridePath?: string): void {
        if (!this.previewEl) return;
        const path = overridePath || this.selectedFolder;
        if (!path || !this.options.resolvePreview) {
            this.previewEl.textContent = '';
            return;
        }
        const t = this.plugin.t.modals?.folderScopePicker;
        const resolved = this.options.resolvePreview(path);
        this.previewEl.textContent = (t?.exportDestination || 'Destination: {path}').replace('{path}', resolved);
    }

    onClose(): void {
        this.contentEl.empty();
    }
}
