import { describe, it, expect, vi, afterEach } from 'vitest';
import { assertWritable } from '../src/core/protectedPaths';
import { applyProtectedFolders, unregisterProtectedFolders } from '../src/commands/protectedFolderCommands';
import { SetupFlow } from '../src/ui/setup/setupFlow';
import { linkToNote } from '../src/services/attachmentHomeService';
import { DEFAULT_SETTINGS } from '../src/core/settings';
import { en } from '../src/i18n/en';
import { ok } from '../src/core/result';
import { makeFakeApp } from './helpers/fakeVault';

afterEach(() => unregisterProtectedFolders());

describe('vault-root folder operations', () => {
	it('count as touching every protected folder', () => {
		expect(assertWritable(['Private'], 'delete', { path: '', folder: true }).ok).toBe(false);
		expect(assertWritable(['Private'], 'rename', { path: '/', folder: true }).ok).toBe(false);
		expect(assertWritable([], 'delete', { path: '', folder: true }).ok).toBe(true);
	});
});

describe('protected-folder updates are queued as intents', () => {
	it('derives each update from the list that is current when it runs', async () => {
		const settings = { ...structuredClone(DEFAULT_SETTINGS), protectedFolders: ['A'] };
		let release!: () => void;
		const gate = new Promise<void>((r) => { release = r; });
		let saves = 0;
		const plugin = { settings, t: en, saveSettings: vi.fn(async () => { if (saves++ === 0) await gate; }) };
		const first = applyProtectedFolders(plugin as never, (cur) => [...cur, 'B']);
		const second = applyProtectedFolders(plugin as never, (cur) => [...cur, 'C']);
		release();
		await Promise.all([first, second]);
		expect(settings.protectedFolders).toEqual(['A', 'B', 'C']);
	});
});

describe('SetupFlow.next honours a close during validation', () => {
	it('does not advance after cancel', async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => { release = r; });
		const flow = new SetupFlow([{ id: 'a', validate: async () => { await gate; return ok(undefined); } }, { id: 'b' }], async () => ok(undefined));
		const pending = flow.next();
		flow.cancel();
		release();
		expect((await pending).ok).toBe(false);
		expect(flow.stepIndex).toBe(0);
	});
});

describe('linkToNote validates the attachment too', () => {
	it('refuses when the attachment no longer exists', async () => {
		const v = makeFakeApp({ 'note.md': 'body' });
		const plugin = { app: v.app, settings: { ...DEFAULT_SETTINGS }, t: en };
		const res = await linkToNote(plugin as never, 'Docs/gone.pdf', 'note.md', 'Attachments');
		expect(res).toEqual({ ok: false, error: 'target-missing' });
	});
});

describe('fake vault resolves extensionless note names from nested notes', () => {
	it('finds Notes/Topic.md from Notes/Index.md by bare name', () => {
		const v = makeFakeApp({ 'Notes/Index.md': '', 'Notes/Topic.md': '' });
		expect(v.app.metadataCache.getFirstLinkpathDest('Topic', 'Notes/Index.md')?.path).toBe('Notes/Topic.md');
	});
});
