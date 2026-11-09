/**
 * What one import run did: the notes it created (a hand-back for a known project offers the existing review), the files it
 * did not import with what to do, copies the person has to decide about, and how many wait. Nothing here writes a note:
 * Review hand-back opens the existing reviewed window, and the two choices for an ambiguous copy only change the import record.
 */
import { App, ButtonComponent, Modal, Notice, TFile } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import { describeError, formatGuidance } from '../../core/friendlyErrors';
import type { ImportReport, ImportedItem } from '../../services/claudeImport/importService';
import type { ClaudeImportRuntime } from '../../services/claudeImport/importRuntime';
import { openHandbackReview } from '../../commands/aiWorkspaceCommands';

const PAGE = 50;

export class ClaudeImportResultModal extends Modal {
    constructor(app: App, private readonly plugin: AIOrganiserPlugin, private readonly runtime: ClaudeImportRuntime, private readonly report: ImportReport) {
        super(app);
    }

    onOpen(): void {
        const t = this.plugin.t.claudeImport;
        const r = this.report;
        const { contentEl } = this;
        contentEl.addClass('ai-organiser-claude-import-result');
        this.setTitle(t.resultTitle);
        if (r.stoppedBy) contentEl.createEl('p', { cls: 'ai-organiser-claude-import-warning', text: `${t.stopped} ${formatGuidance(describeError(this.plugin.t, r.stoppedBy))}` });
        const nothing = r.imported.length === 0 && r.outstanding.length === 0 && r.ambiguous.length === 0;
        if (nothing) contentEl.createEl('p', { text: t.nothingNew });

        this.section(t.importedHeading, r.imported, (row, item) => this.importedRow(row, item));
        this.section(t.refusedHeading, [...r.outstanding].sort((a, b) => (a.name < b.name ? -1 : 1)), (row, item) => {
            const g = describeError(this.plugin.t, `claude-import-${item.reason}`);
            row.createEl('strong', { text: item.name });
            row.createEl('div', { text: `${g.message} ${g.nextStep}` });
        });
        this.section(t.checkHeading, r.ambiguous, (row, item) => {
            row.createEl('div', { text: t.ambiguousLine.replace('{path}', item.path) });
            const buttons = row.createDiv({ cls: 'ai-organiser-claude-import-actions' });
            const decide = (choice: 'is-import' | 'fresh-copy'): void => {
                void this.runtime.resolve(item.hash, choice).then((res) => {
                    if (!res.ok) { new Notice(formatGuidance(describeError(this.plugin.t, res.error)), 8000); return; }
                    row.empty();
                    row.createEl('div', { text: choice === 'is-import' ? t.isImport : t.freshCopy });
                });
            };
            new ButtonComponent(buttons).setButtonText(t.isImport).onClick(() => decide('is-import'));
            new ButtonComponent(buttons).setButtonText(t.freshCopy).onClick(() => decide('fresh-copy'));
        });
        if (r.waiting > 0) contentEl.createEl('p', { text: t.waitingLine.replace('{count}', String(r.waiting)) });
    }

    /** A headed list that shows 50 rows, then a button for the next 50: every row stays reachable. */
    private section<T>(heading: string, items: readonly T[], render: (row: HTMLElement, item: T) => void): void {
        if (items.length === 0) return;
        const t = this.plugin.t.claudeImport;
        this.contentEl.createEl('h3', { text: heading.replace('{count}', String(items.length)) });
        const list = this.contentEl.createEl('ul', { cls: 'ai-organiser-claude-import-list' });
        let shown = 0;
        const more = new ButtonComponent(this.contentEl).setButtonText(t.showMore);
        const next = (): void => {
            for (const item of items.slice(shown, shown + PAGE)) render(list.createEl('li'), item);
            shown = Math.min(items.length, shown + PAGE);
            more.buttonEl.toggle(shown < items.length);
        };
        more.onClick(next);
        next();
    }

    private importedRow(row: HTMLElement, item: ImportedItem): void {
        const t = this.plugin.t.claudeImport;
        row.createEl('strong', { text: item.path });
        const route = item.route;
        const line = route.kind === 'routed' ? t.routeRouted.replace('{path}', route.notePath)
            : route.kind === 'no-id' ? t.routeNoId
            : route.kind === 'unknown-project' ? t.routeUnknown.replace('{id}', route.projectId)
            : route.kind === 'protected' ? t.routeProtected
            : route.kind === 'review-off' ? t.routeReviewOff
            : '';
        if (line !== '') row.createEl('div', { text: line });
        if (!item.verified) row.createEl('div', { cls: 'ai-organiser-claude-import-warning', text: t.unverified });
        const buttons = row.createDiv({ cls: 'ai-organiser-claude-import-actions' });
        const fileOf = (): TFile | null => {
            const f = this.app.vault.getAbstractFileByPath(item.path);
            return f instanceof TFile ? f : null;
        };
        new ButtonComponent(buttons).setButtonText(t.openNote).onClick(() => {
            const f = fileOf();
            if (f) void this.app.workspace.getLeaf(false).openFile(f);
        });
        if (route.kind === 'routed') {
            new ButtonComponent(buttons).setButtonText(t.reviewHandback).setCta().onClick(() => {
                const f = fileOf();
                if (!f) return;
                this.close();
                void openHandbackReview(this.plugin, f);
            });
        }
    }

    onClose(): void {
        this.contentEl.empty();
    }
}
