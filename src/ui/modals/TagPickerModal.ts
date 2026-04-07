import { App, FuzzySuggestModal, Notice } from 'obsidian';
import type { Translations } from '../../i18n/types';

export class TagPickerModal extends FuzzySuggestModal<string> {
    private readonly tags: string[];
    private readonly onSelect: (tag: string) => void;

    constructor(app: App, t: Translations, onSelect: (tag: string) => void) {
        super(app);
        this.onSelect = onSelect;
        this.tags = this.getTags(app);

        this.setPlaceholder(t.modals.tagPicker?.placeholder ?? 'Select a tag...');
        this.setTitle(t.modals.tagPicker?.title ?? 'Select tag');

        if (this.tags.length === 0) {
            new Notice(t.modals.tagPicker?.noTags ?? 'No tags found');
            this.close();
        }
    }

    getItems(): string[] {
        return this.tags;
    }

    getItemText(item: string): string {
        return item;
    }

    onChooseItem(item: string): void {
        this.onSelect(item);
    }

    private getTags(app: App): string[] {
        const tagCounts = (app.metadataCache as { getTags?: () => Record<string, number> }).getTags?.() ?? {};
        return Object.keys(tagCounts)
            .map(tag => (tag.startsWith('#') ? tag.substring(1) : tag))
            .sort((a, b) => a.localeCompare(b));
    }
}
