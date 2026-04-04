/**
 * Find Resources Modal
 * Modal for entering a query to search for related resources
 */

import { App, Modal, Notice, Setting, TextAreaComponent } from 'obsidian';
import { logger } from '../../utils/logger';
import { Translations } from '../../i18n/types';
import { enableAutoExpand } from '../../utils/uiUtils';
import { listen } from '../utils/domUtils';

export class FindResourcesModal extends Modal {
    private t: Translations;
    private onSubmit: (query: string) => void | Promise<void>;
    private query: string = '';
    private textAreaComponent: TextAreaComponent | null = null;
    private cleanups: (() => void)[] = [];

    constructor(
        app: App,
        t: Translations,
        onSubmit: (query: string) => void | Promise<void>
    ) {
        super(app);
        this.t = t;
        this.onSubmit = onSubmit;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('ai-organiser-find-resources-modal');

        // Title
        contentEl.createEl('h2', {
            text: this.t.modals.findResources?.title || 'Find Resources'
        });

        // Description
        contentEl.createEl('p', {
            text: this.t.modals.findResources?.description || 'Describe what kind of resources you\'re looking for.',
            cls: 'ai-organiser-find-resources-description'
        });

        // Examples
        const examplesEl = contentEl.createEl('div', { cls: 'ai-organiser-find-resources-examples' });
        examplesEl.createEl('p', {
            text: this.t.modals.findResources?.examplesTitle || 'Examples:',
            cls: 'ai-organiser-find-resources-examples-title'
        });
        const examplesList = examplesEl.createEl('ul');
        const examples = [
            this.t.modals.findResources?.example1 || 'YouTube tutorials on this topic',
            this.t.modals.findResources?.example2 || 'Articles explaining the basics',
            this.t.modals.findResources?.example3 || 'Visual diagrams or infographics',
            this.t.modals.findResources?.example4 || 'Beginner-friendly explanations'
        ];

        // Create example list items with click handlers
        examples.forEach(example => {
            const li = examplesList.createEl('li');
            li.setText(example);
            this.cleanups.push(listen(li, 'click', () => {
                this.query = example;
                this.textAreaComponent?.setValue(example);
            }));
        });

        // Text area for query
        const textAreaContainer = contentEl.createEl('div', { cls: 'ai-organiser-find-resources-input' });
        new Setting(textAreaContainer)
            .setName(this.t.modals.findResources?.queryLabel || 'What are you looking for?')
            .setDesc(this.t.modals.findResources?.queryDesc || 'Describe the type of resources you need')
            .addTextArea(text => {
                this.textAreaComponent = text;
                text
                    .setPlaceholder(this.t.modals.findResources?.queryPlaceholder || 'e.g., YouTube videos explaining neural networks')
                    .setValue(this.query)
                    .onChange(value => {
                        this.query = value;
                    });
                text.inputEl.rows = 3;
                text.inputEl.spellcheck = true;
                text.inputEl.addClass('ai-organiser-find-resources-textarea');
                enableAutoExpand(text.inputEl);

                // Focus the textarea
                setTimeout(() => text.inputEl.focus(), 50);

                // Submit on Ctrl/Cmd + Enter
                this.cleanups.push(listen(text.inputEl, 'keydown', (e) => {
                    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                        e.preventDefault();
                        void this.submit();
                    }
                }));
            });

        // Buttons
        const buttonContainer = contentEl.createEl('div', { cls: 'ai-organiser-find-resources-buttons' });

        const cancelButton = buttonContainer.createEl('button', {
            text: this.t.modals.cancelButton || 'Cancel'
        });
        this.cleanups.push(listen(cancelButton, 'click', () => this.close()));

        const submitButton = buttonContainer.createEl('button', {
            text: this.t.modals.findResources?.submitButton || 'Search',
            cls: 'mod-cta'
        });
        this.cleanups.push(listen(submitButton, 'click', () => { void this.submit(); }));
    }

    private async submit() {
        // Fallback: read directly from textarea in case onChange didn't fire
        const query = (this.textAreaComponent?.getValue() || this.query).trim();
        if (!query) {
            const el = this.textAreaComponent?.inputEl;
            if (el) {
                el.addClass('ai-organiser-shake');
                setTimeout(() => el.removeClass('ai-organiser-shake'), 400);
            }
            return;
        }
        this.close();
        try {
            await this.onSubmit(query);
        } catch (error) {
            logger.error('UI', 'Find resources error:', error);
            new Notice(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    onClose() {
        for (const cleanup of this.cleanups) cleanup();
        this.cleanups = [];
        const { contentEl } = this;
        contentEl.empty();
    }
}
