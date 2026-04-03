import { App, Modal, Setting, setIcon } from 'obsidian';
import type AIOrganiserPlugin from '../../main';

export type TagScope = 'note' | 'folder' | 'vault';

interface ScopeOption {
    value: TagScope;
    label: string;
    description: string;
    icon: string;
}

export class TagScopeModal extends Modal {
    private plugin: AIOrganiserPlugin;
    private selectedScope: TagScope = 'note';
    private onConfirm: (scope: TagScope) => void;

    constructor(
        app: App,
        plugin: AIOrganiserPlugin,
        onConfirm: (scope: TagScope) => void
    ) {
        super(app);
        this.plugin = plugin;
        this.onConfirm = onConfirm;
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('ai-organiser-scope-modal');

        // Title
        contentEl.createEl('h2', {
            text: this.plugin.t.modals.tagScope.title,
            cls: 'ai-organiser-scope-title'
        });

        // Get context for descriptions
        const activeFile = this.app.workspace.getActiveFile();
        const noteName = activeFile?.basename || 'No file open';
        const folderName = activeFile?.parent?.path || 'Root';
        const folderFiles = activeFile?.parent
            ? this.plugin.getNonExcludedMarkdownFilesFromFolder(activeFile.parent).length
            : 0;
        const vaultFiles = this.plugin.getNonExcludedMarkdownFiles().length;

        const options: ScopeOption[] = [
            {
                value: 'note',
                label: this.plugin.t.modals.tagScope.thisNote,
                description: noteName,
                icon: 'file-text'
            },
            {
                value: 'folder',
                label: this.plugin.t.modals.tagScope.currentFolder,
                description: `${folderName} (${folderFiles} notes)`,
                icon: 'folder'
            },
            {
                value: 'vault',
                label: this.plugin.t.modals.tagScope.entireVault,
                description: `${vaultFiles} notes`,
                icon: 'database'
            }
        ];

        const optionsContainer = contentEl.createDiv({ cls: 'ai-organiser-scope-options' });

        for (const option of options) {
            this.renderOptionCard(optionsContainer, option);
        }

        // Cancel button only (options execute directly on click)
        const buttonContainer = contentEl.createDiv({ cls: 'ai-organiser-scope-buttons' });
        new Setting(buttonContainer)
            .addButton(btn => btn
                .setButtonText(this.plugin.t.modals.cancel)
                .onClick(() => this.close()));
    }

    private renderOptionCard(container: HTMLElement, option: ScopeOption): void {
        const card = container.createDiv({
            cls: `ai-organiser-scope-card ${option.value === this.selectedScope ? 'selected' : ''}`
        });
        card.dataset.value = option.value;

        // Icon
        const iconEl = card.createDiv({ cls: 'ai-organiser-scope-card-icon' });
        setIcon(iconEl, option.icon);

        // Content
        const contentEl = card.createDiv({ cls: 'ai-organiser-scope-card-content' });
        contentEl.createDiv({ cls: 'ai-organiser-scope-card-label', text: option.label });
        contentEl.createDiv({ cls: 'ai-organiser-scope-card-desc', text: option.description });

        // Click handler - execute immediately (direct manipulation UX)
        card.addEventListener('click', () => {
            this.close();
            this.onConfirm(option.value);
        });
    }

    onClose(): void {
        this.contentEl.empty();
    }
}
