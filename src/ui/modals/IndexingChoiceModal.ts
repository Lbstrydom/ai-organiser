import { App, Modal } from 'obsidian';
import type { Translations } from '../../i18n/types';

export type IndexingChoice = 'project' | 'temporary' | 'truncate' | 'settings';

export class IndexingChoiceModal extends Modal {
    private resolveChoice: ((choice: IndexingChoice) => void) | null = null;
    private resolved = false;

    constructor(
        app: App,
        private readonly fileName: string,
        private readonly charCount: number,
        private readonly budgetChars: number,
        private readonly embeddingsAvailable: boolean,
        private readonly isProjectActive: boolean,
        private readonly t: Translations['modals']['unifiedChat'],
    ) { super(app); }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.addClass('ai-organiser-indexing-choice-modal');

        contentEl.createEl('h3', { text: `📄 ${this.fileName}` });
        contentEl.createEl('p', {
            cls: 'ai-organiser-indexing-choice-stats',
            text: this.t.indexingStats
                .replace('{charCount}', this.charCount.toLocaleString())
                .replace('{budget}', this.budgetChars.toLocaleString()),
        });

        if (this.embeddingsAvailable) {
            contentEl.createEl('p', { text: this.t.indexingDescription });

            const projectBtn = contentEl.createEl('button', {
                cls: 'ai-organiser-indexing-choice-btn mod-cta',
                text: this.isProjectActive
                    ? this.t.indexingIntoProject
                    : this.t.indexingCreateProject,
            });
            projectBtn.addEventListener('click', () => this.resolve('project'));

            const tempBtn = contentEl.createEl('button', {
                cls: 'ai-organiser-indexing-choice-btn',
                text: this.t.indexingTemporary,
            });
            tempBtn.addEventListener('click', () => this.resolve('temporary'));
        } else {
            contentEl.createEl('p', { text: this.t.indexingNoEmbeddings });
            const settingsBtn = contentEl.createEl('button', {
                cls: 'ai-organiser-indexing-choice-btn',
                text: this.t.indexingOpenSettings,
            });
            settingsBtn.addEventListener('click', () => this.resolve('settings'));
        }

        const truncBtn = contentEl.createEl('button', {
            cls: 'ai-organiser-indexing-choice-btn',
            text: this.t.indexingTruncate,
        });
        truncBtn.addEventListener('click', () => this.resolve('truncate'));
    }

    waitForChoice(): Promise<IndexingChoice> {
        return new Promise(resolve => { this.resolveChoice = resolve; });
    }

    private resolve(choice: IndexingChoice): void {
        if (this.resolved) return;
        this.resolved = true;
        this.resolveChoice?.(choice);
        this.close();
    }

    onClose(): void {
        if (!this.resolved) {
            this.resolved = true;
            this.resolveChoice?.('truncate');
        }
        this.contentEl.empty();
    }
}
