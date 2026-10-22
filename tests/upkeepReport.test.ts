import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/services/noteEdit/applyNoteEdit', () => ({
	applyNoteEdit: async (plugin: { __vault: Map<string, string> }, target: { filePath: string; baseline: string; nextContent: string }) => {
		if ((plugin.__vault.get(target.filePath) ?? '') !== target.baseline) return { ok: false, error: 'baseline-changed' };
		plugin.__vault.set(target.filePath, target.nextContent);
		return { ok: true, value: undefined };
	},
}));

import { REPORT_FILE_NAME, REPORT_SIGNATURE, literal, renderReport, reportPathFor, saveReport } from '../src/services/upkeep/upkeepReport';
import { DEFAULT_SETTINGS } from '../src/core/settings';
import type { Proposal, RunSummary } from '../src/services/upkeep/upkeepTasks';
import { TFile } from './mocks/obsidian';

const summary = (over: Partial<RunSummary> = {}): RunSummary => ({
	startedAt: '2026-10-22T08:00:00.000Z', durationMs: 1200, trigger: 'manual', status: 'ok', totals: {},
	outcomes: [{ task: 'agentIndex', status: 'ok', counts: {}, omitted: 0 }], ...over,
});

describe('reportPathFor', () => {
	it('puts the report in the chosen folder, or the vault root', () => {
		expect(reportPathFor('Reports', [])).toEqual({ ok: true, value: `Reports/${REPORT_FILE_NAME}` });
		expect(reportPathFor('', [])).toEqual({ ok: true, value: REPORT_FILE_NAME });
		expect(reportPathFor(' Notes\\Upkeep ', [])).toEqual({ ok: true, value: `Notes/Upkeep/${REPORT_FILE_NAME}` });
	});

	it.each(['/abs', 'C:/x', '../out', '.hidden', 'a/.b'])('refuses %j', (folder) => {
		expect(reportPathFor(folder, []).ok).toBe(false);
	});

	it('refuses a protected folder', () => {
		expect(reportPathFor('Course', ['Course'])).toEqual({ ok: false, error: 'protected-path' });
		expect(reportPathFor('Other', ['Course']).ok).toBe(true);
	});
});

describe('renderReport', () => {
	const proposals: Proposal[] = [
		{ kind: 'agent-index-stale', added: 1, removed: 0, changed: 2, unreadable: 0, unstable: false },
		{ kind: 'link-suggestion', attachmentPath: 'F/garden.pdf', notePath: 'N/Garden plan.md', evidence: ['garden'] },
		{ kind: 'attachment-unreferenced', path: 'F/old\nname.png', sizeBytes: 3 },
	];

	it('starts with the signature, lists what was found, and carries no links', () => {
		const text = renderReport(summary(), proposals, 0);
		expect(text.split('\n')[0]).toBe(REPORT_SIGNATURE);
		expect(text).toContain('Run at 2026-10-22T08:00:00.000Z (ok).');
		expect(text).toContain('The agent index is out of date (1 added, 0 removed, 2 changed).');
		expect(text).toContain('` F/garden.pdf ` may belong with ` N/Garden plan.md `');
		expect(text).not.toMatch(/old\nname/); // a newline in a path cannot start a new line of the report
	});

	it('keeps link syntax in a name literal, so the report can never create a link', () => {
		const text = renderReport(summary(), [{ kind: 'attachment-unreferenced', path: 'Attachments/[[Existing note]].png', sizeBytes: 1 }, { kind: 'attachment-large', path: 'A/`tick`.pdf', sizeBytes: 1, referenceCount: 0 }], 0);
		expect(text).toContain('` Attachments/[[Existing note]].png `');
		expect(text).toContain('`` A/`tick`.pdf ``');
		expect(literal('a\nb')).toBe('` a b `');
	});

	it('says nothing to review for an empty ok run, and mentions omitted items', () => {
		expect(renderReport(summary(), [], 0)).toContain('Nothing to review.');
		expect(renderReport(summary(), proposals, 7)).toContain('7 more are not listed here.');
	});

	it('never says nothing to review for a run that did not finish', () => {
		const text = renderReport(summary({ status: 'failed', outcomes: [{ task: 'agentIndex', status: 'failed', reason: 'scan-incomplete', counts: {}, omitted: 0 }] }), [], 0);
		expect(text).not.toContain('Nothing to review.');
		expect(text).toContain('did not finish');
	});

	it('shows a failed or partial run as such', () => {
		const text = renderReport(summary({ status: 'partial', outcomes: [{ task: 'inventories', status: 'failed', reason: 'script-network', counts: {}, omitted: 0 }] }), [], 0);
		expect(text).toContain('(partial)');
		expect(text).toContain('inventories: failed (script-network)');
	});
});

function makePlugin(over: Record<string, unknown> = {}, notes: Record<string, string> = {}) {
	const vault = new Map<string, string>(Object.entries(notes));
	const created: string[] = [];
	const plugin = {
		__vault: vault,
		settings: { ...structuredClone(DEFAULT_SETTINGS), upkeepReportFolder: 'Reports', ...over },
		app: {
			vault: {
				getAbstractFileByPath: (p: string) => { if (vault.has(p)) { const f = new TFile(); f.path = p; return f; } return null; },
				read: async (f: { path: string }) => vault.get(f.path) ?? '',
				create: async (p: string, c: string) => { vault.set(p, c); created.push(p); },
				createFolder: async () => undefined,
			},
		},
	};
	return { plugin: plugin as never, vault, created };
}

describe('saveReport', () => {
	const PATH = `Reports/${REPORT_FILE_NAME}`;
	const text = `${REPORT_SIGNATURE}\n# Vault upkeep report\n`;

	it('creates the note when it is absent', async () => {
		const h = makePlugin();
		expect(await saveReport(h.plugin, text)).toEqual({ ok: true, value: PATH });
		expect(h.vault.get(PATH)).toBe(text);
	});

	it('replaces its own earlier report', async () => {
		const h = makePlugin({}, { [PATH]: `${REPORT_SIGNATURE}\nold\n` });
		expect(await saveReport(h.plugin, text)).toEqual({ ok: true, value: PATH });
		expect(h.vault.get(PATH)).toBe(text);
	});

	it('refuses, and leaves it untouched, a note of that name that is not its own', async () => {
		for (const existing of ['# My own notes\n', '\n' + REPORT_SIGNATURE + '\n', '']) {
			const h = makePlugin({}, { [PATH]: existing });
			expect(await saveReport(h.plugin, text)).toEqual({ ok: false, error: 'upkeep-report-not-ours' });
			expect(h.vault.get(PATH)).toBe(existing);
		}
	});

	it('refuses a protected or unusable folder before touching the vault', async () => {
		const protectedH = makePlugin({ protectedFolders: ['Reports'] });
		expect(await saveReport(protectedH.plugin, text)).toEqual({ ok: false, error: 'protected-path' });
		expect(protectedH.vault.size).toBe(0);
		const bad = makePlugin({ upkeepReportFolder: '../out' });
		expect(await saveReport(bad.plugin, text)).toEqual({ ok: false, error: 'upkeep-report-invalid' });
		expect(bad.vault.size).toBe(0);
	});
});
