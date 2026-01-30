/**
 * Improve Note Modal
 * Modal for entering a query to improve/enhance the current note
 */

import { App, Modal, Notice, Setting, TextAreaComponent } from 'obsidian';
import { Translations } from '../../i18n/types';
import { Persona } from '../../services/configurationService';
import { PersonaSelectModal, createPersonaButton } from './PersonaSelectModal';

export interface ImproveNoteResult {
    query: string;
    personaId?: string;
}

export class ImproveNoteModal extends Modal {
    private t: Translations;
    private onSubmit: (result: ImproveNoteResult) => void | Promise<void>;
    private query: string = '';
    private textAreaComponent: TextAreaComponent | null = null;
    private personas: Persona[];
    private selectedPersona: Persona;
    private personaButtonEl: HTMLElement | null = null;

    constructor(
        app: App,
        t: Translations,
        personas: Persona[],
        defaultPersona: Persona,
        onSubmit: (result: ImproveNoteResult) => void | Promise<void>
    ) {
        super(app);
        this.t = t;
        this.personas = personas;
        this.selectedPersona = defaultPersona;
        this.onSubmit = onSubmit;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('improve-note-modal');

        // Title
        contentEl.createEl('h2', {
            text: this.t.modals.improveNote?.title || 'Improve Note'
        });

        // Description
        contentEl.createEl('p', {
            text: this.t.modals.improveNote?.description || 'Ask a question or request an improvement to your note.',
            cls: 'improve-note-description'
        });

        // Persona selector row
        if (this.personas.length > 1) {
            const personaRow = contentEl.createEl('div', { cls: 'persona-selector-row' });
            personaRow.createEl('span', {
                text: 'Writing style:',
                cls: 'persona-selector-label'
            });

            this.personaButtonEl = createPersonaButton(
                personaRow,
                this.selectedPersona,
                () => this.openPersonaSelector()
            );
        }

        // Examples
        const examplesEl = contentEl.createEl('div', { cls: 'improve-note-examples' });
        examplesEl.createEl('p', {
            text: this.t.modals.improveNote?.examplesTitle || 'Examples:',
            cls: 'improve-note-examples-title'
        });
        const examplesList = examplesEl.createEl('ul');
        const examples = [
            this.t.modals.improveNote?.example1 || 'Give me an analogy to understand this concept',
            this.t.modals.improveNote?.example2 || 'Explain the second section in more detail',
            this.t.modals.improveNote?.example3 || 'Add practical examples',
            this.t.modals.improveNote?.example4 || 'Summarize the key points'
        ];

        // Create example list items with click handlers
        examples.forEach(example => {
            const li = examplesList.createEl('li');
            li.setText(example);
            li.addEventListener('click', () => {
                this.query = example;
                this.textAreaComponent?.setValue(example);
            });
        });

        // Text area for query
        const textAreaContainer = contentEl.createEl('div', { cls: 'improve-note-input' });
        new Setting(textAreaContainer)
            .setName(this.t.modals.improveNote?.queryLabel || 'Your request')
            .setDesc(this.t.modals.improveNote?.queryDesc || 'What would you like to improve or add to this note?')
            .addTextArea(text => {
                this.textAreaComponent = text;
                text
                    .setPlaceholder(this.t.modals.improveNote?.queryPlaceholder || 'Type your request here...')
                    .setValue(this.query)
                    .onChange(value => {
                        this.query = value;
                    });
                text.inputEl.rows = 4;
                text.inputEl.addClass('improve-note-textarea');

                // Focus the textarea
                setTimeout(() => text.inputEl.focus(), 50);

                // Submit on Ctrl/Cmd + Enter
                text.inputEl.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                        e.preventDefault();
                        this.submit();
                    }
                });
            });

        // Buttons
        const buttonContainer = contentEl.createEl('div', { cls: 'improve-note-buttons' });

        const cancelButton = buttonContainer.createEl('button', {
            text: this.t.modals.cancelButton || 'Cancel'
        });
        cancelButton.addEventListener('click', () => this.close());

        const submitButton = buttonContainer.createEl('button', {
            text: this.t.modals.improveNote?.submitButton || 'Improve',
            cls: 'mod-cta'
        });
        submitButton.addEventListener('click', () => this.submit());
    }

    private async submit() {
        // Fallback: read directly from textarea in case onChange didn't fire
        const query = (this.textAreaComponent?.getValue() || this.query).trim();
        this.close();
        try {
            await this.onSubmit({
                query: query || 'Improve and enhance this note',
                personaId: this.selectedPersona.id
            });
        } catch (error) {
            console.error('[AI Organiser] Improve note error:', error);
            new Notice(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    private openPersonaSelector() {
        const modal = new PersonaSelectModal(
            this.app,
            this.personas,
            this.selectedPersona.id,
            (persona) => {
                this.selectedPersona = persona;
                this.updatePersonaButton();
            }
        );
        modal.open();
    }

    private updatePersonaButton() {
        if (this.personaButtonEl) {
            const label = this.personaButtonEl.querySelector('.persona-button-label');
            if (label) {
                label.textContent = this.selectedPersona.name;
            }
            this.personaButtonEl.setAttribute('aria-label', `Persona: ${this.selectedPersona.name}`);
        }
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}
