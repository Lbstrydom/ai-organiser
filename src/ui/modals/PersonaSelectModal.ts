/**
 * Persona Selection Modal
 * Allows users to select an AI persona before running AI commands
 */

import { App, Modal, Setting, setIcon } from 'obsidian';
import { Persona } from '../../services/configurationService';
import { Translations } from '../../i18n/types';

export class PersonaSelectModal extends Modal {
    private readonly t: Translations;
    private personas: Persona[];
    private currentPersonaId: string;
    private onSelect: (persona: Persona) => void;

    constructor(
        app: App,
        t: Translations,
        personas: Persona[],
        currentPersonaId: string,
        onSelect: (persona: Persona) => void
    ) {
        super(app);
        this.t = t;
        this.personas = personas;
        this.currentPersonaId = currentPersonaId;
        this.onSelect = onSelect;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('ai-organiser-persona-select-modal');

        contentEl.createEl('h2', { text: this.t.modals.personaSelect.title });
        contentEl.createEl('p', {
            text: this.t.modals.personaSelect.description,
            cls: 'setting-item-description'
        });

        const listEl = contentEl.createDiv({ cls: 'ai-organiser-persona-list' });

        for (const persona of this.personas) {
            const isSelected = persona.id === this.currentPersonaId;
            const itemEl = listEl.createDiv({
                cls: `ai-organiser-persona-item ${isSelected ? 'is-selected' : ''}`
            });

            const headerEl = itemEl.createDiv({ cls: 'ai-organiser-persona-header' });
            headerEl.createSpan({ text: persona.name, cls: 'ai-organiser-persona-name' });

            if (persona.isDefault) {
                headerEl.createSpan({ text: 'default', cls: 'ai-organiser-persona-badge' });
            }

            if (isSelected) {
                headerEl.createSpan({ text: 'current', cls: 'ai-organiser-persona-badge ai-organiser-persona-badge-current' });
            }

            itemEl.createDiv({
                text: persona.description,
                cls: 'ai-organiser-persona-description'
            });

            itemEl.addEventListener('click', () => {
                this.onSelect(persona);
                this.close();
            });
        }

        // Cancel button
        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText('Cancel')
                .onClick(() => this.close()));
    }

    onClose() {
        this.contentEl.empty();
    }
}

/**
 * Quick persona indicator button component
 * Shows current persona and opens selection modal on click
 */
export function createPersonaButton(
    containerEl: HTMLElement,
    currentPersona: Persona,
    onClick: () => void
): HTMLElement {
    const btn = containerEl.createEl('button', {
        cls: 'ai-organiser-persona-button clickable-icon',
        attr: { 'aria-label': `Persona: ${currentPersona.name}` }
    });

    // User icon
    const iconEl = btn.createSpan();
    setIcon(iconEl, 'user');

    const label = btn.createSpan({ text: currentPersona.name, cls: 'ai-organiser-persona-button-label' });

    btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick();
    });

    return btn;
}
