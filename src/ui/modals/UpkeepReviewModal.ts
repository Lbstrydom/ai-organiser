/**
 * The vault upkeep review: the report. It shows the last run's status, what each check did, and the
 * proposals grouped by kind. Every button opens the flow that already owns that change (rebuild the
 * index, refresh an inventory, review in Find embeds), so approving anything here goes through the
 * existing safe path. The modal itself never changes a note.
 *
 * A review that is open does not change under the user: if a newer run finishes meanwhile, it offers
 * "Show it". "Save report as note" is the one explicit write, and only that click performs it.
 */
import { App, Modal, Notice } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import { describeError, formatGuidance } from '../../core/friendlyErrors';
import type { UpkeepResult } from '../../services/upkeep/upkeepRuntime';
import { renderReport, saveReport } from '../../services/upkeep/upkeepReport';
import { reviewCount } from '../../services/upkeep/upkeepService';
import type { Proposal, ProposalKind } from '../../services/upkeep/upkeepTasks';
import { runBuild } from '../../commands/agentIndexCommands';
import { runRefresh } from '../../commands/cloudInventoryCommands';
import { listen } from '../utils/domUtils';

/** The last result: in memory if there is one, otherwise rebuilt from what was saved. */
export function currentResult(plugin: AIOrganiserPlugin): UpkeepResult | null {
    if (plugin.upkeep?.last) return plugin.upkeep.last;
    const s = plugin.settings;
    if (!s.upkeepLastRun) return null;
    return { summary: s.upkeepLastRun, proposals: s.upkeepLastProposals?.items ?? [], omitted: s.upkeepLastProposals?.omitted ?? 0 };
}

export class UpkeepReviewModal extends Modal {
    private cleanups: (() => void)[] = [];
    private unsubscribe: (() => void) | null = null;
    private newer: UpkeepResult | null = null;
    private shown: UpkeepResult | null;

    constructor(app: App, private readonly plugin: AIOrganiserPlugin) {
        super(app);
        this.containerEl.addClass('ai-organiser-modal-container');
        this.contentEl.addClass('ai-organiser-modal-content');
        this.shown = currentResult(plugin);
    }

    private get t() { return this.plugin.t.vaultUpkeep; }

    onOpen(): void {
        this.unsubscribe = this.plugin.upkeep?.onResult((result) => { this.newer = result; this.render(); }) ?? null;
        this.render();
    }

    private clearCleanups(): void {
        for (const cleanup of this.cleanups) cleanup();
        this.cleanups = [];
    }

    private render(): void {
        const t = this.t;
        this.clearCleanups();
        const el = this.contentEl;
        el.empty();
        el.createEl('h3', { text: t.reviewTitle, cls: 'ai-organiser-modal-title' });
        el.createEl('p', { text: t.reviewIntro, cls: 'setting-item-description' });

        if (this.newer && this.newer !== this.shown) {
            const banner = el.createDiv({ cls: 'setting-item-description' });
            banner.createSpan({ text: `${t.newerResult} ` });
            const show = banner.createEl('button', { text: t.showNewer });
            this.cleanups.push(listen(show, 'click', () => { this.shown = this.newer; this.newer = null; this.render(); }));
        }

        const result = this.shown;
        if (!result) {
            el.createEl('p', { text: t.neverRunReview });
        } else {
            this.renderSummary(el, result);
            this.renderProposals(el, result);
        }

        const buttons = el.createDiv({ cls: 'ai-organiser-modal-buttons' });
        const run = buttons.createEl('button', { text: t.runNow, cls: 'mod-cta' });
        this.cleanups.push(listen(run, 'click', () => { void this.runAgain(); }));
        if (result) {
            const save = buttons.createEl('button', { text: t.saveReport });
            this.cleanups.push(listen(save, 'click', () => { void this.save(result); }));
        }
        const close = buttons.createEl('button', { text: this.plugin.t.modals.cancel });
        this.cleanups.push(listen(close, 'click', () => this.close()));
    }

    private statusText(status: 'ok' | 'partial' | 'failed'): string {
        return status === 'ok' ? this.t.statusOk : status === 'partial' ? this.t.statusPartial : this.t.statusFailed;
    }

    private renderSummary(el: HTMLElement, result: UpkeepResult): void {
        const t = this.t;
        const s = result.summary;
        const seconds = Math.round(s.durationMs / 1000);
        el.createEl('p', { text: `${this.statusText(s.status)}. ${t.lastRunLine.replace('{when}', new Date(s.startedAt).toLocaleString()).replace('{status}', s.trigger).replace('{seconds}', String(seconds))}` });
        const next = this.plugin.upkeep?.nextRun() ?? null;
        el.createEl('p', { text: next === null ? t.nextRunOff : t.nextRunLine.replace('{when}', new Date(next).toLocaleString()), cls: 'setting-item-description' });
        const list = el.createEl('ul');
        const label: Record<string, string> = { ok: t.statusTaskOk, skipped: t.statusTaskSkipped, failed: t.statusTaskFailed, cancelled: t.statusTaskCancelled };
        const taskName: Record<string, string> = { agentIndex: t.taskAgentIndex, inventories: t.taskInventories, attachments: t.taskAttachments };
        for (const o of s.outcomes) {
            const reason = o.reason ? ` — ${formatGuidance(describeError(this.plugin.t, o.reason))}` : '';
            list.createEl('li', { text: `${t.taskLine.replace('{task}', taskName[o.task] ?? o.task).replace('{status}', label[o.status] ?? o.status)}${reason}` });
        }
        // A failed or partial run is never presented as "nothing to review".
        if (s.status !== 'ok' && reviewCount(s) === 0) el.createEl('p', { text: t.partialNotice });
    }

    private renderProposals(el: HTMLElement, result: UpkeepResult): void {
        const t = this.t;
        if (reviewCount(result.summary) === 0) {
            if (result.summary.status === 'ok') el.createEl('p', { text: t.reviewEmpty });
            return;
        }
        const kindLabel: Record<ProposalKind, string> = {
            'agent-index-stale': t.kindIndexStale, 'agent-index-refreshed': t.kindIndexRefreshed, 'inventory-differs': t.kindInventory,
            'attachment-unreferenced': t.kindUnreferenced, 'attachment-large': t.kindLarge, 'attachment-duplicate': t.kindDuplicate, 'link-suggestion': t.kindLink,
        };
        const order = Object.keys(kindLabel) as ProposalKind[];
        for (const kind of order) {
            const items = result.proposals.filter((p) => p.kind === kind);
            const total = result.summary.totals[kind] ?? 0;
            if (total === 0) continue;
            el.createEl('h4', { text: `${kindLabel[kind]} (${total})` });
            const list = el.createEl('ul');
            for (const p of items) this.renderItem(list, p);
            if (total > items.length) list.createEl('li', { text: t.moreItems.replace('{count}', String(total - items.length)), cls: 'setting-item-description' });
        }
    }

    private renderItem(list: HTMLElement, p: Proposal): void {
        const t = this.t;
        const li = list.createEl('li');
        const action = (label: string, run: () => void): void => {
            const btn = li.createEl('button', { text: label });
            this.cleanups.push(listen(btn, 'click', run));
        };
        const findEmbeds = (): void => { (this.app as unknown as { commands: { executeCommandById: (id: string) => void } }).commands.executeCommandById('ai-organiser:find-embeds'); this.close(); };
        switch (p.kind) {
            case 'agent-index-stale':
                li.createSpan({ text: `${t.indexStaleLine.replace('{added}', String(p.added)).replace('{removed}', String(p.removed)).replace('{changed}', String(p.changed))} ` });
                action(t.actionRebuildIndex, () => { void runBuild(this.plugin); });
                break;
            case 'agent-index-refreshed':
                li.createSpan({ text: t.indexRefreshedLine.replace('{path}', p.path) });
                break;
            case 'inventory-differs':
                li.createSpan({ text: `${p.hubPath} ` });
                action(t.actionRefreshInventory, () => { void runRefresh(this.plugin, [p.pairId]); });
                break;
            case 'attachment-unreferenced':
            case 'attachment-large':
                li.createSpan({ text: `${p.path} ` });
                action(t.actionFindEmbeds, findEmbeds);
                break;
            case 'attachment-duplicate':
                li.createSpan({ text: `${p.paths.join(', ')} ` });
                action(t.actionFindEmbeds, findEmbeds);
                break;
            case 'link-suggestion':
                li.createSpan({ text: `${t.suggestionLine.replace('{attachment}', p.attachmentPath).replace('{note}', p.notePath).replace('{words}', p.evidence.join(', '))} ` });
                action(t.actionFindEmbeds, findEmbeds);
                break;
        }
    }

    private async runAgain(): Promise<void> {
        const upkeep = this.plugin.upkeep;
        if (!upkeep) return;
        new Notice(this.t.runningNotice, 3000);
        const res = await upkeep.runNow();
        if (!res.ok) { new Notice(formatGuidance(describeError(this.plugin.t, res.error)), 8000); return; }
        this.shown = res.value;
        this.newer = null;
        this.render();
    }

    private async save(result: UpkeepResult): Promise<void> {
        const text = renderReport(result.summary, result.proposals, result.omitted);
        const res = await saveReport(this.plugin, text);
        new Notice(res.ok ? this.t.reportSaved.replace('{path}', res.value) : formatGuidance(describeError(this.plugin.t, res.error)), 6000);
    }

    onClose(): void {
        this.unsubscribe?.();
        this.clearCleanups();
        this.contentEl.empty();
    }
}
