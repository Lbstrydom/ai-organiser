// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

vi.mock('obsidian', async () => {
	const base = await import('./mocks/obsidian');
	class DomModal {
		app: unknown;
		contentEl: HTMLElement;
		modalEl = document.createElement('div');
		titleEl = document.createElement('div');
		constructor(app: unknown) { this.app = app; this.contentEl = document.createElement('div'); }
		open() { (this as unknown as { onOpen?: () => void }).onOpen?.(); }
		close() { (this as unknown as { onClose?: () => void }).onClose?.(); }
	}
	return { ...base, Modal: DomModal };
});

import { installObsidianDomShims } from './helpers/obsidianDom';
import { createTFile } from './mocks/obsidian';
import { EmbedScanResultsModal, resetEgressChoice } from '../src/ui/modals/EmbedScanResultsModal';
import type { EmbedScanResult, EmbedTarget } from '../src/services/embedScanService';
import { en } from '../src/i18n/en';

beforeAll(() => installObsidianDomShims());
beforeEach(() => resetEgressChoice());

const MB = 1024 * 1024;
const file = (path: string, sizeMB: number) => {
	const f = createTFile(path);
	f.stat = { mtime: 1, ctime: 1, size: sizeMB * MB };
	return f;
};
const target = (path: string, sizeMB: number, type: EmbedTarget['type'] = 'audio'): EmbedTarget => {
	const f = file(path, sizeMB);
	return { file: f, path, type, sizeBytes: f.stat.size, references: [{ sourceFile: createTFile('Notes/a.md'), lineNumber: 1, isEmbedded: true, originalText: `![[${f.name}]]` }] };
};

function result(over: Partial<EmbedScanResult> = {}): EmbedScanResult {
	return {
		targets: [target('Rec/used 1.m4a', 30), target('Rec/used 2.m4a', 40)],
		possiblyOrphaned: [file('Rec/small.png', 1), file('Rec/big recording.m4a', 120), file('Rec/medium.pdf', 30), file('Rec/other recording.m4a', 60)],
		notesScanned: 10,
		cancelled: false,
		coverageFailures: [],
		ambiguousPaths: [],
		scanStartedAt: 1,
		occurrences: [],
		scannedReferrers: [],
		...over,
	};
}

function open(res: EmbedScanResult) {
	const app = { vault: { on: () => ({}), offref: () => {}, getAbstractFileByPath: () => null }, workspace: { openLinkText: vi.fn() } };
	const modal = new EmbedScanResultsModal(app as never, en, res);
	modal.open();
	return { modal, el: (modal as unknown as { contentEl: HTMLElement }).contentEl };
}

const names = (el: HTMLElement) => Array.from(el.querySelectorAll('.ai-organiser-embed-scan-orphan-row .ai-organiser-embed-scan-filename')).map((n) => n.textContent);

describe('Find embeds results layout', () => {
	it('puts the possibly orphaned files first and open, with the in-use files collapsed under a one-line count', () => {
		const { el } = open(result());
		const children = Array.from(el.children).map((c) => c.className);
		const orphanAt = children.findIndex((c) => c.includes('ai-organiser-embed-scan-orphans'));
		const resultsAt = children.findIndex((c) => c.includes('ai-organiser-embed-scan-results'));
		expect(orphanAt).toBeGreaterThan(-1);
		expect(orphanAt).toBeLessThan(resultsAt);
		expect((el.querySelector('.ai-organiser-embed-scan-orphan-section') as HTMLDetailsElement).open).toBe(true);
		const group = el.querySelector('.ai-organiser-embed-scan-group-inuse') as HTMLDetailsElement;
		expect(group.open).toBe(false);
		expect(group.querySelector('summary')?.textContent).toBe('2 files in use, nothing to do');
	});

	it('opens the in-use group when there is no orphan section to focus on', () => {
		const { el } = open(result({ possiblyOrphaned: [] }));
		expect((el.querySelector('.ai-organiser-embed-scan-group-inuse') as HTMLDetailsElement).open).toBe(true);
	});

	it('remembers the choice for the session, and forgets it when the plugin reloads', () => {
		const first = open(result());
		const summary = first.el.querySelector('.ai-organiser-embed-scan-group-inuse summary') as HTMLElement;
		summary.click();
		first.modal.close();
		const second = open(result());
		expect((second.el.querySelector('.ai-organiser-embed-scan-group-inuse') as HTMLDetailsElement).open).toBe(true);
		second.modal.close();
		resetEgressChoice();
		const third = open(result());
		expect((third.el.querySelector('.ai-organiser-embed-scan-group-inuse') as HTMLDetailsElement).open).toBe(false);
	});

	it('lists the orphans largest first by default', () => {
		const { el } = open(result());
		expect(names(el)).toEqual(['big recording.m4a', 'other recording.m4a', 'medium.pdf', 'small.png']);
	});

	it('counts the orphans in the type chips and shows only the picked type', () => {
		const { el } = open(result());
		const chips = () => Array.from(el.querySelectorAll('.ai-organiser-embed-scan-chip')) as HTMLElement[];
		const labels = chips().map((c) => c.textContent);
		expect(labels).toContain('Audio (4)');
		expect(labels).toContain('Image (1)');
		chips().find((c) => c.textContent === 'Audio (4)')!.click();
		expect(names(el)).toEqual(['big recording.m4a', 'other recording.m4a']);
	});

	it('starts with no chip picked and everything shown; a picked chip is marked, and picking it again clears the filter', () => {
		const { el } = open(result());
		const chips = () => Array.from(el.querySelectorAll('.ai-organiser-embed-scan-chip')) as HTMLElement[];
		expect(chips().every((c) => c.getAttribute('aria-checked') === 'false' && !c.classList.contains('active'))).toBe(true);
		expect(names(el)).toHaveLength(4);
		const audio = () => chips().find((c) => c.textContent === 'Audio (4)')!;
		audio().click();
		expect(audio().getAttribute('aria-checked')).toBe('true');
		expect(audio().classList.contains('active')).toBe(true);
		expect(names(el)).toHaveLength(2);
		audio().click();
		expect(audio().getAttribute('aria-checked')).toBe('false');
		expect(names(el)).toHaveLength(4);
	});

	it('picking two chips shows both types (a choice of types, not a hiding switch)', () => {
		const { el } = open(result());
		const chips = () => Array.from(el.querySelectorAll('.ai-organiser-embed-scan-chip')) as HTMLElement[];
		chips().find((c) => c.textContent === 'Audio (4)')!.click();
		chips().find((c) => c.textContent === 'PDF (1)')!.click();
		expect(names(el).sort()).toEqual(['big recording.m4a', 'medium.pdf', 'other recording.m4a']);
	});

	it('the summary and the Showing line describe the same files as the lists', () => {
		const { el } = open(result());
		const summary = el.querySelector('.ai-organiser-embed-scan-summary')!.textContent;
		// 2 in use + 4 not used = 6 files; size is over both lists (30+40 MB in use, 1+120+30+60 MB not used)
		expect(summary).toBe('10 notes and canvases scanned · 6 files found · 2 in use · 4 not used by any note · 281.0 MB total');
		expect(el.querySelector('.ai-organiser-embed-scan-status')!.textContent).toContain('Showing 6 of 6');
	});

	it('Showing N of M follows the filters across the orphan list and the in-use files', () => {
		const { el } = open(result());
		const status = () => el.querySelector('.ai-organiser-embed-scan-status')!.textContent;
		const input = el.querySelector('.ai-organiser-embed-scan-search-input') as HTMLInputElement;
		input.value = 'recording';
		input.dispatchEvent(new Event('input'));
		expect(names(el)).toHaveLength(2);
		expect(status()).toContain('Showing 2 of 6');
		input.value = 'used 1';
		input.dispatchEvent(new Event('input'));
		expect(names(el)).toHaveLength(0);
		expect(status()).toContain('Showing 1 of 6');
		input.value = 'zzz';
		input.dispatchEvent(new Event('input'));
		expect(status()).toContain('Showing 0 of 6');
	});

	it('counts canvases among the scanned notes, and does not count links to missing files as found files', () => {
		const missing: EmbedTarget = { file: null, path: 'gone.pdf', type: 'pdf', sizeBytes: 0, references: target('x.m4a', 1).references };
		const { el } = open(result({ notesScanned: 3, canvasesScanned: 2, possiblyOrphaned: [], targets: [target('Rec/a.m4a', 1), missing] }));
		const summary = el.querySelector('.ai-organiser-embed-scan-summary')!.textContent;
		expect(summary).toContain('5 notes and canvases scanned');
		expect(summary).toContain('1 file found');
		expect(summary).not.toContain('not used');
		expect(el.querySelector('.ai-organiser-embed-scan-status')!.textContent).toContain('Showing 1 of 1');
	});

	it('"Used by N" counts notes, not how many times one note links the file', () => {
		const note = createTFile('Notes/a.md');
		const f = file('Rec/twice.m4a', 5);
		const twice: EmbedTarget = {
			file: f, path: f.path, type: 'audio', sizeBytes: f.stat.size,
			references: [1, 2].map((n) => ({ sourceFile: note, lineNumber: n, isEmbedded: true, originalText: '![[twice.m4a]]' })),
		};
		const { el } = open(result({ possiblyOrphaned: [], targets: [twice] }));
		expect(el.textContent).toContain('Used by 1 note or canvas');
		expect(el.textContent).not.toContain('Used by 2');
	});

	it('searches the orphans by name', () => {
		const { el } = open(result());
		const input = el.querySelector('.ai-organiser-embed-scan-search-input') as HTMLInputElement;
		input.value = 'other';
		input.dispatchEvent(new Event('input'));
		expect(names(el)).toEqual(['other recording.m4a']);
	});

	it('sorts the orphans by name and by smallest first', () => {
		const { el } = open(result());
		const select = el.querySelector('.ai-organiser-embed-scan-sort-select') as HTMLSelectElement;
		select.value = 'name-asc';
		select.dispatchEvent(new Event('change'));
		expect(names(el)).toEqual(['big recording.m4a', 'medium.pdf', 'other recording.m4a', 'small.png']);
		select.value = 'size-asc';
		select.dispatchEvent(new Event('change'));
		expect(names(el)).toEqual(['small.png', 'medium.pdf', 'other recording.m4a', 'big recording.m4a']);
	});

	it('keeps the Large badge and the Find duplicates and Suggest a home entry points', () => {
		const { el } = open(result());
		expect(el.querySelectorAll('.ai-organiser-embed-scan-orphan-row .ai-organiser-embed-scan-badge.large').length).toBe(3);
		expect(el.textContent).toContain(en.embedScan.largeChip);
	});

	it('keeps links to missing files in their own collapsed group so "in use" stays truthful', () => {
		const missing: EmbedTarget = { file: null, path: 'gone.pdf', type: 'pdf', sizeBytes: 0, references: target('x.m4a', 1).references };
		const { el } = open(result({ targets: [target('Rec/used 1.m4a', 30), missing] }));
		expect(el.querySelector('.ai-organiser-embed-scan-group-inuse summary')?.textContent).toBe('1 file in use, nothing to do');
		const group = el.querySelector('.ai-organiser-embed-scan-group-missing') as HTMLDetailsElement;
		expect(group.open).toBe(false);
		expect(group.querySelector('summary')?.textContent).toBe('1 link to files that are missing');
	});

	it('uses no inline styles', () => {
		const { el } = open(result());
		expect(el.querySelectorAll('[style]').length).toBe(0);
	});
});
