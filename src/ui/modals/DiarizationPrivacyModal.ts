import { Modal, type App } from 'obsidian';
import { listen } from '../utils/domUtils';
import type { Translations } from '../../i18n/types';

/**
 * First-time-per-session disclosure modal for Deepgram diarization (plan §3).
 *
 * Behaviour matrix:
 *  - User clicks "Use Deepgram for this session" → resolves `true`
 *  - User clicks "Don't use Deepgram"            → resolves `false`
 *  - User presses ESC / clicks outside / closes  → resolves `false`
 *    (Treated as REJECT per plan §4 R2 H5 — `diarizationDisclosureShownThisSession`
 *     stays false; user can re-trigger by re-checking.)
 *
 * The modal NEVER mutates plugin state directly — host modal owns that. We
 * just return the user's decision via the constructor callback.
 */
export class DiarizationPrivacyModal extends Modal {
    private decided = false;
    private readonly cleanups: Array<() => void> = [];

    constructor(
        app: App,
        private readonly t: Translations,
        private readonly callback: (accepted: boolean) => void,
    ) {
        super(app);
    }

    /** Convenience helper — open + receive choice via callback. */
    static openOnce(app: App, t: Translations, callback: (accepted: boolean) => void): void {
        new DiarizationPrivacyModal(app, t, callback).open();
    }

    onOpen(): void {
        const tDia = this.t.diarization;
        this.contentEl.empty();
        this.contentEl.addClass('ai-organiser-diarization-privacy-modal');

        // Title
        this.titleEl.setText(tDia.privacyTitle || 'Use Deepgram for speaker identification?');

        // Body
        const body = this.contentEl.createDiv({ cls: 'ai-organiser-diarization-privacy-body' });
        body.createEl('p', {
            text:
                tDia.privacyDescription
                || "When enabled, this audio file will be sent to Deepgram for transcription with speaker labels.",
        });

        // Buttons
        const buttons = this.contentEl.createDiv({ cls: 'ai-organiser-diarization-privacy-buttons' });
        const rejectBtn = buttons.createEl('button', {
            cls: 'ai-organiser-diarization-privacy-reject',
            text: tDia.privacyReject || "Don't use Deepgram",
        });
        const acceptBtn = buttons.createEl('button', {
            cls: 'ai-organiser-diarization-privacy-accept mod-cta',
            text: tDia.privacyAccept || 'Use Deepgram for this session',
        });

        this.cleanups.push(
            listen(rejectBtn, 'click', () => {
                this.decided = true;
                this.callback(false);
                this.close();
            }),
        );
        this.cleanups.push(
            listen(acceptBtn, 'click', () => {
                this.decided = true;
                this.callback(true);
                this.close();
            }),
        );

        // Focus the reject button by default — consent UX best practice
        rejectBtn.focus();
    }

    onClose(): void {
        // ESC / outside-click path: counts as REJECT per plan §4 R2 H5.
        if (!this.decided) {
            this.decided = true;
            this.callback(false);
        }
        for (const cleanup of this.cleanups) {
            try { cleanup(); } catch { /* best-effort */ }
        }
        this.cleanups.length = 0;
        this.contentEl.empty();
    }
}
