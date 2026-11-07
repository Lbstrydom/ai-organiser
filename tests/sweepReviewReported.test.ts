// @vitest-environment happy-dom
/**
 * The sweep review shows items already added to the sweep report, but they cannot be added again; a note
 * with nothing new defaults to "swept"; ticking a new item passes its identity keys to the commit.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';

vi.mock('obsidian', async () => {
	const mod = await import('./mocks/obsidian');
	class DomModal {
		contentEl = document.createElement('div');
		containerEl = document.createElement('div');
		constructor(public app: unknown) {}
		open(): void { (this as unknown as { onOpen(): void }).onOpen(); }
		close(): void { (this as unknown as { onClose(): void }).onClose(); }
		onOpen(): void { /* a modal with nothing to set up */ }
		onClose(): void { /* a modal with nothing to clean up */ }
	}
	class DomButton {
		buttonEl: HTMLButtonElement;
		constructor(parent: HTMLElement) { this.buttonEl = parent.appendChild(document.createElement('button')); }
		setButtonText(text: string): this { this.buttonEl.textContent = text; return this; }
		setCta(): this { return this; }
		onClick(fn: () => void): this { this.buttonEl.addEventListener('click', fn); return this; }
	}
	return { ...mod, Modal: DomModal, ButtonComponent: DomButton };
});

import { Modal } from 'obsidian';
import { installObsidianDomShims } from './helpers/obsidianDom';
import { InboxSweepReviewModal } from '../src/ui/modals/InboxSweepReviewModal';
import type { NoteProposals } from '../src/services/inboxSweep/sweepService';
import type { CommitInput } from '../src/services/inboxSweep/sweepCommit';
import { dropAlreadyReported, itemKeys } from '../src/services/inboxSweep/sweepItemIdentity';
import { en } from '../src/i18n/en';

beforeAll(() => installObsidianDomShims());

const item = (text: string, evidence: string, kind: 'next_action' | 'waiting_for' = 'next_action') => ({ kind, text, context: '', evidence });
const plugin = { t: en, settings: {} } as never;

function open(notes: NoteProposals[]) {
	const results: Array<CommitInput | null> = [];
	const modal = new InboxSweepReviewModal({} as never, plugin, notes, (r) => results.push(r));
	modal.open();
	const el = (modal as unknown as { contentEl: HTMLElement }).contentEl;
	return { modal, el, results };
}

const checkboxes = (el: HTMLElement) => Array.from(el.querySelectorAll<HTMLInputElement>('.ai-organiser-sweep-item input[type="checkbox"]'));
const primary = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('button.mod-cta')!;

describe('InboxSweepReviewModal with items already reported', () => {
	const mixed: NoteProposals = {
		path: 'Inbox/a.md', contentHash: 'h2', dropped: 0, truncated: false,
		items: [item('Draft the migration plan', 'I need to draft the migration plan'), item('Call Dana', 'Dana to confirm the room')],
		reported: [true, false],
	};

	it('shows a reported item disabled with the explanation, and a new item as before', () => {
		const { el } = open([mixed]);
		const boxes = checkboxes(el);
		expect(boxes.map((b) => b.disabled)).toEqual([true, false]);
		const rows = Array.from(el.querySelectorAll('.ai-organiser-sweep-item'));
		expect(rows[0].textContent).toContain(en.inboxSweep.alreadyAdded);
		expect(rows[1].textContent).not.toContain(en.inboxSweep.alreadyAdded);
		expect((rows[0].querySelector('input[type="text"]') as HTMLInputElement).disabled).toBe(true);
		expect((rows[0].querySelector('select') as HTMLSelectElement).disabled).toBe(true);
		expect((rows[1].querySelector('select') as HTMLSelectElement).disabled).toBe(false);
	});

	it('an item that only looks like one already added is shown with a note but can still be added', () => {
		const similar: NoteProposals = { ...mixed, items: [mixed.items[1]], reported: [false], similar: [true] };
		const { el, results } = open([similar]);
		const box = checkboxes(el)[0];
		expect(box.disabled).toBe(false);
		expect(el.textContent).toContain(en.inboxSweep.looksAdded);
		expect(el.textContent).not.toContain(en.inboxSweep.alreadyAdded);
		box.checked = true;
		box.dispatchEvent(new Event('change', { bubbles: true }));
		primary(el).click();
		expect(results[0]!.tasks.map((t) => t.text)).toEqual(['Call Dana']);
	});

	it('only the new item counts: ticking it gives "Add 1" and passes keys for it alone', () => {
		const { el, results } = open([mixed]);
		const boxes = checkboxes(el);
		boxes[0].click(); // disabled: ignored
		boxes[1].checked = true;
		boxes[1].dispatchEvent(new Event('change', { bubbles: true }));
		expect(primary(el).textContent).toBe(en.inboxSweep.addButton.replace('{count}', '1'));
		primary(el).click();
		const done = results[0]!;
		expect(done.tasks).toHaveLength(1);
		expect(done.tasks[0].text).toBe('Call Dana');
		expect(done.tasks[0].keys).toEqual(itemKeys({ text: 'Call Dana', evidence: 'Dana to confirm the room', edited: 'Call Dana' }));
	});

	it('a force-ticked reported checkbox still adds nothing', () => {
		const { el, results } = open([mixed]);
		const boxes = checkboxes(el);
		boxes[0].checked = true; // bypassing the disabled state
		boxes[0].dispatchEvent(new Event('change', { bubbles: true }));
		// Alone it adds nothing: the button stays a disabled "Mark reviewed".
		expect(primary(el).disabled).toBe(true);
		expect(primary(el).textContent).toBe(en.inboxSweep.markReviewedButton);
		// With the new item also ticked, only the new item is submitted.
		boxes[1].checked = true;
		boxes[1].dispatchEvent(new Event('change', { bubbles: true }));
		expect(primary(el).textContent).toBe(en.inboxSweep.addButton.replace('{count}', '1'));
		primary(el).click();
		expect(results).toHaveLength(1);
		expect(results[0]!.tasks.map((t) => t.text)).toEqual(['Call Dana']);
	});

	it('a note whose items are all already added says so and defaults to swept, so it stops coming back', () => {
		const allDone: NoteProposals = { ...mixed, items: [mixed.items[0]], reported: [true] };
		const { el, results } = open([allDone]);
		expect(el.textContent).toContain(en.inboxSweep.allAlreadyAdded);
		const swept = el.querySelector<HTMLInputElement>('.ai-organiser-sweep-swept input')!;
		expect(swept.checked).toBe(true);
		expect(primary(el).disabled).toBe(false);
		primary(el).click();
		expect(results[0]).toEqual({ tasks: [], dispositions: [{ sourcePath: 'Inbox/a.md', sourceHash: 'h2', markSwept: true }] });
	});

	it('notes without the flag behave exactly as before (nothing disabled, default swept follows the items)', () => {
		const plain: NoteProposals = { path: 'Inbox/p.md', contentHash: 'hp', dropped: 0, truncated: false, items: [item('One', 'one')] };
		const { el } = open([plain]);
		expect(checkboxes(el).map((b) => b.disabled)).toEqual([false]);
		expect(el.querySelector<HTMLInputElement>('.ai-organiser-sweep-swept input')!.checked).toBe(false);
		expect(el.textContent).not.toContain(en.inboxSweep.alreadyAdded);
	});
});

describe('InboxSweepReviewModal labels and the capture warning', () => {
	const note: NoteProposals = { path: 'Inbox/b.md', contentHash: 'h', dropped: 0, truncated: false, items: [item('Call Dana', 'Call Dana')] };
	const routing = {
		mainId: 'main',
		lists: [{ id: 'main', title: 'Inbox', needsDate: false }, { id: 'dated', title: 'Waiting', needsDate: true }],
		rules: [],
	};
	const openWith = (captureOn: boolean, withRouting = false) => {
		const host = { t: en, settings: { featureFlags: { 'capture-inbox': captureOn } } } as never;
		const modal = new InboxSweepReviewModal({} as never, host, [note], () => undefined, undefined, withRouting ? routing : null);
		modal.open();
		return (modal as unknown as { contentEl: HTMLElement }).contentEl;
	};
	const hint = (el: HTMLElement) => el.querySelector('.ai-organiser-sweep-swept-hint');
	const tick = (box: HTMLInputElement, on: boolean) => { box.checked = on; box.dispatchEvent(new Event('change', { bubbles: true })); };

	it('names the destination and date beside their controls, so a list name is not read as the note folder', () => {
		const el = openWith(false, true);
		const fields = Array.from(el.querySelectorAll('label.ai-organiser-sweep-field'));
		expect(fields[0].textContent).toContain(en.inboxSweep.destinationLabel);
		expect(fields[0].querySelector('select')).not.toBeNull();
		expect(fields[1].textContent).toContain(en.inboxSweep.dateLabel);
		expect(fields[1].querySelector('input[type="date"]')).not.toBeNull();
	});

	it('hides the date label with the date when the list needs no date', () => {
		const el = openWith(false, true);
		const dateField = el.querySelectorAll<HTMLElement>('label.ai-organiser-sweep-field')[1];
		expect(dateField.style.display).toBe('none');
		const select = el.querySelector<HTMLSelectElement>('label.ai-organiser-sweep-field select')!;
		select.value = 'list:dated';
		select.dispatchEvent(new Event('change', { bubbles: true }));
		expect(dateField.style.display).not.toBe('none');
	});

	it('warns only while the note is swept, by hand or by ticking an item', () => {
		const el = openWith(true);
		expect(hint(el)?.classList.contains('ai-organiser-hidden')).toBe(true);
		tick(checkboxes(el)[0], true);
		expect(hint(el)?.classList.contains('ai-organiser-hidden')).toBe(false);
		tick(checkboxes(el)[0], false);
		expect(hint(el)?.classList.contains('ai-organiser-hidden')).toBe(true);
		const swept = el.querySelector<HTMLInputElement>('.ai-organiser-sweep-swept input')!;
		tick(swept, true);
		expect(hint(el)?.classList.contains('ai-organiser-hidden')).toBe(false);
	});

	it('shows no warning when the capture inbox is off', () => {
		const el = openWith(false);
		tick(checkboxes(el)[0], true);
		expect(hint(el)).toBeNull();
	});
});

describe('InboxSweepReviewModal: a task the person writes', () => {
	const empty: NoteProposals = { path: '0 Inbox/Block mining indaba travel.md', contentHash: 'hash1', dropped: 0, truncated: false, items: [] };
	const routing = {
		mainId: 'main',
		lists: [{ id: 'main', title: 'Inbox', needsDate: false }, { id: 'dated', title: 'Waiting', needsDate: true }],
		rules: [],
	};
	const openIt = (withRouting = false) => {
		const results: Array<CommitInput | null> = [];
		const modal = new InboxSweepReviewModal({} as never, plugin, [empty], (r) => results.push(r), undefined, withRouting ? routing : null);
		modal.open();
		return { el: (modal as unknown as { contentEl: HTMLElement }).contentEl, results };
	};
	const addTask = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('.ai-organiser-sweep-add-task button')!;

	it('changes nothing until the button is used: no rows, nothing to add', () => {
		const { el, results } = openIt();
		expect(checkboxes(el)).toHaveLength(0);
		expect(primary(el).textContent).toBe(en.inboxSweep.markReviewedButton);
		expect(primary(el).disabled).toBe(true);
		expect(results).toHaveLength(0);
	});

	it('adds a ticked row with the note title, no quote, and replaces the nothing-found line', () => {
		const { el } = openIt();
		expect(el.textContent).toContain(en.inboxSweep.noProposals);
		addTask(el).click();
		expect(el.textContent).not.toContain(en.inboxSweep.noProposals);
		expect(checkboxes(el)[0].checked).toBe(true);
		expect(el.querySelector<HTMLInputElement>('.ai-organiser-sweep-text')!.value).toBe('Block mining indaba travel');
		expect(el.querySelector('.ai-organiser-sweep-evidence')).toBeNull();
		expect(primary(el).textContent).toBe(en.inboxSweep.addButton.replace('{count}', '1'));
		expect(el.querySelector<HTMLInputElement>('.ai-organiser-sweep-swept input')!.checked).toBe(true);
	});

	it('commits the edited wording as the identity, not the suggested title', () => {
		const { el, results } = openIt();
		addTask(el).click();
		const text = el.querySelector<HTMLInputElement>('.ai-organiser-sweep-text')!;
		text.value = 'Book indaba flights';
		text.dispatchEvent(new Event('input', { bubbles: true }));
		primary(el).click();
		const task = results[0]!.tasks[0];
		expect(task.text).toBe('Book indaba flights');
		expect(task.sourcePath).toBe(empty.path);
		expect(task.sourceHash).toBe('hash1');
		expect(task.keys).toEqual(itemKeys({ text: 'Book indaba flights', evidence: '' }));
	});

	it('is not added when unticked', () => {
		const { el, results } = openIt();
		addTask(el).click();
		const box = checkboxes(el)[0];
		box.checked = false;
		box.dispatchEvent(new Event('change', { bubbles: true }));
		expect(primary(el).textContent).toBe(en.inboxSweep.markReviewedButton);
		// Nothing is ticked and the note follows its items, so mark it swept to be able to finish the review.
		const swept = el.querySelector<HTMLInputElement>('.ai-organiser-sweep-swept input')!;
		swept.checked = true;
		swept.dispatchEvent(new Event('change', { bubbles: true }));
		primary(el).click();
		expect(results[0]!.tasks).toHaveLength(0);
	});

	it('is not added when left blank', () => {
		const { el, results } = openIt();
		addTask(el).click();
		const text = el.querySelector<HTMLInputElement>('.ai-organiser-sweep-text')!;
		text.value = '   ';
		text.dispatchEvent(new Event('input', { bubbles: true }));
		primary(el).click();
		expect(results[0]!.tasks).toHaveLength(0);
	});

	it('on a dated list waits for the date, then comes back ticked with list and date in the approval', () => {
		const { el, results } = openIt(true);
		addTask(el).click();
		const box = checkboxes(el)[0];
		const dest = el.querySelector<HTMLSelectElement>('label.ai-organiser-sweep-field select')!;
		dest.value = 'list:dated';
		dest.dispatchEvent(new Event('change', { bubbles: true }));
		expect(box.checked).toBe(false);
		expect(box.disabled).toBe(true);
		const date = el.querySelector<HTMLInputElement>('input[type="date"]')!;
		date.value = '2026-11-09';
		date.dispatchEvent(new Event('input', { bubbles: true }));
		expect(box.checked).toBe(true);
		primary(el).click();
		expect(results[0]!.tasks[0]).toMatchObject({ destination: { type: 'list', listId: 'dated' }, due: '2026-11-09', kind: 'next_action' });
	});

	it('stays unticked after a date if the person unticked it', () => {
		const { el } = openIt(true);
		addTask(el).click();
		const box = checkboxes(el)[0];
		box.checked = false;
		box.dispatchEvent(new Event('change', { bubbles: true }));
		const dest = el.querySelector<HTMLSelectElement>('label.ai-organiser-sweep-field select')!;
		dest.value = 'list:dated';
		dest.dispatchEvent(new Event('change', { bubbles: true }));
		const date = el.querySelector<HTMLInputElement>('input[type="date"]')!;
		date.value = '2026-11-09';
		date.dispatchEvent(new Event('input', { bubbles: true }));
		expect(box.checked).toBe(false);
	});

	it('the same wording twice in one review is dropped by the commit rule', () => {
		const { el, results } = openIt();
		addTask(el).click();
		addTask(el).click();
		expect(checkboxes(el)).toHaveLength(2);
		primary(el).click();
		const tasks = results[0]!.tasks;
		expect(dropAlreadyReported(tasks, {}, []).kept).toHaveLength(1);
	});
});

describe('InboxSweepReviewModal leaving with work in it', () => {
	const note: NoteProposals = { path: 'Inbox/c.md', contentHash: 'h', dropped: 0, truncated: false, items: [item('Call Dana', 'Call Dana')] };
	const tick = (box: HTMLInputElement, on: boolean) => { box.checked = on; box.dispatchEvent(new Event('change', { bubbles: true })); };
	const closing = (modal: InboxSweepReviewModal) => {
		const spy = vi.spyOn(Modal.prototype as unknown as { open(): void }, 'open');
		modal.close();
		const shown = spy.mock.contexts.at(-1) as { contentEl: HTMLElement } | undefined;
		spy.mockRestore();
		return shown ?? null;
	};
	const button = (el: HTMLElement, label: string) => Array.from(el.querySelectorAll('button')).find((b) => b.textContent === label)!;

	it('closes at once when nothing was done', () => {
		const { modal, results } = open([note]);
		expect(closing(modal)).toBeNull();
		expect(results).toEqual([null]);
	});

	it('asks first when an item is ticked; going back keeps the review, confirming drops it', () => {
		const { modal, el, results } = open([note]);
		tick(checkboxes(el)[0], true);
		const ask = closing(modal);
		expect(ask).not.toBeNull();
		expect(ask!.contentEl.textContent).toContain(en.inboxSweep.leaveReviewBody);
		expect(results).toEqual([]);
		// A second stray click while asking does not stack a second question.
		expect(closing(modal)).toBeNull();
		button(ask!.contentEl, en.modals.cancel).click();
		expect(results).toEqual([]);
		expect(checkboxes(el)[0].checked).toBe(true);
		const again = closing(modal);
		expect(again).not.toBeNull();
		button(again!.contentEl, en.modals.confirm).click();
		expect(results).toEqual([null]);
	});

	it('asks first for a task the person wrote, or a note they marked as swept', () => {
		const a = open([note]);
		a.el.querySelector<HTMLButtonElement>('.ai-organiser-sweep-add-task button')!.click();
		expect(closing(a.modal)).not.toBeNull();
		const b = open([note]);
		tick(b.el.querySelector<HTMLInputElement>('.ai-organiser-sweep-swept input')!, true);
		expect(closing(b.modal)).not.toBeNull();
	});

	it('does not ask after adding', () => {
		const { el, results } = open([note]);
		tick(checkboxes(el)[0], true);
		const spy = vi.spyOn(Modal.prototype as unknown as { open(): void }, 'open');
		primary(el).click();
		expect(spy).not.toHaveBeenCalled();
		spy.mockRestore();
		expect(results[0]!.tasks).toHaveLength(1);
	});

	it('keeps the add button in a footer that stays in view', () => {
		const { el } = open([note]);
		expect(el.querySelector('.ai-organiser-sweep-footer button.mod-cta')).not.toBeNull();
	});
});

describe('InboxSweepReviewModal quick mode (Make a Google task)', () => {
	const note: NoteProposals = { path: 'Projects/Q4 plan.md', contentHash: 'hq', dropped: 0, truncated: false, items: [] };
	const routing = {
		mainId: 'main',
		lists: [{ id: 'main', title: 'Inbox', needsDate: false }, { id: 'dated', title: 'Waiting', needsDate: true }],
		rules: [],
	};
	const openQuick = (text: string, allowSwept: boolean, withRouting = false) => {
		const results: Array<CommitInput | null> = [];
		const modal = new InboxSweepReviewModal({} as never, plugin, [note], (r) => results.push(r), undefined, withRouting ? routing : null, undefined, { text, allowSwept });
		modal.open();
		return { modal, el: (modal as unknown as { contentEl: HTMLElement }).contentEl, results };
	};
	const closing = (modal: InboxSweepReviewModal) => {
		const spy = vi.spyOn(Modal.prototype as unknown as { open(): void }, 'open');
		modal.close();
		const shown = spy.mock.contexts.at(-1);
		spy.mockRestore();
		return shown ?? null;
	};

	it('opens with one ticked row, the quick title and the send label; no nothing-found line', () => {
		const { el } = openQuick('Book the venue', false);
		expect(el.querySelector('h3')!.textContent).toBe(en.inboxSweep.quickTitle);
		const texts = Array.from(el.querySelectorAll<HTMLInputElement>('.ai-organiser-sweep-item input[type="text"]'));
		expect(texts.map((t) => t.value)).toEqual(['Book the venue']);
		expect(checkboxes(el)[0].checked).toBe(true);
		expect(primary(el).textContent).toBe('Send 1 task to Google Tasks');
		expect(el.textContent).not.toContain(en.inboxSweep.noProposals);
	});

	it('uses the note title when no text was selected', () => {
		const { el } = openQuick('', false);
		expect(el.querySelector<HTMLInputElement>('.ai-organiser-sweep-item input[type="text"]')!.value).toBe('Q4 plan');
	});

	it('outside the inbox: no swept box, and the note is never marked swept', () => {
		const { el, results } = openQuick('Book the venue', false);
		expect(el.querySelector('.ai-organiser-sweep-swept')).toBeNull();
		primary(el).click();
		expect(results[0]!.tasks).toHaveLength(1);
		expect(results[0]!.dispositions).toEqual([{ sourcePath: note.path, sourceHash: 'hq', markSwept: false }]);
	});

	it('in the inbox: the swept box is offered and follows the tick as in a sweep', () => {
		const { el, results } = openQuick('Book the venue', true);
		expect(el.querySelector<HTMLInputElement>('.ai-organiser-sweep-swept input')!.checked).toBe(true);
		primary(el).click();
		expect(results[0]!.dispositions[0].markSwept).toBe(true);
	});

	it('closes without asking until the person changes something', () => {
		const a = openQuick('Book the venue', false);
		expect(closing(a.modal)).toBeNull();
		expect(a.results).toEqual([null]);
		const b = openQuick('Book the venue', false);
		const text = b.el.querySelector<HTMLInputElement>('.ai-organiser-sweep-item input[type="text"]')!;
		text.value = 'Book the venue for 40';
		text.dispatchEvent(new Event('input', { bubbles: true }));
		expect(closing(b.modal)).not.toBeNull();
	});

	it('a dated list takes the date written in the selected text', () => {
		const { el, results } = openQuick('Chase the signed contract by 2026-11-20', false, true);
		const dest = el.querySelector<HTMLSelectElement>('label.ai-organiser-sweep-field select')!;
		dest.value = 'list:dated';
		dest.dispatchEvent(new Event('change', { bubbles: true }));
		expect(el.querySelector<HTMLInputElement>('input[type="date"]')!.value).toBe('2026-11-20');
		expect(checkboxes(el)[0].checked).toBe(true);
		primary(el).click();
		expect(results[0]!.tasks[0]).toMatchObject({ destination: { type: 'list', listId: 'dated' }, due: '2026-11-20' });
	});
});
