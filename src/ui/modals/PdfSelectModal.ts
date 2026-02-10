/**
 * PDF Select Modal
 * Modal for selecting a PDF file to summarize with persona selection and optional context
 */

import { App, Modal, Setting, TFile, Platform } from 'obsidian';
import type { Translations } from '../../i18n/types';
import type { Persona } from '../../services/configurationService';

export interface PdfSelectResult {
    file?: TFile;
    externalPath?: string;  // For files outside the vault
    personaId: string;
    context?: string;  // Optional user context to guide summarization
    includeCompanion?: boolean;  // Study companion toggle state
}

export class PdfSelectModal extends Modal {
    private readonly files: TFile[];
    private onSelect: (result: PdfSelectResult) => void;
    private onExternalSelect?: (result: { externalPath: string; personaId: string; context?: string; includeCompanion?: boolean }) => void;
    private t: Translations;
    private personaId: string;
    private context: string = '';
    private includeCompanion = true;
    private readonly personas: Persona[];
    private readonly enableStudyCompanion: boolean;
    private companionToggleEl!: HTMLElement;

    constructor(
        app: App,
        translations: Translations,
        files: TFile[],
        defaultPersonaId: string,
        personas: Persona[],
        enableStudyCompanion: boolean,
        onSelect: (result: PdfSelectResult) => void,
        onExternalSelect?: (result: { externalPath: string; personaId: string; context?: string; includeCompanion?: boolean }) => void
    ) {
        super(app);
        this.t = translations;
        this.files = files;
        this.personaId = defaultPersonaId;
        this.onSelect = onSelect;
        this.onExternalSelect = onExternalSelect;
        this.personas = personas;
        this.enableStudyCompanion = enableStudyCompanion;
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
                dropdown.onChange(value => {
                    this.personaId = value;
                    this.companionToggleEl.style.display =
                        (this.enableStudyCompanion && value === 'study') ? '' : 'none';
                });
            });

        // Companion toggle (visible only when Study persona is selected)
        const companionSetting = new Setting(contentEl)
            .setName(this.t.settings.summarization.enableCompanion || 'Study Companion Notes')
            .setDesc(this.t.settings.summarization.enableCompanionDesc || 'Create a companion note that explains the material in conversational language')
            .addToggle(toggle => toggle
                .setValue(this.includeCompanion)
                .onChange(value => this.includeCompanion = value));
        this.companionToggleEl = companionSetting.settingEl;
        this.companionToggleEl.style.display =
            (this.enableStudyCompanion && this.personaId === 'study') ? '' : 'none';

        // Optional context field
        new Setting(contentEl)
            .setName(this.t.modals.pdfSelect.contextLabel || 'Additional Context')
            .setDesc(this.t.modals.pdfSelect.contextDesc || 'Optional: Guide the summary focus (e.g., "focus on chapter 3" or "extract the key findings")')
            .addTextArea(text => {
                text.setPlaceholder(this.t.modals.pdfSelect.contextPlaceholder || 'e.g., Focus on the methodology section...')
                    .onChange(value => this.context = value);
                text.inputEl.rows = 2;
                text.inputEl.addClass('summary-context-textarea');
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
                this.onSelect({
                    file,
                    personaId: this.personaId,
                    context: this.context.trim() || undefined,
                    includeCompanion: (this.enableStudyCompanion && this.personaId === 'study') ? this.includeCompanion : undefined
                });
            };
        });

        // Add browse button for external files (desktop only)
        if (!Platform.isMobile && this.onExternalSelect) {
            const browseSection = new Setting(contentEl)
                .setName(this.t.modals.pdfSelect.browseLabel || 'Browse External')
                .setDesc(this.t.modals.pdfSelect.browseDesc || 'Select a PDF from outside your vault (Google Drive, OneDrive, etc.)');

            browseSection.addButton(btn => btn
                .setButtonText(this.t.modals.pdfSelect.browseButton || 'Browse...')
                .onClick(() => this.browseForExternalPdf())
            );
        }

        // Add cancel button
        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText(this.t.modals.cancel)
                .onClick(() => this.close())
            );
    }

    /**
     * Open file picker for external PDF files
     */
    private browseForExternalPdf(): void {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.pdf,application/pdf';
        input.style.display = 'none';

        input.onchange = () => {
            const file = input.files?.[0];
            if (file && this.onExternalSelect) {
                // Get the file path - on Electron we can access the path property
                const filePath = (file as File & { path?: string }).path;
                if (filePath) {
                    this.close();
                    this.onExternalSelect({
                        externalPath: filePath,
                        personaId: this.personaId,
                        context: this.context.trim() || undefined,
                        includeCompanion: (this.enableStudyCompanion && this.personaId === 'study') ? this.includeCompanion : undefined
                    });
                }
            }
            input.remove();
        };

        document.body.appendChild(input);
        input.click();
    }

    onClose(): void {
        this.contentEl.empty();
    }
}
