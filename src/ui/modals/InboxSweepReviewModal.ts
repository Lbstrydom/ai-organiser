/**
 * Review modal for the inbox sweep. Items are grouped by source note and UNCHECKED by default:
 * nothing is added to the report until the user ticks it. The user can edit the text, change the
 * context and reject. A checkbox per note says whether the note counts as swept. The footer button
 * reads "Add N to sweep report" when N > 0 items are ticked, and "Mark reviewed" when none are (it
 * is enabled only if at least one note is marked swept). Nothing is written before that click.
 * "Add a task" on any note adds a row the person wrote themselves: it has no quoted line, starts ticked
 * because adding it is the choice, and goes through the same approval and export as any other row.
 *
 * Quick mode ("Make a Google task" from a note's menu) is the same window with one row the person wrote already in it: no
 * model read the note, so there are no proposals. A note outside the inbox folders offers no swept box and is never marked swept.
 */
import { App, Modal } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import { DEFAULT_SWEEP_CONTEXTS, isDefaultContextSet } from '../../services/inboxSweep/sweepContexts';
import type { NoteProposals } from '../../services/inboxSweep/sweepService';
import type { SweepItem, SweepItemKind } from '../../services/prompts/sweepPrompts';
import type { CommitInput } from '../../services/inboxSweep/sweepCommit';
import { newTaskId } from '../../services/inboxSweep/sweepCommit';
import { itemKeys } from '../../services/inboxSweep/sweepItemIdentity';
import { approvalFields, changeDestination, checkRow, defaultRowRouting, needsDate, type ReviewRouting, type RowRouting } from '../../services/inboxSweep/reviewRouting';
import { isFeatureEnabled } from '../../services/featureService';
import { ConfirmationModal } from './ConfirmationModal';
import { filingFoldersFor } from '../../services/inboxSweep/sweepFiling';
import type { Filing } from '../../services/inboxSweep/sweepLedger';
import { listen } from '../utils/domUtils';
import { plural } from '../../utils/plural';

/** The note's own title, a starting point for a task the person writes. */
const noteTitle = (path: string): string => (path.split('/').pop() ?? path).replace(/\.md$/i, '');

interface Row {
    note: NoteProposals;
    item: SweepItem;
    checked: boolean;
    /** Already added to the sweep report from this note: shown, but cannot be added again */
    reported: boolean;
    /** Looks like an item already added (same line, similar wording): can be added, the user decides */
    similar: boolean;
    text: string;
    context: string;
    /** Destination and date, only when the review offers routing */
    route?: RowRouting;
    /** Written by the person with "Add a task", so it has no quoted line */
    manual?: boolean;
    /** A manual row the person still wants: a date-needed list unticks it until the date is picked, then it comes back */
    wanted?: boolean;
}

/** One task the person is writing from a note's menu, with no model involved. */
export interface QuickTask {
    /** The starting wording: the selected text, or the note's title */
    text: string;
    /** The note is in an inbox folder, so it may be marked as swept */
    allowSwept: boolean;
}

const PREFIX: Record<SweepItemKind, string> = { next_action: '', waiting_for: 'Waiting: ', project: 'Project: ', someday_maybe: 'Someday: ' };

export class InboxSweepReviewModal extends Modal {
    private cleanups: (() => void)[] = [];
    /** The footer is redrawn on every change; its listeners are released with each redraw, not kept until close */
    private footerCleanups: (() => void)[] = [];
    private rows: Row[];
    /** undefined = follow the items (swept when any of its items is ticked); boolean = the user chose */
    private sweptChoice = new Map<string, boolean>();
    /** What to do with each note once its tasks are safe; absent = leave it where it is */
    private filingChoice = new Map<string, Filing>();
    /** The folders a note can be filed into, read once when the window opens */
    private folders: string[] = [];
    private settled = false;
    private footer!: HTMLElement;
    /** The person agreed to drop what they did in this review */
    private leaveConfirmed = false;
    private askingToLeave = false;

    constructor(app: App, private readonly plugin: AIOrganiserPlugin, private readonly notes: NoteProposals[], private readonly onDone: (result: CommitInput | null) => void, private readonly contexts: readonly string[] = DEFAULT_SWEEP_CONTEXTS, private readonly routing: ReviewRouting | null = null, private readonly projectOf: (path: string) => string | null = () => null, private readonly quick: QuickTask | null = null) {
        super(app);
        this.containerEl.addClass('ai-organiser-modal-container');
        this.contentEl.addClass('ai-organiser-modal-content');
        this.rows = notes.flatMap((note) => note.items.map((item, i) => ({ note, item, checked: false, reported: note.reported?.[i] === true, similar: note.similar?.[i] === true, text: item.text, context: item.context, ...(this.routing ? { route: defaultRowRouting(item, this.routing) } : {}) })));
        if (quick && notes[0]) this.rows.push(this.newManualRow(notes[0], quick.text));
    }

    /** The note may be marked as swept: always in a sweep, and in quick mode only for a note in an inbox folder. */
    private get offersSwept(): boolean { return !this.quick || this.quick.allowSwept; }

    private get t() { return this.plugin.t.inboxSweep; }

    private isSwept(note: NoteProposals): boolean {
        if (!this.offersSwept) return false;
        const chosen = this.sweptChoice.get(note.path);
        if (chosen !== undefined) return chosen;
        const rows = this.rows.filter((r) => r.note === note);
        // Nothing new here and something already added: the note has nothing left to offer, so it counts as swept.
        if (rows.length > 0 && rows.every((r) => r.reported)) return true;
        return rows.some((r) => r.checked && !r.reported);
    }

    onOpen(): void {
        const t = this.t;
        try { this.folders = filingFoldersFor(this.plugin); } catch { this.folders = []; }
        this.contentEl.createEl('h3', { text: this.quick ? t.quickTitle : t.reviewTitle, cls: 'ai-organiser-modal-title' });
        this.contentEl.createEl('p', { text: this.quick ? t.quickIntro : t.reviewIntro, cls: 'setting-item-description' });
        if (this.notes.length === 0) this.contentEl.createEl('p', { text: t.reviewEmpty });
        for (const note of this.notes) this.renderNote(note);
        this.footer = this.contentEl.createDiv({ cls: 'ai-organiser-modal-buttons ai-organiser-sweep-footer' });
        this.renderFooter();
    }

    private renderNote(note: NoteProposals): void {
        const t = this.t;
        const box = this.contentEl.createDiv({ cls: 'ai-organiser-sweep-note' });
        box.createEl('h4', { text: note.path });
        if (note.truncated) box.createEl('p', { text: t.truncatedNote, cls: 'setting-item-description' });
        if (note.dropped > 0) box.createEl('p', { text: plural(t.droppedNote, note.dropped), cls: 'setting-item-description' });
        const none = note.items.length === 0 && !this.quick ? box.createEl('p', { text: t.noProposals, cls: 'setting-item-description' }) : null;
        const noteRows = this.rows.filter((r) => r.note === note);
        if (noteRows.length > 0 && noteRows.every((r) => r.reported)) box.createEl('p', { text: t.allAlreadyAdded, cls: 'setting-item-description' });

        const rowsEl = box.createDiv();
        for (const row of noteRows) this.renderRow(rowsEl, row);

        const addTask = box.createDiv({ cls: 'ai-organiser-sweep-add-task' }).createEl('button', { text: t.addTaskButton });
        this.cleanups.push(listen(addTask, 'click', () => {
            none?.remove();
            const row = this.newManualRow(note);
            this.rows.push(row);
            const input = this.renderRow(rowsEl, row);
            input.focus();
            input.select();
            // The note's swept box follows its items, and only a change event inside the note refreshes it.
            box.dispatchEvent(new Event('change'));
            this.renderFooter();
        }));

        if (!this.offersSwept) return;
        const swept = box.createDiv({ cls: 'ai-organiser-sweep-swept' });
        const sweptBox = swept.createEl('input', { type: 'checkbox', attr: { id: `sw-${note.path}` } });
        sweptBox.checked = this.isSwept(note);
        swept.createEl('label', { text: t.markSwept, attr: { for: `sw-${note.path}` } });
        // A swept note is also skipped by the capture inbox, so say so at the moment it applies, whether ticked by hand or by an item.
        const captureHint = isFeatureEnabled(this.plugin.settings, 'capture-inbox')
            ? box.createDiv({ text: t.sweptSkipsCapture, cls: 'setting-item-description ai-organiser-sweep-swept-hint', attr: { role: 'status' } })
            : null;
        captureHint?.toggleClass('ai-organiser-hidden', !sweptBox.checked);
        this.cleanups.push(listen(sweptBox, 'change', () => { this.sweptChoice.set(note.path, sweptBox.checked); this.renderFooter(); }));
        // Ticking items updates the follow-the-items default; refresh the box unless the user chose.
        this.cleanups.push(listen(box, 'change', () => {
            if (!this.sweptChoice.has(note.path)) sweptBox.checked = this.isSwept(note);
            captureHint?.toggleClass('ai-organiser-hidden', !sweptBox.checked);
        }));
        this.renderFiling(box, note);
    }

    /** Then: leave the note, move it into a PARA folder, or put it in the trash, once its tasks are safe. Offered where swept is. */
    private renderFiling(box: HTMLElement, note: NoteProposals): void {
        const t = this.t;
        const field = box.createEl('label', { cls: 'ai-organiser-sweep-field ai-organiser-sweep-filing' });
        field.createSpan({ text: t.thenLabel, cls: 'setting-item-description' });
        const select = field.createEl('select');
        select.createEl('option', { text: t.filingLeave, value: '' });
        for (const folder of this.folders) select.createEl('option', { text: t.filingMoveTo.replace('{folder}', folder), value: 'move:' + folder });
        select.createEl('option', { text: t.filingTrash, value: 'trash' });
        const hint = box.createDiv({ text: t.filingTrashHint, cls: 'setting-item-description ai-organiser-hidden' });
        this.cleanups.push(listen(select, 'change', () => {
            const v = select.value;
            if (v === '') this.filingChoice.delete(note.path);
            else this.filingChoice.set(note.path, v === 'trash' ? { type: 'trash' } : { type: 'move', folder: v.slice(5) });
            hint.toggleClass('ai-organiser-hidden', v !== 'trash');
            this.renderFooter();
        }));
    }

    private newManualRow(note: NoteProposals, text?: string): Row {
        const title = text?.trim() || noteTitle(note.path);
        const item: SweepItem = { kind: 'next_action', text: title, context: '', evidence: '' };
        return { note, item, checked: true, reported: false, similar: false, text: title, context: '', manual: true, wanted: true, ...(this.routing ? { route: defaultRowRouting(item, this.routing) } : {}) };
    }

    /** One item row. Returns its text input. */
    private renderRow(parent: HTMLElement, row: Row): HTMLInputElement {
        const t = this.t;
        const line = parent.createDiv({ cls: 'ai-organiser-sweep-item' });
        const check = line.createEl('input', { type: 'checkbox', attr: { 'aria-label': t.includeItem } });
        check.checked = row.checked;
        check.disabled = row.reported;
        this.cleanups.push(listen(check, 'change', () => { row.checked = check.checked; row.wanted = check.checked; this.renderFooter(); }));
        const text = line.createEl('input', { type: 'text', value: row.text, attr: { 'aria-label': t.itemText } });
        text.addClass('ai-organiser-sweep-text');
        text.disabled = row.reported;
        this.cleanups.push(listen(text, 'input', () => { row.text = text.value; this.renderFooter(); }));
        if (row.item.kind === 'next_action') {
            const ctx = line.createEl('select', { attr: { 'aria-label': t.itemContext } });
            ctx.disabled = row.reported;
            for (const c of ['', ...this.contexts]) {
                const o = ctx.createEl('option', { text: c || t.noContext, value: c });
                if (c === row.context) o.selected = true;
            }
            this.cleanups.push(listen(ctx, 'change', () => { row.context = ctx.value; }));
        } else {
            line.createSpan({ text: t.kindLabels[row.item.kind], cls: 'setting-item-description' });
        }
        if (this.routing && row.route && !row.reported) this.renderRouting(line, row);
        if (row.reported) line.createSpan({ text: t.alreadyAdded, cls: 'setting-item-description ai-organiser-sweep-reported' });
        else if (row.similar) line.createSpan({ text: t.looksAdded, cls: 'setting-item-description ai-organiser-sweep-reported' });
        if (!row.manual) line.createDiv({ text: `“${row.item.evidence}”`, cls: 'setting-item-description ai-organiser-sweep-evidence' });
        return text;
    }

    /** Destination and date, with the reason a row cannot be approved yet beside it. */
    private renderRouting(line: HTMLElement, row: Row): void {
        const t = this.t;
        const routing = this.routing!;
        const box = line.createDiv({ cls: 'ai-organiser-sweep-routing' });
        // A visible name: a bare "Inbox" reads as where the note is, not where the task goes.
        const destField = box.createEl('label', { cls: 'ai-organiser-sweep-field' });
        destField.createSpan({ text: t.destinationLabel, cls: 'setting-item-description' });
        const dest = destField.createEl('select');
        for (const list of routing.lists) {
            const o = dest.createEl('option', { text: list.title || list.id, value: `list:${list.id}` });
            if (row.route!.destination.type === 'list' && row.route!.destination.listId === list.id) o.selected = true;
        }
        const keep = dest.createEl('option', { text: t.destinationReportOnly, value: 'report-only' });
        if (row.route!.destination.type === 'report-only') keep.selected = true;
        const dateField = box.createEl('label', { cls: 'ai-organiser-sweep-field' });
        dateField.createSpan({ text: t.dateLabel, cls: 'setting-item-description' });
        const date = dateField.createEl('input', { type: 'date', value: row.route!.due });
        const from = box.createSpan({ text: t.dateFromText, cls: 'setting-item-description' });
        const hint = box.createDiv({ cls: 'setting-item-description ai-organiser-capture-warning', attr: { role: 'status' } });
        const check = (): HTMLInputElement | null => line.querySelector('input[type="checkbox"]');
        const sync = (): void => {
            const needs = needsDate(row.route!.destination, routing);
            dateField.toggle(needs);
            from.toggle(needs && row.route!.dueFromText && row.route!.due !== '');
            const verdict = checkRow(row.route!, routing);
            hint.setText(verdict.ok ? '' : t.dateNeededHint.replace('{list}', verdict.listTitle));
            const box1 = check();
            // The row cannot be ticked while it is incomplete, and a tick set earlier is taken back.
            if (box1) { box1.disabled = !verdict.ok || row.reported; if (!verdict.ok && box1.checked) { box1.checked = false; row.checked = false; } }
            // A task the person wrote comes back ticked once its date is picked, so it cannot be lost by not re-ticking it.
            if (box1 && row.manual && row.wanted && verdict.ok && !box1.checked) { box1.checked = true; row.checked = true; }
            // The footer does not exist yet while the rows are first drawn.
            if (this.footer) this.renderFooter();
        };
        this.cleanups.push(listen(dest, 'change', () => {
            const value = dest.value;
            row.route = changeDestination(row.route!, value === 'report-only' ? { type: 'report-only' } : { type: 'list', listId: value.slice(5) }, routing, { text: row.text });
            date.value = row.route.due;
            sync();
        }));
        this.cleanups.push(listen(date, 'input', () => { row.route = { ...row.route!, due: date.value, dueFromText: false }; sync(); }));
        sync();
    }

    private selected(): Row[] {
        return this.rows.filter((r) => r.checked && !r.reported && r.text.trim() !== '' && (!this.routing || !r.route || checkRow(r.route, this.routing).ok));
    }

    private renderFooter(): void {
        const t = this.t;
        for (const cleanup of this.footerCleanups) cleanup();
        this.footerCleanups = [];
        this.footer.empty();
        const n = this.selected().length;
        const anySwept = this.notes.some((note) => this.isSwept(note)) || this.filingChoice.size > 0;
        // With nothing ticked the button only saves the choices (swept, Then), in a sweep and in quick mode alike.
        const label = n === 0 ? t.markReviewedButton : this.quick ? plural(t.quickSendButton, n) : t.addButton.replace('{count}', String(n));
        const primary = this.footer.createEl('button', { cls: 'mod-cta', text: label });
        primary.disabled = n === 0 && !anySwept;
        this.footerCleanups.push(listen(primary, 'click', () => this.finish()));
        const cancel = this.footer.createEl('button', { text: this.plugin.t.modals.cancel });
        this.footerCleanups.push(listen(cancel, 'click', () => this.close()));
    }

    /** The project the item's note belongs to, when the project service resolves exactly one (never a guess). */
    private projectFields(path: string): { projectId?: string } {
        const id = this.projectOf(path);
        return id ? { projectId: id } : {};
    }

    private finish(): void {
        const tasks = this.selected().map((r) => ({
            id: newTaskId(),
            text: `${PREFIX[r.item.kind]}${r.text.trim()}${r.item.kind === 'waiting_for' && r.item.waitingOn ? ` (${r.item.waitingOn})` : ''}`,
            context: r.item.kind === 'next_action' ? r.context : '',
            sourcePath: r.note.path,
            sourceHash: r.note.contentHash,
            // A task the person wrote is identified by their final wording only: the suggested title they typed over is not an item.
            keys: r.manual ? itemKeys({ text: r.text.trim(), evidence: '' }) : itemKeys({ text: r.item.text, evidence: r.item.evidence, edited: r.text.trim() }),
            // Routing is stamped only when the review offered it; otherwise the task is exactly what it always was.
            ...(this.routing && r.route ? approvalFields(r.item.kind, r.route, this.routing) : {}),
            ...this.projectFields(r.note.path),
            // Stamped only for a custom set: a record made under the built-in set is exactly what it always was.
            ...(isDefaultContextSet(this.contexts) ? {} : { contexts: [...this.contexts] }),
        }));
        const dispositions = this.notes.map((note) => {
            const filing = this.offersSwept ? this.filingChoice.get(note.path) : undefined;
            // Stamped only when chosen: a note left where it is gives exactly the disposition it always did.
            return { sourcePath: note.path, sourceHash: note.contentHash, markSwept: this.isSwept(note), ...(filing ? { filing } : {}) };
        });
        this.settled = true;
        this.onDone({ tasks, dispositions });
        this.close();
    }

    /** Something here would be lost by closing: a ticked item, a task the person wrote, or a note they chose to mark as swept. */
    private hasWork(): boolean {
        if (this.settled) return false;
        // Quick mode opens with its one row already written: only a change by the person is something to lose.
        const chose = [...this.sweptChoice.values()].some(Boolean) || this.filingChoice.size > 0;
        if (this.quick) return this.rows.length > 1 || this.rows[0]?.text.trim() !== this.rows[0]?.item.text || chose;
        return this.rows.some((r) => r.manual || (r.checked && !r.reported)) || chose;
    }

    /** Every way out comes through here (the X, Esc, a click beside the window, Cancel), so a stray click cannot lose a review. */
    close(): void {
        if (this.leaveConfirmed || !this.hasWork()) { super.close(); return; }
        if (this.askingToLeave) return;
        this.askingToLeave = true;
        const t = this.t;
        const ask = new ConfirmationModal(this.app, t.leaveReviewTitle, t.leaveReviewBody, () => { this.leaveConfirmed = true; this.close(); }, this.plugin);
        const closeAsk = ask.onClose.bind(ask);
        ask.onClose = () => { closeAsk(); this.askingToLeave = false; };
        ask.open();
    }

    onClose(): void {
        for (const cleanup of [...this.cleanups, ...this.footerCleanups]) cleanup();
        this.cleanups = [];
        this.footerCleanups = [];
        this.contentEl.empty();
        if (!this.settled) { this.settled = true; this.onDone(null); }
    }
}
