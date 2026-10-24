// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeAll } from 'vitest';

vi.mock('obsidian', async () => await import('./mocks/obsidian'));

import { installObsidianDomShims } from './helpers/obsidianDom';
import { renderKeptPanel, type KeptPanelHandlers } from '../src/ui/modals/EmbedScanKeptPanel';
import { describeKept } from '../src/services/attachmentKeptModel';
import { en } from '../src/i18n/en';

beforeAll(() => installObsidianDomShims());

const file = { path: 'Rec/meeting.m4a', name: 'meeting.m4a', sizeBytes: 120 * 1024 * 1024 };
const handlers = (): KeptPanelHandlers & { calls: string[] } => {
	const calls: string[] = [];
	return {
		calls,
		open: (p) => calls.push('open:' + p),
		removeAndDelete: (p) => calls.push('remove:' + p),
		enableRemoval: (p) => calls.push('enable:' + p),
		scanAgain: () => calls.push('scan'),
	};
};

function render(cards: ReturnType<typeof describeKept>[], h = handlers(), busy = false) {
	const host = document.createElement('div');
	const dispose = renderKeptPanel(host, cards, en, h, busy);
	return { host, h, dispose };
}

const referenced = (linkRemoval: 'on' | 'off' | 'unavailable' = 'on') =>
	describeKept(
		file,
		{ eligible: false, reasons: ['still-referenced'], referenceCount: 1, blockers: { referrers: [{ path: 'Minutes/2026-01 standup.md', extension: 'md', lineNumber: 4, linktext: 'meeting.m4a' }], sameNameFiles: [], unreadable: [] } },
		{ protectedFolders: [], linkRemoval },
	);

describe('Kept panel', () => {
	it('renders nothing for no cards', () => {
		const { host } = render([]);
		expect(host.children.length).toBe(0);
	});

	it('is a named region that names the blocking note and its line, with Open note and Remove the link and delete', () => {
		const { host, h } = render([referenced()]);
		const region = host.querySelector('[role="region"]');
		expect(region?.getAttribute('aria-label')).toBe(en.embedScan.keptPanelLabel);
		expect(host.textContent).toContain('meeting.m4a');
		expect(host.textContent).toContain('Used in 2026-01 standup, line 4');
		const buttons = [...host.querySelectorAll('button')];
		expect(buttons.map((b) => b.textContent)).toEqual(['Open note', 'Remove the link and delete']);
		expect(buttons[0].getAttribute('aria-label')).toBe('Open note: meeting.m4a');
		buttons[0].click();
		buttons[1].click();
		expect(h.calls).toEqual(['open:Minutes/2026-01 standup.md', 'remove:Rec/meeting.m4a']);
	});

	it('offers a one-click enable when link removal is off, and no remove button', () => {
		const { host, h } = render([referenced('off')]);
		const labels = [...host.querySelectorAll('button')].map((b) => b.textContent);
		expect(labels).toEqual(['Open note', 'Turn on and continue']);
		expect(host.textContent).toContain('Removing links is off.');
		[...host.querySelectorAll('button')][1].click();
		expect(h.calls).toEqual(['enable:Rec/meeting.m4a']);
	});

	it('gives a canvas referrer text-only guidance with Open canvas, never a remove action', () => {
		const card = describeKept(file, { eligible: false, reasons: ['still-referenced'], referenceCount: 1, blockers: { referrers: [{ path: 'Board.canvas', extension: 'canvas', lineNumber: 0, linktext: 'x' }], sameNameFiles: [], unreadable: [] } }, { protectedFolders: [], linkRemoval: 'on' });
		const { host } = render([card]);
		expect(host.textContent).toContain('Used in the canvas Board');
		expect(host.textContent).toContain(en.embedScan.keptCanvasHint);
		expect([...host.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Open canvas']);
	});

	it('names the other file for an ambiguous link, the unreadable note, and offers Scan again for a changed file', () => {
		const ambiguous = describeKept(file, { eligible: false, reasons: ['ambiguous-reference'], referenceCount: 0, blockers: { referrers: [], sameNameFiles: ['Archive/meeting.m4a'], unreadable: [] } }, { protectedFolders: [], linkRemoval: 'on' });
		const unreadable = describeKept({ ...file, path: 'b.pdf', name: 'b.pdf' }, { eligible: false, reasons: ['scan-incomplete'], referenceCount: 0, blockers: { referrers: [], sameNameFiles: [], unreadable: [{ path: 'Broken.md', kind: 'markdown-unreadable' }] } }, { protectedFolders: [], linkRemoval: 'on' });
		const changed = describeKept({ ...file, path: 'c.pdf', name: 'c.pdf' }, { eligible: false, reasons: ['file-changed'], referenceCount: 0 }, { protectedFolders: [], linkRemoval: 'on' });
		const { host, h } = render([ambiguous, unreadable, changed]);
		expect(host.textContent).toContain('A link could mean this file or Archive/meeting.m4a');
		expect(host.textContent).toContain('Broken could not be read');
		expect(host.textContent).toContain(en.embedScan.keptUnreadableHint);
		const scan = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Scan again');
		scan?.click();
		expect(h.calls).toEqual(['scan']);
	});

	it('disables every action while a workflow is running', () => {
		const { host } = render([referenced()], handlers(), true);
		expect([...host.querySelectorAll('button')].every((b) => b.disabled)).toBe(true);
	});

	it('never writes a style attribute, and disposes its listeners', () => {
		const { host, h, dispose } = render([referenced()]);
		expect(host.querySelectorAll('[style]').length).toBe(0);
		const button = host.querySelector('button')!;
		for (const d of dispose) d();
		button.click();
		expect(h.calls).toEqual([]);
	});
});
