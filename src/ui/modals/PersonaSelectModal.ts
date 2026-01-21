/**
 * Persona Selection Modal
 * Allows users to select an AI persona before running AI commands
 */

import { App, Modal, Setting } from 'obsidian';
import { Persona } from '../../services/configurationService';

export class PersonaSelectModal extends Modal {
    private personas: Persona[];
    private currentPersonaId: string;
    private onSelect: (persona: Persona) => void;

    constructor(
        app: App,
        personas: Persona[],
        currentPersonaId: string,
        onSelect: (persona: Persona) => void
    ) {
        super(app);
        this.personas = personas;
        this.currentPersonaId = currentPersonaId;
        this.onSelect = onSelect;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('persona-select-modal');

        contentEl.createEl('h2', { text: 'Select AI Persona' });
        contentEl.createEl('p', {
            text: 'Choose a writing style for this AI operation.',
            cls: 'setting-item-description'
        });

        const listEl = contentEl.createDiv({ cls: 'persona-list' });

        for (const persona of this.personas) {
            const isSelected = persona.id === this.currentPersonaId;
            const itemEl = listEl.createDiv({
                cls: `persona-item ${isSelected ? 'is-selected' : ''}`
            });

            const headerEl = itemEl.createDiv({ cls: 'persona-header' });
            headerEl.createSpan({ text: persona.name, cls: 'persona-name' });

            if (persona.isDefault) {
                headerEl.createSpan({ text: 'default', cls: 'persona-badge' });
            }

            if (isSelected) {
                headerEl.createSpan({ text: 'current', cls: 'persona-badge persona-badge-current' });
            }

            itemEl.createDiv({
                text: persona.description,
                cls: 'persona-description'
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
        cls: 'persona-button clickable-icon',
        attr: { 'aria-label': `Persona: ${currentPersona.name}` }
    });

    // User icon
    btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>`;

    const label = btn.createSpan({ text: currentPersona.name, cls: 'persona-button-label' });

    btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick();
    });

    return btn;
}
