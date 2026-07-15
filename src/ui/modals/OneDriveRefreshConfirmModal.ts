import { App, Modal, Setting } from 'obsidian';

export interface OneDriveRefreshConfirmOptions {
    title: string;
    body: string;
    /** One filename per line, shown as a plain list beneath the body text. */
    fileNames: string[];
    confirmText: string;
    cancelText: string;
    onConfirm: () => void;
    onCancel: () => void;
}

/**
 * Confirms overwriting the vault-cached copy of one or more OneDrive-linked
 * documents whose source file has changed since it was last embedded
 * (onedrive-link-insert extension, brainstormed 2026-07-15). Mirrors
 * `FeatureDisableConfirmModal`'s shape — this codebase's established
 * pattern is one small purpose-built confirm modal per use case rather than
 * a shared generic one. Default close (Esc / X / cancel) is cancel.
 */
export class OneDriveRefreshConfirmModal extends Modal {
    private readonly opts: OneDriveRefreshConfirmOptions;
    private decided = false;

    constructor(app: App, opts: OneDriveRefreshConfirmOptions) {
        super(app);
        this.opts = opts;
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h3', { text: this.opts.title });
        contentEl.createEl('p', { text: this.opts.body });
        const list = contentEl.createEl('ul');
        for (const name of this.opts.fileNames) {
            list.createEl('li', { text: name });
        }
        new Setting(contentEl)
            .addButton((b) => b
                .setButtonText(this.opts.cancelText)
                .onClick(() => this.close()))
            .addButton((b) => b
                .setButtonText(this.opts.confirmText)
                .setCta()
                .onClick(() => { this.decided = true; this.opts.onConfirm(); this.close(); }));
    }

    onClose(): void {
        if (!this.decided) this.opts.onCancel();
        this.contentEl.empty();
    }
}
