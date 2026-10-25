/**
 * Shared builders for the sweep re-offer tests: approval records, sweep deps over one note, and a fake plugin
 * with an in-memory vault. The test files install the note-edit mock themselves (vi.mock is per file).
 */
import { newApproval, type ApprovalRecord } from '../../src/services/inboxSweep/sweepLedger';
import { itemKeys } from '../../src/services/inboxSweep/sweepItemIdentity';
import type { SweepDeps } from '../../src/services/inboxSweep/sweepService';
import type { SweepPolicy } from '../../src/services/inboxSweep/sweepGuard';
import { DEFAULT_SETTINGS } from '../../src/core/settings';
import { ok } from '../../src/core/result';
import { en } from '../../src/i18n/en';
import { TFile } from '../mocks/obsidian';

export const id = (n: number): string => `aio-${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;

export function record(tasks: Array<{ n: number; text: string; path?: string; keys?: string[]; state?: 'reported' | 'failed' | 'approved' }>): ApprovalRecord {
	const base = newApproval({
		runId: 'run-a',
		now: '2026-10-25T00:00:00.000Z',
		reportPath: 'Report.md',
		tasks: tasks.map((t) => ({ id: id(t.n), text: t.text, context: '', sourcePath: t.path ?? 'Inbox/a.md', sourceHash: 'h', keys: t.keys })),
		dispositions: [],
	});
	return { ...base, tasks: base.tasks.map((t, i) => ({ ...t, state: tasks[i].state ?? 'reported' })) };
}

export const policy = (): SweepPolicy => ({ excludedFolders: [], excludedTags: [], excludedProperties: [], excludedTerms: [], protectedFolders: [], maxNoteChars: 20_000 });

export function sweepDeps(text: string, reportedKeys?: SweepDeps['reportedKeys']): SweepDeps {
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

export const NOTE = '- I need to draft the migration plan\n- Dana to confirm the room\n';

export function makePlugin(over: Record<string, unknown> = {}) {
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

export const task = (n: number, text: string, evidence: string, path = 'Inbox/a.md') => ({ id: id(n), text, context: '', sourcePath: path, sourceHash: 'h', keys: itemKeys({ text, evidence, edited: text }) });
export const lines = (report: string) => report.split('\n').filter((l) => l.startsWith('- [ ]'));

