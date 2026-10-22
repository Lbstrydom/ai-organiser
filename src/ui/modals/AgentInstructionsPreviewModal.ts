/**
 * Preview of the `AGENTS.md` block before anything is written: the block as it will be, and the
 * block as it is now when there is one. Apply is the approval; closing the window writes nothing.
 */
import { App, Modal } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import type { InstructionsPreview } from '../../services/agentIndex/agentInstructionsWriter';
import { listen } from '../utils/domUtils';

export class AgentInstructionsPreviewModal extends Modal {
    private cleanups: (() => void)[] = [];
    private settled = false;

    constructor(app: App, private readonly plugin: AIOrganiserPlugin, private readonly preview: InstructionsPreview, private readonly onDone: (apply: boolean) => void) {
        super(app);
        this.containerEl.addClass('ai-organiser-modal-container');
        this.contentEl.addClass('ai-organiser-modal-content');
    }

    onOpen(): void {
        const t = this.plugin.t.agentIndex;
        const p = this.preview;
        this.contentEl.createEl('h3', { text: t.previewTitle, cls: 'ai-organiser-modal-title' });
        this.contentEl.createEl('p', { text: (p.creates ? t.previewCreate : p.before ? t.previewUpdate : t.previewAppend).replace('{path}', p.path), cls: 'setting-item-description' });
        if (!p.changed) {
            this.contentEl.createEl('p', { text: t.previewNoChange });
        } else {
            if (p.before) {
                this.contentEl.createEl('h4', { text: t.previewBefore });
                this.contentEl.createEl('pre', { text: p.before, cls: 'ai-organiser-inventory-preview' });
            }
            this.contentEl.createEl('h4', { text: t.previewAfter });
            this.contentEl.createEl('pre', { text: p.after, cls: 'ai-organiser-inventory-preview' });
        }
        const buttons = this.contentEl.createDiv({ cls: 'ai-organiser-modal-buttons' });
        // Nothing to apply: offer only Close, not a button that does nothing.
        if (p.changed) {
            const apply = buttons.createEl('button', { text: t.previewApply, cls: 'mod-cta' });
            this.cleanups.push(listen(apply, 'click', () => { this.settled = true; this.onDone(true); this.close(); }));
        }
        const cancel = buttons.createEl('button', { text: p.changed ? this.plugin.t.modals.cancel : this.plugin.t.common.close });
        this.cleanups.push(listen(cancel, 'click', () => this.close()));
    }

    onClose(): void {
        for (const cleanup of this.cleanups) cleanup();
        this.cleanups = [];
        this.contentEl.empty();
        if (!this.settled) { this.settled = true; this.onDone(false); }
    }
}
