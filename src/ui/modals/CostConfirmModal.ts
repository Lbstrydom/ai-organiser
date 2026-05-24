/**
 * CostConfirmModal — pre-flight cost & duration confirmation for audio narration.
 *
 * Promise-based modal that mirrors CompressionConfirmModal shape:
 *   - waitForChoice() returns 'cancel' | 'settings' | 'generate'
 *   - ESC / onClose resolves 'cancel' (safety default)
 *
 * Consumes a PreparedNarration directly — no separate input shape (H1 fix
 * from R1 audit: single canonical pipeline, modal reads what the service
 * computed).
 */

import { Modal, Setting } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import type { PreparedNarration } from '../../services/audioNarration/narrationTypes';
import { LLM_ENHANCEMENT_PROVIDERS } from '../../services/audioNarration/llmEnhancerProvider';

export type CostAction = 'cancel' | 'settings' | 'generate';

export class CostConfirmModal extends Modal {
    private actionFired = false;
    private resolveChoice!: (choice: CostAction) => void;

    constructor(
        private readonly plugin: AIOrganiserPlugin,
        private readonly prepared: PreparedNarration,
    ) {
        super(plugin.app);
    }

    /** Await this after calling open() to get the user's choice. */
    waitForChoice(): Promise<CostAction> {
        return new Promise(resolve => { this.resolveChoice = resolve; });
    }

    onOpen(): void {
        const { contentEl } = this;
        const t = this.plugin.t.modals.costConfirm;

        contentEl.empty();
        contentEl.addClass('ai-organiser-modal-content');

        contentEl.createEl('h2', { text: t.title });
        contentEl.createEl('p', {
            text: this.prepared.file.basename,
            cls: 'ai-organiser-cost-title',
        });
        contentEl.createEl('p', {
            text: this.prepared.provider.displayName,
            cls: 'ai-organiser-cost-provider',
        });

        // Stats — semantic <dl> for screen-reader pairing
        const statsEl = contentEl.createDiv({ cls: 'ai-organiser-cost-stats' });
        const dl = statsEl.createEl('dl');
        const addRow = (label: string, value: string): void => {
            dl.createEl('dt', { text: label });
            dl.createEl('dd', { text: value });
        };

        const numFmt = new Intl.NumberFormat();
        addRow(t.statSpokenChars, `${numFmt.format(this.prepared.cost.charCount)} characters`);
        addRow(t.statEstDuration, this.formatDuration(this.prepared.cost.estDurationSec));
        addRow(t.statChunks, String(this.prepared.cost.chunkCount));
        addRow(t.statVoice, this.prepared.voice);
        addRow(t.statEstCost, this.formatCost(this.prepared.cost.estUsd, this.prepared.cost.estEur));

        // AI enhancement rows — shown only when the LLM pre-pass will actually run.
        // Driven by llmIntent (the RESOLVED behaviour, not the raw setting), so
        // mode='on' without a key won't promise enhancement we can't deliver.
        if (this.prepared.llmIntent && this.prepared.cost.llmEnhancementUsd) {
            const tEnh = this.plugin.t.settings.audioNarration.enhancement;
            const providerCfg = LLM_ENHANCEMENT_PROVIDERS[this.prepared.llmIntent.providerId];
            addRow(tEnh.costLineLabel, `~$${this.prepared.cost.llmEnhancementUsd.toFixed(3)}`);
            contentEl.createDiv({
                cls: 'ai-organiser-cost-enhancement-hint',
                text: tEnh.varianceHint,
            });
            contentEl.createDiv({
                cls: 'ai-organiser-cost-enhancement-privacy',
                text: tEnh.privacyHint.replace('{provider}', providerCfg.displayName),
            });
        }

        contentEl.createDiv({
            cls: 'ai-organiser-cost-output',
            text: `${t.statOutputPath}: ${this.prepared.outputPath}`,
        });

        // Buttons
        const btnRow = new Setting(contentEl);
        btnRow.addButton(btn => btn
            .setButtonText(t.cancel)
            .onClick(() => this.choose('cancel')));
        btnRow.addButton(btn => btn
            .setButtonText(t.settings)
            .onClick(() => this.choose('settings')));
        btnRow.addButton(btn => btn
            .setButtonText(t.generate)
            .setCta()
            .onClick(() => this.choose('generate')));
    }

    onClose(): void {
        this.contentEl.empty();
        if (!this.actionFired) {
            this.actionFired = true;
            this.resolveChoice('cancel');
        }
    }

    private choose(action: CostAction): void {
        this.actionFired = true;
        this.close();
        this.resolveChoice(action);
    }

    private formatDuration(secondsTotal: number): string {
        const t = this.plugin.t.modals.costConfirm;
        const m = Math.floor(secondsTotal / 60);
        const s = secondsTotal % 60;
        return t.durationFmt.replace('{min}', String(m)).replace('{sec}', String(s));
    }

    private formatCost(usd: number, eur: number): string {
        const t = this.plugin.t.modals.costConfirm;
        return t.costFmt
            .replace('{usd}', usd.toFixed(2))
            .replace('{eur}', eur.toFixed(2));
    }
}
