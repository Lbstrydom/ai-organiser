/**
 * A commit that is interrupted by a rename or a failed save never overwrites what a rename remapped meanwhile.
 */
import { describe, it, expect, vi } from 'vitest';

// The note-edit seam has its own tests; here it applies the transform to the stored text.
vi.mock('../src/services/noteEdit/applyNoteEdit', () => ({
	applyNoteEdit: async (plugin: { __vault: Map<string, string> }, target: { filePath: string; recompute: (c: string) => { ok: boolean; value?: { content: string }; error?: string } }) => {
		const current = plugin.__vault.get(target.filePath) ?? '';
		const res = target.recompute(current);
		if (!res.ok) return { ok: false, error: res.error };
		plugin.__vault.set(target.filePath, res.value!.content);
		return { ok: true, value: undefined };
	},
}));

import { renameApprovals, itemKeys } from '../src/services/inboxSweep/sweepLedger';
import { commitReview } from '../src/services/inboxSweep/sweepCommit';
import { id, lines, makePlugin, record, task } from './helpers/sweepReofferFixtures';

describe('commitReview under renames and failed saves', () => {
	it('a failed ledger save does not overwrite a map that a rename replaced meanwhile', async () => {
		const h = makePlugin();
		let calls = 0;
		const original = (h.plugin as unknown as { saveSettings: () => Promise<void> }).saveSettings;
		(h.plugin as unknown as { saveSettings: () => Promise<void> }).saveSettings = async () => {
			calls++;
			if (calls === 3) { h.settings.sweepReportedItems = { 'Archive/a.md': ['q|renamed'] }; throw new Error('disk full'); }
			await original();
		};
		await commitReview(h.plugin, { tasks: [task(1, 'Draft the migration plan', 'I need to draft the migration plan')], dispositions: [] });
		expect(h.settings.sweepReportedItems).toEqual({ 'Archive/a.md': ['q|renamed'] });
	});

	it('a note renamed while the commit is in flight: keys and ledger land under the new path', async () => {
		const h = makePlugin();
		let calls = 0;
		const original = (h.plugin as unknown as { saveSettings: () => Promise<void> }).saveSettings;
		(h.plugin as unknown as { saveSettings: () => Promise<void> }).saveSettings = async () => {
			calls++;
			if (calls === 2) { // the report is written and reported: the vault renames Inbox -> Archive now
				h.settings.sweepApprovals = renameApprovals(h.settings.sweepApprovals, 'Inbox', 'Archive').records;
			}
			await original();
		};
		await commitReview(h.plugin, { tasks: [task(1, 'Draft the migration plan', 'I need to draft the migration plan')], dispositions: [{ sourcePath: 'Inbox/a.md', sourceHash: 'h', markSwept: true }] });
		expect(Object.keys(h.settings.sweepReportedItems)).toEqual(['Archive/a.md']);
		expect(Object.keys(h.settings.sweepLedger)).toEqual(['Archive/a.md']);
		expect(h.settings.sweepApprovals[0].tasks[0].sourcePath).toBe('Archive/a.md');
	});

	it('a note renamed while the report note is being written keeps its new path in the saved record', async () => {
		const h = makePlugin();
		const vaultApi = (h.plugin as unknown as { app: { vault: { create: (p: string, c: string) => Promise<void> } } }).app.vault;
		const create = vaultApi.create;
		vaultApi.create = async (p, c) => {
			h.settings.sweepApprovals = renameApprovals(h.settings.sweepApprovals, 'Inbox', 'Archive').records;
			await create(p, c);
		};
		await commitReview(h.plugin, { tasks: [task(1, 'Draft the migration plan', 'I need to draft the migration plan')], dispositions: [] });
		expect(h.settings.sweepApprovals[0].tasks[0].sourcePath).toBe('Archive/a.md');
		expect(Object.keys(h.settings.sweepReportedItems)).toEqual(['Archive/a.md']);
	});

	it('a failed ledger save does not overwrite a ledger a rename remapped meanwhile', async () => {
		const h = makePlugin();
		let calls = 0;
		const original = (h.plugin as unknown as { saveSettings: () => Promise<void> }).saveSettings;
		(h.plugin as unknown as { saveSettings: () => Promise<void> }).saveSettings = async () => {
			calls++;
			if (calls === 3) { h.settings.sweepLedger = { 'Archive/a.md': { sha256: 'x', sweptAt: 't', runId: 'r' } }; throw new Error('disk full'); }
			await original();
		};
		await commitReview(h.plugin, { tasks: [task(1, 'Draft the migration plan', 'I need to draft the migration plan')], dispositions: [{ sourcePath: 'Inbox/a.md', sourceHash: 'h', markSwept: true }] });
		expect(Object.keys(h.settings.sweepLedger)).toEqual(['Archive/a.md']);
	});

	it('restores the ledger AND the keys when the ledger step cannot be saved', async () => {
		const h = makePlugin();
		// Saves: 1 persist, 2 reported, 3 ledger. Fail the third.
		let calls = 0;
		const original = (h.plugin as unknown as { saveSettings: () => Promise<void> }).saveSettings;
		(h.plugin as unknown as { saveSettings: () => Promise<void> }).saveSettings = async () => { calls++; if (calls === 3) throw new Error('disk full'); await original(); };
		const out = await commitReview(h.plugin, { tasks: [task(1, 'Draft the migration plan', 'I need to draft the migration plan')], dispositions: [{ sourcePath: 'Inbox/a.md', sourceHash: 'h', markSwept: true }] });
		expect(out).toMatchObject({ stoppedAt: 'ledger', error: 'write-failed' });
		expect(h.settings.sweepLedger).toEqual({});
		expect(h.settings.sweepReportedItems).toEqual({});
	});
});
