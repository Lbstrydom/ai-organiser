import { App, Modal, Setting, setIcon, TFolder, TFile } from 'obsidian';
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
        const taggableCount = parentFolder
            ? this.plugin.getNonExcludedMarkdownFilesFromFolder(parentFolder).length
            : 0;
        // Raw file count (before exclusion filter) lets us distinguish the
        // "folder is empty" case from the "everything here is excluded" case
        // — persona round 4 P2 #14: a populated test folder showed "(0 notes)"
        // because it sat under the default-excluded AI-Organiser output dir.
        const rawCount = parentFolder ? this.countMarkdownRecursive(parentFolder) : 0;
        const vaultFiles = this.plugin.getNonExcludedMarkdownFiles().length;

        const ts = this.plugin.t.modals.tagScope;
        let folderDesc: string;
        if (!parentFolder) {
            folderDesc = ts.folderRequiresOpenNote || 'Open a note first to scope to its folder';
        } else if (taggableCount === 0 && rawCount > 0) {
            folderDesc = (ts.folderAllExcluded || '{folder} ({raw} notes — all excluded by settings)')
                .replace('{folder}', folderName)
                .replace('{raw}', String(rawCount));
        } else {
            folderDesc = (ts.folderTaggableCount || '{folder} ({count} taggable notes)')
                .replace('{folder}', folderName)
                .replace('{count}', String(taggableCount));
        }

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

    /**
     * Count all markdown files under a folder, ignoring the user's
     * exclude-folders list. Used alongside getNonExcludedMarkdownFilesFromFolder
     * so we can distinguish "folder is empty" from "everything here is
     * excluded by settings" — the latter previously looked like a count bug.
     */
    private countMarkdownRecursive(folder: TFolder): number {
        let count = 0;
        for (const child of folder.children) {
            if (child instanceof TFile && child.extension === 'md') {
                count++;
            } else if (child instanceof TFolder) {
                count += this.countMarkdownRecursive(child);
            }
        }
        return count;
    }

    onClose(): void {
        this.contentEl.empty();
    }
}
