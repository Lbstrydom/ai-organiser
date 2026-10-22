/**
 * Review modal for the inbox sweep. Items are grouped by source note and UNCHECKED by default:
 * nothing is added to the report until the user ticks it. The user can edit the text, change the
 * context and reject. A checkbox per note says whether the note counts as swept. The footer button
 * reads "Add N to sweep report" when N > 0 items are ticked, and "Mark reviewed" when none are (it
 * is enabled only if at least one note is marked swept). Nothing is written before that click.
 */
import { App, Modal } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import { VALID_GTD_CONTEXTS } from '../../services/validators/constants';
import type { NoteProposals } from '../../services/inboxSweep/sweepService';
import type { SweepItem, SweepItemKind } from '../../services/prompts/sweepPrompts';
import type { CommitInput } from '../../services/inboxSweep/sweepCommit';
import { newTaskId } from '../../services/inboxSweep/sweepCommit';
import { listen } from '../utils/domUtils';

interface Row {
    note: NoteProposals;
    item: SweepItem;
    checked: boolean;
    text: string;
    context: string;
}

const PREFIX: Record<SweepItemKind, string> = { next_action: '', waiting_for: 'Waiting: ', project: 'Project: ', someday_maybe: 'Someday: ' };

export class InboxSweepReviewModal extends Modal {
    private cleanups: (() => void)[] = [];
    private rows: Row[];
    /** undefined = follow the items (swept when any of its items is ticked); boolean = the user chose */
    private sweptChoice = new Map<string, boolean>();
    private settled = false;
    private footer!: HTMLElement;

    constructor(app: App, private readonly plugin: AIOrganiserPlugin, private readonly notes: NoteProposals[], private readonly onDone: (result: CommitInput | null) => void) {
        super(app);
        this.containerEl.addClass('ai-organiser-modal-container');
        this.contentEl.addClass('ai-organiser-modal-content');
        this.rows = notes.flatMap((note) => note.items.map((item) => ({ note, item, checked: false, text: item.text, context: item.context })));
    }

    private get t() { return this.plugin.t.inboxSweep; }

    private isSwept(note: NoteProposals): boolean {
        const chosen = this.sweptChoice.get(note.path);
        return chosen ?? this.rows.some((r) => r.note === note && r.checked);
    }

    onOpen(): void {
        const t = this.t;
        this.contentEl.createEl('h3', { text: t.reviewTitle, cls: 'ai-organiser-modal-title' });
        this.contentEl.createEl('p', { text: t.reviewIntro, cls: 'setting-item-description' });
        if (this.notes.length === 0) this.contentEl.createEl('p', { text: t.reviewEmpty });
        for (const note of this.notes) this.renderNote(note);
        this.footer = this.contentEl.createDiv({ cls: 'ai-organiser-modal-buttons' });
        this.renderFooter();
    }

    private renderNote(note: NoteProposals): void {
        const t = this.t;
        const box = this.contentEl.createDiv({ cls: 'ai-organiser-sweep-note' });
        box.createEl('h4', { text: note.path });
        if (note.truncated) box.createEl('p', { text: t.truncatedNote, cls: 'setting-item-description' });
        if (note.dropped > 0) box.createEl('p', { text: t.droppedNote.replace('{count}', String(note.dropped)), cls: 'setting-item-description' });
        if (note.items.length === 0) box.createEl('p', { text: t.noProposals, cls: 'setting-item-description' });

        for (const row of this.rows.filter((r) => r.note === note)) {
            const line = box.createDiv({ cls: 'ai-organiser-sweep-item' });
            const check = line.createEl('input', { type: 'checkbox', attr: { 'aria-label': t.includeItem } });
            check.checked = row.checked;
            this.cleanups.push(listen(check, 'change', () => { row.checked = check.checked; this.renderFooter(); }));
            const text = line.createEl('input', { type: 'text', value: row.text, attr: { 'aria-label': t.itemText } });
            text.addClass('ai-organiser-sweep-text');
            this.cleanups.push(listen(text, 'input', () => { row.text = text.value; this.renderFooter(); }));
            if (row.item.kind === 'next_action') {
                const ctx = line.createEl('select', { attr: { 'aria-label': t.itemContext } });
                for (const c of ['', ...(VALID_GTD_CONTEXTS as readonly string[])]) {
                    const o = ctx.createEl('option', { text: c || t.noContext, value: c });
                    if (c === row.context) o.selected = true;
                }
                this.cleanups.push(listen(ctx, 'change', () => { row.context = ctx.value; }));
            } else {
                line.createSpan({ text: t.kindLabels[row.item.kind], cls: 'setting-item-description' });
            }
            line.createDiv({ text: `“${row.item.evidence}”`, cls: 'setting-item-description ai-organiser-sweep-evidence' });
        }

        const swept = box.createDiv({ cls: 'ai-organiser-sweep-swept' });
        const sweptBox = swept.createEl('input', { type: 'checkbox', attr: { id: `sw-${note.path}` } });
        sweptBox.checked = this.isSwept(note);
        swept.createEl('label', { text: t.markSwept, attr: { for: `sw-${note.path}` } });
        this.cleanups.push(listen(sweptBox, 'change', () => { this.sweptChoice.set(note.path, sweptBox.checked); this.renderFooter(); }));
        // Ticking items updates the follow-the-items default; refresh the box unless the user chose.
        this.cleanups.push(listen(box, 'change', () => { if (!this.sweptChoice.has(note.path)) sweptBox.checked = this.isSwept(note); }));
    }

    private selected(): Row[] {
        return this.rows.filter((r) => r.checked && r.text.trim() !== '');
    }

    private renderFooter(): void {
        const t = this.t;
        this.footer.empty();
        const n = this.selected().length;
        const anySwept = this.notes.some((note) => this.isSwept(note));
        const primary = this.footer.createEl('button', { cls: 'mod-cta', text: n > 0 ? t.addButton.replace('{count}', String(n)) : t.markReviewedButton });
        primary.disabled = n === 0 && !anySwept;
        this.cleanups.push(listen(primary, 'click', () => this.finish()));
        const cancel = this.footer.createEl('button', { text: this.plugin.t.modals.cancel });
        this.cleanups.push(listen(cancel, 'click', () => this.close()));
    }

    private finish(): void {
        const tasks = this.selected().map((r) => ({
            id: newTaskId(),
            text: `${PREFIX[r.item.kind]}${r.text.trim()}${r.item.kind === 'waiting_for' && r.item.waitingOn ? ` (${r.item.waitingOn})` : ''}`,
            context: r.item.kind === 'next_action' ? r.context : '',
            sourcePath: r.note.path,
            sourceHash: r.note.contentHash,
        }));
        const dispositions = this.notes.map((note) => ({ sourcePath: note.path, sourceHash: note.contentHash, markSwept: this.isSwept(note) }));
        this.settled = true;
        this.onDone({ tasks, dispositions });
        this.close();
    }

    onClose(): void {
        for (const cleanup of this.cleanups) cleanup();
        this.cleanups = [];
        this.contentEl.empty();
        if (!this.settled) { this.settled = true; this.onDone(null); }
    }
}
