/**
 * What is remembered about items already added to the sweep report: the key store, the sweep's flags and the settings.
 */
import { describe, it, expect } from 'vitest';
import {
	dropAlreadyReported,
	MAX_REPORTED_KEYS_PER_NOTE,
	recordReportedItems,
	renameReportedItems,
	reportedKeysFor,
} from '../src/services/inboxSweep/sweepLedger';
import { estimateSweep, runSweep } from '../src/services/inboxSweep/sweepService';
import { itemKeys } from '../src/services/inboxSweep/sweepLedger';
import { DEFAULT_SETTINGS, migrateOldSettings } from '../src/core/settings';
import { id, NOTE, record, sweepDeps } from './helpers/sweepReofferFixtures';

describe('reportedKeysFor / recordReportedItems / dropAlreadyReported', () => {
	it('unions stored keys, the keys of open records and the text of keyless legacy tasks, per note', () => {
		const rec = record([
			{ n: 1, text: 'Waiting: Priya to send SOW', path: 'Inbox/a.md' },
			{ n: 2, text: 'X', path: 'Inbox/a.md', keys: ['q|from record'] },
			{ n: 3, text: 'Other note task', path: 'Inbox/b.md' },
		]);
		const known = reportedKeysFor('Inbox/a.md', { 'Inbox/a.md': ['q|stored'] }, [rec]);
		expect([...known].sort()).toEqual(['q|from record', 'q|stored', '|priya to send sow']);
	});

	it('a task whose EXPORT failed is still in the report, so it still counts as reported', () => {
		const rec = record([{ n: 1, text: 'Call Dana', keys: ['q|call dana'], state: 'failed' }]);
		expect(reportedKeysFor('Inbox/a.md', {}, [rec]).has('q|call dana')).toBe(true);
		expect(recordReportedItems({}, rec)['Inbox/a.md']).toEqual(['q|call dana']);
		expect(dropAlreadyReported([{ sourcePath: 'Inbox/a.md', text: 'Call Dana', keys: ['q|call dana'] }], {}, [rec]).dropped).toBe(1);
	});

	it('records the items of a record, keeps order, caps the list and does not mutate the input', () => {
		const stored = { 'Inbox/a.md': ['q|old'] };
		const next = recordReportedItems(stored, record([{ n: 1, text: 'T', keys: ['q|new', 'q|old'] }]));
		expect(next['Inbox/a.md']).toEqual(['q|old', 'q|new']);
		expect(stored['Inbox/a.md']).toEqual(['q|old']);
		const many = record(Array.from({ length: MAX_REPORTED_KEYS_PER_NOTE + 20 }, (_, i) => ({ n: i, text: 'T', keys: [`q|k${i}`] })));
		const capped = recordReportedItems({}, many)['Inbox/a.md'];
		expect(capped).toHaveLength(MAX_REPORTED_KEYS_PER_NOTE);
		expect(capped[capped.length - 1]).toBe(`q|k${MAX_REPORTED_KEYS_PER_NOTE + 19}`);
	});

	it('drops tasks already reported from their note and repeats inside the batch, keeps new ones', () => {
		const tasks = [
			{ sourcePath: 'Inbox/a.md', text: 'Known', keys: ['q|known'], n: 1 },
			{ sourcePath: 'Inbox/b.md', text: 'Known', keys: ['q|known'], n: 2 }, // same key, different note: new
			{ sourcePath: 'Inbox/a.md', text: 'Fresh', keys: ['q|fresh'], n: 3 },
			{ sourcePath: 'Inbox/a.md', text: 'Fresh', keys: ['q|fresh', 'q|fresh again'], n: 4 }, // repeats the previous one
		];
		const { kept, dropped } = dropAlreadyReported(tasks, { 'Inbox/a.md': ['q|known'] }, []);
		expect(kept.map((t) => t.n)).toEqual([2, 3]);
		expect(dropped).toBe(2);
	});

	it('a dropped task adds nothing to the batch: its other wording does not block a later, different task', () => {
		const tasks = [
			{ sourcePath: 'Inbox/a.md', text: 'Known', keys: ['q|known', 'q|renamed by the user'], n: 1 }, // dropped: exact match on the first key
			{ sourcePath: 'Inbox/a.md', text: 'Renamed by the user', keys: ['other quote|renamed by the user'], n: 2 },
		];
		const { kept } = dropAlreadyReported(tasks, { 'Inbox/a.md': ['q|known'] }, []);
		expect(kept.map((t) => t.n)).toEqual([2]);
	});

	it('distinct commitments from one quoted sentence are all kept, in the batch and against what is known', () => {
		const q = 'call dana and book the venue';
		const tasks = [
			{ sourcePath: 'Inbox/a.md', text: 'Call Dana', keys: [`${q}|call dana`], n: 1 },
			{ sourcePath: 'Inbox/a.md', text: 'Book the venue', keys: [`${q}|book the venue`], n: 2 },
		];
		expect(dropAlreadyReported(tasks, {}, []).kept.map((t) => t.n)).toEqual([1, 2]);
		expect(dropAlreadyReported([tasks[1]], { 'Inbox/a.md': [`${q}|call dana`] }, []).kept.map((t) => t.n)).toEqual([2]);
	});

	it('a task without keys is judged by its text, so the guarantee holds for callers that skip the modal', () => {
		const rec = record([{ n: 1, text: 'Waiting: Priya to send the revised SOW (Priya)' }]);
		const tasks = [
			{ sourcePath: 'Inbox/a.md', text: 'Waiting: Priya to send the revised SOW', n: 1 },
			{ sourcePath: 'Inbox/a.md', text: 'Book the venue', n: 2 },
			{ sourcePath: 'Inbox/a.md', text: 'Book the venue', n: 3 },
		];
		const { kept, dropped } = dropAlreadyReported(tasks, {}, [rec]);
		expect(kept.map((t) => t.n)).toEqual([2]);
		expect(dropped).toBe(2);
	});

	it('renaming a note moves its keys with it', () => {
		const out = renameReportedItems({ 'Inbox/a.md': ['q|x'], 'Inbox/sub/b.md': ['q|y'] }, 'Inbox', 'Archive');
		expect(out.changed).toBe(true);
		expect(out.items).toEqual({ 'Archive/a.md': ['q|x'], 'Archive/sub/b.md': ['q|y'] });
		expect(renameReportedItems({ 'Elsewhere/a.md': ['q|x'] }, 'Inbox', 'Archive').changed).toBe(false);
	});
});

describe('runSweep flags items already reported from the note', () => {
	it('without known keys nothing is flagged', async () => {
		const res = await runSweep(sweepDeps(NOTE), { maxNotes: 5, maxChars: 12_000 });
		expect(res.ok && res.value.notes[0].reported).toEqual([false, false]);
	});

	it('an edited note: the old item is flagged, the new one is not', async () => {
		const known = new Set(itemKeys({ text: 'Draft the migration plan', evidence: 'I need to draft the migration plan' }));
		const res = await runSweep(sweepDeps(NOTE + '- extra line\n', () => known), { maxNotes: 5, maxChars: 12_000 });
		expect(res.ok && res.value.notes[0].items.map((i) => i.text)).toEqual(['Draft the migration plan', 'Call Dana about the room']);
		expect(res.ok && res.value.notes[0].reported).toEqual([true, false]);
	});

	it('the same quoted line with different but similar wording is flagged similar, not reported', async () => {
		const known = new Set(itemKeys({ text: 'Write the migration plan', evidence: 'I need to draft the migration plan' }));
		const res = await runSweep(sweepDeps(NOTE, () => known), { maxNotes: 5, maxChars: 12_000 });
		expect(res.ok && res.value.notes[0].reported).toEqual([false, false]);
		expect(res.ok && res.value.notes[0].similar).toEqual([true, false]);
	});

	it('estimateSweep is unaffected', async () => {
		const est = await estimateSweep(sweepDeps(NOTE), { maxNotes: 5, maxChars: 12_000 });
		expect(est.ok && est.value.notes).toBe(1);
	});
});

describe('settings', () => {
	it('defaults to an empty map and keeps well-formed keys on tasks', () => {
		expect(DEFAULT_SETTINGS.sweepReportedItems).toEqual({});
		const migrated = migrateOldSettings({
			sweepReportedItems: { 'Inbox/a.md': ['e:x', 5, 't:y'], 'Inbox/b.md': 'nope' },
			sweepApprovals: [{ runId: 'run-a', createdAt: 'x', reportPath: 'R.md', reportDone: true, ledgerDone: true, dispositions: [], tasks: [
				{ id: id(1), text: 'T', context: '', sourcePath: 'Inbox/a.md', sourceHash: 'h', state: 'reported', keys: ['e:x'] },
				{ id: id(2), text: 'U', context: '', sourcePath: 'Inbox/a.md', sourceHash: 'h', state: 'reported', keys: [1, 2] },
			] }],
		} as never) as unknown as typeof DEFAULT_SETTINGS;
		expect(migrated.sweepReportedItems).toEqual({ 'Inbox/a.md': ['e:x', 't:y'] });
		expect(migrated.sweepApprovals[0].tasks[0].keys).toEqual(['e:x']);
		expect(migrated.sweepApprovals[0].tasks[1].keys).toBeUndefined();
	});

	it('a settings file from before this change migrates to an empty map', () => {
		const migrated = migrateOldSettings({} as never) as unknown as typeof DEFAULT_SETTINGS;
		expect(migrated.sweepReportedItems).toEqual({});
	});
});
