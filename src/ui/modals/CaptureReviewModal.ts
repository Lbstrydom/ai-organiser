/**
 * Review one capture. Three separate consequences, each its own button:
 *   1. Accept text   - adds one labelled section and two properties to the note (nothing else).
 *   2. Create note   - a NEW note in a folder you pick, with a link back. The original is not moved.
 *   3. Run sweep     - the existing inbox sweep, with its own confirmation and review.
 * Machine text (a transcript or text read from an image) must be accepted before 2 and 3 are offered:
 * recognition errors are seen first. There is no task extraction here; the sweep owns tasks.
 */
import { App, ButtonComponent, Modal, Notice } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import type { CaptureController } from '../../services/captureInbox/captureController';
import { getEntry } from '../../services/captureInbox/captureJournal';
import { describeError, formatGuidance } from '../../core/friendlyErrors';
import { listen } from '../utils/domUtils';
import { plural } from '../../utils/plural';
import type { CaptureEntry, CaptureProposal } from '../../services/captureInbox/captureTypes';

const parseTags = (text: string): string[] => text.split(/[,\n]+/).map((t) => t.trim().replace(/^#/, '')).filter(Boolean);

export class CaptureReviewModal extends Modal {
    private cleanups: (() => void)[] = [];
    private edits: { text: string | null; title: string | null; tags: string | null; folder: string | null | undefined } = { text: null, title: null, tags: null, folder: undefined };
    private unsubscribe: (() => void) | null = null;
    private busy = false;

    constructor(app: App, private readonly plugin: AIOrganiserPlugin, private readonly ctl: CaptureController, private readonly id: string) {
        super(app);
    }

    onOpen(): void {
        this.containerEl.addClass('ai-organiser-modal-container');
        this.contentEl.addClass('ai-organiser-capture-review');
        this.unsubscribe = this.ctl.store.subscribe(() => { if (!this.busy) this.draw(); });
        this.draw();
    }

    private entry(): CaptureEntry | undefined {
        return getEntry(this.ctl.store.get(), this.id);
    }

    private run(work: () => Promise<unknown>): void {
        if (this.busy) return;
        this.busy = true;
        void work().finally(() => { this.busy = false; this.draw(); });
    }

    private draw(): void {
        for (const cleanup of this.cleanups) cleanup();
        this.cleanups = [];
        const { contentEl } = this;
        contentEl.empty();
        const t = this.plugin.t.captureInbox;
        const entry = this.entry();
        if (!entry) { this.close(); return; }

        contentEl.createEl('h2', { text: `${t.reviewTitle}: ${entry.companionPath ?? entry.id}`.slice(0, 120) });
        const source = entry.source ? t.sourceLabels[entry.source] : '';
        if (source) contentEl.createEl('p', { text: t.reviewSource.replace('{source}', source), cls: 'ai-organiser-capture-source' });

        const message = contentEl.createDiv({ cls: 'ai-organiser-capture-message', attr: { role: 'status' } });
        if (entry.state === 'failed') {
            const detail = [entry.errorText, entry.attempts > 0 ? plural('{attempts} attempt[s] made.', entry.attempts, 'attempts') : ''].filter(Boolean).join(' ');
            message.setText(t.failedLine.replace('{stage}', entry.failedStage ?? '').replace('{detail}', detail).trim());
            this.button(contentEl, t.rowRetry, () => this.run(() => this.ctl.retry(this.id)));
            this.footer(contentEl);
            return;
        }
        if (entry.state === 'waiting_for_stable' && entry.needsConfirm) {
            contentEl.createEl('p', { text: t.changedBanner, cls: 'ai-organiser-capture-warning' });
            this.button(contentEl, t.processAgain, () => this.run(() => this.ctl.processAgain(this.id)));
            this.footer(contentEl);
            return;
        }
        if (entry.state !== 'awaiting_review' && entry.state !== 'accepted' && entry.state !== 'organised') {
            message.setText(t.stateLabels[entry.state].replace('{stage}', entry.failedStage ?? ''));
            this.footer(contentEl);
            return;
        }

        const accepted = entry.state === 'accepted' || entry.state === 'organised';
        const hasMachineText = !!entry.text && entry.text.trim() !== '';

        // 1. Text
        contentEl.createEl('h3', { text: t.reviewHeadingText });
        if (entry.noteText) {
            contentEl.createEl('label', { text: t.noteTextLabel, attr: { for: 'ai-organiser-capture-note' } });
            const note = contentEl.createEl('textarea', { cls: 'ai-organiser-capture-text', attr: { id: 'ai-organiser-capture-note', readonly: 'true', rows: '4' } });
            note.value = entry.noteText;
        }
        let machine: HTMLTextAreaElement | null = null;
        if (hasMachineText) {
            contentEl.createEl('label', { text: t.machineTextLabel, attr: { for: 'ai-organiser-capture-machine' } });
            machine = contentEl.createEl('textarea', { cls: 'ai-organiser-capture-text', attr: { id: 'ai-organiser-capture-machine', rows: '8' } });
            machine.value = this.edits.text ?? entry.text ?? '';
            if (accepted) machine.setAttribute('readonly', 'true');
            else this.cleanups.push(listen(machine, 'input', () => { this.edits.text = machine?.value ?? null; }));
        }
        const audioCount = (entry.attachments ?? []).filter((a) => a.kind === 'audio').length;
        if (entry.source === 'note-text' && audioCount > 0 && !accepted) {
            contentEl.createEl('p', { text: t.audioNotTranscribed });
            this.button(contentEl, t.transcribeAnyway, () => this.run(() => this.ctl.transcribeAnyway(this.id)));
        }
        const acceptRow = contentEl.createDiv({ cls: 'ai-organiser-capture-actions' });
        const acceptBtn = this.button(acceptRow, t.acceptText, () => this.run(async () => {
            const ok = await this.ctl.accept(this.id, { machineText: this.edits.text ?? undefined, proposal: this.proposal(entry) });
            if (ok) new Notice(t.acceptedNotice, 4000);
        }), true);
        if (accepted) acceptBtn.setDisabled(true);

        // 2. Organise
        // Both later consequences wait for Accept: nothing is written to your note as a side effect of another button.
        const needsAccept = !accepted;
        contentEl.createEl('h3', { text: t.reviewHeadingOrganise });
        const titleInput = this.field(contentEl, t.titleLabel, 'ai-organiser-capture-title', this.edits.title ?? entry.proposal?.title ?? '', (v) => { this.edits.title = v; });
        void titleInput;
        this.field(contentEl, t.tagsLabel, 'ai-organiser-capture-tags', this.edits.tags ?? (entry.proposal?.tags ?? []).join(', '), (v) => { this.edits.tags = v; });
        const folders = this.ctl.folderOptions();
        const currentFolder = this.edits.folder !== undefined ? this.edits.folder : entry.proposal?.folder ?? null;
        contentEl.createEl('label', { text: t.folderLabel, attr: { for: 'ai-organiser-capture-folder' } });
        const select = contentEl.createEl('select', { attr: { id: 'ai-organiser-capture-folder' } });
        select.createEl('option', { text: t.noFolder, attr: { value: '' } });
        // Only folders that are allowed NOW are offered (a stored proposal that has since been kept out is dropped).
        for (const folder of new Set(folders)) {
            const option = select.createEl('option', { text: folder, attr: { value: folder } });
            if (folder === currentFolder) option.selected = true;
        }
        this.cleanups.push(listen(select, 'change', () => { this.edits.folder = select.value === '' ? null : select.value; }));
        const createBtn = this.button(contentEl, t.createNote.replace('{folder}', currentFolder ?? '…'), () => this.run(async () => {
            const path = await this.ctl.organise(this.id, { title: this.edits.title ?? undefined, tags: this.edits.tags === null ? undefined : parseTags(this.edits.tags), folder: this.edits.folder });
            if (path) new Notice(t.organisedNotice.replace('{path}', path), 5000);
        }));
        if (entry.state === 'organised') createBtn.setDisabled(true);
        if (needsAccept) {
            createBtn.setDisabled(true);
            contentEl.createDiv({ cls: 'ai-organiser-capture-reason', text: t.needsAcceptFirst });
        }

        // 3. Tasks (the existing inbox sweep)
        contentEl.createEl('h3', { text: t.reviewHeadingTasks });
        contentEl.createEl('p', { text: t.sweepExplain });
        if (!this.ctl.sweepAvailable()) {
            contentEl.createEl('p', { text: t.sweepOff, cls: 'ai-organiser-capture-reason' });
        } else {
            const sweepCap = Math.max(this.plugin.settings.sweepMaxChars, 20_000);
            if (`${entry.noteText ?? ''}${entry.text ?? ''}`.length > sweepCap) contentEl.createEl('p', { text: t.sweepLongWarning, cls: 'ai-organiser-capture-warning' });
            const sweepBtn = this.button(contentEl, t.runSweep, () => { this.close(); void this.ctl.runSweep(); });
            if (needsAccept) {
                sweepBtn.setDisabled(true);
                contentEl.createDiv({ cls: 'ai-organiser-capture-reason', text: t.needsAcceptFirst });
            }
        }

        this.footer(contentEl, !accepted);
    }

    private proposal(entry: CaptureEntry): CaptureProposal {
        return {
            title: this.edits.title ?? entry.proposal?.title ?? '',
            tags: this.edits.tags === null ? entry.proposal?.tags ?? [] : parseTags(this.edits.tags),
            folder: this.edits.folder !== undefined ? this.edits.folder : entry.proposal?.folder ?? null,
        };
    }

    private field(parent: HTMLElement, label: string, id: string, value: string, onChange: (v: string) => void): HTMLInputElement {
        parent.createEl('label', { text: label, attr: { for: id } });
        const input = parent.createEl('input', { type: 'text', attr: { id } });
        input.value = value;
        this.cleanups.push(listen(input, 'input', () => onChange(input.value)));
        return input;
    }

    private button(parent: HTMLElement, text: string, onClick: () => void, cta = false): ButtonComponent {
        const btn = new ButtonComponent(parent).setButtonText(text).onClick(onClick);
        if (cta) btn.setCta();
        return btn;
    }

    private footer(parent: HTMLElement, showSkip = true): void {
        const t = this.plugin.t.captureInbox;
        const row = parent.createDiv('ai-organiser-modal-buttons');
        if (showSkip) this.button(row, t.skip, () => this.run(async () => { await this.ctl.skip(this.id); new Notice(t.skippedNotice, 3000); this.close(); }));
        this.button(row, t.close, () => this.close());
    }

    onClose(): void {
        this.unsubscribe?.();
        this.unsubscribe = null;
        for (const cleanup of this.cleanups) cleanup();
        this.cleanups = [];
        this.contentEl.empty();
    }
}

/** Show a friendly message for a guidance code. */
export function guidanceMessage(plugin: AIOrganiserPlugin, code: string): string {
    return formatGuidance(describeError(plugin.t, code));
}
