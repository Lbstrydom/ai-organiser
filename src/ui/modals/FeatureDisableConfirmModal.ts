import { App, Modal, Setting } from 'obsidian';

export interface FeatureDisableConfirmOptions {
    title: string;
    body: string;
    confirmText: string;
    cancelText: string;
    onConfirm: () => void;
    onCancel: () => void;
}

/**
 * Cascade-disable confirm for the Features settings section (FT-8): when disabling a
 * feature with enabled dependents, confirm before turning them off too. Default close
 * (Esc / X / cancel button) is treated as cancel — the caller reverts the toggle.
 */
export class FeatureDisableConfirmModal extends Modal {
    private readonly opts: FeatureDisableConfirmOptions;
    private decided = false;

    constructor(app: App, opts: FeatureDisableConfirmOptions) {
        super(app);
        this.opts = opts;
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h3', { text: this.opts.title });
        contentEl.createEl('p', { text: this.opts.body });
        new Setting(contentEl)
            .addButton((b) => b
                .setButtonText(this.opts.cancelText)
                .onClick(() => this.close()))
            .addButton((b) => b
                .setButtonText(this.opts.confirmText)
                .setWarning()
                .onClick(() => { this.decided = true; this.opts.onConfirm(); this.close(); }));
    }

    onClose(): void {
        // Esc / X / cancel button → revert. The confirm button sets `decided` first.
        if (!this.decided) this.opts.onCancel();
        this.contentEl.empty();
    }
}
