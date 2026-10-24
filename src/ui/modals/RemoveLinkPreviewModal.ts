/**
 * Preview before "Remove the link and delete": every note that will be edited and every line that
 * changes, before and after. Applying approves exactly this plan; the write refuses if a note changed
 * after it was made (services/attachmentUnlinkService), and the file is trashed only after a separate,
 * later confirmation.
 */
import { App, Modal } from 'obsidian';
import type { Translations } from '../../i18n/types';
import type { NotePlan } from '../../services/attachmentUnlinkService';
import { plural } from '../../utils/plural';
import { listen } from '../utils/domUtils';

export class RemoveLinkPreviewModal extends Modal {
    private cleanups: Array<() => void> = [];
    private decided = false;

    constructor(
        app: App,
        private readonly t: Translations,
        private readonly fileName: string,
        private readonly plans: readonly NotePlan[],
        private readonly onApply: () => void,
    ) {
        super(app);
    }

    onOpen(): void {
        const es = this.t.embedScan;
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('ai-organiser-embed-scan-confirm-modal');
        contentEl.createEl('h3', { text: es.unlinkPreviewTitle });
        contentEl.createEl('p', { text: `${this.fileName}. ${es.unlinkPreviewIntro}` });

        const list = contentEl.createDiv({ cls: 'ai-organiser-embed-scan-unlink-list' });
        for (const plan of this.plans) {
            const note = list.createDiv({ cls: 'ai-organiser-embed-scan-unlink-note' });
            note.createDiv({ cls: 'ai-organiser-embed-scan-filename', text: plan.notePath });
            for (const change of plan.changes) {
                const row = note.createDiv({ cls: 'ai-organiser-embed-scan-unlink-change' });
                row.createSpan({ cls: 'ai-organiser-embed-scan-badge', text: `L${change.line}` });
                const before = row.createDiv({ cls: 'ai-organiser-embed-scan-unlink-before' });
                before.createSpan({ cls: 'ai-organiser-embed-scan-unlink-label', text: es.unlinkBefore });
                before.createEl('code', { text: change.before });
                const after = row.createDiv({ cls: 'ai-organiser-embed-scan-unlink-after' });
                after.createSpan({ cls: 'ai-organiser-embed-scan-unlink-label', text: es.unlinkAfter });
                if (change.after === null) after.createSpan({ cls: 'setting-item-description', text: es.unlinkLineRemoved });
                else after.createEl('code', { text: change.after });
            }
        }
        contentEl.createEl('p', {
            cls: 'setting-item-description',
            text: plural(es.unlinkNotesCount, this.plans.length),
        });

        const buttons = contentEl.createDiv({ cls: 'ai-organiser-embed-scan-buttons' });
        const cancel = buttons.createEl('button', { text: es.cancelButton, attr: { type: 'button' } });
        const apply = buttons.createEl('button', { text: es.unlinkApply, cls: 'mod-warning', attr: { type: 'button' } });
        this.cleanups.push(listen(cancel, 'click', () => this.close()));
        this.cleanups.push(listen(apply, 'click', () => {
            if (this.decided) return;
            this.decided = true;
            this.close();
            this.onApply();
        }));
    }

    onClose(): void {
        for (const dispose of this.cleanups) dispose();
        this.cleanups = [];
        this.contentEl.empty();
    }
}
