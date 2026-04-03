/**
 * Content Size Modal
 * Modal for choosing how to handle large content
 */

import { App, Modal, Setting } from 'obsidian';
import type { Translations } from '../../i18n/types';

export type ContentSizeChoice = 'truncate' | 'chunk' | 'cancel';

export class ContentSizeModal extends Modal {
    private contentLength: number;
    private maxLength: number;
    private onChoice: (choice: ContentSizeChoice) => void;
    private t: Translations;

    constructor(
        app: App,
        translations: Translations,
        contentLength: number,
        maxLength: number,
        onChoice: (choice: ContentSizeChoice) => void
    ) {
        super(app);
        this.t = translations;
        this.contentLength = contentLength;
        this.maxLength = maxLength;
        this.onChoice = onChoice;
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.addClass('ai-organiser-modal-content');
        contentEl.addClass('ai-organiser-content-size-modal');

        contentEl.createEl('h2', { text: this.t.modals.contentSize.title });

        const percentage = Math.round((this.contentLength / this.maxLength) * 100);
        const description = this.t.modals.contentSize.description
            .replace('{length}', this.contentLength.toLocaleString())
            .replace('{percentage}', String(percentage))
            .replace('{max}', this.maxLength.toLocaleString());

        contentEl.createEl('p', {
            text: description,
            cls: 'ai-organiser-content-size-description'
        });

        // Truncate option
        const truncateSection = contentEl.createEl('div', { cls: 'ai-organiser-content-size-option' });
        truncateSection.createEl('h4', { text: this.t.modals.contentSize.truncateOption });
        truncateSection.createEl('p', {
            text: this.t.modals.contentSize.truncateDesc,
            cls: 'setting-item-description'
        });
        const truncateBtn = truncateSection.createEl('button', {
            text: this.t.modals.contentSize.truncateButton,
            cls: 'mod-warning'
        });
        truncateBtn.onclick = () => {
            this.close();
            this.onChoice('truncate');
        };

        // Chunk option
        const chunkSection = contentEl.createEl('div', { cls: 'ai-organiser-content-size-option' });
        chunkSection.createEl('h4', { text: this.t.modals.contentSize.chunkOption });
        chunkSection.createEl('p', {
            text: this.t.modals.contentSize.chunkDesc,
            cls: 'setting-item-description'
        });
        const chunkBtn = chunkSection.createEl('button', {
            text: this.t.modals.contentSize.chunkButton,
            cls: 'mod-cta'
        });
        chunkBtn.onclick = () => {
            this.close();
            this.onChoice('chunk');
        };

        // Cancel button
        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText(this.t.modals.contentSize.cancelButton)
                .onClick(() => {
                    this.close();
                    this.onChoice('cancel');
                })
            );
    }

    onClose(): void {
        this.contentEl.empty();
    }
}
