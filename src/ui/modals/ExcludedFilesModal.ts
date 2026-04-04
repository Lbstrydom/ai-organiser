import { App, Modal, ButtonComponent } from 'obsidian';
import AIOrganiserPlugin from '../../main';
import { getVaultItems, VaultItem } from '../../utils/vaultPathFetcher';

export class ExcludedFilesModal extends Modal {
    private excludedFolders: string[] = [];
    private filterInput!: HTMLInputElement;
    private pathDropdownContainer!: HTMLElement;
    private searchTerm: string = '';
    private cachedPaths: VaultItem[] = [];
    private hasLoadedPaths: boolean = false;

    private documentClickListener = (event: MouseEvent) => {
        const target = event.target as Node;
        if (this.filterInput && !this.filterInput.parentElement?.contains(target) && 
            !this.pathDropdownContainer.contains(target)) {
            this.pathDropdownContainer.addClass('ai-organiser-hidden');
        }
    };

    constructor(
        app: App, 
        private plugin: AIOrganiserPlugin, 
        private onSave: (excludedFolders: string[]) => void
    ) {
        super(app);
        this.excludedFolders = [...plugin.settings.excludedFolders];
    }

    private loadCachedPaths() {
        // Only load paths if they haven't been loaded yet
        if (!this.hasLoadedPaths) {
            try {
                this.cachedPaths = getVaultItems(this.app);
                this.hasLoadedPaths = true;
            } catch (_error) {
                this.cachedPaths = [];
            }
        }
    }

    onOpen() {
        const { contentEl } = this;

        // Load paths when the modal is opened
        this.loadCachedPaths();

        // Set container styles
        contentEl.addClass('ai-organiser-excluded-files-modal');
        contentEl.addClass('ai-organiser-p-16');
        contentEl.setCssProps({ '--max-w': '500px' }); contentEl.addClass('ai-organiser-max-w-custom');
        contentEl.setCssProps({ '--margin': '0 auto' }); contentEl.addClass('ai-organiser-margin-custom');
        
        // Set modal title with improved styling
        const titleEl = contentEl.createEl('h2', {
            text: this.plugin.t.modals.excludedFilesTitle,
            cls: 'ai-organiser-excluded-files-title'
        });
        titleEl.addClass('ai-organiser-mt-0');
        titleEl.addClass('ai-organiser-mb-10');
        titleEl.addClass('ai-organiser-text-normal');
        titleEl.addClass('ai-organiser-border-b');
        titleEl.addClass('ai-organiser-pb-8');
        
        const subtitleEl = contentEl.createEl('p', {
            text: this.plugin.t.modals.excludedFilesSubtitle,
            cls: 'ai-organiser-excluded-files-subtitle'
        });
        subtitleEl.setCssProps({ '--margin': '10px 0 15px' }); subtitleEl.addClass('ai-organiser-margin-custom');
        subtitleEl.addClass('ai-organiser-text-muted');
        subtitleEl.addClass('ai-organiser-text-lg');

        // Create container for excluded paths list
        const excludedListContainer = contentEl.createDiv({ cls: 'ai-organiser-excluded-list' });
        excludedListContainer.addClass('ai-organiser-mb-20');
        excludedListContainer.setCssProps({ '--max-h': '200px' }); excludedListContainer.addClass('ai-organiser-max-h-custom');
        excludedListContainer.addClass('ai-organiser-overflow-y-auto');
        excludedListContainer.setCssProps({ '--pad': '5px' }); excludedListContainer.addClass('ai-organiser-pad-custom');
        excludedListContainer.addClass('ai-organiser-border');
        excludedListContainer.addClass('ai-organiser-rounded');
        excludedListContainer.addClass('ai-organiser-bg-secondary');
        
        this.renderExcludedList(excludedListContainer);

        // Create filter input container with improved styling
        const filterContainer = contentEl.createDiv({
            cls: 'filter-container'
        });
        filterContainer.addClass('ai-organiser-mb-20');

        // Add filter label
        const filterLabel = filterContainer.createEl('div', {
            text: this.plugin.t.modals.filterLabel,
            cls: 'filter-label'
        });
        filterLabel.addClass('ai-organiser-font-bold');
        filterLabel.addClass('ai-organiser-mb-8');
        filterLabel.addClass('ai-organiser-text-lg');

        // Create input container
        const inputContainer = filterContainer.createDiv({
            cls: 'filter-input-container'
        });
        inputContainer.addClass('ai-organiser-flex');
        inputContainer.addClass('ai-organiser-relative');

        // Add input field with improved styling
        this.filterInput = inputContainer.createEl('input', {
            type: 'text',
            placeholder: this.plugin.t.modals.pathPlaceholder,
            cls: 'filter-input',
            value: ''
        });
        this.filterInput.addClass('ai-organiser-flex-1');
        this.filterInput.setCssProps({ '--pad': '8px 12px' }); this.filterInput.addClass('ai-organiser-pad-custom');
        this.filterInput.addClass('ai-organiser-text-lg');
        this.filterInput.addClass('ai-organiser-border');
        this.filterInput.addClass('ai-organiser-rounded');
        this.filterInput.addClass('ai-organiser-bg-primary');
        
        this.searchTerm = '';  // Start with empty search term

        // Create path dropdown container
        this.pathDropdownContainer = inputContainer.createDiv({
            cls: 'path-dropdown-container'
        });
        
        // Style the dropdown container
        this.pathDropdownContainer.setCssProps({ '--pos': 'absolute', '--popup-top': '100%', '--popup-left': '0' });
        this.pathDropdownContainer.addClass('ai-organiser-pos-custom');
        this.pathDropdownContainer.addClass('ai-organiser-w-full');
        this.pathDropdownContainer.setCssProps({ '--max-h': '200px' }); this.pathDropdownContainer.addClass('ai-organiser-max-h-custom');
        this.pathDropdownContainer.addClass('ai-organiser-overflow-y-auto');
        this.pathDropdownContainer.addClass('ai-organiser-bg-primary');
        this.pathDropdownContainer.addClass('ai-organiser-border');
        this.pathDropdownContainer.addClass('ai-organiser-rounded');
        this.pathDropdownContainer.setCssProps({ '--shadow': '0 4px 14px rgba(0, 0, 0, 0.15)' }); this.pathDropdownContainer.addClass('ai-organiser-shadow-custom');
        this.pathDropdownContainer.setCssProps({ '--z': '1000' }); this.pathDropdownContainer.addClass('ai-organiser-z-custom');
        this.pathDropdownContainer.addClass('ai-organiser-hidden');
        
        // Prevent event bubbling to keep dropdown open when clicked
        this.pathDropdownContainer.addEventListener('click', (e) => {
            e.stopPropagation();
        });

        // Add button with improved styling
        const addButtonContainer = inputContainer.createDiv();
        addButtonContainer.addClass('ai-organiser-ml-8');
        
        const addButtonEl = new ButtonComponent(addButtonContainer)
            .setButtonText(this.plugin.t.modals.addButton)
            .onClick(() => {
                const value = this.filterInput.value.trim();
                if (value && !this.excludedFolders.includes(value)) {
                    this.excludedFolders.push(value);
                    this.renderExcludedList(excludedListContainer);
                    this.filterInput.value = '';
                    this.searchTerm = '';
                    this.pathDropdownContainer.addClass('ai-organiser-hidden');
                }
            });
        
        // Add class to the button element
        addButtonEl.buttonEl.addClass('ai-organiser-excluded-files-add-button');
        addButtonEl.buttonEl.setCssProps({ '--pad': '8px 16px' }); addButtonEl.buttonEl.addClass('ai-organiser-pad-custom');
        addButtonEl.buttonEl.addClass('ai-organiser-text-lg');
        addButtonEl.buttonEl.addClass('ai-organiser-font-bold');

        // Set up input events
        this.filterInput.addEventListener('focus', () => {
            // Show dropdown when input gets focus
            this.updatePathDropdown(this.filterInput.value);
            this.pathDropdownContainer.addClass('ai-organiser-block');
        });

        this.filterInput.addEventListener('input', () => {
            this.searchTerm = this.filterInput.value;
            this.updatePathDropdown(this.searchTerm);
            
            // Make sure dropdown is visible when typing
            this.pathDropdownContainer.addClass('ai-organiser-block');
        });

        this.filterInput.addEventListener('click', (e) => {
            // Prevent document click handler from hiding dropdown
            e.stopPropagation();
            
            // Show dropdown on click in the input
            this.updatePathDropdown(this.filterInput.value);
            this.pathDropdownContainer.addClass('ai-organiser-block');
        });

        // Handle clicks outside the dropdown
        document.addEventListener('click', this.documentClickListener);

        // Create spacer element to push buttons to bottom
        const spacerEl = contentEl.createDiv('modal-spacer');
        spacerEl.addClass('ai-organiser-flex-1');
        spacerEl.setCssProps({ '--min-h': '20px' }); spacerEl.addClass('ai-organiser-min-h-custom');
        
        // Create button container for Save/Cancel with improved positioning
        const buttonContainer = contentEl.createDiv('modal-button-container');
        buttonContainer.addClass('ai-organiser-flex-row');
        buttonContainer.addClass('ai-organiser-gap-8');
        buttonContainer.addClass('ai-organiser-mt-20');
        buttonContainer.setCssProps({ '--pad': '10px 0' }); buttonContainer.addClass('ai-organiser-pad-custom');
        buttonContainer.addClass('ai-organiser-border-t');
        
        // Left-side buttons container
        const leftButtonContainer = buttonContainer.createDiv('left-buttons');
        
        // Add Clear All button
        const clearAllButtonEl = new ButtonComponent(leftButtonContainer)
            .setButtonText(this.plugin.t.modals.clearAllButton)
            .onClick(() => { void (async () => {
                // Confirmation dialog to prevent accidental deletion
                if (this.excludedFolders.length > 0 && await this.plugin.showConfirmationDialog(this.plugin.t.modals.clearAllConfirm)) {
                    this.excludedFolders = [];
                    this.renderExcludedList(excludedListContainer);
                }
            })(); });
        
        // Set appropriate class
        clearAllButtonEl.buttonEl.addClass('ai-organiser-excluded-files-clear-button');
        clearAllButtonEl.buttonEl.addClass('ai-organiser-bg-secondary');
        
        // Disable button if no exclusions exist
        if (this.excludedFolders.length === 0) {
            clearAllButtonEl.buttonEl.setAttribute('disabled', 'true');
            clearAllButtonEl.buttonEl.addClass('disabled');
        }
        
        // Right-side buttons container
        const rightButtonContainer = buttonContainer.createDiv('right-buttons');
        rightButtonContainer.addClass('ai-organiser-flex-row', 'ai-organiser-gap-10');
        
        // Add cancel button
        const cancelButtonEl = new ButtonComponent(rightButtonContainer)
            .setButtonText(this.plugin.t.modals.cancelButton)
            .onClick(() => {
                this.close();
            });
        
        cancelButtonEl.buttonEl.setCssProps({ '--min-w': '80px' }); cancelButtonEl.buttonEl.addClass('ai-organiser-min-w-custom');
        
        // Add save button
        const saveButtonEl = new ButtonComponent(rightButtonContainer)
            .setButtonText(this.plugin.t.modals.saveButton)
            .setCta()
            .onClick(() => {
                this.onSave(this.excludedFolders);
                this.close();
            });
        
        saveButtonEl.buttonEl.setCssProps({ '--min-w': '80px' }); saveButtonEl.buttonEl.addClass('ai-organiser-min-w-custom');
    }

    private updatePathDropdown(searchTerm: string) {
        this.pathDropdownContainer.empty();
        
        try {
            // Make sure paths are loaded
            if (!this.hasLoadedPaths) {
                this.loadCachedPaths();
            }
            
            const lowerSearchTerm = searchTerm.toLowerCase().trim();
            let matchedItems: VaultItem[] = [];
            
            // Filter cached paths based on search term
            if (lowerSearchTerm) {
                matchedItems = this.cachedPaths.filter(item => 
                    item.path.toLowerCase().includes(lowerSearchTerm) ||
                    item.name.toLowerCase().includes(lowerSearchTerm)
                );
                
                // Sort by relevance - exact matches first, then starts with, then includes
                matchedItems.sort((a, b) => {
                    const aName = a.name.toLowerCase();
                    const bName = b.name.toLowerCase();
                    const aPath = a.path.toLowerCase();
                    const bPath = b.path.toLowerCase();
                    
                    // Exact name matches
                    if (aName === lowerSearchTerm && bName !== lowerSearchTerm) return -1;
                    if (aName !== lowerSearchTerm && bName === lowerSearchTerm) return 1;
                    
                    // Name starts with
                    if (aName.startsWith(lowerSearchTerm) && !bName.startsWith(lowerSearchTerm)) return -1;
                    if (!aName.startsWith(lowerSearchTerm) && bName.startsWith(lowerSearchTerm)) return 1;
                    
                    // Path starts with
                    if (aPath.startsWith(lowerSearchTerm) && !bPath.startsWith(lowerSearchTerm)) return -1;
                    if (!aPath.startsWith(lowerSearchTerm) && bPath.startsWith(lowerSearchTerm)) return 1;
                    
                    // Folders first
                    if (a.isFolder && !b.isFolder) return -1;
                    if (!a.isFolder && b.isFolder) return 1;
                    
                    // Default to alphabetical
                    return aPath.localeCompare(bPath);
                });
            } else {
                // Show common folders/patterns if no search term
                const commonPatterns = [
                    { path: 'Tags/', isFolder: true, name: 'Tags' },
                    { path: 'images/', isFolder: true, name: 'images' },
                    { path: 'audio/', isFolder: true, name: 'audio' },
                    { path: 'Excalidraw/', isFolder: true, name: 'Excalidraw' },
                    { path: 'textgenerator/', isFolder: true, name: 'textgenerator' },
                    { path: 'attachments/', isFolder: true, name: 'attachments' },
                    { path: 'templates/', isFolder: true, name: 'templates' },
                    { path: `${this.app.vault.configDir}/`, isFolder: true, name: this.app.vault.configDir },
                ];
                
                // Find actual matching folders from vault that match common patterns
                for (const pattern of commonPatterns) {
                    const existingItem = this.cachedPaths.find(item => 
                        item.path.toLowerCase() === pattern.path.toLowerCase() ||
                        item.name.toLowerCase() === pattern.name.toLowerCase()
                    );
                    
                    if (existingItem) {
                        matchedItems.push(existingItem);
                    } else {
                        // Add suggestion even if not found
                        matchedItems.push(pattern);
                    }
                }
            }
            
            // Limit items shown for performance
            const limitedItems = matchedItems.slice(0, 10);
            
            if (limitedItems.length === 0) {
                // Show a message when no items match
                const noItemsEl = this.pathDropdownContainer.createDiv({
                    cls: 'path-dropdown-empty'
                });
                noItemsEl.setCssProps({ '--pad': '10px' }); noItemsEl.addClass('ai-organiser-pad-custom');
                noItemsEl.addClass('ai-organiser-text-center');
                noItemsEl.addClass('ai-organiser-text-muted');
                noItemsEl.addClass('ai-organiser-text-lg');
                
                noItemsEl.textContent = this.plugin.t.modals.noMatchingPaths;
                
                // Add option to use current text as a pattern
                if (lowerSearchTerm) {
                    const useCurrentTextEl = this.pathDropdownContainer.createDiv({
                        cls: 'path-dropdown-item path-use-current'
                    });
                    useCurrentTextEl.setCssProps({ '--pad': '8px 12px' }); useCurrentTextEl.addClass('ai-organiser-pad-custom');
                    useCurrentTextEl.addClass('ai-organiser-cursor-pointer');
                    useCurrentTextEl.addClass('ai-organiser-flex-center');
                    useCurrentTextEl.addClass('ai-organiser-text-accent');
                    useCurrentTextEl.addClass('ai-organiser-bg-secondary');
                    useCurrentTextEl.addClass('ai-organiser-rounded');
                    useCurrentTextEl.setCssProps({ '--margin': '8px' }); useCurrentTextEl.addClass('ai-organiser-margin-custom');
                    
                    useCurrentTextEl.addEventListener('mouseenter', () => {
                        useCurrentTextEl.setCssProps({ '--bg': 'var(--background-modifier-hover)' }); useCurrentTextEl.addClass('ai-organiser-bg-custom');
                    });
                    
                    useCurrentTextEl.addEventListener('mouseleave', () => {
                        useCurrentTextEl.addClass('ai-organiser-bg-secondary');
                    });
                    
                    useCurrentTextEl.textContent = this.plugin.t.modals.useAsPattern.replace('{searchTerm}', searchTerm);
                    
                    useCurrentTextEl.addEventListener('click', () => {
                        // Add current text as an exclusion pattern
                        if (!this.excludedFolders.includes(searchTerm)) {
                            this.excludedFolders.push(searchTerm);
                            const listContainer = this.contentEl.querySelector('.ai-organiser-excluded-list') as HTMLElement;
                            if (listContainer) this.renderExcludedList(listContainer);
                            this.filterInput.value = '';
                            this.searchTerm = '';
                            this.pathDropdownContainer.addClass('ai-organiser-hidden');
                        }
                    });
                }
            } else {
                // Render all matched items
                for (const item of limitedItems) {
                    this.renderPathItem(item);
                }
                
                // Show total count if there are more results
                if (matchedItems.length > limitedItems.length) {
                    const moreItemsEl = this.pathDropdownContainer.createDiv({
                        cls: 'path-dropdown-more'
                    });
                    moreItemsEl.setCssProps({ '--pad': '6px 10px' }); moreItemsEl.addClass('ai-organiser-pad-custom');
                    moreItemsEl.addClass('ai-organiser-text-center');
                    moreItemsEl.addClass('ai-organiser-text-md');
                    moreItemsEl.addClass('ai-organiser-text-muted');
                    moreItemsEl.addClass('ai-organiser-border-t');
                    
                    moreItemsEl.textContent = `${matchedItems.length - limitedItems.length} ${this.plugin.t.modals.moreResults}`;
                }
            }
            
            // Display the dropdown
            this.pathDropdownContainer.addClass('ai-organiser-block');
        } catch (_error) {
            
            // Show error state
            const errorEl = this.pathDropdownContainer.createDiv({
                cls: 'path-dropdown-error'
            });
            errorEl.setCssProps({ '--pad': '10px' }); errorEl.addClass('ai-organiser-pad-custom');
            errorEl.addClass('ai-organiser-text-error');
            errorEl.textContent = this.plugin.t.modals.errorLoadingPaths;
        }
    }

    private renderPathItem(item: VaultItem) {
        const itemEl = this.pathDropdownContainer.createDiv({
            cls: 'path-dropdown-item'
        });
        
        // Style the item
        itemEl.setCssProps({ '--pad': '8px 12px' }); itemEl.addClass('ai-organiser-pad-custom');
        itemEl.addClass('ai-organiser-cursor-pointer');
        itemEl.addClass('ai-organiser-flex-center');
        itemEl.addClass('ai-organiser-border-b');
        
        // Add hover effect
        itemEl.addEventListener('mouseenter', () => {
            itemEl.setCssProps({ '--bg': 'var(--background-modifier-hover)' }); itemEl.addClass('ai-organiser-bg-custom');
        });
        
        itemEl.addEventListener('mouseleave', () => {
            itemEl.removeClass('ai-organiser-bg-custom');
        });
        
        // Add appropriate icon
        const iconEl = itemEl.createSpan({
            cls: `path-item-icon ${item.isFolder ? 'folder-icon' : 'file-icon'}`
        });
        
        iconEl.addClass('ai-organiser-mr-8');
        iconEl.addClass('ai-organiser-text-lg');
        iconEl.setCssProps({ '--min-w': '20px' }); iconEl.addClass('ai-organiser-min-w-custom');
        iconEl.addClass('ai-organiser-inline-flex');
        iconEl.addClass('ai-organiser-items-center');
        iconEl.addClass('ai-organiser-flex-end');
        
        // Create text element for path
        const textEl = itemEl.createSpan({
            cls: 'path-item-text',
            text: item.path
        });
        
        textEl.addClass('ai-organiser-overflow-hidden');
        textEl.addClass('ai-organiser-truncate');
        textEl.addClass('ai-organiser-truncate');
        textEl.addClass('ai-organiser-flex-1');
        
        // Highlight search term if applicable
        if (this.searchTerm) {
            const searchTermLower = this.searchTerm.toLowerCase();
            const pathLower = item.path.toLowerCase();
            const index = pathLower.indexOf(searchTermLower);
            
            if (index >= 0) {
                textEl.empty();
                
                // Text before match
                if (index > 0) {
                    textEl.createSpan({
                        text: item.path.substring(0, index)
                    });
                }
                
                // Highlighted match
                const highlightSpan = textEl.createSpan({
                    text: item.path.substring(index, index + this.searchTerm.length),
                    cls: 'path-match-highlight'
                });
                
                highlightSpan.setCssProps({ '--bg': 'var(--text-highlight-bg)' }); highlightSpan.addClass('ai-organiser-bg-custom');
                highlightSpan.addClass('ai-organiser-rounded');
                
                // Text after match
                if (index + this.searchTerm.length < item.path.length) {
                    textEl.createSpan({
                        text: item.path.substring(index + this.searchTerm.length)
                    });
                }
            }
        }
        
        // Add click handler
        itemEl.addEventListener('click', () => {
            this.filterInput.value = item.path;
            this.searchTerm = item.path;
            this.pathDropdownContainer.addClass('ai-organiser-hidden');
            
            // Add path to excluded folders directly
            if (!this.excludedFolders.includes(item.path)) {
                this.excludedFolders.push(item.path);
                const listContainer = this.contentEl.querySelector('.ai-organiser-excluded-list') as HTMLElement;
                if (listContainer) this.renderExcludedList(listContainer);
                this.filterInput.value = '';
                this.searchTerm = '';
            }
        });
    }

    private renderExcludedList(container: HTMLElement) {
        container.empty();
        
        if (this.excludedFolders.length === 0) {
            const emptyEl = container.createEl('div', {
                text: this.plugin.t.modals.noExclusionsDefined,
                cls: 'ai-organiser-excluded-empty-message'
            });
            
            emptyEl.setCssProps({ '--pad': '10px' }); emptyEl.addClass('ai-organiser-pad-custom');
            emptyEl.addClass('ai-organiser-text-muted');
            emptyEl.addClass('ai-organiser-text-center');
            emptyEl.addClass('ai-organiser-italic');
            
            return;
        }
        
        const excludedList = container.createEl('div', {
            cls: 'ai-organiser-excluded-folders-list'
        });
        
        for (const folder of this.excludedFolders) {
            const item = excludedList.createEl('div', {
                cls: 'ai-organiser-excluded-folder-item'
            });
            
            item.addClass('ai-organiser-flex-center');
            item.addClass('ai-organiser-flex-between');
            item.setCssProps({ '--pad': '6px 8px' }); item.addClass('ai-organiser-pad-custom');
            item.setCssProps({ '--margin': '3px 0' }); item.addClass('ai-organiser-margin-custom');
            item.addClass('ai-organiser-bg-primary');
            item.addClass('ai-organiser-rounded');
            item.addClass('ai-organiser-border');
            
            // Path text with icon
            const pathContainer = item.createDiv({
                cls: 'ai-organiser-excluded-folder-path'
            });
            pathContainer.addClass('ai-organiser-flex-center');
            pathContainer.addClass('ai-organiser-overflow-hidden');
            pathContainer.addClass('ai-organiser-flex-1');
            
            // Add appropriate icon based on pattern
            const isFolder = folder.endsWith('/');
            const iconEl = pathContainer.createSpan({
                cls: `ai-organiser-excluded-item-icon ${isFolder ? 'folder-icon' : folder.includes('*') ? 'search-icon' : 'file-icon'}`
            });
            iconEl.addClass('ai-organiser-mr-8');
            
            // Path text
            const textEl = pathContainer.createSpan({
                text: folder,
                cls: 'ai-organiser-excluded-folder-text'
            });
            textEl.addClass('ai-organiser-overflow-hidden');
            textEl.addClass('ai-organiser-truncate');
            textEl.addClass('ai-organiser-truncate');
            
            // Remove button
            const removeButton = item.createEl('button', {
                cls: 'ai-organiser-excluded-folder-remove',
                text: '×'
            });
            
            removeButton.setCssProps({ '--border': 'none' }); removeButton.addClass('ai-organiser-border-custom');
            removeButton.setCssProps({ '--bg': 'none' }); removeButton.addClass('ai-organiser-bg-custom');
            removeButton.addClass('ai-organiser-cursor-pointer');
            removeButton.addClass('ai-organiser-text-muted');
            removeButton.setCssProps({ '--pad': '0 4px' }); removeButton.addClass('ai-organiser-pad-custom');
            removeButton.addClass('ai-organiser-text-lg');
            removeButton.addClass('ai-organiser-ml-4');
            
            removeButton.addEventListener('mouseenter', () => {
                removeButton.addClass('ai-organiser-text-error');
            });
            
            removeButton.addEventListener('mouseleave', () => {
                removeButton.addClass('ai-organiser-text-muted');
            });
            
            removeButton.addEventListener('click', (e) => {
                e.stopPropagation();
                const index = this.excludedFolders.indexOf(folder);
                if (index !== -1) {
                    this.excludedFolders.splice(index, 1);
                    this.renderExcludedList(container);
                }
            });
        }
    }

    onClose() {
        document.removeEventListener('click', this.documentClickListener);
        this.contentEl.empty();
    }
} 