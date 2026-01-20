/**
 * Content Selection Modal
 * Allows users to select which embedded/linked content to include in note generation
 */

import { App, Modal, Setting, setIcon } from 'obsidian';
import type { Translations } from '../../i18n/types';
import { DetectedContent, ContentType, getContentTypeDisplayName, getContentTypeIcon } from '../../utils/embeddedContentDetector';

export interface ContentSelectionResult {
    selectedItems: DetectedContent[];
    includeNoteText: boolean;
    cancelled: boolean;
}

export class ContentSelectionModal extends Modal {
    private detectedItems: DetectedContent[];
    private selectedItems: Set<DetectedContent>;
    private includeNoteText: boolean = true;
    private readonly onSubmit: (result: ContentSelectionResult) => void;
    private readonly t: Translations;
    private readonly noteHasText: boolean;

    constructor(
        app: App,
        translations: Translations,
        detectedItems: DetectedContent[],
        noteHasText: boolean,
        onSubmit: (result: ContentSelectionResult) => void
    ) {
        super(app);
        this.t = translations;
        this.detectedItems = detectedItems;
        this.noteHasText = noteHasText;
        this.selectedItems = new Set();
        this.onSubmit = onSubmit;
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.addClass('ai-organiser-modal-content');
        contentEl.addClass('ai-organiser-content-selection-modal');

        // Title
        contentEl.createEl('h2', {
            text: this.t.modals.contentSelection?.title || 'Select Content to Include'
        });

        // Description
        contentEl.createEl('p', {
            text: this.t.modals.contentSelection?.description ||
                'Select which embedded content to extract and include in your note. The AI will analyze and summarize the selected items.',
            cls: 'setting-item-description'
        });

        // Include note text toggle (if there's text in the note)
        if (this.noteHasText) {
            new Setting(contentEl)
                .setName(this.t.modals.contentSelection?.includeNoteText || 'Include existing note text')
                .setDesc(this.t.modals.contentSelection?.includeNoteTextDesc || 'Keep the current text content of the note')
                .addToggle(toggle => toggle
                    .setValue(this.includeNoteText)
                    .onChange(value => this.includeNoteText = value)
                );
        }

        // Group items by type
        const groupedItems = this.groupByType(this.detectedItems);

        // Create sections for each content type
        for (const [type, items] of groupedItems) {
            this.createTypeSection(contentEl, type, items);
        }

        // Select all / Deselect all buttons
        const buttonRow = contentEl.createDiv({ cls: 'ai-organiser-button-row' });

        const selectAllBtn = buttonRow.createEl('button', {
            text: this.t.modals.contentSelection?.selectAll || 'Select All',
            cls: 'mod-muted'
        });
        selectAllBtn.addEventListener('click', () => this.selectAll());

        const deselectAllBtn = buttonRow.createEl('button', {
            text: this.t.modals.contentSelection?.deselectAll || 'Deselect All',
            cls: 'mod-muted'
        });
        deselectAllBtn.addEventListener('click', () => this.deselectAll());

        // Action buttons
        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText(this.t.modals.contentSelection?.generateButton || 'Generate Note')
                .setCta()
                .onClick(() => this.submit())
            )
            .addButton(btn => btn
                .setButtonText(this.t.modals.cancel)
                .onClick(() => this.cancel())
            );
    }

    private groupByType(items: DetectedContent[]): Map<ContentType, DetectedContent[]> {
        const grouped = new Map<ContentType, DetectedContent[]>();

        for (const item of items) {
            if (!grouped.has(item.type)) {
                grouped.set(item.type, []);
            }
            grouped.get(item.type)!.push(item);
        }

        return grouped;
    }

    private createTypeSection(container: HTMLElement, type: ContentType, items: DetectedContent[]): void {
        const section = container.createDiv({ cls: 'ai-organiser-content-section' });

        // Section header with icon
        const header = section.createDiv({ cls: 'ai-organiser-section-header' });
        const iconEl = header.createSpan({ cls: 'ai-organiser-section-icon' });
        setIcon(iconEl, getContentTypeIcon(type));
        header.createSpan({
            text: `${getContentTypeDisplayName(type)} (${items.length})`,
            cls: 'ai-organiser-section-title'
        });

        // Items list
        const itemsList = section.createDiv({ cls: 'ai-organiser-items-list' });

        for (const item of items) {
            this.createItemRow(itemsList, item);
        }
    }

    private createItemRow(container: HTMLElement, item: DetectedContent): void {
        const row = container.createDiv({ cls: 'ai-organiser-item-row' });

        // Checkbox
        const checkbox = row.createEl('input', { type: 'checkbox' });
        checkbox.checked = this.selectedItems.has(item);
        checkbox.addEventListener('change', () => {
            if (checkbox.checked) {
                this.selectedItems.add(item);
            } else {
                this.selectedItems.delete(item);
            }
            this.updateRowStyle(row, checkbox.checked);
        });

        // Item info
        const infoDiv = row.createDiv({ cls: 'ai-organiser-item-info' });

        // Display name
        infoDiv.createDiv({
            text: item.displayName,
            cls: 'ai-organiser-item-name'
        });

        // URL/path (truncated)
        const urlText = item.url.length > 60 ? item.url.substring(0, 60) + '...' : item.url;
        infoDiv.createDiv({
            text: urlText,
            cls: 'ai-organiser-item-url'
        });

        // Status indicators
        const statusDiv = row.createDiv({ cls: 'ai-organiser-item-status' });

        if (item.isEmbedded) {
            statusDiv.createSpan({
                text: this.t.modals.contentSelection?.embedded || 'Embedded',
                cls: 'ai-organiser-status-badge'
            });
        }

        if (item.isExternal) {
            statusDiv.createSpan({
                text: this.t.modals.contentSelection?.external || 'External',
                cls: 'ai-organiser-status-badge ai-organiser-status-external'
            });
        }

        if (!item.isExternal && !item.resolvedFile) {
            statusDiv.createSpan({
                text: this.t.modals.contentSelection?.notFound || 'Not Found',
                cls: 'ai-organiser-status-badge ai-organiser-status-warning'
            });
        }
    }

    private updateRowStyle(row: HTMLElement, selected: boolean): void {
        if (selected) {
            row.addClass('ai-organiser-item-selected');
        } else {
            row.removeClass('ai-organiser-item-selected');
        }
    }

    private selectAll(): void {
        this.detectedItems.forEach(item => this.selectedItems.add(item));
        this.refreshCheckboxes();
    }

    private deselectAll(): void {
        this.selectedItems.clear();
        this.refreshCheckboxes();
    }

    private refreshCheckboxes(): void {
        const checkboxes = this.contentEl.querySelectorAll('input[type="checkbox"]');
        const rows = this.contentEl.querySelectorAll('.ai-organiser-item-row');

        checkboxes.forEach((checkbox, index) => {
            const item = this.detectedItems[index];
            if (item) {
                (checkbox as HTMLInputElement).checked = this.selectedItems.has(item);
                this.updateRowStyle(rows[index] as HTMLElement, this.selectedItems.has(item));
            }
        });
    }

    private submit(): void {
        this.close();
        this.onSubmit({
            selectedItems: Array.from(this.selectedItems),
            includeNoteText: this.includeNoteText,
            cancelled: false
        });
    }

    private cancel(): void {
        this.close();
        this.onSubmit({
            selectedItems: [],
            includeNoteText: false,
            cancelled: true
        });
    }

    onClose(): void {
        this.contentEl.empty();
    }
}
