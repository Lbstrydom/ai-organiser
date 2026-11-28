import { Modal, Notice, Setting, type ButtonComponent } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import { describeError, formatGuidance } from '../../core/friendlyErrors';
import { cleanNewName, listModelNames, replaceModelNameAndSave, touchesSearchModel } from '../../services/modelNames/modelNameSettings';

/** Choose a model or deployment name, type its replacement, see every setting that changes, confirm. */
export class ReplaceModelNameModal extends Modal {
    private from = '';
    private to = '';
    private previewEl: HTMLElement | null = null;
    private confirmButton: ButtonComponent | null = null;
    private saving = false;

    constructor(private readonly plugin: AIOrganiserPlugin, private readonly onDone?: () => void) {
        super(plugin.app);
    }

    onOpen(): void {
        const t = this.plugin.t.modals.modelReplace;
        const names = listModelNames(this.plugin.settings);
        this.titleEl.setText(t.title);
        this.contentEl.createEl('p', { text: t.intro });
        if (names.length === 0) {
            this.contentEl.createEl('p', { text: t.noNames });
            return;
        }
        this.from = names[0].name;

        new Setting(this.contentEl)
            .setName(t.currentName)
            .addDropdown(dropdown => {
                for (const { name, paths } of names) dropdown.addOption(name, `${name} (${paths.length})`);
                dropdown.setValue(this.from).onChange(value => { this.from = value; this.refresh(); });
            });
        new Setting(this.contentEl)
            .setName(t.newName)
            .setDesc(t.newNameDesc)
            .addText(text => text.onChange(value => { this.to = value; this.refresh(); }));

        this.previewEl = this.contentEl.createDiv();
        new Setting(this.contentEl)
            .addButton(button => button.setButtonText(t.cancel).onClick(() => this.close()))
            .addButton(button => {
                this.confirmButton = button.setButtonText(t.confirm).setCta().onClick(() => void this.apply());
            });
        this.refresh();
    }

    onClose(): void {
        this.contentEl.empty();
    }

    private refresh(): void {
        const t = this.plugin.t.modals.modelReplace;
        const paths = listModelNames(this.plugin.settings).find(n => n.name === this.from)?.paths ?? [];
        const preview = this.previewEl;
        if (!preview) return;
        preview.empty();
        preview.createEl('p', { text: t.willChange });
        const list = preview.createEl('ul');
        for (const path of paths) list.createEl('li', { text: path });
        if (touchesSearchModel(paths)) preview.createEl('p', { text: t.searchModelWarning });
        this.confirmButton?.setDisabled(this.saving || !cleanNewName(this.from, this.to));
    }

    private async apply(): Promise<void> {
        if (this.saving) return;
        this.saving = true;
        this.confirmButton?.setDisabled(true);
        const result = await replaceModelNameAndSave(this.plugin.settings, this.from, this.to, () => this.plugin.saveSettings());
        this.saving = false;
        if (!result.ok) {
            new Notice(formatGuidance(describeError(this.plugin.t, result.error)), 10000);
            this.refresh();
            return;
        }
        if (result.value.length > 0) new Notice(`${this.plugin.t.modals.modelReplace.done}: ${result.value.length}`);
        this.close();
        this.onDone?.();
    }
}
