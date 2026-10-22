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

import { checkSource, commitReview, finishRecord, repairApprovals, sendApproved, sweepPolicy } from '../src/services/inboxSweep/sweepCommit';
import { DEFAULT_SETTINGS, migrateOldSettings } from '../src/core/settings';
import { sweepBlocker } from '../src/commands/inboxSweepCommands';
import { markReported, newApproval, type ApprovalRecord } from '../src/services/inboxSweep/sweepLedger';
import { findSection, renderSection } from '../src/services/inboxSweep/sweepReport';
import { sha256Hex } from '../src/services/attachmentDuplicateService';
import { en } from '../src/i18n/en';
import { TFile } from './mocks/obsidian';

const id = (n: number): string => `aio-${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
const hash = (t: string): Promise<string> => sha256Hex(new TextEncoder().encode(t).buffer);

function makePlugin(over: Record<string, unknown> = {}, notes: Record<string, string> = {}) {
	const vault = new Map<string, string>(Object.entries(notes));
	const created: string[] = [];
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
				create: async (p: string, c: string) => { vault.set(p, c); created.push(p); },
				createFolder: async () => undefined,
			},
		},
		saveSettings: async () => { if (failSave > 0) { failSave--; throw new Error('disk full'); } },
		secretStorageService: { getSecret: async () => 'S', setSecret: async () => undefined },
	};
	return { plugin: plugin as never, vault, created, failNextSaves(n: number) { failSave = n; }, settings };
}

const input = (n = 2) => ({
	tasks: Array.from({ length: n }, (_, i) => ({ id: id(i), text: `Task ${i}`, context: '@home', sourcePath: `Inbox/n${i}.md`, sourceHash: `h${i}` })),
	dispositions: [{ sourcePath: 'Inbox/n0.md', sourceHash: 'h0', markSwept: true }, { sourcePath: 'Inbox/n1.md', sourceHash: 'h1', markSwept: false }],
});

describe('commitReview (the outbox)', () => {
	it('persists first, writes the report section, then reports the items and applies the dispositions', async () => {
		const h = makePlugin();
		const out = await commitReview(h.plugin, input());
		expect(out.error).toBeUndefined();
		expect(out.record).toMatchObject({ reportDone: true, ledgerDone: true });
		expect(out.record.tasks.map((t) => t.state)).toEqual(['reported', 'reported']);
		const report = h.vault.get('Inbox sweep report.md')!;
		expect(report).toContain('# Inbox sweep report');
		expect(findSection(report, out.record.runId)).toMatchObject({ state: 'ok', ids: [id(0), id(1)] });
		expect(Object.keys(h.settings.sweepLedger)).toEqual(['Inbox/n0.md']); // exactly the user's disposition
		expect(h.settings.sweepApprovals).toHaveLength(1);
	});

	it('appends a new section to an existing report and keeps the user\'s text', async () => {
		const h = makePlugin({}, { 'Inbox sweep report.md': '# My report\n\nMy words.\n' });
		await commitReview(h.plugin, input(1));
		const report = h.vault.get('Inbox sweep report.md')!;
		expect(report.startsWith('# My report\n\nMy words.\n')).toBe(true);
		expect(report).toContain('Task 0');
	});

	it('with zero approved tasks writes no section and only updates the ledger', async () => {
		const h = makePlugin();
		const out = await commitReview(h.plugin, { tasks: [], dispositions: [{ sourcePath: 'Inbox/a.md', sourceHash: 'ha', markSwept: true }] });
		expect(out.record.reportDone).toBe(true);
		expect(h.vault.has('Inbox sweep report.md')).toBe(false);
		expect(h.created).toEqual([]);
		expect(h.settings.sweepLedger['Inbox/a.md']).toMatchObject({ sha256: 'ha' });
	});

	it('keeps the record when it cannot be saved, and writes nothing', async () => {
		const h = makePlugin();
		h.failNextSaves(1);
		const out = await commitReview(h.plugin, input());
		expect(out).toMatchObject({ stoppedAt: 'persist', error: 'write-failed' });
		expect(h.vault.has('Inbox sweep report.md')).toBe(false);
	});

	it('refuses an unusable or protected report path before anything is written', async () => {
		for (const path of ['', 'notes.txt', '../escape.md', '.hidden/r.md']) {
			const h = makePlugin({ sweepReportPath: path });
			const out = await commitReview(h.plugin, input(1));
			expect(out.stoppedAt, path).toBe('persist');
			expect(h.vault.size).toBe(0);
		}
		const protectedH = makePlugin({ sweepReportPath: 'Course/report.md', protectedFolders: ['Course'] });
		expect((await commitReview(protectedH.plugin, input(1))).error).toBe('protected-path');
		expect(protectedH.vault.size).toBe(0);
	});

	it('never modifies a source note', async () => {
		const h = makePlugin({}, { 'Inbox/n0.md': 'source text', 'Inbox/n1.md': 'other' });
		await commitReview(h.plugin, input());
		expect(h.vault.get('Inbox/n0.md')).toBe('source text');
		expect(h.vault.get('Inbox/n1.md')).toBe('other');
	});
});

describe('durability: the live settings only keep what was saved', () => {
	it('puts the approvals back when the first save fails, so recovery never reads an unsaved checkpoint', async () => {
		const h = makePlugin();
		h.failNextSaves(1);
		const out = await commitReview(h.plugin, input());
		expect(out.stoppedAt).toBe('persist');
		expect(h.settings.sweepApprovals).toEqual([]);
		expect(await repairApprovals(h.plugin)).toEqual({ repaired: 0 }); // nothing to repair: nothing was recorded
		expect(h.vault.has('Inbox sweep report.md')).toBe(false);
	});

	it('keeps the report step undone when its checkpoint cannot be saved, and finishes it next time without a second section', async () => {
		const h = makePlugin();
		const flaky = h.plugin as unknown as { saveSettings: () => Promise<void> };
		const real = flaky.saveSettings;
		let calls = 0;
		flaky.saveSettings = async () => { if (++calls === 2) throw new Error('disk full'); return real(); }; // 1: record, 2: reported checkpoint
		const out = await commitReview(h.plugin, input());
		expect(out).toMatchObject({ stoppedAt: 'report', error: 'write-failed' });
		expect(h.settings.sweepApprovals[0]).toMatchObject({ reportDone: false });
		const report = h.vault.get('Inbox sweep report.md')!;
		expect(findSection(report, out.record.runId)).toMatchObject({ state: 'ok' });
		flaky.saveSettings = real;
		expect(await repairApprovals(h.plugin)).toEqual({ repaired: 1 });
		expect(h.vault.get('Inbox sweep report.md')).toBe(report); // the section was found, not written again
		expect(h.settings.sweepApprovals[0]).toMatchObject({ reportDone: true, ledgerDone: true });
	});

	it('does not mark notes swept when the ledger checkpoint cannot be saved', async () => {
		const h = makePlugin();
		const flaky = h.plugin as unknown as { saveSettings: () => Promise<void> };
		const real = flaky.saveSettings;
		let calls = 0;
		flaky.saveSettings = async () => { if (++calls === 3) throw new Error('disk full'); return real(); }; // 3: the ledger step
		const out = await commitReview(h.plugin, input());
		expect(out).toMatchObject({ stoppedAt: 'ledger', error: 'write-failed' });
		expect(h.settings.sweepLedger).toEqual({});
		flaky.saveSettings = real;
		await repairApprovals(h.plugin);
		expect(Object.keys(h.settings.sweepLedger)).toEqual(['Inbox/n0.md']);
	});

	it('returns a typed failure, never a rejection, when the report cannot be read', async () => {
		const h = makePlugin({}, { 'Inbox sweep report.md': 'x' });
		const vault = (h.plugin as unknown as { app: { vault: { read: () => Promise<string> } } }).app.vault;
		vault.read = async () => { throw new Error('permission denied'); };
		const out = await commitReview(h.plugin, input());
		expect(out.error).toBeDefined();
		expect(h.settings.sweepApprovals[0]).toMatchObject({ reportDone: false });
	});
});

describe('recovery', () => {
	async function crashedAfterPersist(h: ReturnType<typeof makePlugin>): Promise<ApprovalRecord> {
		const rec = newApproval({ runId: 'run-crash12', now: '2026-10-22T00:00:00Z', reportPath: 'Inbox sweep report.md', tasks: input().tasks, dispositions: input().dispositions });
		h.settings.sweepApprovals.push(rec);
		return rec;
	}

	it('redoes a report step that never happened', async () => {
		const h = makePlugin();
		await crashedAfterPersist(h);
		const out = await repairApprovals(h.plugin);
		expect(out).toEqual({ repaired: 1 });
		expect(h.settings.sweepApprovals[0]).toMatchObject({ reportDone: true, ledgerDone: true });
		expect(findSection(h.vault.get('Inbox sweep report.md')!, 'run-crash12')).toMatchObject({ state: 'ok', ids: [id(0), id(1)] });
	});

	it('does not write the section twice when the crash came after the report step', async () => {
		const h = makePlugin();
		const rec = await crashedAfterPersist(h);
		const section = renderSection(rec.runId, rec.createdAt, rec.tasks.map((t) => ({ id: t.id, text: t.text, context: t.context, sourcePath: t.sourcePath })));
		if (!section.ok) throw new Error('setup');
		h.vault.set('Inbox sweep report.md', `# Report\n\n${section.value}\n`);
		const before = h.vault.get('Inbox sweep report.md');
		await repairApprovals(h.plugin);
		expect(h.vault.get('Inbox sweep report.md')).toBe(before);
		expect(h.settings.sweepApprovals[0].reportDone).toBe(true);
	});

	it('stops with a conflict, naming the note, when the section is partial or damaged, and writes nothing', async () => {
		const h = makePlugin();
		const rec = await crashedAfterPersist(h);
		const partial = renderSection(rec.runId, rec.createdAt, [{ id: id(0), text: 'Task 0', context: '', sourcePath: 'Inbox/n0.md' }]);
		if (!partial.ok) throw new Error('setup');
		const text = `# Report\n\n${partial.value}\n`;
		h.vault.set('Inbox sweep report.md', text);
		const out = await repairApprovals(h.plugin);
		expect(out).toEqual({ repaired: 0, error: 'sweep-report-conflict', path: 'Inbox sweep report.md' });
		expect(h.vault.get('Inbox sweep report.md')).toBe(text);
		expect(h.settings.sweepApprovals[0].reportDone).toBe(false);
		expect(Object.keys(h.settings.sweepLedger)).toEqual([]);
	});

	it('finishing a record is repeatable', async () => {
		const h = makePlugin();
		const out = await commitReview(h.plugin, input());
		const again = await finishRecord(h.plugin, out.record);
		expect(again.error).toBeUndefined();
		expect(Object.keys(h.settings.sweepLedger)).toEqual(['Inbox/n0.md']);
	});
});

describe('guard at export time', () => {
	it('reports ok, changed, missing and excluded from the current source note', async () => {
		const text = 'I must ship the report.';
		const h = makePlugin({}, { 'Inbox/a.md': text });
		const sourceHash = await hash(text);
		expect(await checkSource(h.plugin, 'Inbox/a.md', sourceHash)).toBe('ok');
		expect(await checkSource(h.plugin, 'Inbox/a.md', 'stale')).toBe('changed');
		expect(await checkSource(h.plugin, 'Inbox/gone.md', sourceHash)).toBe('missing');
		const excluded = makePlugin({ sweepExcludedTerms: ['ship the report'] }, { 'Inbox/a.md': text });
		expect(await checkSource(excluded.plugin, 'Inbox/a.md', sourceHash)).toBe('excluded');
		const moved = makePlugin({ sweepExcludedFolders: ['Inbox'] }, { 'Inbox/a.md': text });
		expect(await checkSource(moved.plugin, 'Inbox/a.md', sourceHash)).toBe('excluded');
	});
});

describe('sendApproved', () => {
	it('refuses when the export is off, no list is chosen or the link is not valid', async () => {
		const off = makePlugin();
		expect(await sendApproved(off.plugin)).toEqual({ ok: false, error: 'tasks-not-ready' });
		const flags = { featureFlags: { 'inbox-sweep': true, 'google-tasks-export': true } };
		const noList = makePlugin({ ...flags });
		expect(await sendApproved(noList.plugin)).toEqual({ ok: false, error: 'tasks-no-list' });
		const badUrl = makePlugin({ ...flags, tasksListId: 'L', tasksScriptUrl: 'https://evil.example.com/x' });
		expect(await sendApproved(badUrl.plugin)).toEqual({ ok: false, error: 'script-invalid-endpoint' });
	});

	it('sends nothing when nothing is waiting', async () => {
		const h = makePlugin({ featureFlags: { 'inbox-sweep': true, 'google-tasks-export': true }, tasksListId: 'L', tasksScriptUrl: 'https://script.google.com/macros/s/AKfycbxTEST/exec' });
		const res = await sendApproved(h.plugin);
		expect(res).toMatchObject({ ok: true, value: { exported: 0, pending: 0 } });
	});

	it('reuses markReported so only reported items are ever offered', () => {
		const rec = newApproval({ runId: 'run-x12345', now: 'T', reportPath: 'R.md', tasks: input().tasks, dispositions: [] });
		expect(markReported(rec).tasks.every((t) => t.state === 'reported')).toBe(true);
	});
});

const withLlm = (h: { plugin: unknown }, llmService: unknown): never => ({ ...(h.plugin as object), llmService }) as never;

describe('preconditions (fail closed)', () => {
	const flags = { featureFlags: { 'inbox-sweep': true } };

	it('names the first thing missing', () => {
		expect(sweepBlocker(makePlugin({ sweepInboxFolders: [] }).plugin as never)).toBe('sweep-no-folders');
		expect(sweepBlocker(withLlm(makePlugin({ sweepNothingToExclude: false }), {}))).toBe('sweep-keepout-required');
		expect(sweepBlocker(withLlm(makePlugin({ sweepReportPath: 'x.txt' }), {}))).toBe('sweep-report-invalid');
		expect(sweepBlocker(withLlm(makePlugin(flags), undefined))).toBe('sweep-no-provider');
		expect(sweepBlocker(withLlm(makePlugin(flags), {}))).toBeNull();
	});

	it('any single exclusion rule satisfies the keep-out requirement', () => {
		for (const rule of [{ sweepExcludedFolders: ['P'] }, { sweepExcludedTags: ['t'] }, { sweepExcludedProperties: ['k: v'] }, { sweepExcludedTerms: ['w'] }]) {
			expect(sweepBlocker(withLlm(makePlugin({ sweepNothingToExclude: false, ...rule }), {}))).toBeNull();
		}
	});

	it('builds the policy from the settings, with protected folders included', () => {
		const h = makePlugin({ sweepExcludedTags: ['work'], protectedFolders: ['Course'] });
		expect(sweepPolicy(h.plugin)).toMatchObject({ excludedTags: ['work'], protectedFolders: ['Course'] });
	});
});

describe('settings migration for the sweep', () => {
	it('keeps a lone exclusion string, drops bad ledger and approval entries, and clamps limits', () => {
		const out = migrateOldSettings({
			sweepExcludedTerms: ' Falcon ',
			sweepExcludedTags: ['a', 3, ''],
			sweepMaxNotes: 0,
			sweepMaxChars: 'many',
			sweepLedger: { 'Inbox/a.md': { sha256: 'h', sweptAt: 'T', runId: 'r' }, bad: { sha256: 1 }, worse: null },
			sweepApprovals: [{ runId: 'run-1', createdAt: 'T', reportPath: 'R.md', tasks: [{ id: 'aio-1', text: 't', sourcePath: 'a', sourceHash: 'h', state: 'reported' }, { id: 'x' }], dispositions: [{ sourcePath: 'a', sourceHash: 'h', markSwept: true }, 5] }, 'junk', { runId: 3 }],
			tasksLastTest: { ok: 'yes' },
		}) as Record<string, unknown>;
		expect(out.sweepExcludedTerms).toEqual(['Falcon']);
		expect(out.sweepExcludedTags).toEqual(['a']);
		expect(out.sweepMaxNotes).toBe(1);
		expect(out.sweepMaxChars).toBe(12000);
		expect(Object.keys(out.sweepLedger as object)).toEqual(['Inbox/a.md']);
		// The record with an unusable task and disposition is dropped as a whole, not kept in halves.
		expect(out.sweepApprovals as ApprovalRecord[]).toEqual([]);
		expect(out.tasksLastTest).toBeNull();
	});

	it('keeps a complete record intact', () => {
		const rec = { runId: 'run-1', createdAt: 'T', reportPath: 'R.md', reportDone: false, ledgerDone: false, tasks: [{ id: 'aio-1', text: 't', context: '', sourcePath: 'a', sourceHash: 'h', state: 'reported' }], dispositions: [{ sourcePath: 'a', sourceHash: 'h', markSwept: true }] };
		const out = migrateOldSettings({ sweepApprovals: [rec] }) as Record<string, unknown>;
		expect((out.sweepApprovals as ApprovalRecord[])[0]).toMatchObject({ runId: 'run-1', tasks: [{ id: 'aio-1' }], dispositions: [{ sourcePath: 'a' }] });
	});

	it('is idempotent', () => {
		const once = migrateOldSettings({ sweepExcludedTerms: 'x' }) as Record<string, unknown>;
		expect(migrateOldSettings(structuredClone(once))).toEqual(once);
	});
});
