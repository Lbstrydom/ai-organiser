import { App, ItemView, Notice, TFile, WorkspaceLeaf } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import { describeError, formatGuidance, isGuidanceCode } from '../../core/friendlyErrors';
import { isFeatureEnabled } from '../../services/featureService';
import { getCaptureController } from '../../commands/captureInboxCommands';
import { handbackActive } from '../../services/aiWorkspaces/handbackService';
import { isInsideOrEqual, normalisePath } from '../../core/protectedPaths';
import { capRows, captureItems, handbackItems, heldItems, newHandbackItems, projectProcess, PROCESS_GROUPS, type ProcessAction, type ProcessAdapter, type ProcessItem } from '../../services/process/processProjection';
import { ok } from '../../core/result';
import { openHandbackReview } from '../../commands/aiWorkspaceCommands';
import { PROCESS_VIEW_TYPE } from './processRefresh';
import { renderActionRow } from '../components/ActionRow';
import { plural } from '../../utils/plural';
import { logger } from '../../utils/logger';

export { PROCESS_VIEW_TYPE };

/**
 * Process: one list of what is waiting to be clarified, grouped by owner. It reads the owners' state (never keeps its own)
 * and each row opens the owner's existing review. It re-reads when its window is shown, when the capture journal changes
 * (debounced) and on Refresh.
 */
export class ProcessView extends ItemView {
    private cleanups: Array<() => void> = [];
    private unsubscribe: (() => void) | null = null;
    private timer: number | null = null;
    private reading = false;
    private closed = false;

    constructor(leaf: WorkspaceLeaf, private readonly plugin: AIOrganiserPlugin) {
        super(leaf);
    }

    getViewType(): string { return PROCESS_VIEW_TYPE; }
    getDisplayText(): string { return this.plugin.t.process.title; }
    getIcon(): string { return 'list-checks'; }

    async onOpen(): Promise<void> {
        this.contentEl.addClass('ai-organiser-process');
        const ctl = isFeatureEnabled(this.plugin.settings, 'capture-inbox') ? getCaptureController(this.plugin) : null;
        this.unsubscribe = ctl ? ctl.store.subscribe(() => this.schedule()) : null;
        this.registerEvent(this.app.workspace.on('active-leaf-change', (leaf) => { if (leaf === this.leaf) this.schedule(); }));
        // A hand-back note arriving or changing in the inbox shows up without pressing Refresh.
        this.registerEvent(this.app.metadataCache.on('changed', () => this.schedule()));
        await this.read();
    }

    onClose(): Promise<void> {
        this.closed = true;
        this.unsubscribe?.();
        this.unsubscribe = null;
        if (this.timer !== null) window.clearTimeout(this.timer);
        this.timer = null;
        this.release();
        return Promise.resolve();
    }

    private release(): void {
        for (const c of this.cleanups.splice(0)) c();
    }

    private schedule(): void {
        if (this.closed) return;
        if (this.timer !== null) window.clearTimeout(this.timer);
        this.timer = window.setTimeout(() => { this.timer = null; void this.read(); }, 300);
    }

    private adapters(): ProcessAdapter[] {
        const s = this.plugin.settings;
        const out: ProcessAdapter[] = [];
        const ctl = isFeatureEnabled(s, 'capture-inbox') ? getCaptureController(this.plugin) : null;
        if (ctl) out.push({ group: 'captures', read: () => ok(captureItems(ctl.store.get(), Date.now(), ctl.stabilityMs())) });
        if (handbackActive(this.plugin)) out.push({ group: 'handbacks', read: () => ok([...handbackItems(s.aiHandbacks, (p) => this.app.vault.getAbstractFileByPath(p) instanceof TFile), ...newHandbackItems(this.inboxHandbacks(), s.aiHandbacks)]) });
        // Held rows are about the Google export and their Retry is its command, so the group exists only while that export does.
        if (isFeatureEnabled(s, 'google-tasks-export')) out.push({ group: 'held', read: () => ok(heldItems(s.sweepApprovals)) });
        return out;
    }

    /** Notes in the inbox folders whose headings include a Handoff section (from the metadata cache: no file is read). */
    private inboxHandbacks(): Array<{ path: string }> {
        const folders = this.plugin.settings.sweepInboxFolders.map(normalisePath).filter(Boolean);
        if (folders.length === 0) return [];
        return this.app.vault.getMarkdownFiles()
            .filter((f) => folders.some((folder) => isInsideOrEqual(normalisePath(f.path), folder)))
            .filter((f) => (this.app.metadataCache.getFileCache(f)?.headings ?? []).some((h) => h.level <= 3 && h.heading.trim().toLowerCase() === 'handoff'))
            .map((f) => ({ path: f.path }));
    }

    /** Read again now (used when something this view lists has just changed elsewhere). */
    refresh(): void {
        this.schedule();
    }

    private async read(): Promise<void> {
        if (this.reading || this.closed) return;
        this.reading = true;
        try {
            const groups = await projectProcess(this.adapters());
            // A read that finished after the view was closed draws nothing and leaves no listeners behind.
            if (!this.closed) this.draw(groups);
        } catch (e) {
            logger.error('Process', 'Could not read the Process view', e);
            if (!this.closed) this.contentEl.createDiv({ text: formatGuidance(describeError(this.plugin.t, 'unknown')), cls: 'setting-item-description ai-organiser-capture-warning' });
        } finally {
            this.reading = false;
        }
    }

    private draw(groups: Awaited<ReturnType<typeof projectProcess>>): void {
        const t = this.plugin.t.process;
        this.release();
        const el = this.contentEl;
        el.empty();
        // The tab already shows the title; the heading here would say it twice.
        const head = el.createDiv({ cls: 'ai-organiser-process-head' });
        const refresh = head.createEl('button', { text: t.refresh });
        refresh.addEventListener('click', () => { void this.read(); });

        const total = groups.reduce((n, g) => n + g.items.length, 0);
        if (groups.length === 0) { el.createDiv({ text: t.nothingEnabled, cls: 'setting-item-description' }); return; }
        if (total === 0 && groups.every((g) => !g.error)) el.createDiv({ text: t.allClear, cls: 'setting-item-description' });

        for (const group of PROCESS_GROUPS) {
            const found = groups.find((g) => g.group === group);
            if (!found) continue;
            if (found.items.length === 0 && !found.error) continue;
            el.createEl('h4', { text: `${t.groups[group]}${found.items.length > 0 ? ` (${found.items.length})` : ''}` });
            if (found.error) {
                el.createDiv({ text: formatGuidance(describeError(this.plugin.t, found.error)), cls: 'setting-item-description ai-organiser-capture-warning' });
                continue;
            }
            const { shown, more } = capRows(found.items);
            const list = el.createEl('ul', { cls: 'ai-organiser-action-rows', attr: { 'aria-label': t.groups[group] } });
            for (const item of shown) this.cleanups.push(this.row(list, item));
            if (more > 0) el.createDiv({ text: plural(t.moreRows, more), cls: 'setting-item-description' });
        }
    }

    private row(list: HTMLElement, item: ProcessItem): () => void {
        const t = this.plugin.t.process;
        const label: Record<ProcessAction, string> = { review: t.actions.review, retry: t.actions.retry, open: t.actions.open };
        const detail = item.group === 'handbacks' && item.detail ? (item.detail === 'new' ? t.handbackNew : plural(t.handbackWaiting, Number(item.detail))) : item.detail;
        return renderActionRow(list, {
            title: item.title,
            ...(detail ? { detail } : {}),
            ...(item.heldReason ? { held: this.heldText(item.heldReason) } : {}),
            actions: item.actions.map((a) => ({ label: label[a], onClick: () => { void this.go(item, a); } })),
        });
    }

    private heldText(code: string): string {
        const t = this.plugin.t.process;
        if (code === 'handback-item-failed') return t.handbackFailed;
        // A guidance code says what to do; any other stable code is the export's own "the last attempt failed".
        return isGuidanceCode(code) ? formatGuidance(describeError(this.plugin.t, code)) : t.heldGeneric;
    }

    private async go(item: ProcessItem, action: ProcessAction): Promise<void> {
        const route = item.route;
        try {
            if (route.type === 'command') { (this.app as App & { commands: { executeCommandById: (id: string) => void } }).commands.executeCommandById(`ai-organiser:${route.id}`); return; }
            const file = this.app.vault.getAbstractFileByPath(route.path);
            if (!(file instanceof TFile)) { new Notice(this.plugin.t.process.noteMissing, 6000); return; }
            if (route.type === 'handback' && action !== 'open') { await openHandbackReview(this.plugin, file); return; }
            await this.app.workspace.getLeaf(false).openFile(file);
        } catch (e) {
            logger.error('Process', 'Could not open the row', e);
            new Notice(formatGuidance(describeError(this.plugin.t, 'unknown')), 8000);
        } finally {
            this.schedule();
        }
    }
}
