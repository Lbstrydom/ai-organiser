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
	}
	return { ...mod, Modal: DomModal };
});

import { installObsidianDomShims } from './helpers/obsidianDom';
import { InboxSweepReviewModal } from '../src/ui/modals/InboxSweepReviewModal';
import type { NoteProposals } from '../src/services/inboxSweep/sweepService';
import type { CommitInput } from '../src/services/inboxSweep/sweepCommit';
import { itemKeys } from '../src/services/inboxSweep/sweepLedger';
import { en } from '../src/i18n/en';

beforeAll(() => installObsidianDomShims());

const item = (text: string, evidence: string, kind: 'next_action' | 'waiting_for' = 'next_action') => ({ kind, text, context: '', evidence });
const plugin = { t: en } as never;

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
		expect(primary(el).textContent).not.toBe(en.inboxSweep.addButton.replace('{count}', '1'));
		primary(el).click();
		expect(results[0]?.tasks ?? []).toEqual([]);
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
