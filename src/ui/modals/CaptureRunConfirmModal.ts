/**
 * The estimate and the privacy statement, shown before a manual run. Counts, megabytes of audio, images,
 * a cost range, and the plain warning that audio and images leave the machine before their content can be
 * checked against the keep-out words. Esc or Cancel runs nothing.
 */
import { App, ButtonComponent, Modal } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import { plural } from '../../utils/plural';
import { listen } from '../utils/domUtils';

export interface RunConfirmInfo {
    captures: number;
    audioMB: number;
    images: number;
    /** Older notes ignored because they predate the setup */
    older: number;
    cost: string;
}

export interface RunConfirmResult {
    confirmed: boolean;
    includeExisting: boolean;
}

export class CaptureRunConfirmModal extends Modal {
    private cleanups: (() => void)[] = [];
    private answered = false;
    private includeExisting = false;

    constructor(app: App, private readonly plugin: AIOrganiserPlugin, private readonly info: RunConfirmInfo, private readonly onResult: (r: RunConfirmResult) => void) {
        super(app);
    }

    onOpen(): void {
        const t = this.plugin.t.captureInbox;
        const { contentEl, info } = this;
        this.containerEl.addClass('ai-organiser-modal-container');
        contentEl.addClass('ai-organiser-capture-confirm');
        contentEl.createEl('h3', { text: t.confirmTitle, cls: 'ai-organiser-modal-title' });
        const body = plural(t.confirmBody, info.captures, 'captures')
            .replace('{audioMB}', info.audioMB.toFixed(1))
            .replace('{images}', String(info.images))
            .replace('{cost}', info.cost);
        contentEl.createEl('p', { text: body });
        contentEl.createEl('p', { text: t.confirmPrivacy, cls: 'ai-organiser-capture-warning' });

        if (info.older > 0) {
            contentEl.createEl('p', { text: plural(t.confirmOlder, info.older, 'count').replace('{count}', String(info.older)) });
            const row = contentEl.createDiv({ cls: 'ai-organiser-capture-checkrow' });
            const box = row.createEl('input', { type: 'checkbox', attr: { id: 'ai-organiser-capture-existing' } });
            row.createEl('label', { text: t.confirmOlderToggle, attr: { for: 'ai-organiser-capture-existing' } });
            this.cleanups.push(listen(box, 'change', () => { this.includeExisting = box.checked; }));
        }

        const buttons = contentEl.createDiv('ai-organiser-modal-buttons');
        new ButtonComponent(buttons).setButtonText(this.plugin.t.modals.cancel).onClick(() => this.close());
        new ButtonComponent(buttons).setButtonText(this.plugin.t.modals.confirm).setCta().onClick(() => {
            this.answered = true;
            this.onResult({ confirmed: true, includeExisting: this.includeExisting });
            this.close();
        });
    }

    onClose(): void {
        for (const cleanup of this.cleanups) cleanup();
        this.cleanups = [];
        this.contentEl.empty();
        if (!this.answered) this.onResult({ confirmed: false, includeExisting: false });
    }
}
