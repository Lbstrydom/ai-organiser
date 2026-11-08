import { App, Modal, Notice, Setting } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import { describeError, formatGuidance } from '../../core/friendlyErrors';
import type { Result } from '../../core/result';
import type { LivePackService, LiveReview, RefreshOutcome, SelectionPreview } from '../../services/aiWorkspaces/livePackService';
import { logger } from '../../utils/logger';
import { plural } from '../../utils/plural';

/**
 * The consent step of the live pack: every candidate note with a checkbox (the project note required, notes approved before ticked,
 * new notes NOT ticked), the exact size of the selected live file, and one button that turns it on. Previews run one at a time and
 * only the newest selection's result is shown. Nothing is written until the person confirms.
 */
export class LivePackReviewModal extends Modal {
    private ticked = new Set<string>();
    private revision = 0;
    private running = false;
    private pending = false;
    private preview: SelectionPreview | null = null;
    private previewFor = -1;
    private closed = false;
    private busy = false;
    private statusEl: HTMLElement | null = null;
    private problemEl: HTMLElement | null = null;
    private confirmButton: HTMLButtonElement | null = null;
    private readonly boxes: HTMLInputElement[] = [];

    constructor(
        app: App,
        private readonly plugin: AIOrganiserPlugin,
        private readonly review: LiveReview,
        private readonly onConfirm: (preview: SelectionPreview) => Promise<Result<RefreshOutcome>>,
        private readonly onDone: (outcome: RefreshOutcome) => void,
        /** Called with the ticks when the review went stale: the caller opens a fresh review that keeps them */
        private readonly onStale: (ticked: string[]) => void,
        private readonly initialTicks: readonly string[] | null = null,
    ) {
        super(app);
    }

    onOpen(): void {
        const t = this.plugin.t.aiWorkspaces.live;
        const r = this.review;
        const keep = this.initialTicks ? new Set(this.initialTicks) : null;
        for (const n of r.snapshot.notes) {
            if (!n.shareable) continue;
            if (n.path === r.snapshot.projectPath || (keep ? keep.has(n.path) : n.approved)) this.ticked.add(n.path);
        }
        this.containerEl.addClass('ai-organiser-modal-container');
        const el = this.contentEl;
        el.createEl('h3', { text: r.generation > 0 ? t.reviewTitleAgain : t.reviewTitle, cls: 'ai-organiser-modal-title' });
        el.createEl('p', { text: t.reviewIntro.replace('{path}', livePathOf(r.folder, r.fileName)), cls: 'setting-item-description' });

        const list = el.createDiv({ cls: 'ai-organiser-live-review-list' });
        for (const n of r.snapshot.notes) {
            const row = list.createDiv({ cls: 'ai-organiser-live-review-row' });
            if (!n.shareable) {
                row.createSpan({ text: `${n.path} (${t.notShared.replace('{reason}', this.reasonText(n.reason))})`, cls: 'setting-item-description' });
                continue;
            }
            const isProject = n.path === r.snapshot.projectPath;
            const label = row.createEl('label');
            const box = label.createEl('input', { type: 'checkbox' });
            box.checked = this.ticked.has(n.path);
            box.disabled = isProject;
            if (!isProject) this.boxes.push(box);
            box.setAttribute('aria-label', n.path);
            label.appendText(` ${n.path} `);
            label.createSpan({ text: `(${isProject ? t.tagProject : n.approved ? t.tagApproved : t.tagNew})`, cls: 'setting-item-description' });
            box.addEventListener('change', () => {
                // While a confirmation runs, the selection is the one being written: it cannot change.
                if (this.busy) { box.checked = this.ticked.has(n.path); return; }
                if (box.checked) this.ticked.add(n.path); else this.ticked.delete(n.path);
                this.requestPreview();
            });
        }

        // Only the project, its Area and the context sources are candidates: say how to add another note, so a short list is not a dead end.
        el.createEl('p', { text: t.reviewAddHint, cls: 'setting-item-description' });

        this.statusEl = el.createDiv({ cls: 'setting-item-description ai-organiser-live-status', attr: { role: 'status', 'aria-live': 'polite' } });
        this.problemEl = el.createDiv({ cls: 'setting-item-description ai-organiser-capture-warning', attr: { role: 'alert' } });
        new Setting(el)
            .addButton((b) => b.setButtonText(this.plugin.t.aiWorkspaces.cancel).onClick(() => this.close()))
            .addButton((b) => {
                b.setCta().setButtonText(r.generation > 0 ? t.confirmAgain : t.confirm).onClick(() => { void this.confirm(); });
                this.confirmButton = b.buttonEl;
            });
        this.requestPreview();
    }

    onClose(): void {
        this.closed = true;
        this.contentEl.empty();
    }

    private reasonText(reason: string | null): string {
        const reasons = this.plugin.t.aiWorkspaces.skipReasons as Record<string, string>;
        return (reason && reasons[reason]) || reasons['outside-allow-list'];
    }

    /** Coalesced: at most one preview runs; a change while it runs asks for one more, of the newest selection. */
    private requestPreview(): void {
        this.revision++;
        this.preview = null;
        this.refresh();
        if (this.running) { this.pending = true; return; }
        void this.runPreview();
    }

    private async runPreview(): Promise<void> {
        this.running = true;
        try {
            do {
                this.pending = false;
                const rev = this.revision;
                const ticked = [...this.ticked];
                let res: Awaited<ReturnType<LivePackService['previewSelection']>> | undefined;
                try {
                    res = await this.plugin.livePacks?.service.previewSelection(this.review, ticked);
                } catch (e) {
                    logger.error('AiWorkspaces', 'Could not preview the live pack', e);
                    res = { ok: false, error: 'unknown' };
                }
                // A late answer for an older selection, or after closing, is dropped.
                if (this.closed || rev !== this.revision) continue;
                if (res?.ok) { this.preview = res.value; this.previewFor = rev; this.problemEl?.setText(''); }
                else this.problemEl?.setText(formatGuidance(describeError(this.plugin.t, res ? res.error : 'live-desktop-only')));
                this.refresh();
            } while (this.pending && !this.closed);
        } finally {
            this.running = false;
        }
    }

    private refresh(): void {
        const t = this.plugin.t.aiWorkspaces.live;
        const current = this.preview !== null && this.previewFor === this.revision;
        if (this.statusEl) {
            const p = current ? this.preview : null;
            // A ticked note the build had to leave out is named with its reason, so a short pack is never a silent surprise.
            const leftOut = p && p.skipped.length > 0
                ? ` ${t.leftOut.replace('{notes}', p.skipped.map((s) => `${s.path} (${this.reasonText(s.reason)})`).join(', '))}`
                : '';
            this.statusEl.setText(p
                ? plural(t.selection, p.ticked.length).replace('{kb}', String(Math.max(1, Math.round(p.bytes / 1024)))) + leftOut
                : t.updating);
        }
        if (this.confirmButton) this.confirmButton.disabled = this.busy || !current;
        for (const b of this.boxes) b.disabled = this.busy;
    }

    private async confirm(): Promise<void> {
        const preview = this.preview;
        if (!preview || this.previewFor !== this.revision || this.busy) return;
        this.busy = true;
        this.refresh();
        try {
            const res = await this.onConfirm(preview);
            if (this.closed) return;
            if (res.ok) { this.close(); this.onDone(res.value); return; }
            // Stale: a fresh review is opened with the same ticks (this one was bound to notes that changed). Failed: the reason stays here.
            if (res.error === 'pack-preview-stale') { const ticks = [...this.ticked]; this.close(); this.onStale(ticks); return; }
            this.problemEl?.setText(formatGuidance(describeError(this.plugin.t, res.error)));
        } catch (e) {
            logger.error('AiWorkspaces', 'Could not turn on the live pack', e);
            if (!this.closed) this.problemEl?.setText(formatGuidance(describeError(this.plugin.t, 'unknown')));
        } finally {
            this.busy = false;
            if (!this.closed) this.refresh();
        }
    }
}

/** What the person is told after a refresh or a confirmation: every outcome has its own message. */
export function outcomeMessage(plugin: AIOrganiserPlugin, outcome: RefreshOutcome, path?: string): string {
    const t = plugin.t.aiWorkspaces.live;
    switch (outcome.kind) {
        case 'written':
        case 'held': return path ? t.writtenNotice.replace('{path}', path) : t.refreshedNotice;
        case 'unchanged': return t.unchangedNotice;
        case 'revoked': return t.revokedNotice;
        case 'needs-review': return t.pausedNotice;
    }
}

/** The file's full path for messages, with the folder's own separator. */
export function livePathOf(folder: string, fileName: string): string {
    const sep = folder.includes('\\') ? '\\' : '/';
    return folder.endsWith(sep) ? `${folder}${fileName}` : `${folder}${sep}${fileName}`;
}

/** Prepare the review and open it; on success say where the file is. Used by the workspace window and the refresh command. */
export async function openLiveReview(plugin: AIOrganiserPlugin, aioId: string, initialTicks: readonly string[] | null = null, after?: () => void): Promise<void> {
    const service = plugin.livePacks?.service;
    if (!service) { new Notice(formatGuidance(describeError(plugin.t, 'live-desktop-only')), 9000); return; }
    let review: Awaited<ReturnType<LivePackService['prepareReview']>>;
    try { review = await service.prepareReview(aioId); } catch (e) { logger.error('AiWorkspaces', 'Could not open the live pack review', e); review = { ok: false, error: 'unknown' }; }
    if (!review.ok) { new Notice(formatGuidance(describeError(plugin.t, review.error)), 9000); return; }
    new LivePackReviewModal(plugin.app, plugin, review.value,
        (preview) => service.confirm(review.value, preview),
        (outcome) => {
            const path = livePathOf(review.value.folder, review.value.fileName);
            new Notice(outcomeMessage(plugin, outcome, path), 10000);
            after?.();
        },
        (ticks) => { void openLiveReview(plugin, aioId, ticks, after); },
        initialTicks,
    ).open();
}

/** One sentence for a project's live pack, from its status (never from codes shown raw). */
export function liveStatusText(plugin: AIOrganiserPlugin, aioId: string): string {
    const t = plugin.t.aiWorkspaces.live;
    const s = plugin.settings.aiWorkspaceLiveStatus[aioId];
    const on = !!plugin.settings.aiWorkspaces[aioId]?.live;
    if (!s || (!on && s.state !== 'revoking')) return t.stateOff;
    const held = s.held.length > 0 ? ` ${plural(t.stateHeld, s.held.length)}` : '';
    switch (s.state) {
        case 'live': return `${s.lastWrittenAt ? t.stateLive.replace('{time}', new Date(s.lastWrittenAt).toLocaleString()) : t.stateLiveNever}${held}`;
        case 'needs-review': return `${t.stateNeedsReview}${held}`;
        case 'other-device': return t.stateOtherDevice;
        case 'revoking': return t.stateRevoking;
        case 'error': return t.stateError.replace('{reason}', formatGuidance(describeError(plugin.t, s.lastError ?? 'unknown')));
        default: return t.stateOff;
    }
}
