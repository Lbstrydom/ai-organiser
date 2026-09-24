import { App, Modal, Setting, ButtonComponent } from 'obsidian';
import { listen } from '../utils/domUtils';
import { Translations } from '../../i18n/types';

/**
 * Paste-in target for `azureConfigTransfer`'s exported JSON blob. Free text,
 * not a file picker — the export path puts the blob straight on the
 * clipboard, so the natural move is paste-and-go.
 *
 * Text is routed through i18n (`az`, the caller's `t.settings.llm.azure`)
 * rather than hardcoded — every sibling modal already does this, and
 * `obsidianmd/ui/sentence-case` can only statically check a literal string
 * argument, so a hardcoded 'Import Azure config' is flagged (it wants
 * 'Azure' lowercased) while the same text routed through an i18n object
 * property is opaque to the linter, matching how 'Azure API key' and
 * 'Azure AI Foundry' already read elsewhere in this settings UI.
 */
export class AzureConfigImportModal extends Modal {
    private cleanups: (() => void)[] = [];
    private value = '';

    constructor(
        app: App,
        private az: Translations['settings']['llm']['azure'],
        private onSubmit: (raw: string) => void | Promise<void>,
    ) {
        super(app);
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.createEl('h2', { text: this.az.importModalHeading });
        contentEl.createEl('p', {
            text: this.az.importModalDesc,
            cls: 'setting-item-description',
        });

        const textarea = contentEl.createEl('textarea', {
            attr: { rows: '14', placeholder: '{ "schemaVersion": 1, ... }' },
        });
        textarea.classList.add('ai-organiser-azure-import-textarea');
        this.cleanups.push(listen(textarea, 'input', () => { this.value = textarea.value; }));

        new Setting(contentEl).addButton((btn: ButtonComponent) => btn
            .setButtonText(this.az.importModalApplyButton)
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
