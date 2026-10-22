/**
 * Late-stage hardening: protection checked inside the locked callback, serialized updates,
 * canvas text-node references, cancellation during validation, Markdown contexts.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { writeNote } from '../src/services/noteEdit/noteWritePort';
import { setActiveProtection } from '../src/core/protectedPaths';
import { guardActiveNote, installActiveNoteGuard, referrersProtectedActive } from '../src/utils/protectedGuard';
import { applyProtectedFolders, unregisterProtectedFolders } from '../src/commands/protectedFolderCommands';
import { collectOccurrences, parseCanvasTextNodes } from '../src/services/embedScanService';
import { SetupFlow } from '../src/ui/setup/setupFlow';
import { evaluateSetup } from '../src/core/setupState';
import { appendAttachmentLink, alreadyLinks } from '../src/services/attachmentHomeService';
import { DEFAULT_SETTINGS } from '../src/core/settings';
import { en } from '../src/i18n/en';
import { ok, err } from '../src/core/result';
import { createTFile } from './mocks/obsidian';

afterEach(() => {
	setActiveProtection(null);
	installActiveNoteGuard(null, null);
	unregisterProtectedFolders();
});

describe('noteWritePort decides protection again inside the locked write', () => {
	it('aborts without writing when the list changes between the early check and the callback', async () => {
		let reads = 0;
		const settings = {
			get protectedFolders() { return ++reads === 1 ? [] : ['P']; },
		};
		let text = 'hello';
		const process = vi.fn(async (_f: unknown, fn: (s: string) => string) => { text = fn(text); return text; });
		const app = { vault: { process }, workspace: { getLeavesOfType: () => [] } };
		const res = await writeNote(app as never, createTFile('P/a.md') as never, (c) => ok({ content: c.toUpperCase() }), settings as never);
		expect(res).toEqual({ ok: false, error: 'protected-path' });
		expect(text).toBe('hello');
	});
});

describe('guards without an editor-path provider', () => {
	it('refuses an editor when protection applies and nothing can identify its note', () => {
		setActiveProtection(() => ['P']);
		installActiveNoteGuard(() => 'Other/x.md', () => 'protected'); // two-argument installation
		expect(guardActiveNote({} as never)).toBe(false);
	});

	it('treats a link index that is still being built as an incomplete footprint', () => {
		setActiveProtection(() => ['P']);
		const app = { metadataCache: { resolved: false, resolvedLinks: {} } } as never;
		expect(referrersProtectedActive(app, 'a.pdf')).toBe(true);
	});
});

describe('protected-folder updates are serialized', () => {
	it('a failed older save cannot roll back a newer successful one', async () => {
		const settings = { ...structuredClone(DEFAULT_SETTINGS), protectedFolders: ['Base'] };
		let call = 0;
		let releaseFirst!: () => void;
		const firstGate = new Promise<void>((r) => { releaseFirst = r; });
		const plugin = {
			settings,
			t: en,
			saveSettings: vi.fn(async () => {
				call++;
				if (call === 1) { await firstGate; throw new Error('disk full'); }
			}),
		};
		const first = applyProtectedFolders(plugin as never, ['A']);
		const second = applyProtectedFolders(plugin as never, ['B']);
		releaseFirst();
		const [r1, r2] = await Promise.all([first, second]);
		expect(r1.ok).toBe(false);
		expect(r2.ok).toBe(true);
		expect(plugin.settings.protectedFolders).toEqual(['B']);
	});
});

describe('canvas text nodes', () => {
	const canvas = JSON.stringify({
		nodes: [
			{ id: 'a', type: 'text', text: 'Notes with ![[Docs/report.pdf]]\nand [x](img/pic.png) and [[Another note]]' },
			{ id: 'b', type: 'file', file: 'Docs/spec.docx' },
			{ id: 'c', type: 'text', text: 7 },
		],
	});

	it('reads the text of text nodes only', () => {
		expect(parseCanvasTextNodes(canvas)).toEqual(['Notes with ![[Docs/report.pdf]]\nand [x](img/pic.png) and [[Another note]]']);
		expect(parseCanvasTextNodes('{oops')).toEqual([]);
	});

	it('counts a link inside a text node as a reference to the file', () => {
		const { occurrences } = collectOccurrences('Board.canvas', 'canvas', canvas);
		expect(occurrences.map((o) => o.linktext).sort()).toEqual(['Docs/report.pdf', 'Docs/spec.docx', 'img/pic.png']);
		// file nodes use vault-path rules; links in text nodes follow Markdown link rules
		expect(occurrences.filter((o) => o.kind === 'canvas').map((o) => o.linktext)).toEqual(['Docs/spec.docx']);
		expect(occurrences.filter((o) => o.kind === 'markdown').map((o) => o.linktext).sort()).toEqual(['Docs/report.pdf', 'img/pic.png']);
	});
});

describe('SetupFlow cancellation and persistence failures', () => {
	it('does not save when the dialog is closed while validation is pending', async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => { release = r; });
		const onFinish = vi.fn(async () => ok(undefined));
		const flow = new SetupFlow([{ id: 'a', validate: async () => { await gate; return ok(undefined); } }], onFinish);
		const pending = flow.finish();
		flow.cancel();
		release();
		expect((await pending).ok).toBe(false);
		expect(onFinish).not.toHaveBeenCalled();
	});

	it('turns a throwing save into an error result and stays unfinished', async () => {
		const flow = new SetupFlow([{ id: 'a' }], async () => { throw new Error('boom'); });
		expect(await flow.finish()).toEqual({ ok: false, error: 'write-failed' });
		expect(flow.isFinished).toBe(false);
	});
});

describe('setup health uses effective folder entries', () => {
	it('does not call a list of only "/" or blanks ready', () => {
		for (const protectedFolders of [['/'], [' '], ['./']]) {
			expect(evaluateSetup('protected-folders', { ...DEFAULT_SETTINGS, protectedFolders }).state).toBe('not-set-up');
		}
	});
});

describe('attachment link Markdown contexts', () => {
	it('does not count a link inside an inline code span', () => {
		expect(alreadyLinks('see `![[Docs/a.pdf]]` for syntax', 'Docs/a.pdf')).toBe(false);
		expect(alreadyLinks('see ![[Docs/a.pdf]] here', 'Docs/a.pdf')).toBe(true);
	});

	it('refuses to append into a note that ends inside an unterminated fence', () => {
		const res = appendAttachmentLink('text\n```js\ncode never closed\n', 'Docs/a.pdf', 'Attachments');
		expect(res).toEqual(err('link-failed'));
	});

	it('still appends when every fence is closed', () => {
		const res = appendAttachmentLink('```js\ncode\n```\n', 'Docs/a.pdf', 'Attachments');
		expect(res.ok && res.value.content).toContain('![[Docs/a.pdf]]');
	});
});
