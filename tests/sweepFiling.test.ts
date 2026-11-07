/**
 * Filing after a review: the note is moved or trashed only once its tasks are safe, an edited note is never trashed, a move
 * never overwrites, protected notes are left alone, and every skipped filing is said once and not retried.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTFile, createTFolder, mockNotices } from './mocks/obsidian';
import { filingFolders, runPendingFiling } from '../src/services/inboxSweep/sweepFiling';
import { filingReadiness, type ApprovalRecord, type ApprovedTask, type Disposition } from '../src/services/inboxSweep/sweepLedger';
import { buildSnapshot } from '../src/services/inboxSweep/noteSnapshot';
import { migrateOldSettings } from '../src/core/settings';
import { en } from '../src/i18n/en';

const task = (state: ApprovedTask['state'], sourcePath = '0 Inbox/a.md', error?: string): ApprovedTask => ({ id: 'aio-1', text: 'x', context: '', sourcePath, sourceHash: 'h', state, ...(error ? { error } : {}) });
const record = (tasks: ApprovedTask[], dispositions: Disposition[], done = true): ApprovalRecord => ({ runId: 'run-a', createdAt: '2026-11-07', reportPath: 'r.md', tasks, dispositions, reportDone: done, ledgerDone: done });
const trash = (sourcePath = '0 Inbox/a.md', sourceHash = 'h'): Disposition => ({ sourcePath, sourceHash, markSwept: true, filing: { type: 'trash' } });

describe('filingReadiness', () => {
	it('is none without a choice or once filed', () => {
		expect(filingReadiness(record([], [{ sourcePath: 'a', sourceHash: 'h', markSwept: true }]), { sourcePath: 'a', sourceHash: 'h', markSwept: true }, true)).toBe('none');
		const d = { ...trash(), filed: 'done' as const };
		expect(filingReadiness(record([], [d]), d, true)).toBe('none');
	});
	it('waits for the report and ledger', () => {
		expect(filingReadiness(record([], [trash()], false), trash(), true)).toBe('wait');
	});
	it('waits until every task from the note is exported or kept', () => {
		expect(filingReadiness(record([task('reported'), task('exported')], [trash()]), trash(), true)).toBe('wait');
		expect(filingReadiness(record([task('routed')], [trash()]), trash(), true)).toBe('wait');
		expect(filingReadiness(record([task('failed', '0 Inbox/a.md', 'http')], [trash()]), trash(), true)).toBe('wait');
		expect(filingReadiness(record([task('exported'), task('kept'), task('approved', 'other.md')], [trash()]), trash(), true)).toBe('ready');
	});
	it('is blocked by a task that can never be sent', () => {
		expect(filingReadiness(record([task('failed', '0 Inbox/a.md', 'conflict')], [trash()]), trash(), true)).toBe('blocked');
	});
	it('with Google Tasks off, a finished record is enough', () => {
		expect(filingReadiness(record([task('reported')], [trash()]), trash(), false)).toBe('ready');
	});
	it('a note with no tasks (filing only) is ready', () => {
		expect(filingReadiness(record([], [trash()]), trash(), true)).toBe('ready');
	});
});

describe('filingFolders', () => {
	const roots = [
		{ path: '0 Inbox', kind: 'inbox' as const },
		{ path: '1 Projects', kind: 'projects' as const },
		{ path: '2 Areas', kind: 'areas' as const },
		{ path: '3 Reference', kind: 'reference' as const },
	];
	const folders = ['0 Inbox', '0 Inbox/sub', '1 Projects', '1 Projects/Q4', '2 Areas', '2 Areas/Health', '2 Areas/Health/Dental', '2 Areas/Health/Dental/2026', '2 Areas/.hidden', '2 Areas/Tech', '2 Areas/Tech/ML', '3 Reference', '9 Other'];

	it('lists the filing roots and two levels below, never the inbox, hidden or deeper folders', () => {
		expect(filingFolders(roots, folders, [])).toEqual(['1 Projects', '1 Projects/Q4', '2 Areas', '2 Areas/Health', '2 Areas/Health/Dental', '2 Areas/Tech', '2 Areas/Tech/ML', '3 Reference']);
	});
	it('leaves out protected folders and what is inside them', () => {
		expect(filingFolders(roots, folders, ['2 Areas/Tech'])).not.toContain('2 Areas/Tech/ML');
		expect(filingFolders(roots, folders, ['2 Areas/Tech'])).not.toContain('2 Areas/Tech');
	});
	it('is empty with no PARA roots', () => {
		expect(filingFolders([], folders, [])).toEqual([]);
	});
});

describe('settings migration keeps a filing choice', () => {
	it('keeps a valid choice and its outcome, and drops a malformed one', () => {
		const stored = {
			sweepApprovals: [{
				runId: 'run-a', createdAt: '2026-11-07', reportPath: 'r.md', tasks: [], reportDone: true, ledgerDone: true,
				dispositions: [
					{ sourcePath: 'a.md', sourceHash: 'h', markSwept: true, filing: { type: 'move', folder: '2 Areas' }, filed: 'done' },
					{ sourcePath: 'b.md', sourceHash: 'h', markSwept: false, filing: { type: 'trash' } },
					{ sourcePath: 'c.md', sourceHash: 'h', markSwept: false, filing: { type: 'move', folder: '' } },
					{ sourcePath: 'd.md', sourceHash: 'h', markSwept: false },
				],
			}],
		};
		const out = migrateOldSettings(stored) as { sweepApprovals: ApprovalRecord[] };
		expect(out.sweepApprovals[0].dispositions).toEqual([
			{ sourcePath: 'a.md', sourceHash: 'h', markSwept: true, filing: { type: 'move', folder: '2 Areas' }, filed: 'done' },
			{ sourcePath: 'b.md', sourceHash: 'h', markSwept: false, filing: { type: 'trash' } },
			{ sourcePath: 'c.md', sourceHash: 'h', markSwept: false },
			{ sourcePath: 'd.md', sourceHash: 'h', markSwept: false },
		]);
	});
});

describe('runPendingFiling', () => {
	let files: Map<string, ReturnType<typeof createTFile> | ReturnType<typeof createTFolder>>;
	let texts: Map<string, string>;
	let trashFile: ReturnType<typeof vi.fn>;
	let renameFile: ReturnType<typeof vi.fn>;

	const hashOf = async (text: string) => (await buildSnapshot('x', text, '')).contentHash;

	const pluginWith = (approvals: ApprovalRecord[], protectedFolders: string[] = []) => {
		const plugin = {
			t: en,
			settings: { sweepApprovals: approvals, protectedFolders, featureFlags: { 'inbox-sweep': true, 'google-tasks-export': true }, tasksListId: 'L' },
			saveSettings: vi.fn(async () => undefined),
			app: {
				vault: {
					getAbstractFileByPath: (p: string) => files.get(p) ?? null,
					read: async (f: { path: string }) => texts.get(f.path) ?? '',
				},
				fileManager: { trashFile, renameFile },
				metadataCache: { resolvedLinks: {} },
			},
		};
		return plugin;
	};

	beforeEach(() => {
		files = new Map();
		texts = new Map();
		mockNotices.length = 0;
		trashFile = vi.fn(async (f: { path: string }) => { files.delete(f.path); });
		renameFile = vi.fn(async (f: { path: string }, to: string) => { files.delete(f.path); files.set(to, createTFile(to)); });
		files.set('0 Inbox/a.md', createTFile('0 Inbox/a.md'));
		texts.set('0 Inbox/a.md', 'Call the dentist');
		files.set('2 Areas/Health', createTFolder('2 Areas/Health'));
	});

	it('trashes an unchanged note whose tasks were sent, and marks it done', async () => {
		const plugin = pluginWith([record([task('exported')], [trash('0 Inbox/a.md', await hashOf('Call the dentist'))])]);
		await runPendingFiling(plugin as never);
		expect(trashFile).toHaveBeenCalledTimes(1);
		expect(plugin.settings.sweepApprovals[0].dispositions[0].filed).toBe('done');
		expect(plugin.saveSettings).toHaveBeenCalled();
	});

	it('does nothing while a task is still to be sent', async () => {
		const plugin = pluginWith([record([task('reported')], [trash('0 Inbox/a.md', await hashOf('Call the dentist'))])]);
		await runPendingFiling(plugin as never);
		expect(trashFile).not.toHaveBeenCalled();
		expect(plugin.settings.sweepApprovals[0].dispositions[0].filed).toBeUndefined();
	});

	it('never trashes a note changed since the review, and says so once', async () => {
		const plugin = pluginWith([record([task('exported')], [trash('0 Inbox/a.md', await hashOf('older text'))])]);
		await runPendingFiling(plugin as never);
		expect(trashFile).not.toHaveBeenCalled();
		expect(plugin.settings.sweepApprovals[0].dispositions[0].filed).toBe('skipped');
		await runPendingFiling(plugin as never);
		expect(trashFile).not.toHaveBeenCalled();
	});

	it('moves into the chosen folder with the link-keeping rename', async () => {
		const plugin = pluginWith([record([task('exported')], [{ sourcePath: '0 Inbox/a.md', sourceHash: 'any', markSwept: true, filing: { type: 'move', folder: '2 Areas/Health' } }])]);
		await runPendingFiling(plugin as never);
		expect(renameFile).toHaveBeenCalledWith(expect.objectContaining({ path: '0 Inbox/a.md' }), '2 Areas/Health/a.md');
		expect(plugin.settings.sweepApprovals[0].dispositions[0].filed).toBe('done');
	});

	it('never overwrites a note of the same name', async () => {
		files.set('2 Areas/Health/a.md', createTFile('2 Areas/Health/a.md'));
		const plugin = pluginWith([record([task('exported')], [{ sourcePath: '0 Inbox/a.md', sourceHash: 'any', markSwept: true, filing: { type: 'move', folder: '2 Areas/Health' } }])]);
		await runPendingFiling(plugin as never);
		expect(renameFile).not.toHaveBeenCalled();
		expect(plugin.settings.sweepApprovals[0].dispositions[0].filed).toBe('skipped');
	});

	it('leaves a protected destination alone', async () => {
		const plugin = pluginWith([record([task('exported')], [{ sourcePath: '0 Inbox/a.md', sourceHash: 'any', markSwept: true, filing: { type: 'move', folder: '2 Areas/Health' } }])], ['2 Areas/Health']);
		await runPendingFiling(plugin as never);
		expect(renameFile).not.toHaveBeenCalled();
		expect(plugin.settings.sweepApprovals[0].dispositions[0].filed).toBe('skipped');
	});

	it('marks a blocked filing skipped without touching the note', async () => {
		const plugin = pluginWith([record([task('failed', '0 Inbox/a.md', 'conflict')], [trash('0 Inbox/a.md', await hashOf('Call the dentist'))])]);
		await runPendingFiling(plugin as never);
		expect(trashFile).not.toHaveBeenCalled();
		expect(plugin.settings.sweepApprovals[0].dispositions[0].filed).toBe('skipped');
	});
});
