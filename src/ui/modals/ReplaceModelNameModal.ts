import { Modal, Notice, Setting, type ButtonComponent } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import { cleanNewName, listModelNames, replaceModelName, touchesSearchModel } from '../../services/modelNames/modelNameSettings';

/** Choose a model or deployment name, type its replacement, see every setting that changes, confirm. */
export class ReplaceModelNameModal extends Modal {
    private from = '';
    private to = '';
    private previewEl: HTMLElement | null = null;
    private confirmButton: ButtonComponent | null = null;

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
        this.confirmButton?.setDisabled(!cleanNewName(this.from, this.to));
    }

    private async apply(): Promise<void> {
        const t = this.plugin.t.modals.modelReplace;
        const changed = replaceModelName(this.plugin.settings, this.from, this.to);
        if (changed.length === 0) return;
        this.confirmButton?.setDisabled(true);
        await this.plugin.saveSettings();
        new Notice(`${t.done}: ${changed.length}`);
        this.close();
        this.onDone?.();
    }
}
