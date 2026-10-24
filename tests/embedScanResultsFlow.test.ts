// @vitest-environment happy-dom
/**
 * The delete / kept / remove-the-link flow of the Find embeds results window, driven through the real
 * modal with the vault re-check and the note writer replaced by fakes.
 */
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

vi.mock('../src/services/attachmentEligibility', async (orig) => ({
	...(await orig<typeof import('../src/services/attachmentEligibility')>()),
	revalidate: vi.fn(),
	createAppVaultPort: vi.fn(() => ({})),
}));

const previews: Array<{ fileName: string; plans: unknown[]; onApply: () => void; onCancel: () => void }> = [];
vi.mock('../src/ui/modals/RemoveLinkPreviewModal', () => ({
	RemoveLinkPreviewModal: class {
		constructor(_app: unknown, _t: unknown, fileName: string, plans: unknown[], onApply: () => void, onCancel: () => void) { previews.push({ fileName, plans, onApply, onCancel }); }
		open() { /* captured */ }
	},
}));

vi.mock('../src/services/attachmentUnlinkService', async (orig) => ({
	...(await orig<typeof import('../src/services/attachmentUnlinkService')>()),
	removeLinks: vi.fn(),
}));

import { installObsidianDomShims } from './helpers/obsidianDom';
import { createTFile, mockNotices } from './mocks/obsidian';
import { EmbedScanResultsModal, resetEgressChoice } from '../src/ui/modals/EmbedScanResultsModal';
import { revalidate, type Eligibility } from '../src/services/attachmentEligibility';
import { removeLinks } from '../src/services/attachmentUnlinkService';
import type { EmbedScanResult } from '../src/services/embedScanService';
import { en } from '../src/i18n/en';

beforeAll(() => installObsidianDomShims());

const reval = vi.mocked(revalidate);
const unlink = vi.mocked(removeLinks);
const MB = 1024 * 1024;
const REC = 'Rec/meeting Jan 2026.m4a';
const NOTE = 'Minutes/2026-01 standup.md';

const kept = (over: Partial<Eligibility> = {}): Eligibility => ({
	eligible: false,
	reasons: ['still-referenced'],
	referenceCount: 1,
	blockers: { referrers: [{ path: NOTE, extension: 'md', lineNumber: 4, linktext: 'meeting Jan 2026.m4a' }], sameNameFiles: [], unreadable: [] },
	...over,
});
const safe = (): Eligibility => ({ eligible: true, reasons: [], referenceCount: 0 });

interface Harness {
	modal: EmbedScanResultsModal;
	el: HTMLElement;
	app: { fileManager: { trashFile: ReturnType<typeof vi.fn> }; vault: { read: ReturnType<typeof vi.fn> } };
	settings: Record<string, unknown>;
	rescan: ReturnType<typeof vi.fn>;
}

function setup(settingsOver: Record<string, unknown> = {}): Harness {
	const rec = createTFile(REC);
	rec.stat = { mtime: 1, ctime: 1, size: 120 * MB };
	const note = createTFile(NOTE);
	const files = new Map([[REC, rec], [NOTE, note]]);
	const app = {
		vault: { on: () => ({}), offref: () => {}, getAbstractFileByPath: (p: string) => files.get(p) ?? null, read: vi.fn(async () => 'intro\n![[meeting Jan 2026.m4a]]\n') },
		workspace: { openLinkText: vi.fn() },
		metadataCache: { getFirstLinkpathDest: (l: string) => (l === 'meeting Jan 2026.m4a' ? rec : null) },
		fileManager: { trashFile: vi.fn(async () => {}) },
	};
	const settings: Record<string, unknown> = { protectedFolders: [], featureFlags: { 'embed-scan': true }, attachmentAllowLinkRemoval: true, attachmentLargeFileMB: 20, ...settingsOver };
	const plugin = { settings, saveSettings: vi.fn(async () => {}), t: en };
	const rescan = vi.fn();
	const res: EmbedScanResult = { targets: [], possiblyOrphaned: [rec], notesScanned: 1, cancelled: false, coverageFailures: [], ambiguousPaths: [], scanStartedAt: 1, occurrences: [], scannedReferrers: [] };
	const modal = new EmbedScanResultsModal(app as never, en, res, { plugin: plugin as never, onRescan: rescan });
	modal.open();
	return { modal, el: (modal as unknown as { contentEl: HTMLElement }).contentEl, app, settings, rescan };
}

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); };

async function selectAndDelete(h: Harness): Promise<void> {
	const box = h.el.querySelector('.ai-organiser-embed-scan-orphan-row input[type="checkbox"]') as HTMLInputElement;
	box.checked = true;
	box.dispatchEvent(new Event('change'));
	(h.el.querySelector('.ai-organiser-embed-scan-delete-btn') as HTMLElement).click();
	await flush();
}

const keptPanel = (h: Harness) => h.el.querySelector('[role="region"]');
const buttonLabels = (root: Element | null) => Array.from((root?.querySelectorAll('button') ?? [])).map((b) => b.textContent);

beforeEach(() => {
	resetEgressChoice();
	reval.mockReset();
	unlink.mockReset();
	previews.length = 0;
	mockNotices.length = 0;
});

describe('kept files', () => {
	it('shows a card that names the blocking note instead of only a notice', async () => {
		const h = setup();
		reval.mockResolvedValue({ ok: true, value: new Map([[REC, kept()]]) });
		await selectAndDelete(h);
		const panel = keptPanel(h)!;
		expect(panel).not.toBeNull();
		expect(panel.textContent).toContain('Used in 2026-01 standup, line 4');
		expect(buttonLabels(panel)).toEqual(['Open note', 'Remove the link and delete']);
		expect(h.app.fileManager.trashFile).not.toHaveBeenCalled();
	});

	it('Open note opens the blocking note', async () => {
		const h = setup();
		reval.mockResolvedValue({ ok: true, value: new Map([[REC, kept()]]) });
		await selectAndDelete(h);
		(keptPanel(h)!.querySelector('button') as HTMLElement).click();
		expect((h.modal as unknown as { app: { workspace: { openLinkText: ReturnType<typeof vi.fn> } } }).app.workspace.openLinkText).toHaveBeenCalledWith(NOTE, '', false);
	});

	it('a changed file offers Scan again inline', async () => {
		const h = setup();
		reval.mockResolvedValue({ ok: true, value: new Map([[REC, kept({ reasons: ['file-changed'], referenceCount: 0, blockers: { referrers: [], sameNameFiles: [], unreadable: [] } })]]) });
		await selectAndDelete(h);
		const scan = Array.from(keptPanel(h)!.querySelectorAll('button')).find((b) => b.textContent === 'Scan again')!;
		scan.click();
		expect(h.rescan).toHaveBeenCalledTimes(1);
	});

	it('offers a one-click enable when link removal is off, then carries on to the preview', async () => {
		const h = setup({ attachmentAllowLinkRemoval: false });
		reval.mockResolvedValue({ ok: true, value: new Map([[REC, kept()]]) });
		await selectAndDelete(h);
		expect(buttonLabels(keptPanel(h))).toEqual(['Open note', 'Turn on and continue']);
		(Array.from(keptPanel(h)!.querySelectorAll('button')).find((b) => b.textContent === 'Turn on and continue') as HTMLElement).click();
		await flush();
		expect(h.settings.attachmentAllowLinkRemoval).toBe(true);
		expect(previews).toHaveLength(1);
	});

	it('does not offer removal when the blocking note is in a protected folder', async () => {
		const h = setup({ protectedFolders: ['Minutes'] });
		reval.mockResolvedValue({ ok: true, value: new Map([[REC, kept()]]) });
		await selectAndDelete(h);
		expect(buttonLabels(keptPanel(h))).toEqual(['Open note']);
		expect(keptPanel(h)!.textContent).toContain(en.embedScan.keptReferrerProtected);
	});
});

describe('not-ready index', () => {
	it('says so inline with a retry, keeps the selection, and the retry re-checks', async () => {
		const h = setup();
		reval.mockResolvedValueOnce({ ok: false, error: 'metadata-not-ready' });
		await selectAndDelete(h);
		const status = h.el.querySelector('.ai-organiser-embed-scan-not-ready [role="status"]')!;
		expect(status.textContent).toContain('Obsidian is still indexing your links');
		expect(keptPanel(h)).toBeNull();
		reval.mockResolvedValueOnce({ ok: true, value: new Map([[REC, kept()]]) });
		(status.querySelector('button') as HTMLElement).click();
		await flush();
		expect(reval).toHaveBeenCalledTimes(2);
		expect(h.el.querySelector('.ai-organiser-embed-scan-not-ready [role="status"]')).toBeNull();
		expect(keptPanel(h)).not.toBeNull();
	});
});

describe('a batch trash re-checks each later file', () => {
	it('keeps a later file that became referenced while the first one was being trashed', async () => {
		const h = setup();
		const second = createTFile('Rec/second.m4a');
		second.stat = { mtime: 1, ctime: 1, size: 110 * MB };
		const app = (h.modal as unknown as { app: { vault: { getAbstractFileByPath: (p: string) => unknown } } }).app;
		const orig = app.vault.getAbstractFileByPath;
		app.vault.getAbstractFileByPath = (p: string) => (p === second.path ? second : orig(p));
		const first = app.vault.getAbstractFileByPath(REC);
		reval.mockResolvedValueOnce({ ok: true, value: new Map([[REC, safe()], [second.path, safe()]]) });
		reval.mockResolvedValueOnce({ ok: true, value: new Map([[second.path, kept()]]) });
		await (h.modal as unknown as { executeDelete(files: unknown[]): Promise<void> }).executeDelete([first, second]);
		expect(h.app.fileManager.trashFile).toHaveBeenCalledTimes(1);
		expect(h.app.fileManager.trashFile.mock.calls[0][0]).toBe(first);
		expect(reval).toHaveBeenCalledTimes(2);
	});
});

describe('deletion uses a current verdict (after the confirm click)', () => {
	const exec = (h: Harness) => (h.modal as unknown as { executeDelete(files: unknown[]): Promise<void> }).executeDelete([h.app.vault.read && (h.modal as unknown as { app: { vault: { getAbstractFileByPath(p: string): unknown } } }).app.vault.getAbstractFileByPath(REC)]);

	it('does not trash when a reference appeared while the confirmation was open', async () => {
		const h = setup();
		reval.mockResolvedValue({ ok: true, value: new Map([[REC, kept()]]) });
		await exec(h);
		expect(h.app.fileManager.trashFile).not.toHaveBeenCalled();
		expect(keptPanel(h)).not.toBeNull();
	});

	it('does not trash while the index is not ready', async () => {
		const h = setup();
		reval.mockResolvedValue({ ok: false, error: 'metadata-not-ready' });
		await exec(h);
		expect(h.app.fileManager.trashFile).not.toHaveBeenCalled();
	});

	it('trashes only the files the fresh check still calls safe', async () => {
		const h = setup();
		reval.mockResolvedValue({ ok: true, value: new Map([[REC, safe()]]) });
		await exec(h);
		expect(h.app.fileManager.trashFile).toHaveBeenCalledTimes(1);
	});
});

describe('Remove the link and delete', () => {
	it('holds the workflow lock while the preview is open, and Cancel releases it', async () => {
		const h = setup();
		reval.mockResolvedValueOnce({ ok: true, value: new Map([[REC, kept()]]) });
		await selectAndDelete(h);
		const remove = () => Array.from(keptPanel(h)!.querySelectorAll('button')).find((b) => b.textContent === 'Remove the link and delete') as HTMLButtonElement;
		remove().click();
		await flush();
		expect(previews).toHaveLength(1);
		expect(Array.from(keptPanel(h)!.querySelectorAll('button')).every((b) => b.disabled)).toBe(true);
		previews[0].onCancel();
		expect(Array.from(keptPanel(h)!.querySelectorAll('button')).every((b) => !b.disabled)).toBe(true);
	});

	it('ignores a second click while the first is planning', async () => {
		const h = setup();
		reval.mockResolvedValueOnce({ ok: true, value: new Map([[REC, kept()]]) });
		await selectAndDelete(h);
		const btn = Array.from(keptPanel(h)!.querySelectorAll('button')).find((b) => b.textContent === 'Remove the link and delete') as HTMLButtonElement;
		btn.click();
		btn.click();
		await flush();
		expect(previews).toHaveLength(1);
	});

	it('reports a note that cannot be read instead of failing silently', async () => {
		const h = setup();
		reval.mockResolvedValueOnce({ ok: true, value: new Map([[REC, kept()]]) });
		await selectAndDelete(h);
		h.app.vault.read.mockRejectedValue(new Error('gone'));
		Array.from(keptPanel(h)!.querySelectorAll('button')).find((b) => b.textContent === 'Remove the link and delete')!.click();
		await flush();
		expect(previews).toHaveLength(0);
		expect(mockNotices.some((n) => n.includes('The link could not be removed'))).toBe(true);
		expect(Array.from(keptPanel(h)!.querySelectorAll('button')).every((b) => !b.disabled)).toBe(true);
	});

	async function toPreview(h: Harness) {
		reval.mockResolvedValueOnce({ ok: true, value: new Map([[REC, kept()]]) });
		await selectAndDelete(h);
		(Array.from(keptPanel(h)!.querySelectorAll('button')).find((b) => b.textContent === 'Remove the link and delete') as HTMLElement).click();
		await flush();
	}

	it('previews the plan for every referencing note and writes nothing before Apply', async () => {
		const h = setup();
		await toPreview(h);
		expect(previews).toHaveLength(1);
		expect(previews[0].fileName).toBe('meeting Jan 2026.m4a');
		expect(previews[0].plans).toHaveLength(1);
		expect(unlink).not.toHaveBeenCalled();
	});

	it('applies, re-checks, and only then reaches the delete confirmation', async () => {
		const h = setup();
		await toPreview(h);
		unlink.mockResolvedValue({ ok: true, value: { items: [{ notePath: NOTE, status: 'written' }], errors: [], warnings: [], isPartial: false } });
		reval.mockResolvedValueOnce({ ok: true, value: new Map([[REC, safe()]]) });
		previews[0].onApply();
		await flush();
		expect(unlink).toHaveBeenCalledTimes(1);
		expect(unlink.mock.calls[0][1]).toBe(REC);
		expect(reval).toHaveBeenCalledTimes(2);
		expect(h.app.fileManager.trashFile).not.toHaveBeenCalled(); // trashing needs the later confirm
		expect(mockNotices.some((n) => n.includes('Removed the links in 1 note'))).toBe(true);
	});

	it('keeps the file and shows what remains when a second reference exists after the edit', async () => {
		const h = setup();
		await toPreview(h);
		unlink.mockResolvedValue({ ok: true, value: { items: [{ notePath: NOTE, status: 'written' }], errors: [], warnings: [], isPartial: false } });
		reval.mockResolvedValueOnce({ ok: true, value: new Map([[REC, kept({ blockers: { referrers: [{ path: 'Other.md', extension: 'md', lineNumber: 1, linktext: 'x' }], sameNameFiles: [], unreadable: [] } })]]) });
		previews[0].onApply();
		await flush();
		expect(keptPanel(h)!.textContent).toContain('Used in Other, line 1');
		expect(h.app.fileManager.trashFile).not.toHaveBeenCalled();
	});

	it('shows a fresh preview, not a write, when a note changed after the first one', async () => {
		const h = setup();
		await toPreview(h);
		unlink.mockResolvedValue({ ok: true, value: { items: [], errors: [{ source: NOTE, error: 'stale' }], warnings: [], isPartial: false } });
		previews[0].onApply();
		await flush();
		expect(previews).toHaveLength(2);
		expect(mockNotices.some((n) => n.includes('The note changed after the preview'))).toBe(true);
	});

	it('disables the card actions while the job runs and keeps announcing after the window closes', async () => {
		const h = setup();
		await toPreview(h);
		let release!: (v: unknown) => void;
		let shouldContinue: (() => boolean) | undefined;
		unlink.mockImplementation((_p, _f, _plans, opts) => { shouldContinue = opts?.shouldContinue; return new Promise((r) => { release = r as typeof release; }) as never; });
		previews[0].onApply();
		await flush();
		expect(Array.from(keptPanel(h)!.querySelectorAll('button')).every((b) => b.disabled)).toBe(true);
		expect(shouldContinue?.()).toBe(true);
		h.modal.close();
		expect(shouldContinue?.()).toBe(false);
		release({ ok: true, value: { items: [{ notePath: NOTE, status: 'written' }], errors: [], warnings: [], isPartial: false } });
		await flush();
		expect(mockNotices.some((n) => n.includes('Removed the links in 1 note'))).toBe(true);
		expect(reval).toHaveBeenCalledTimes(1); // no re-check on a closed window
	});

	it('refuses with a reason when the link sits where it cannot be removed safely', async () => {
		const h = setup();
		h.app.vault.read.mockResolvedValue('---\nrec: "![[meeting Jan 2026.m4a]]"\n---\n');
		await toPreview(h);
		expect(previews).toHaveLength(0);
		expect(mockNotices.some((n) => n.includes('cannot be removed automatically'))).toBe(true);
	});
});
