/**
 * Reusable vault-folder picker for settings fields.
 *
 * `FolderSuggest` wraps Obsidian's `AbstractInputSuggest` to give any text input
 * a type-to-search autocomplete over all vault folders. `addFolderPicker` is the
 * canonical helper applied across every folder-path setting so the UX is
 * identical everywhere (browse-style autocomplete instead of plain text).
 *
 * Pure Obsidian APIs — no plugin imports — so the component is widely reusable.
 */

import { AbstractInputSuggest, App, Setting, TextComponent, TFolder } from 'obsidian';

/**
 * Pure suggestion filter — case-insensitive substring match on folder path,
 * sorted by path. Extracted so it can be unit-tested without the full Obsidian
 * popover machinery.
 */
export function filterFolders(folders: TFolder[], query: string): TFolder[] {
    const q = query.toLowerCase();
    return folders
        .filter(f => f.path.toLowerCase().includes(q))
        .sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Type-to-search suggestion popover over all loaded vault folders.
 * Filters case-insensitively by substring; renders the full folder path.
 */
export class FolderSuggest extends AbstractInputSuggest<TFolder> {
    private readonly inputEl: HTMLInputElement;
    private readonly onSelectCb: (value: string) => void;

    constructor(app: App, inputEl: HTMLInputElement, onSelect: (value: string) => void) {
        super(app, inputEl);
        this.inputEl = inputEl;
        this.onSelectCb = onSelect;
    }

    protected getSuggestions(query: string): TFolder[] {
        const allFolders = this.app.vault
            .getAllLoadedFiles()
            .filter((f): f is TFolder => f instanceof TFolder);
        return filterFolders(allFolders, query);
    }

    renderSuggestion(folder: TFolder, el: HTMLElement): void {
        el.setText(folder.path);
    }

    selectSuggestion(folder: TFolder): void {
        this.inputEl.value = folder.path;
        this.inputEl.trigger('input');
        this.onSelectCb(folder.path);
        this.close();
    }
}

/**
 * Add a browse-style folder picker (text input + `FolderSuggest`) to a Setting.
 *
 * `onChange` fires on both typing AND suggestion-select, so callers can keep
 * their existing normalization/default logic in one place. The picker is the
 * SAME helper everywhere — consistency is the goal.
 */
export function addFolderPicker(
    setting: Setting,
    app: App,
    getValue: () => string,
    onChange: (value: string) => void,
    placeholder?: string,
): TextComponent {
    let component!: TextComponent;
    setting.addText(text => {
        component = text;
        if (placeholder) text.setPlaceholder(placeholder);
        text.setValue(getValue());
        text.onChange(onChange);
        new FolderSuggest(app, text.inputEl, onChange);
    });
    return component;
}
