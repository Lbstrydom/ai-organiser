import { Modal, type App } from 'obsidian';
import { listen } from '../utils/domUtils';
import type { Translations } from '../../i18n/types';

/**
 * One-time consent disclosure for the local ONNX embedding fallback
 * (npm-audit-remediation plan, Cluster 4). The @xenova/transformers ->
 * onnxruntime-web -> protobufjs chain has a critical, unpatched RCE-class
 * vulnerability; this modal is the ONLY path that sets
 * `settings.enableLocalOnnxEmbeddings = true`.
 *
 * Behaviour matrix (mirrors DiarizationPrivacyModal's established pattern):
 *  - User clicks "Enable local embeddings" -> resolves `true`
 *  - User clicks "Don't enable"            -> resolves `false`
 *  - User presses ESC / clicks outside     -> resolves `false`
 *
 * The modal NEVER mutates plugin state directly — the caller (via
 * `applyLocalOnnxConsentChange`) owns that.
 */
export class LocalOnnxConsentModal extends Modal {
    private decided = false;
    private readonly cleanups: Array<() => void> = [];

    constructor(
        app: App,
        private readonly t: Translations,
        private readonly callback: (accepted: boolean) => void,
    ) {
        super(app);
    }

    onOpen(): void {
        // audit-caught (L2): reset per-session state here, not just at
        // construction — every real call site creates a fresh instance per
        // open today, but treating onOpen() as the start of a new decision
        // session (rather than relying on that call-site convention) is
        // the actual fix, not an assumption about how callers behave.
        this.decided = false;
        const tc = this.t.modals.localOnnxConsent;
        this.contentEl.empty();
        this.contentEl.addClass('ai-organiser-modal-content');
        this.contentEl.addClass('ai-organiser-local-onnx-consent-modal');

        this.titleEl.setText(tc.title);

        this.contentEl.createEl('p', { text: tc.description });

        const bulletList = this.contentEl.createEl('ul', { cls: 'ai-organiser-local-onnx-consent-bullets' });
        bulletList.createEl('li', { text: tc.bullet1 });
        bulletList.createEl('li', { text: tc.bullet2 });
        bulletList.createEl('li', { text: tc.bullet3 });

        const buttons = this.contentEl.createDiv({ cls: 'ai-organiser-modal-buttons' });
        const declineBtn = buttons.createEl('button', { text: tc.declineButton, cls: 'ai-organiser-local-onnx-consent-decline' });
        const acceptBtn = buttons.createEl('button', { text: tc.acceptButton, cls: 'ai-organiser-local-onnx-consent-accept mod-cta' });

        this.cleanups.push(
            listen(declineBtn, 'click', () => {
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

        // Focus the decline button by default — consent UX best practice.
        declineBtn.focus();
    }

    onClose(): void {
        // ESC / outside-click path counts as decline.
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
