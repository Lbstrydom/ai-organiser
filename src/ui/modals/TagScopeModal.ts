import { App, Modal, Setting } from 'obsidian';
import type AIOrganiserPlugin from '../../main';

export type TagScope = 'note' | 'folder' | 'vault';

export class TagScopeModal extends Modal {
    private plugin: AIOrganiserPlugin;
    private selectedScope: TagScope = 'note';
    private onConfirm: (scope: TagScope) => void;

    constructor(
        app: App,
        plugin: AIOrganiserPlugin,
        onConfirm: (scope: TagScope) => void
    ) {
        super(app);
        this.plugin = plugin;
        this.onConfirm = onConfirm;
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('ai-organiser-modal-content');
        contentEl.addClass('ai-organiser-tag-scope-modal');

        contentEl.createEl('h2', { text: this.plugin.t.modals.tagScope.title });

        const options: { value: TagScope; label: string }[] = [
            { value: 'note', label: this.plugin.t.modals.tagScope.thisNote },
            { value: 'folder', label: this.plugin.t.modals.tagScope.currentFolder },
            { value: 'vault', label: this.plugin.t.modals.tagScope.entireVault }
        ];

        const radioGroup = contentEl.createDiv({ cls: 'ai-organiser-scope-options' });

        for (const option of options) {
            const optionEl = radioGroup.createDiv({ cls: 'ai-organiser-scope-option' });
            const input = optionEl.createEl('input', {
                type: 'radio',
                attr: { name: 'tag-scope', value: option.value }
            });
            if (option.value === 'note') {
                input.checked = true;
            }

            optionEl.createEl('label', { text: option.label });

            input.addEventListener('change', () => {
                this.selectedScope = option.value;
            });
        }

        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText(this.plugin.t.modals.cancel)
                .onClick(() => this.close()))
            .addButton(btn => btn
                .setButtonText(this.plugin.t.modals.tagScope.tagButton)
                .setCta()
                .onClick(() => {
                    this.close();
                    this.onConfirm(this.selectedScope);
                }));
    }

    onClose(): void {
        this.contentEl.empty();
    }
}
