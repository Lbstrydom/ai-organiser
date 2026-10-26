import { App, Modal, Setting } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import type { PreparedWorkspacePack } from '../../services/aiWorkspaces/workspaceService';
import { plural } from '../../utils/plural';

/**
 * The preview that stands between the vault and anything shared: the exact notes, their size, and what was left out and why.
 * Nothing is written or copied until the person confirms here.
 */
export class SharePreviewModal extends Modal {
    constructor(
        app: App,
        private readonly plugin: AIOrganiserPlugin,
        private readonly prepared: PreparedWorkspacePack,
        private readonly mode: 'pack' | 'copy',
        private readonly onConfirm: () => void,
    ) {
        super(app);
    }

    onOpen(): void {
        const t = this.plugin.t.aiWorkspaces;
        const { pack } = this.prepared;
        this.containerEl.addClass('ai-organiser-modal-container');
        this.contentEl.createEl('h3', { text: t.previewTitle, cls: 'ai-organiser-modal-title' });
        this.contentEl.createEl('p', { text: t.previewIntro, cls: 'setting-item-description' });

        this.contentEl.createEl('h4', { text: t.previewNotes });
        const list = this.contentEl.createEl('ul');
        for (const source of pack.sources) list.createEl('li', { text: source.path });
        this.contentEl.createDiv({
            text: plural(t.previewTotal, pack.sources.length).replace('{kb}', String(Math.max(1, Math.round(pack.bytes / 1024)))),
            cls: 'setting-item-description',
        });

        if (pack.skipped.length > 0) {
            this.contentEl.createEl('h4', { text: t.previewSkipped });
            const skipped = this.contentEl.createEl('ul');
            for (const s of pack.skipped) skipped.createEl('li', { text: `${s.path} (${t.skipReasons[s.reason]})` });
        }
        this.contentEl.createDiv({ text: t.revokeNote, cls: 'setting-item-description' });

        new Setting(this.contentEl)
            .addButton((b) => b.setButtonText(t.cancel).onClick(() => this.close()))
            .addButton((b) => b.setCta().setButtonText(this.mode === 'pack' ? t.confirmPack : t.confirmCopy).onClick(() => {
                this.close();
                this.onConfirm();
            }));
    }

    onClose(): void {
        this.contentEl.empty();
    }
}
