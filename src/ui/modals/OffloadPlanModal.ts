/**
 * Offload plan modal: the dry run and the progress of moving one large file to Google Drive.
 *
 * Two stages, both approvals before anything irreversible happens:
 *  - Plan: the file, where the copy goes, which Drive folder, and every link that will change, with
 *    its original text. Nothing happens until "Start offload".
 *  - Final review: shown after Google Drive has the copy, with the exact before and after text of
 *    every link using the real Drive link. Nothing in a note changes until "Rewrite references".
 */
import { App, Modal, Notice, Setting, TFile } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import { describeError, formatGuidance } from '../../core/friendlyErrors';
import { formatFileSize } from '../../services/embedScanService';
import type { CloudInventoryPair } from '../../core/settings';
import { listen } from '../utils/domUtils';
import {
    abortOffload,
    advanceOffload,
    approveRewrite,
    continueOffload,
    prepareRewrite,
    startOffload,
    type AdvanceOutcome,
    type OffloadDeps,
} from '../../services/offload/offloadService';
import { createOffloadDeps, planOffload, type OffloadPreview } from '../../services/offload/offloadRuntime';
import { offloadablePairs, suggestPair, type RewritePlan } from '../../services/offload/offloadPlan';
import { isTerminal, type OffloadRecord } from '../../services/offload/offloadJournal';

export type OffloadModalSource = { kind: 'file'; file: TFile } | { kind: 'resume'; record: OffloadRecord };

export class OffloadPlanModal extends Modal {
    private cleanups: (() => void)[] = [];
    private abortController = new AbortController();
    private chosenPair: CloudInventoryPair | null = null;
    private busy = false;

    constructor(app: App, private readonly plugin: AIOrganiserPlugin, private readonly source: OffloadModalSource) {
        super(app);
        this.containerEl.addClass('ai-organiser-modal-container');
        this.contentEl.addClass('ai-organiser-modal-content');
    }

    private get o() { return this.plugin.t.offload; }

    private guidance(code: string): string {
        return formatGuidance(describeError(this.plugin.t, code));
    }

    onOpen(): void {
        this.contentEl.createEl('h3', { text: this.o.modalTitle, cls: 'ai-organiser-modal-title' });
        if (this.source.kind === 'resume') {
            void this.show(this.source.record);
        } else {
            this.chosenPair = suggestPair(this.plugin.settings.cloudInventoryPairs, this.source.file.path);
            void this.renderPlan();
        }
    }

    onClose(): void {
        this.abortController.abort();
        for (const cleanup of this.cleanups) cleanup();
        this.cleanups = [];
        this.contentEl.empty();
    }

    private body(): HTMLElement {
        this.contentEl.empty();
        this.contentEl.createEl('h3', { text: this.o.modalTitle, cls: 'ai-organiser-modal-title' });
        return this.contentEl.createDiv();
    }

    private deps(): OffloadDeps | null {
        return createOffloadDeps(this.plugin, { signal: this.abortController.signal });
    }

    // ─── Stage 1: plan ─────────────────────────────────────────────────────────

    private async renderPlan(): Promise<void> {
        if (this.source.kind !== 'file') return;
        const file = this.source.file;
        const el = this.body();
        const pairs = offloadablePairs(this.plugin.settings.cloudInventoryPairs);
        if (pairs.length === 0) { el.createEl('p', { text: this.o.unavailable }); return; }

        if (pairs.length > 1) {
            new Setting(el).setName(this.o.pairLabel).addDropdown((d) => {
                d.addOption('', '');
                for (const p of pairs) d.addOption(p.id, p.label || p.vaultFolder || '/');
                d.setValue(this.chosenPair?.id ?? '').onChange((v) => {
                    this.chosenPair = pairs.find((p) => p.id === v) ?? null;
                    void this.renderPlan();
                });
            });
        }
        if (!this.chosenPair) { el.createEl('p', { text: this.o.noPairChosen }); return; }

        const status = el.createDiv({ cls: 'setting-item-description', attr: { role: 'status' } });
        status.setText(this.o.working);
        const preview = await planOffload(this.plugin, file, this.chosenPair);
        status.remove();
        if (!preview.ok) { el.createEl('p', { text: this.guidance(preview.error) }); this.addClose(el); return; }
        this.renderPreview(el, file, this.chosenPair, preview.value);
    }

    private renderPreview(el: HTMLElement, file: TFile, pair: CloudInventoryPair, preview: OffloadPreview): void {
        const o = this.o;
        el.createEl('h4', { text: o.planHeading });
        const rows = el.createEl('ul');
        rows.createEl('li', { text: `${o.planFile}: ${file.path} (${formatFileSize(file.stat.size)})` });
        rows.createEl('li', { text: `${o.planCopyTo}: ${pair.localMountFolder ?? ''}` });
        rows.createEl('li', { text: `${o.planDriveFolder}: ${pair.label || pair.vaultFolder || '/'}` });
        for (const line of [o.planStep1, o.planStep2, o.planStep3, o.planStep4]) el.createEl('p', { text: line, cls: 'setting-item-description' });

        el.createEl('h4', { text: o.planLinks });
        if (preview.referrers.length === 0) {
            el.createEl('p', { text: o.planNoLinks });
        } else {
            const list = el.createEl('ul');
            for (const r of preview.referrers) {
                const li = list.createEl('li', { text: r.path });
                const inner = li.createEl('ul');
                for (const occ of r.occurrences) inner.createEl('li', { text: occ.kind === 'canvas-file' ? `canvas card ${occ.nodeId ?? ''}` : occ.original });
            }
            el.createEl('p', { text: o.planLinkNote, cls: 'setting-item-description' });
        }

        const buttons = el.createDiv({ cls: 'ai-organiser-modal-buttons' });
        const start = buttons.createEl('button', { text: o.startButton, cls: 'mod-cta' });
        const cancel = buttons.createEl('button', { text: o.cancelButton });
        this.cleanups.push(listen(cancel, 'click', () => this.close()));
        this.cleanups.push(listen(start, 'click', () => {
            if (this.busy) return;
            void this.run(async (deps) => {
                const saved = await startOffload(deps, preview.record);
                if (!saved.ok) return { record: preview.record, waiting: 'blocked' as const, error: saved.error };
                return advanceOffload(deps, saved.value);
            });
        }));
    }

    // ─── Running and showing state ─────────────────────────────────────────────

    private async run(task: (deps: OffloadDeps) => Promise<AdvanceOutcome & { error?: string }>): Promise<void> {
        const deps = this.deps();
        const el = this.body();
        if (!deps) { el.createEl('p', { text: this.o.unavailable }); this.addClose(el); return; }
        this.busy = true;
        const status = el.createDiv({ attr: { role: 'status' } });
        status.setText(this.o.working);
        let outcome: (AdvanceOutcome & { error?: string }) | null = null;
        try {
            outcome = await task(deps);
        } catch {
            outcome = null;
        } finally {
            this.busy = false;
        }
        if (!outcome) { el.empty(); el.createEl('p', { text: this.guidance('write-failed') }); this.addClose(el); return; }
        if (outcome.error) { el.empty(); el.createEl('p', { text: this.guidance(outcome.error) }); this.addClose(el); return; }
        await this.show(outcome.record, outcome.waiting, outcome.persistError);
    }

    private async show(record: OffloadRecord, waiting?: AdvanceOutcome['waiting'], persistError?: string): Promise<void> {
        const o = this.o;
        const el = this.body();
        // The operation moved on but its progress could not be written down: say so, so a later restart is not a surprise.
        if (persistError) el.createEl('p', { text: this.guidance(persistError), cls: 'mod-warning' });
        el.createEl('p', { text: o.stepLabel.replace('{step}', record.step), cls: 'setting-item-description' });

        if (record.step === 'done') {
            new Notice(o.doneNotice, 8000);
            this.close();
            return;
        }
        if (record.step === 'aborted') { el.createEl('p', { text: o.stopped }); this.addClose(el); return; }

        if (record.step === 'planned' || record.step === 'copied' || (record.step === 'failed' && !record.blocked)) {
            if (record.blocked === 'drive-not-synced' || waiting === 'drive-sync') {
                el.createEl('p', { text: o.waitingSync });
            } else if (record.blocked) {
                el.createEl('p', { text: this.guidance(record.blocked) });
            }
            const buttons = el.createDiv({ cls: 'ai-organiser-modal-buttons' });
            if (!isTerminal(record.step)) {
                const again = buttons.createEl('button', { text: o.checkAgain, cls: 'mod-cta' });
                this.cleanups.push(listen(again, 'click', () => { if (!this.busy) void this.run((deps) => advanceOffload(deps, record)); }));
                this.addStop(buttons, record);
            }
            const later = buttons.createEl('button', { text: o.resumeLater });
            this.cleanups.push(listen(later, 'click', () => this.close()));
            return;
        }

        if (record.step === 'remote-captured') {
            await this.renderReview(el, record);
            return;
        }

        // Past the approval: rewriting, verified, trash-pending. Show why it is paused and let the user retry.
        if (record.blocked) el.createEl('p', { text: this.o.blockedNotice.replace('{reason}', this.guidance(record.blocked)) });
        const buttons = el.createDiv({ cls: 'ai-organiser-modal-buttons' });
        if (!isTerminal(record.step)) {
            const retry = buttons.createEl('button', { text: o.checkAgain, cls: 'mod-cta' });
            this.cleanups.push(listen(retry, 'click', () => { if (!this.busy) void this.run((deps) => continueOffload(deps, record)); }));
            if (record.step === 'rewrite-approved' || record.step === 'rewriting') this.addStop(buttons, record);
        }
        const close = buttons.createEl('button', { text: o.resumeLater });
        this.cleanups.push(listen(close, 'click', () => this.close()));
    }

    // ─── Stage 2: final review ─────────────────────────────────────────────────

    private async renderReview(el: HTMLElement, record: OffloadRecord): Promise<void> {
        const o = this.o;
        const deps = this.deps();
        if (!deps) { el.createEl('p', { text: o.unavailable }); this.addClose(el); return; }
        const prep = await prepareRewrite(deps, record);
        if (!prep.ok) { el.createEl('p', { text: this.guidance(prep.error) }); this.addClose(el); return; }
        const { plan, changed } = prep.value;
        el.createEl('h4', { text: o.reviewHeading });
        el.createEl('p', { text: o.reviewIntro });
        if (changed.length > 0) el.createEl('p', { text: o.skippedNote.replace('{paths}', changed.join(', ')), cls: 'setting-item-description' });
        this.renderRewritePlan(el, plan);

        const buttons = el.createDiv({ cls: 'ai-organiser-modal-buttons' });
        const go = buttons.createEl('button', { text: o.rewriteButton, cls: 'mod-cta' });
        this.cleanups.push(listen(go, 'click', () => {
            if (this.busy) return;
            void this.run(async (d) => {
                const approved = await approveRewrite(d, record, plan, changed);
                if (!approved.ok) return { record, waiting: 'blocked' as const, error: approved.error };
                return continueOffload(d, approved.value);
            });
        }));
        this.addStop(buttons, record);
    }

    private renderRewritePlan(el: HTMLElement, plan: RewritePlan): void {
        for (const item of plan.items) {
            el.createEl('h4', { text: item.path });
            for (const p of item.preview) {
                const row = el.createDiv({ cls: 'ai-organiser-offload-diff' });
                row.createEl('div', { text: `${this.o.reviewBefore}: ${p.before}`, cls: 'setting-item-description' });
                row.createEl('div', { text: `${this.o.reviewAfter}: ${p.after}` });
            }
        }
    }

    // ─── Small pieces ──────────────────────────────────────────────────────────

    private addStop(buttons: HTMLElement, record: OffloadRecord): void {
        const stop = buttons.createEl('button', { text: this.o.stopButton });
        this.cleanups.push(listen(stop, 'click', () => {
            if (this.busy) return;
            void (async () => {
                const deps = this.deps();
                if (!deps) return;
                this.busy = true;
                try {
                    const res = await abortOffload(deps, record);
                    new Notice(res.ok ? this.o.stopped : this.guidance(res.error), 6000);
                    this.close();
                } finally {
                    this.busy = false;
                }
            })();
        }));
    }

    private addClose(el: HTMLElement): void {
        const buttons = el.createDiv({ cls: 'ai-organiser-modal-buttons' });
        const close = buttons.createEl('button', { text: this.o.cancelButton });
        this.cleanups.push(listen(close, 'click', () => this.close()));
    }
}
