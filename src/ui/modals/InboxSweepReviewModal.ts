/**
 * Review modal for the inbox sweep. Items are grouped by source note and UNCHECKED by default:
 * nothing is added to the report until the user ticks it. The user can edit the text, change the
 * context and reject. A checkbox per note says whether the note counts as swept. The footer button
 * reads "Add N to sweep report" when N > 0 items are ticked, and "Mark reviewed" when none are (it
 * is enabled only if at least one note is marked swept). Nothing is written before that click.
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
import { listen } from '../utils/domUtils';
import { plural } from '../../utils/plural';

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
}

const PREFIX: Record<SweepItemKind, string> = { next_action: '', waiting_for: 'Waiting: ', project: 'Project: ', someday_maybe: 'Someday: ' };

export class InboxSweepReviewModal extends Modal {
    private cleanups: (() => void)[] = [];
    /** The footer is redrawn on every change; its listeners are released with each redraw, not kept until close */
    private footerCleanups: (() => void)[] = [];
    private rows: Row[];
    /** undefined = follow the items (swept when any of its items is ticked); boolean = the user chose */
    private sweptChoice = new Map<string, boolean>();
    private settled = false;
    private footer!: HTMLElement;

    constructor(app: App, private readonly plugin: AIOrganiserPlugin, private readonly notes: NoteProposals[], private readonly onDone: (result: CommitInput | null) => void, private readonly contexts: readonly string[] = DEFAULT_SWEEP_CONTEXTS, private readonly routing: ReviewRouting | null = null, private readonly projectOf: (path: string) => string | null = () => null) {
        super(app);
        this.containerEl.addClass('ai-organiser-modal-container');
        this.contentEl.addClass('ai-organiser-modal-content');
        this.rows = notes.flatMap((note) => note.items.map((item, i) => ({ note, item, checked: false, reported: note.reported?.[i] === true, similar: note.similar?.[i] === true, text: item.text, context: item.context, ...(this.routing ? { route: defaultRowRouting(item, this.routing) } : {}) })));
    }

    private get t() { return this.plugin.t.inboxSweep; }

    private isSwept(note: NoteProposals): boolean {
        const chosen = this.sweptChoice.get(note.path);
        if (chosen !== undefined) return chosen;
        const rows = this.rows.filter((r) => r.note === note);
        // Nothing new here and something already added: the note has nothing left to offer, so it counts as swept.
        if (rows.length > 0 && rows.every((r) => r.reported)) return true;
        return rows.some((r) => r.checked && !r.reported);
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
        if (note.dropped > 0) box.createEl('p', { text: plural(t.droppedNote, note.dropped), cls: 'setting-item-description' });
        if (note.items.length === 0) box.createEl('p', { text: t.noProposals, cls: 'setting-item-description' });
        const noteRows = this.rows.filter((r) => r.note === note);
        if (noteRows.length > 0 && noteRows.every((r) => r.reported)) box.createEl('p', { text: t.allAlreadyAdded, cls: 'setting-item-description' });

        for (const row of this.rows.filter((r) => r.note === note)) {
            const line = box.createDiv({ cls: 'ai-organiser-sweep-item' });
            const check = line.createEl('input', { type: 'checkbox', attr: { 'aria-label': t.includeItem } });
            check.checked = row.checked;
            check.disabled = row.reported;
            this.cleanups.push(listen(check, 'change', () => { row.checked = check.checked; this.renderFooter(); }));
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

    /** Destination and date, with the reason a row cannot be approved yet beside it. */
    private renderRouting(line: HTMLElement, row: Row): void {
        const t = this.t;
        const routing = this.routing!;
        const box = line.createDiv({ cls: 'ai-organiser-sweep-routing' });
        const dest = box.createEl('select', { attr: { 'aria-label': t.destinationLabel } });
        for (const list of routing.lists) {
            const o = dest.createEl('option', { text: list.title || list.id, value: `list:${list.id}` });
            if (row.route!.destination.type === 'list' && row.route!.destination.listId === list.id) o.selected = true;
        }
        const keep = dest.createEl('option', { text: t.destinationReportOnly, value: 'report-only' });
        if (row.route!.destination.type === 'report-only') keep.selected = true;
        const date = box.createEl('input', { type: 'date', value: row.route!.due, attr: { 'aria-label': t.dateLabel } });
        const from = box.createSpan({ text: t.dateFromText, cls: 'setting-item-description' });
        const hint = box.createDiv({ cls: 'setting-item-description ai-organiser-capture-warning', attr: { role: 'status' } });
        const check = (): HTMLInputElement | null => line.querySelector('input[type="checkbox"]');
        const sync = (): void => {
            const needs = needsDate(row.route!.destination, routing);
            date.toggle(needs);
            from.toggle(needs && row.route!.dueFromText && row.route!.due !== '');
            const verdict = checkRow(row.route!, routing);
            hint.setText(verdict.ok ? '' : t.dateNeededHint.replace('{list}', verdict.listTitle));
            const box1 = check();
            // The row cannot be ticked while it is incomplete, and a tick set earlier is taken back.
            if (box1) { box1.disabled = !verdict.ok || row.reported; if (!verdict.ok && box1.checked) { box1.checked = false; row.checked = false; } }
            // The footer does not exist yet while the rows are first drawn.
            if (this.footer) this.renderFooter();
        };
        this.cleanups.push(listen(dest, 'change', () => {
            const value = dest.value;
            row.route = changeDestination(row.route!, value === 'report-only' ? { type: 'report-only' } : { type: 'list', listId: value.slice(5) }, routing);
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
        const anySwept = this.notes.some((note) => this.isSwept(note));
        const primary = this.footer.createEl('button', { cls: 'mod-cta', text: n > 0 ? t.addButton.replace('{count}', String(n)) : t.markReviewedButton });
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
            keys: itemKeys({ text: r.item.text, evidence: r.item.evidence, edited: r.text.trim() }),
            // Routing is stamped only when the review offered it; otherwise the task is exactly what it always was.
            ...(this.routing && r.route ? approvalFields(r.item.kind, r.route, this.routing) : {}),
            ...this.projectFields(r.note.path),
            // Stamped only for a custom set: a record made under the built-in set is exactly what it always was.
            ...(isDefaultContextSet(this.contexts) ? {} : { contexts: [...this.contexts] }),
        }));
        const dispositions = this.notes.map((note) => ({ sourcePath: note.path, sourceHash: note.contentHash, markSwept: this.isSwept(note) }));
        this.settled = true;
        this.onDone({ tasks, dispositions });
        this.close();
    }

    onClose(): void {
        for (const cleanup of [...this.cleanups, ...this.footerCleanups]) cleanup();
        this.cleanups = [];
        this.footerCleanups = [];
        this.contentEl.empty();
        if (!this.settled) { this.settled = true; this.onDone(null); }
    }
}
