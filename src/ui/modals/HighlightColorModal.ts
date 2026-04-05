/**
 * Highlight Color Modal
 * Allows users to select a highlight color for selected text
 */

import { App, Modal } from 'obsidian';
import type { Translations } from '../../i18n/types';

export interface HighlightColor {
    id: string;
    name: string;
    color: string;
    textColor?: string;
}

export const HIGHLIGHT_COLORS: HighlightColor[] = [
    { id: 'yellow', name: 'Yellow', color: '#fff3a3' },
    { id: 'green', name: 'Green', color: '#a8e6cf' },
    { id: 'blue', name: 'Blue', color: '#a8d8ea' },
    { id: 'pink', name: 'Pink', color: '#ffb7b2' },
    { id: 'orange', name: 'Orange', color: '#ffd3a5' },
    { id: 'purple', name: 'Purple', color: '#d4a5ff' },
];

export class HighlightColorModal extends Modal {
    private t: Translations;
    private onSelect: (color: HighlightColor) => void;

    constructor(
        app: App,
        t: Translations,
        onSelect: (color: HighlightColor) => void
    ) {
        super(app);
        this.t = t;
        this.onSelect = onSelect;
    }

    onOpen() {
        const { contentEl } = this;
        const t = this.t.modals.highlight;

        contentEl.empty();
        contentEl.addClass('ai-organiser-modal', 'highlight-color-modal');

        // Title
        contentEl.createEl('h2', { text: t?.title || 'Highlight Text' });

        // Description
        contentEl.createEl('p', {
            text: t?.description || 'Select a highlight color:',
            cls: 'setting-item-description'
        });

        // Color grid
        const colorGrid = contentEl.createDiv({ cls: 'ai-organiser-highlight-color-grid' });

        for (const color of HIGHLIGHT_COLORS) {
            const colorBtn = colorGrid.createDiv({ cls: 'ai-organiser-highlight-color-btn ai-organiser-color-swatch' });
            colorBtn.setCssProps({ '--swatch-color': color.color });
            colorBtn.setAttribute('aria-label', color.name);
            colorBtn.setAttribute('title', color.name);

            // Add color name label
            const label = colorBtn.createSpan({ cls: 'ai-organiser-highlight-color-label' });
            label.setText(this.getLocalizedColorName(color.id) || color.name);

            colorBtn.addEventListener('click', () => {
                this.onSelect(color);
                this.close();
            });

            // Keyboard support
            colorBtn.setAttribute('tabindex', '0');
            colorBtn.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    this.onSelect(color);
                    this.close();
                }
            });
        }

        // Clear highlight option
        const clearBtn = contentEl.createDiv({ cls: 'ai-organiser-highlight-clear-btn' });
        clearBtn.setText(t?.clearHighlight || 'Remove Highlight');
        clearBtn.addEventListener('click', () => {
            this.onSelect({ id: 'clear', name: 'Clear', color: '' });
            this.close();
        });
    }

    private getLocalizedColorName(colorId: string): string | undefined {
        const colors = this.t.modals.highlight?.colors;
        if (!colors) return undefined;
        return (colors as Record<string, string>)[colorId];
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}
