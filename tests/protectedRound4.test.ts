import { describe, it, expect, vi, afterEach } from 'vitest';
import { analyseDuplicates } from '../src/services/attachmentDuplicateService';
import { alreadyLinks, appendAttachmentLink } from '../src/services/attachmentHomeService';
import { revalidate, EMPTY_CHANGES, type AttachmentVaultPort, type FileIdentity } from '../src/services/attachmentEligibility';
import { SetupFlow } from '../src/ui/setup/setupFlow';
import { applyProtectedFolders, unregisterProtectedFolders } from '../src/commands/protectedFolderCommands';
import { updateAIOMetadata } from '../src/utils/frontmatterUtils';
import { setActiveProtection } from '../src/core/protectedPaths';
import { DEFAULT_SETTINGS } from '../src/core/settings';
import { en } from '../src/i18n/en';
import { ok } from '../src/core/result';
import { createTFile } from './mocks/obsidian';

afterEach(() => {
	setActiveProtection(null);
	unregisterProtectedFolders();
});

const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;

describe('duplicate analysis input validation', () => {
	it.each([Number.NaN, 0, -3, Number.POSITIVE_INFINITY, 1.7])('falls back to a working concurrency for %s', async (concurrency) => {
		const files = [{ path: 'a', size: 2 }, { path: 'b', size: 2 }];
		const res = await analyseDuplicates(files, { readBinary: async () => enc('xx') }, { maxBytes: 100, concurrency });
		expect(res.ok && res.value.groups).toHaveLength(1);
	});
});

describe('Markdown code spans and fences', () => {
	it('does not count a link inside a double-backtick span that contains single backticks', () => {
		expect(alreadyLinks('use `` `![[Docs/a.pdf]]` `` to embed', 'Docs/a.pdf')).toBe(false);
		expect(alreadyLinks('use ``![[Docs/a.pdf]]`` to embed', 'Docs/a.pdf')).toBe(false);
		expect(alreadyLinks('real ![[Docs/a.pdf]] and `code`', 'Docs/a.pdf')).toBe(true);
	});

	it('appends before an unterminated fence when the section sits above it, and refuses when it would land inside', () => {
		const above = '## Attachments\n![[x.png]]\n\n```js\nnever closed\n';
		const ok1 = appendAttachmentLink(above, 'Docs/a.pdf', 'Attachments');
		expect(ok1.ok && ok1.value.content.indexOf('![[Docs/a.pdf]]')).toBeLessThan(above.indexOf('```js'));
		const inside = '```js\nopen\n## Attachments\n';
		expect(appendAttachmentLink(inside, 'Docs/a.pdf', 'Attachments')).toEqual({ ok: false, error: 'link-failed' });
		const noHeading = 'text\n```js\nopen\n';
		expect(appendAttachmentLink(noHeading, 'Docs/a.pdf', 'Attachments')).toEqual({ ok: false, error: 'link-failed' });
	});
});

describe('revalidate also watches the attachment namespace', () => {
	it('rebuilds when a file appears or disappears during the read', async () => {
		const scanned: FileIdentity = { path: 'Docs/a.pdf', size: 1, mtime: 1 };
		let names = ['Docs/a.pdf'];
		let reads = 0;
		const port: AttachmentVaultPort = {
			isResolved: () => true,
			waitResolved: async () => true,
			listReferrers: () => [{ path: 'n.md', extension: 'md', mtime: 1 }],
			readText: async () => { if (reads++ === 0) names = ['Docs/a.pdf', 'Docs/b.pdf']; return 'x'; },
			resolveLink: () => null,
			candidatesFor: () => [],
			identity: () => scanned,
			namespaceSignature: () => names.join('|'),
		};
		const res = await revalidate(port, { files: [scanned], scanStartedAt: 0, occurrences: [], changes: EMPTY_CHANGES, protectedFolders: [] });
		expect(res.ok).toBe(true);
		expect(reads).toBeGreaterThan(1); // the first attempt was discarded
	});
});

describe('SetupFlow during persistence', () => {
	it('cannot be cancelled once the save has started', async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => { release = r; });
		const flow = new SetupFlow([{ id: 'a' }], async () => { await gate; return ok(undefined); });
		const pending = flow.finish();
		await Promise.resolve();
		await Promise.resolve();
		expect(flow.isFinishing).toBe(true);
		flow.cancel();
		release();
		expect((await pending).ok).toBe(true);
		expect(flow.isCancelled).toBe(false);
		expect(flow.isFinished).toBe(true);
	});
});

describe('one save for list and completion time', () => {
	it('stores the list and the setup-completed time together, and rolls both back on failure', async () => {
		const settings = { ...structuredClone(DEFAULT_SETTINGS), protectedFolders: ['Old'] };
		const saveSettings = vi.fn(async () => undefined);
		const plugin = { settings, t: en, saveSettings };
		const res = await applyProtectedFolders(plugin as never, ['New'], (s) => { s.featureSetupCompletedAt['protected-folders'] = 'T'; });
		expect(res.ok).toBe(true);
		expect(saveSettings).toHaveBeenCalledTimes(1);
		expect(settings.featureSetupCompletedAt['protected-folders']).toBe('T');

		const failing = { settings, t: en, saveSettings: vi.fn(async () => { throw new Error('x'); }) };
		const bad = await applyProtectedFolders(failing as never, ['Newer'], (s) => { s.featureSetupCompletedAt['protected-folders'] = 'T2'; });
		expect(bad.ok).toBe(false);
		expect(settings.protectedFolders).toEqual(['New']);
		expect(settings.featureSetupCompletedAt['protected-folders']).toBe('T');
	});
});

describe('frontmatter writer re-checks protection inside the mutation', () => {
	it('aborts when the note becomes protected between the early check and the callback', async () => {
		let calls = 0;
		setActiveProtection(() => (++calls === 1 ? [] : ['P']));
		const mutated = vi.fn();
		const app = {
			fileManager: {
				processFrontMatter: async (_f: unknown, fn: (fm: Record<string, unknown>) => void) => { const fm = {}; fn(fm); mutated(fm); },
			},
		};
		const done = await updateAIOMetadata(app as never, createTFile('P/a.md') as never, { aio_status: 'processed' } as never);
		expect(done).toBe(false);
		expect(mutated).not.toHaveBeenCalled();
	});
});
