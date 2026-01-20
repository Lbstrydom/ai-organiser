/**
 * PDF Select Modal
 * Modal for selecting a PDF file to summarize with persona selection
 */

import { App, Modal, Setting, TFile } from 'obsidian';
import type { Translations } from '../../i18n/types';
import { BUILTIN_PERSONAS, SummaryPersona } from '../../services/prompts/summaryPersonas';

export interface PdfSelectResult {
    file: TFile;
    personaId: string;
}

export class PdfSelectModal extends Modal {
    private readonly files: TFile[];
    private onSelect: (result: PdfSelectResult) => void;
    private t: Translations;
    private personaId: string;
    private readonly personas: SummaryPersona[];

    constructor(
        app: App,
        translations: Translations,
        files: TFile[],
        defaultPersonaId: string,
        onSelect: (result: PdfSelectResult) => void
    ) {
        super(app);
        this.t = translations;
        this.files = files;
        this.personaId = defaultPersonaId;
        this.onSelect = onSelect;
        this.personas = BUILTIN_PERSONAS;
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.addClass('ai-organiser-modal-content');
        contentEl.addClass('pdf-select-modal');

        contentEl.createEl('h2', { text: this.t.modals.pdfSelect.title });
        contentEl.createEl('p', {
            text: this.t.modals.pdfSelect.description,
            cls: 'setting-item-description'
        });

        // Persona selection dropdown at the top
        new Setting(contentEl)
            .setName(this.t.modals.pdfSelect.personaLabel || 'Summary Style')
            .setDesc(this.t.modals.pdfSelect.personaDesc || 'Choose how to format the summary')
            .addDropdown(dropdown => {
                for (const persona of this.personas) {
                    dropdown.addOption(persona.id, persona.name);
                }
                dropdown.setValue(this.personaId);
                dropdown.onChange(value => this.personaId = value);
            });

        const listEl = contentEl.createEl('div', { cls: 'pdf-list' });

        // Show max 15 recent PDFs
        this.files.slice(0, 15).forEach(file => {
            const item = listEl.createEl('div', { cls: 'pdf-list-item' });

            const infoDiv = item.createEl('div', { cls: 'pdf-info' });
            infoDiv.createEl('span', { text: file.name, cls: 'pdf-name' });

            const modifiedDate = new Date(file.stat.mtime);
            infoDiv.createEl('span', {
                text: `${this.t.modals.pdfSelect.modifiedLabel}: ${modifiedDate.toLocaleDateString()} ${modifiedDate.toLocaleTimeString()}`,
                cls: 'pdf-modified'
            });

            const selectBtn = item.createEl('button', {
                text: this.t.modals.pdfSelect.selectButton,
                cls: 'mod-cta'
            });
            selectBtn.onclick = () => {
                this.close();
                this.onSelect({ file, personaId: this.personaId });
            };
        });

        // Add cancel button
        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText(this.t.modals.cancel)
                .onClick(() => this.close())
            );
    }

    onClose(): void {
        this.contentEl.empty();
    }
}
