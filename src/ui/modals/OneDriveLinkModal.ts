import { Modal, Setting, App, ButtonComponent } from 'obsidian';
import type { Translations } from '../../i18n/types';
import { logger } from '../../utils/logger';

/**
 * Outcome of the "pick a local file" action (docs/plans/onedrive-link-insert.md §4,
 * round-3 H1). A bare `Result<void>` couldn't distinguish "cancelled, stay open"
 * from "inserted, close" from "failed, stay open" — this discriminated type can.
 */
export type PickOutcome = 'inserted' | 'cancelled' | 'failed';

/** Outcome of the "paste a share link" action. `'invalid-link'` is the modal's
 *  own inline-error case, distinct from a system-failure `'failed'`. */
export type ShareOutcome = 'inserted' | 'invalid-link' | 'failed';

/**
 * Two independent entry actions (round-2 H1 — NOT a sequential "pick file, then
 * choose type" flow): Section A picks a local OneDrive file and inserts a
 * `file://` link; Section B lets the user type their own label and paste an
 * existing share link. Neither reads data the other produced.
 */
export class OneDriveLinkModal extends Modal {
    private submitting = false;
    private disposed = false;

    private labelText = '';
    private shareUrl = '';

    private pickButton: ButtonComponent | null = null;
    private insertButton: ButtonComponent | null = null;
    private labelInputEl: HTMLInputElement | null = null;
    private urlInputEl: HTMLInputElement | null = null;
    private errorEl: HTMLElement | null = null;

    constructor(
        app: App,
        private t: Translations,
        private onPickLocalFile: () => Promise<PickOutcome>,
        private onSubmitShareLink: (labelText: string, url: string) => Promise<ShareOutcome>,
    ) {
        super(app);
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.addClass('ai-organiser-modal-content');

        contentEl.createEl('h2', { text: this.t.oneDriveLink.title });

        // Section A — pick a local file.
        const sectionA = contentEl.createDiv({ cls: 'ai-organiser-onedrive-section' });
        new Setting(sectionA)
            .addButton((btn) => {
                this.pickButton = btn
                    .setButtonText(this.t.oneDriveLink.pickLocalFileButton)
                    .setCta()
                    .onClick(() => void this.handlePickLocalFile());
            });
        sectionA.createEl('p', {
            text: this.t.oneDriveLink.localLinkDeviceOnlyNotice,
            cls: 'setting-item-description',
        });

        // Section B — paste a link the user already has.
        const sectionB = contentEl.createDiv({ cls: 'ai-organiser-onedrive-section' });
        new Setting(sectionB)
            .setName(this.t.oneDriveLink.linkTextLabel)
            .addText((text) => {
                text.setPlaceholder(this.t.oneDriveLink.linkTextPlaceholder)
                    .onChange((value) => { this.labelText = value; });
                this.labelInputEl = text.inputEl;
            });
        new Setting(sectionB)
            .setName(this.t.oneDriveLink.shareUrlLabel)
            .addText((text) => {
                text.setPlaceholder(this.t.oneDriveLink.shareUrlPlaceholder)
                    .onChange((value) => { this.shareUrl = value; });
                this.urlInputEl = text.inputEl;
            });
        new Setting(sectionB)
            .addButton((btn) => {
                this.insertButton = btn
                    .setButtonText(this.t.oneDriveLink.insertShareLinkButton)
                    .setCta()
                    .onClick(() => void this.handleSubmitShareLink());
            });
        this.errorEl = sectionB.createEl('p', {
            cls: 'setting-item-description ai-organiser-onedrive-error ai-organiser-hidden',
        });
    }

    private setDisabled(disabled: boolean): void {
        this.pickButton?.setDisabled(disabled);
        this.insertButton?.setDisabled(disabled);
        this.labelInputEl?.toggleAttribute('disabled', disabled);
        this.urlInputEl?.toggleAttribute('disabled', disabled);
    }

    private async handlePickLocalFile(): Promise<void> {
        if (this.submitting) return;
        this.submitting = true;
        this.setDisabled(true);

        // audit round-1 M2: try/finally guarantees the modal is never left
        // permanently disabled — even if a future onPickLocalFile implementation
        // rejects instead of resolving (today's never does, but the modal
        // shouldn't rely on that to stay usable).
        let outcome: PickOutcome | 'failed' = 'failed';
        try {
            outcome = await this.onPickLocalFile();
        } catch (error) {
            logger.warn('OneDriveLink', `onPickLocalFile rejected unexpectedly: ${String(error)}`);
        } finally {
            if (!this.disposed) {
                this.submitting = false;
                this.setDisabled(false);
            }
        }

        if (this.disposed) return;
        if (outcome === 'inserted') {
            this.close();
        }
        // 'cancelled' and 'failed' both stay open, re-enabled, no in-modal
        // message — the underlying Notice (if any) already explains 'failed'.
    }

    private async handleSubmitShareLink(): Promise<void> {
        if (this.submitting) return;
        const label = this.labelText.trim();
        const url = this.shareUrl.trim();
        if (!label || !url) return;

        this.submitting = true;
        this.setDisabled(true);
        this.errorEl?.toggleClass('ai-organiser-hidden', true);

        // audit round-1 M2: same try/finally guarantee as handlePickLocalFile.
        let outcome: ShareOutcome | 'failed' = 'failed';
        try {
            outcome = await this.onSubmitShareLink(label, url);
        } catch (error) {
            logger.warn('OneDriveLink', `onSubmitShareLink rejected unexpectedly: ${String(error)}`);
        } finally {
            if (!this.disposed) {
                this.submitting = false;
                this.setDisabled(false);
            }
        }

        if (this.disposed) return;
        if (outcome === 'inserted') {
            this.close();
            return;
        }
        if (outcome === 'invalid-link') {
            this.errorEl?.setText(this.t.oneDriveLink.invalidLinkError);
            this.errorEl?.toggleClass('ai-organiser-hidden', false);
        }
        // 'failed' stays open, re-enabled, no in-modal message.
    }

    onClose(): void {
        this.disposed = true;
        this.contentEl.empty();
    }
}
