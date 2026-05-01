/**
 * Source Picker Modal — Create-flow source picker
 *
 * Allows the user to pick a source for the slide-creation flow. Each
 * variant resolves to a `SelectedSource` — the controller owns turning
 * that into resolved content.
 *
 * Three variants share the same modal class so the panel can mount one
 * picker per "+ Add note / + Add folder / + Add web search" button:
 *   - 'note'   → FuzzySuggestModal across all md files in the vault
 *   - 'folder' → FuzzySuggestModal across all folders
 *   - 'web'    → free-form query input
 *
 * Plan: docs/completed/slide-authoring-followup-implementation.md (Phase C).
 */

import { App, FuzzySuggestModal, Modal, ButtonComponent, TFile, TFolder } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import type { SelectedSource } from '../../services/chat/presentationTypes';

export type SourcePickerKind = 'note' | 'folder' | 'web';

interface FuzzyItemFile { kind: 'note'; file: TFile; }
interface FuzzyItemFolder { kind: 'folder'; folder: TFolder; }

/**
 * Open the appropriate picker for the requested kind. Returns the
 * SelectedSource via callback (or null if the user cancelled).
 */
export function openSourcePicker(
    app: App,
    plugin: AIOrganiserPlugin,
    kind: SourcePickerKind,
    onPick: (source: SelectedSource | null) => void,
): void {
    if (kind === 'note') {
        new NoteSourcePickerModal(app, plugin, onPick).open();
    } else if (kind === 'folder') {
        new FolderSourcePickerModal(app, plugin, onPick).open();
    } else {
        new WebSourcePickerModal(app, plugin, onPick).open();
    }
}

class NoteSourcePickerModal extends FuzzySuggestModal<FuzzyItemFile> {
    private picked = false;

    constructor(
        app: App,
        private readonly plugin: AIOrganiserPlugin,
        private readonly onPick: (source: SelectedSource | null) => void,
    ) {
        super(app);
        const t = this.plugin.t.modals.unifiedChat;
        this.setPlaceholder(t.slideCreateSourcesAddNote);
    }

    getItems(): FuzzyItemFile[] {
        return this.app.vault.getMarkdownFiles().map((f): FuzzyItemFile => ({ kind: 'note', file: f }));
    }

    getItemText(item: FuzzyItemFile): string {
        return item.file.path;
    }

    onChooseItem(item: FuzzyItemFile): void {
        this.picked = true;
        this.onPick({ kind: 'note', ref: item.file.path });
    }

    onClose(): void {
        super.onClose();
        if (!this.picked) this.onPick(null);
    }
}

class FolderSourcePickerModal extends FuzzySuggestModal<FuzzyItemFolder> {
    private picked = false;

    constructor(
        app: App,
        private readonly plugin: AIOrganiserPlugin,
        private readonly onPick: (source: SelectedSource | null) => void,
    ) {
        super(app);
        const t = this.plugin.t.modals.unifiedChat;
        this.setPlaceholder(t.slideCreateSourcesAddFolder);
    }

    getItems(): FuzzyItemFolder[] {
        const folders: TFolder[] = [];
        const walk = (folder: TFolder): void => {
            folders.push(folder);
            for (const child of folder.children) {
                if (child instanceof TFolder) walk(child);
            }
        };
        const root = this.app.vault.getRoot();
        for (const child of root.children) {
            if (child instanceof TFolder) walk(child);
        }
        folders.sort((a, b) => a.path.localeCompare(b.path));
        return folders.map((f): FuzzyItemFolder => ({ kind: 'folder', folder: f }));
    }

    getItemText(item: FuzzyItemFolder): string {
        return item.folder.path || '/';
    }

    onChooseItem(item: FuzzyItemFolder): void {
        this.picked = true;
        this.onPick({ kind: 'folder', ref: item.folder.path });
    }

    onClose(): void {
        super.onClose();
        if (!this.picked) this.onPick(null);
    }
}

class WebSourcePickerModal extends Modal {
    private input!: HTMLInputElement;
    private picked = false;

    constructor(
        app: App,
        private readonly plugin: AIOrganiserPlugin,
        private readonly onPick: (source: SelectedSource | null) => void,
    ) {
        super(app);
    }

    onOpen(): void {
        const { contentEl } = this;
        const t = this.plugin.t.modals.unifiedChat;
        contentEl.empty();
        contentEl.addClass('ai-organiser-pres-web-source-picker');

        contentEl.createEl('h2', { text: t.slideCreateSourcesAddWeb });

        this.input = contentEl.createEl('input', {
            type: 'text',
            placeholder: t.slideCreateSourcesAddWeb,
            cls: 'ai-organiser-pres-web-source-input',
        });
        this.input.addClass('ai-organiser-w-full');

        const buttonRow = contentEl.createDiv({ cls: 'ai-organiser-pres-web-source-actions' });
        buttonRow.addClass('ai-organiser-flex-row', 'ai-organiser-gap-8', 'ai-organiser-mt-12');

        new ButtonComponent(buttonRow)
            .setButtonText(this.plugin.t.common.cancel)
            .onClick(() => this.close());

        const addBtn = new ButtonComponent(buttonRow)
            .setButtonText(this.plugin.t.common.confirm)
            .setCta()
            .onClick(() => this.commit());

        const refresh = (): void => {
            addBtn.setDisabled(this.input.value.trim().length === 0);
        };
        this.input.addEventListener('input', refresh);
        this.input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                this.commit();
            }
        });
        setTimeout(() => this.input.focus(), 0);
        refresh();
    }

    private commit(): void {
        const query = this.input.value.trim();
        if (!query) return;
        this.picked = true;
        this.onPick({ kind: 'web-search', ref: query });
        this.close();
    }

    onClose(): void {
        this.contentEl.empty();
        if (!this.picked) this.onPick(null);
    }
}
