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
        const parentFolder = activeFile?.parent ?? null;
        const folderRawPath = parentFolder?.path ?? '';
        const folderName = folderRawPath === '' || folderRawPath === '/'
            ? (this.plugin.t.modals.tagScope.vaultRoot || 'Vault root')
            : folderRawPath;
        const folderFiles = parentFolder
            ? this.plugin.getNonExcludedMarkdownFilesFromFolder(parentFolder).length
            : 0;
        const vaultFiles = this.plugin.getNonExcludedMarkdownFiles().length;

        // Defensive description for folder: when no file is open we can't scope
        // to a folder at all → say so explicitly instead of showing "(0 notes)"
        // which looks like a count bug (persona round 4 P2 #14).
        const folderDesc = parentFolder
            ? `${folderName} (${folderFiles} notes)`
            : (this.plugin.t.modals.tagScope.folderRequiresOpenNote || 'Open a note first to scope to its folder');

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
                description: folderDesc,
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
            const disabled =
                (option.value === 'folder' && !parentFolder) ||
                (option.value === 'note' && !activeFile);
            this.renderOptionCard(optionsContainer, option, disabled);
        }

        // Cancel button only (options execute directly on click)
        const buttonContainer = contentEl.createDiv({ cls: 'ai-organiser-scope-buttons' });
        new Setting(buttonContainer)
            .addButton(btn => btn
                .setButtonText(this.plugin.t.modals.cancel)
                .onClick(() => this.close()));
    }

    private renderOptionCard(container: HTMLElement, option: ScopeOption, disabled = false): void {
        const selectedCls = option.value === this.selectedScope ? 'selected' : '';
        const disabledCls = disabled ? 'is-disabled' : '';
        const card = container.createDiv({
            cls: `ai-organiser-scope-card ${selectedCls} ${disabledCls}`.trim()
        });
        card.dataset.value = option.value;

        // Icon
        const iconEl = card.createDiv({ cls: 'ai-organiser-scope-card-icon' });
        setIcon(iconEl, option.icon);

        // Content
        const contentEl = card.createDiv({ cls: 'ai-organiser-scope-card-content' });
        contentEl.createDiv({ cls: 'ai-organiser-scope-card-label', text: option.label });
        contentEl.createDiv({ cls: 'ai-organiser-scope-card-desc', text: option.description });

        if (disabled) return;

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
