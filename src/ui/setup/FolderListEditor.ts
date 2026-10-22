/**
 * FolderListEditor: a list of vault folders chosen with the folder picker, never typed.
 *
 * Add uses the existing `FolderSuggest` popover; each row shows a live note count and a
 * "folder not found" warning when the folder no longer exists; Remove drops it. The list
 * logic (`addFolderToList`, `removeFolderFromList`) is pure so every consumer (protected
 * folders, agent index scope, inbox sweep) shares one behaviour.
 */
import { App, Setting, TFile, TFolder, type TextComponent } from 'obsidian';
import type { Translations } from '../../i18n/types';
import { normalisePath } from '../../core/protectedPaths';
import { FolderSuggest } from '../settings/components/FolderSuggest';
import { plural } from '../../utils/plural';

/** Add a folder to the list. Ignores empty input and duplicates (case-insensitive). */
export function addFolderToList(list: readonly string[], folder: string): { list: string[]; added: boolean } {
    const norm = normalisePath(folder);
    if (!norm) return { list: [...list], added: false };
    const key = norm.toLowerCase();
    if (list.some((f) => normalisePath(f).toLowerCase() === key)) return { list: [...list], added: false };
    return { list: [...list, norm], added: true };
}

/** Remove a folder from the list (case-insensitive). */
export function removeFolderFromList(list: readonly string[], folder: string): string[] {
    const key = normalisePath(folder).toLowerCase();
    return list.filter((f) => normalisePath(f).toLowerCase() !== key);
}

/** Number of markdown notes inside a folder (any depth). */
export function countNotesInFolder(app: App, folder: string): number {
    const prefix = normalisePath(folder).toLowerCase() + '/';
    let count = 0;
    for (const file of app.vault.getMarkdownFiles()) {
        if (file.path.toLowerCase().startsWith(prefix)) count++;
    }
    return count;
}

/** True when the path is an existing vault folder. */
export function folderExists(app: App, folder: string): boolean {
    return app.vault.getAbstractFileByPath(normalisePath(folder)) instanceof TFolder;
}

export interface FolderListEditorOptions {
    app: App;
    container: HTMLElement;
    t: Translations;
    /** Current list (the editor never mutates it; it reports the next list through `onChange`). */
    getFolders: () => readonly string[];
    onChange: (next: string[]) => void | Promise<void>;
    /** Text shown when the list is empty. Defaults to `t.setup.noFoldersYet`. */
    emptyText?: string;
}

export class FolderListEditor {
    private listEl: HTMLElement | null = null;
    private pending = '';
    private input: TextComponent | null = null;

    constructor(private readonly opts: FolderListEditorOptions) {}

    render(): void {
        const { container, t, app } = this.opts;
        const adder = new Setting(container).setName(t.setup.addFolder);
        adder.addText((text) => {
            this.input = text;
            text.setPlaceholder(t.setup.chooseFolder);
            text.onChange((value) => { this.pending = value; });
            text.inputEl.setAttribute('aria-label', t.setup.chooseFolder);
            new FolderSuggest(app, text.inputEl, (value) => { this.pending = value; });
        });
        adder.addButton((btn) => btn
            .setButtonText(t.setup.addFolder)
            .setCta()
            .onClick(() => { void this.add(); }));
        this.listEl = container.createDiv({ cls: 'ai-organiser-folder-list' });
        this.renderList();
    }

    /** Re-render the rows from the current list. */
    refresh(): void {
        this.renderList();
    }

    private async add(): Promise<void> {
        const { app, t } = this.opts;
        const picked = this.pending.trim();
        if (!picked) return;
        if (!folderExists(app, picked)) {
            this.showHint(t.setup.folderMissing);
            return;
        }
        const res = addFolderToList(this.opts.getFolders(), picked);
        this.pending = '';
        this.input?.setValue('');
        if (res.added) await this.opts.onChange(res.list);
        this.renderList();
    }

    private showHint(text: string): void {
        if (!this.listEl) return;
        // One hint at a time: a second invalid attempt replaces the first.
        for (const old of Array.from(this.listEl.querySelectorAll('.ai-organiser-folder-list-hint'))) old.remove();
        this.listEl.createDiv({ cls: 'ai-organiser-folder-list-hint', text, attr: { role: 'status' } });
    }

    private renderList(): void {
        const listEl = this.listEl;
        if (!listEl) return;
        const { app, t } = this.opts;
        listEl.empty();
        const folders = this.opts.getFolders();
        if (folders.length === 0) {
            listEl.createDiv({ cls: 'setting-item-description', text: this.opts.emptyText ?? t.setup.noFoldersYet });
            return;
        }
        for (const folder of folders) {
            const exists = folderExists(app, folder);
            const row = new Setting(listEl).setName(folder);
            row.setDesc(exists
                ? plural(t.setup.folderCount, countNotesInFolder(app, folder))
                : t.setup.folderMissingWarning);
            if (!exists) row.settingEl.addClass('ai-organiser-folder-missing');
            row.addExtraButton((btn) => btn
                .setIcon('trash-2')
                .setTooltip(t.setup.removeFolder)
                .onClick(() => {
                    void (async () => {
                        await this.opts.onChange(removeFolderFromList(this.opts.getFolders(), folder));
                        this.renderList();
                    })();
                }));
        }
    }
}

/** Convenience used by tests and callers that only have files. */
export function notesUnder(files: readonly TFile[], folder: string): TFile[] {
    const prefix = normalisePath(folder).toLowerCase() + '/';
    return files.filter((f) => f.path.toLowerCase().startsWith(prefix));
}
