import { App, Modal, Setting, ButtonComponent } from 'obsidian';
import { listen } from '../utils/domUtils';

/**
 * Paste-in target for `azureConfigTransfer`'s exported JSON blob. Free text,
 * not a file picker — the export path puts the blob straight on the
 * clipboard, so the natural move is paste-and-go.
 */
export class AzureConfigImportModal extends Modal {
    private cleanups: (() => void)[] = [];
    private value = '';

    constructor(app: App, private onSubmit: (raw: string) => void | Promise<void>) {
        super(app);
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.createEl('h2', { text: 'Import Azure config' });
        contentEl.createEl('p', {
            text: 'Paste the JSON a teammate copied from "Export config" above. Your API key is never included — enter it separately.',
            cls: 'setting-item-description',
        });

        const textarea = contentEl.createEl('textarea', {
            attr: { rows: '14', placeholder: '{ "schemaVersion": 1, ... }' },
        });
        textarea.classList.add('ai-organiser-azure-import-textarea');
        this.cleanups.push(listen(textarea, 'input', () => { this.value = textarea.value; }));

        new Setting(contentEl).addButton((btn: ButtonComponent) => btn
            .setButtonText('Apply')
            .setCta()
            .onClick(async () => {
                await this.onSubmit(this.value.trim());
                this.close();
            }));
    }

    onClose(): void {
        for (const cleanup of this.cleanups) cleanup();
        this.cleanups = [];
        this.contentEl.empty();
    }
}
