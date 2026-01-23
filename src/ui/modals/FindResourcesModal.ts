/**
 * Find Resources Modal
 * Modal for entering a query to search for related resources
 */

import { App, Modal, Notice, Setting, TextAreaComponent } from 'obsidian';
import { Translations } from '../../i18n/types';

export class FindResourcesModal extends Modal {
    private t: Translations;
    private onSubmit: (query: string) => void | Promise<void>;
    private query: string = '';
    private textAreaComponent: TextAreaComponent | null = null;

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
        contentEl.addClass('find-resources-modal');

        // Title
        contentEl.createEl('h2', {
            text: this.t.modals.findResources?.title || 'Find Resources'
        });

        // Description
        contentEl.createEl('p', {
            text: this.t.modals.findResources?.description || 'Describe what kind of resources you\'re looking for.',
            cls: 'find-resources-description'
        });

        // Examples
        const examplesEl = contentEl.createEl('div', { cls: 'find-resources-examples' });
        examplesEl.createEl('p', {
            text: this.t.modals.findResources?.examplesTitle || 'Examples:',
            cls: 'find-resources-examples-title'
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
            li.addEventListener('click', () => {
                this.query = example;
                this.textAreaComponent?.setValue(example);
            });
        });

        // Text area for query
        const textAreaContainer = contentEl.createEl('div', { cls: 'find-resources-input' });
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
                text.inputEl.addClass('find-resources-textarea');

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
        const buttonContainer = contentEl.createEl('div', { cls: 'find-resources-buttons' });

        const cancelButton = buttonContainer.createEl('button', {
            text: this.t.modals.cancelButton || 'Cancel'
        });
        cancelButton.addEventListener('click', () => this.close());

        const submitButton = buttonContainer.createEl('button', {
            text: this.t.modals.findResources?.submitButton || 'Search',
            cls: 'mod-cta'
        });
        submitButton.addEventListener('click', () => this.submit());
    }

    private async submit() {
        if (this.query.trim()) {
            this.close();
            try {
                await this.onSubmit(this.query.trim());
            } catch (error) {
                console.error('[AI Organiser] Find resources error:', error);
                new Notice(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
            }
        }
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}
