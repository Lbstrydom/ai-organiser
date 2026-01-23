import { App, Modal, Setting } from 'obsidian';
import type AIOrganiserPlugin from '../../main';

export type ClearTagsScope = 'note' | 'folder' | 'vault';

interface ScopeOption {
    value: ClearTagsScope;
    label: string;
    description: string;
    icon: string;
}

export class ClearTagsScopeModal extends Modal {
    private plugin: AIOrganiserPlugin;
    private selectedScope: ClearTagsScope = 'note';
    private onConfirm: (scope: ClearTagsScope) => void;

    constructor(
        app: App,
        plugin: AIOrganiserPlugin,
        onConfirm: (scope: ClearTagsScope) => void
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
            text: this.plugin.t.modals.clearTagsScope.title,
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
                label: this.plugin.t.modals.clearTagsScope.thisNote,
                description: noteName,
                icon: this.getFileIcon()
            },
            {
                value: 'folder',
                label: this.plugin.t.modals.clearTagsScope.currentFolder,
                description: `${folderName} (${folderFiles} notes)`,
                icon: this.getFolderIcon()
            },
            {
                value: 'vault',
                label: this.plugin.t.modals.clearTagsScope.entireVault,
                description: `${vaultFiles} notes`,
                icon: this.getVaultIcon()
            }
        ];

        const optionsContainer = contentEl.createDiv({ cls: 'ai-organiser-scope-options' });

        for (const option of options) {
            this.renderOptionCard(optionsContainer, option);
        }

        // Buttons
        const buttonContainer = contentEl.createDiv({ cls: 'ai-organiser-scope-buttons' });
        new Setting(buttonContainer)
            .addButton(btn => btn
                .setButtonText(this.plugin.t.modals.cancel)
                .onClick(() => this.close()))
            .addButton(btn => btn
                .setButtonText(this.plugin.t.modals.clearTagsScope.clearButton)
                .setWarning()
                .onClick(() => {
                    this.close();
                    this.onConfirm(this.selectedScope);
                }));
    }

    private renderOptionCard(container: HTMLElement, option: ScopeOption): void {
        const card = container.createDiv({
            cls: `ai-organiser-scope-card ${option.value === this.selectedScope ? 'selected' : ''}`
        });
        card.dataset.value = option.value;

        // Icon
        const iconEl = card.createDiv({ cls: 'ai-organiser-scope-card-icon' });
        iconEl.innerHTML = option.icon;

        // Content
        const contentEl = card.createDiv({ cls: 'ai-organiser-scope-card-content' });
        contentEl.createDiv({ cls: 'ai-organiser-scope-card-label', text: option.label });
        contentEl.createDiv({ cls: 'ai-organiser-scope-card-desc', text: option.description });

        // Hidden radio for accessibility
        const radio = card.createEl('input', {
            type: 'radio',
            cls: 'ai-organiser-scope-radio-hidden',
            attr: { name: 'clear-tags-scope', value: option.value }
        });
        radio.checked = option.value === this.selectedScope;

        // Click handler
        card.addEventListener('click', () => {
            this.selectedScope = option.value;
            // Update visual selection
            container.querySelectorAll('.ai-organiser-scope-card').forEach(c => {
                c.removeClass('selected');
                (c.querySelector('input') as HTMLInputElement).checked = false;
            });
            card.addClass('selected');
            radio.checked = true;
        });
    }

    private getFileIcon(): string {
        return `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line></svg>`;
    }

    private getFolderIcon(): string {
        return `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>`;
    }

    private getVaultIcon(): string {
        return `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"></ellipse><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"></path><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"></path></svg>`;
    }

    onClose(): void {
        this.contentEl.empty();
    }
}
