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

import {
	dropAlreadyReported,
	isReportedItem,
	reportedMatch,
	itemKeys,
	legacyTaskKeys,
	MAX_REPORTED_KEYS_PER_NOTE,
	normaliseItemText,
	newApproval,
	recordReportedItems,
	renameReportedItems,
	reportedKeysFor,
	type ApprovalRecord,
} from '../src/services/inboxSweep/sweepLedger';
import { estimateSweep, runSweep, type SweepDeps } from '../src/services/inboxSweep/sweepService';
import type { SweepPolicy } from '../src/services/inboxSweep/sweepGuard';
import { commitReview } from '../src/services/inboxSweep/sweepCommit';
import { DEFAULT_SETTINGS, migrateOldSettings } from '../src/core/settings';
import { ok } from '../src/core/result';
import { en } from '../src/i18n/en';
import { TFile } from './mocks/obsidian';

const id = (n: number): string => `aio-${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;

describe('item identity keys', () => {
	it('normalise case, punctuation and spacing', () => {
		expect(normaliseItemText('  Call   the plumber!! (Thursday) ')).toBe('call the plumber thursday');
		expect(normaliseItemText('É déjà vu')).toBe('é déjà vu');
	});

	it('are quote|wording pairs, one per wording (model and edited)', () => {
		const keys = itemKeys({ text: 'Draft the migration plan', evidence: 'I need to draft the migration plan', edited: 'Draft migration plan v2' });
		expect(keys).toEqual(['i need to draft the migration plan|draft the migration plan', 'i need to draft the migration plan|draft migration plan v2']);
	});

	it('an edited text equal to the model text adds no duplicate key, and empty wordings are dropped', () => {
		expect(itemKeys({ text: 'A b', evidence: 'x y', edited: 'a b' })).toEqual(['x y|a b']);
		expect(itemKeys({ text: '!!!', evidence: '...' })).toEqual([]);
	});

	it('long texts keep their whole identity (no shared-prefix collapse at 160 characters)', () => {
		const prefix = 'prepare the quarterly review pack for the board including '.repeat(4);
		const a = itemKeys({ text: prefix + 'revenue', evidence: 'q' });
		const b = itemKeys({ text: prefix + 'headcount', evidence: 'q2' });
		expect(prefix.length).toBeGreaterThan(160);
		expect(isReportedItem(new Set(a), b)).toBe(false);
		expect(isReportedItem(new Set(a), a)).toBe(true);
	});
});

describe('normalisation length', () => {
	it('text that NFKC lengthens keeps its identity (the cap is on the text as written)', () => {
		const ligatures = 'ﬃ'.repeat(200); // 200 characters written, 600 after NFKC
		const a = itemKeys({ text: `${ligatures}a`, evidence: 'q' });
		const b = itemKeys({ text: `${ligatures}b`, evidence: 'q' });
		expect(normaliseItemText(`${ligatures}a`).length).toBeGreaterThan(400);
		expect(isReportedItem(new Set(a), b)).toBe(false);
		expect(isReportedItem(new Set(a), a)).toBe(true);
	});
});

describe('isReportedItem', () => {
	const known = new Set(itemKeys({ text: 'Draft the migration plan', evidence: 'I need to draft the migration plan' }));

	it('same wording matches whatever the quote', () => {
		expect(isReportedItem(known, itemKeys({ text: 'Draft the migration plan!', evidence: 'something else' }))).toBe(true);
	});

	it('the same quote with reworded but similar text is only "similar": flagged for the user, never enforced', () => {
		const reworded = itemKeys({ text: 'Write the migration plan', evidence: 'I need to draft the migration plan' });
		expect(reportedMatch(known, reworded)).toBe('similar');
		expect(isReportedItem(known, reworded)).toBe(false);
	});

	it('two commitments from one sentence are never "exact", even when their wording overlaps', () => {
		const both = 'Send the invoice to Alice and send the invoice to Bob';
		const first = new Set(itemKeys({ text: 'Send the invoice to Alice', evidence: both }));
		const second = itemKeys({ text: 'Send the invoice to Bob', evidence: both });
		expect(isReportedItem(first, second)).toBe(false); // never silently blocked
		expect(reportedMatch(first, second)).toBe('similar'); // but the user is told
		expect(reportedMatch(first, itemKeys({ text: 'Book the venue', evidence: both }))).toBeNull();
		expect(reportedMatch(first, itemKeys({ text: 'Send the invoice to Alice', evidence: both }))).toBe('exact');
	});

	it('a different quote with different wording does not match, and nothing known means nothing matches', () => {
		expect(isReportedItem(known, itemKeys({ text: 'Book the venue', evidence: 'book the venue' }))).toBe(false);
		expect(isReportedItem(new Set(), itemKeys({ text: 'x y', evidence: 'x y' }))).toBe(false);
	});
});

describe('legacy keys (tasks reported before keys existed)', () => {
	it('are wording-only and drop the kind prefix and a trailing (who)', () => {
		expect(legacyTaskKeys('Waiting: Priya to send the revised SOW (Priya)')).toEqual(['|priya to send the revised sow priya', '|priya to send the revised sow']);
		expect(legacyTaskKeys('Someday: Look at a data catalogue tool')).toEqual(['|look at a data catalogue tool']);
		expect(legacyTaskKeys('Draft the migration plan')).toEqual(['|draft the migration plan']);
	});

	it('keep a parenthesis the user wrote; only a waiting-for item can have had "(who)" appended', () => {
		expect(legacyTaskKeys('Call Dana (re budget)')).toEqual(['|call dana re budget']);
		expect(legacyTaskKeys('Project: Move house (phase 2)')).toEqual(['|move house phase 2']);
	});
});

function record(tasks: Array<{ n: number; text: string; path?: string; keys?: string[]; state?: 'reported' | 'failed' | 'approved' }>): ApprovalRecord {
	const base = newApproval({
		runId: 'run-a',
		now: '2026-10-25T00:00:00.000Z',
		reportPath: 'Report.md',
		tasks: tasks.map((t) => ({ id: id(t.n), text: t.text, context: '', sourcePath: t.path ?? 'Inbox/a.md', sourceHash: 'h', keys: t.keys })),
		dispositions: [],
	});
	return { ...base, tasks: base.tasks.map((t, i) => ({ ...t, state: tasks[i].state ?? 'reported' })) };
}

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

// ─── runSweep: the proposals carry the flag ─────────────────────────────────

const policy = (): SweepPolicy => ({ excludedFolders: [], excludedTags: [], excludedProperties: [], excludedTerms: [], protectedFolders: [], maxNoteChars: 20_000 });

function sweepDeps(text: string, reportedKeys?: SweepDeps['reportedKeys']): SweepDeps {
	const answer = JSON.stringify({ gtd_processing: {
		next_actions: [
			{ text: 'Draft the migration plan', context: '@computer', evidence: 'I need to draft the migration plan' },
			{ text: 'Call Dana about the room', context: '', evidence: 'Dana to confirm the room' },
		],
		waiting_for: [], projects: [], someday_maybe: [],
	} });
	return {
		candidates: () => ['Inbox/a.md'],
		readText: async () => text,
		complete: async () => ok(answer),
		policy,
		ledger: () => ({}),
		reportedKeys,
	};
}

const NOTE = '- I need to draft the migration plan\n- Dana to confirm the room\n';

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

// ─── commit: the same item never reaches the report or the export twice ─────

function makePlugin(over: Record<string, unknown> = {}) {
	const vault = new Map<string, string>();
	let failSave = 0;
	const settings = { ...structuredClone(DEFAULT_SETTINGS), sweepInboxFolders: ['Inbox'], sweepNothingToExclude: true, ...over } as typeof DEFAULT_SETTINGS;
	const plugin = {
		__vault: vault,
		t: en,
		settings,
		app: {
			vault: {
				getAbstractFileByPath: (p: string) => { if (vault.has(p)) { const f = new TFile(); f.path = p; return f; } return null; },
				read: async (f: { path: string }) => vault.get(f.path) ?? '',
				create: async (p: string, c: string) => { vault.set(p, c); },
				createFolder: async () => undefined,
			},
		},
		saveSettings: async () => { if (failSave > 0) { failSave--; throw new Error('disk full'); } },
		secretStorageService: { getSecret: async () => 'S', setSecret: async () => undefined },
	};
	return { plugin: plugin as never, vault, settings, failNextSaves(n: number) { failSave = n; } };
}

const task = (n: number, text: string, evidence: string, path = 'Inbox/a.md') => ({ id: id(n), text, context: '', sourcePath: path, sourceHash: 'h', keys: itemKeys({ text, evidence, edited: text }) });
const lines = (report: string) => report.split('\n').filter((l) => l.startsWith('- [ ]'));

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
