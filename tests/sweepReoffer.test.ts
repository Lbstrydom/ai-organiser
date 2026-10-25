/**
 * A note that is swept again after an edit offers every item in it once more. The items already added
 * to the sweep report must be recognisable, and must never reach the report or the export twice.
 * Found by the P-GTD persona test: 4 duplicate report lines and 10 Google tasks for 6 distinct items.
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

describe('commitReview with item identity', () => {
	it('records the keys of what it reports', async () => {
		const h = makePlugin();
		await commitReview(h.plugin, { tasks: [task(1, 'Draft the migration plan', 'I need to draft the migration plan')], dispositions: [] });
		expect(h.settings.sweepReportedItems['Inbox/a.md']).toEqual(['i need to draft the migration plan|draft the migration plan']);
	});

	it('a second commit of the same items writes no second report line and creates no task', async () => {
		const h = makePlugin();
		await commitReview(h.plugin, { tasks: [task(1, 'Draft the migration plan', 'I need to draft the migration plan'), task(2, 'Call Dana', 'Dana to confirm the room')], dispositions: [] });
		const before = h.vault.get('Inbox sweep report.md')!;
		expect(lines(before)).toHaveLength(2);

		const again = await commitReview(h.plugin, {
			tasks: [task(3, 'Draft the migration plan', 'I need to draft the migration plan'), task(4, 'Call Dana', 'Dana to confirm the room'), task(5, 'Book the venue', 'book the venue')],
			dispositions: [{ sourcePath: 'Inbox/a.md', sourceHash: 'h2', markSwept: true }],
		});
		expect(again.duplicates).toBe(2);
		expect(again.record.tasks.map((t) => t.text)).toEqual(['Book the venue']);
		const report = h.vault.get('Inbox sweep report.md')!;
		expect(lines(report)).toHaveLength(3);
		expect(report.match(/Draft the migration plan/g)).toHaveLength(1);
		// Only the new task can ever be exported.
		expect(h.settings.sweepApprovals.flatMap((r) => r.tasks).filter((t) => t.text.startsWith('Draft'))).toHaveLength(1);
	});

	it('an all-duplicate batch writes no section but still applies the disposition', async () => {
		const h = makePlugin();
		await commitReview(h.plugin, { tasks: [task(1, 'Draft the migration plan', 'I need to draft the migration plan')], dispositions: [] });
		const before = h.vault.get('Inbox sweep report.md');
		const out = await commitReview(h.plugin, { tasks: [task(2, 'Draft the migration plan', 'I need to draft the migration plan')], dispositions: [{ sourcePath: 'Inbox/a.md', sourceHash: 'h2', markSwept: true }] });
		expect(out.duplicates).toBe(1);
		expect(out.record.tasks).toEqual([]);
		expect(h.vault.get('Inbox sweep report.md')).toBe(before);
		expect(h.settings.sweepLedger['Inbox/a.md']).toMatchObject({ sha256: 'h2' });
	});

	it('recognises items reported by a release without keys, from the approval record it left', async () => {
		const legacy = record([{ n: 1, text: 'Waiting: Priya to send the revised SOW (Priya)' }, { n: 2, text: 'Draft the migration plan' }]);
		const h = makePlugin({ sweepApprovals: [{ ...legacy, reportDone: true, ledgerDone: true }] });
		const out = await commitReview(h.plugin, {
			tasks: [task(3, 'Priya to send the revised SOW', 'Priya to send the revised SOW by Friday'), task(4, 'Draft the migration plan', 'I need to draft the migration plan'), task(5, 'New thing', 'new thing')],
			dispositions: [],
		});
		expect(out.duplicates).toBe(2);
		expect(out.record.tasks.map((t) => t.text)).toEqual(['New thing']);
	});

	it('a caller that passes no keys cannot bypass the guard: the task text is checked', async () => {
		const h = makePlugin();
		await commitReview(h.plugin, { tasks: [task(1, 'Draft the migration plan', 'I need to draft the migration plan')], dispositions: [] });
		const out = await commitReview(h.plugin, { tasks: [{ id: id(2), text: 'Draft the migration plan', context: '', sourcePath: 'Inbox/a.md', sourceHash: 'h2' }], dispositions: [] });
		expect(out.duplicates).toBe(1);
		expect(lines(h.vault.get('Inbox sweep report.md')!)).toHaveLength(1);
	});

	it('two commitments from one quoted sentence are both added, and a re-sweep drops only the pair already added', async () => {
		const h = makePlugin();
		const q = 'Call Dana and book the venue';
		await commitReview(h.plugin, { tasks: [task(1, 'Call Dana', q), task(2, 'Book the venue', q)], dispositions: [] });
		expect(lines(h.vault.get('Inbox sweep report.md')!)).toHaveLength(2);
		const again = await commitReview(h.plugin, { tasks: [task(3, 'Call Dana', q), task(4, 'Book the venue', q), task(5, 'Send the invite', q)], dispositions: [] });
		expect(again.duplicates).toBe(2);
		expect(again.record.tasks.map((t) => t.text)).toEqual(['Send the invite']);
	});

	it('a reworded item (same quote, similar wording) is NOT blocked: the user was told and chose it', async () => {
		const h = makePlugin();
		await commitReview(h.plugin, { tasks: [task(1, 'Draft the migration plan', 'I need to draft the migration plan')], dispositions: [] });
		const out = await commitReview(h.plugin, { tasks: [task(2, 'Write the migration plan', 'I need to draft the migration plan')], dispositions: [] });
		expect(out.duplicates).toBeUndefined();
		expect(lines(h.vault.get('Inbox sweep report.md')!)).toHaveLength(2);
	});
});
