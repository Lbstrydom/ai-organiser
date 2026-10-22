import { describe, it, expect } from 'vitest';
import { evaluateSetup, toFolderSet } from '../src/core/setupState';
import { DEFAULT_SETTINGS } from '../src/core/settings';
import { tasksConfigKey } from '../src/commands/inboxSweepCommands';
import { validateReportPath } from '../src/services/inboxSweep/sweepReport';
import { GUIDANCE_CODES } from '../src/core/friendlyErrors';
import { en } from '../src/i18n/en';

const done = (id: string) => ({ featureSetupCompletedAt: { [id]: 'T' } });
const base = structuredClone(DEFAULT_SETTINGS) as unknown as Record<string, unknown>;

describe('setup state for the inbox sweep', () => {
	const configured = (over: Record<string, unknown> = {}) => ({ ...base, sweepInboxFolders: ['Inbox'], sweepReportPath: 'Report.md', ...done('inbox-sweep'), ...over });

	it('is not set up until the wizard finishes', () => {
		expect(evaluateSetup('inbox-sweep', { ...base, sweepInboxFolders: ['Inbox'] }).state).toBe('not-set-up');
		expect(evaluateSetup('inbox-sweep', configured({ featureSetupCompletedAt: {} })).state).toBe('not-set-up');
	});

	it('is ready when configured and its folders exist', () => {
		expect(evaluateSetup('inbox-sweep', configured(), { existingFolders: toFolderSet(['Inbox']) }).state).toBe('ready');
	});

	it('needs attention when an inbox or excluded folder disappeared', () => {
		expect(evaluateSetup('inbox-sweep', configured(), { existingFolders: toFolderSet(['Other']) })).toEqual({ state: 'needs-attention', reason: 'missing-folder' });
		const s = configured({ sweepExcludedFolders: ['Private'] });
		expect(evaluateSetup('inbox-sweep', s, { existingFolders: toFolderSet(['Inbox']) }).reason).toBe('missing-folder');
	});
});

describe('setup state for Google Tasks', () => {
	const configured = (over: Record<string, unknown> = {}) => ({ ...base, tasksScriptUrl: 'https://script.google.com/macros/s/AKfycbxTEST/exec', tasksListId: 'L1', ...done('google-tasks'), ...over });
	const key = (s: Record<string, unknown>) => tasksConfigKey(s.tasksScriptUrl as string, s.tasksListId as string);

	it('is not set up without a link, a list and the wizard', () => {
		expect(evaluateSetup('google-tasks', base).state).toBe('not-set-up');
		expect(evaluateSetup('google-tasks', configured({ featureSetupCompletedAt: {} })).state).toBe('not-set-up');
		expect(evaluateSetup('google-tasks', configured({ tasksListId: '' })).state).not.toBe('ready'); // finished once, but the list is gone
	});

	it('needs attention until a passing test is recorded for this exact link and list', () => {
		const s = configured();
		expect(evaluateSetup('google-tasks', s, { configHash: key(s) })).toEqual({ state: 'needs-attention', reason: 'connection-untested' });
		const passed = { ok: true, configHash: key(s), at: 'T' };
		expect(evaluateSetup('google-tasks', s, { configHash: key(s), connection: passed }).state).toBe('ready');
		expect(evaluateSetup('google-tasks', s, { configHash: key(s), connection: { ...passed, ok: false } }).reason).toBe('connection-failed');
		const changed = configured({ tasksListId: 'L2' });
		expect(evaluateSetup('google-tasks', changed, { configHash: key(changed), connection: passed }).reason).toBe('connection-stale');
	});
});

describe('report path', () => {
	it('accepts a vault-relative Markdown note and normalises it', () => {
		expect(validateReportPath(' Notes\\Sweeps/Report.md ', [])).toEqual({ ok: true, value: 'Notes/Sweeps/Report.md' });
	});

	it.each(['', 'report.txt', '/abs/report.md', 'C:/x/report.md', '../out.md', '.hidden/report.md', 'a/.b/report.md'])('refuses %j', (p) => {
		expect(validateReportPath(p, []).ok).toBe(false);
	});

	it('refuses a protected location', () => {
		expect(validateReportPath('Course/report.md', ['Course'])).toEqual({ ok: false, error: 'protected-path' });
		expect(validateReportPath('Other/report.md', ['Course']).ok).toBe(true);
	});
});

describe('guidance for the new codes', () => {
	it('every sweep and Tasks code has two sentences and never shows itself', () => {
		for (const code of ['sweep-keepout-required', 'sweep-no-folders', 'sweep-report-invalid', 'sweep-report-conflict', 'sweep-no-provider', 'sweep-run-failed', 'tasks-no-list', 'tasks-not-ready', 'script-tasks-off'] as const) {
			expect(GUIDANCE_CODES).toContain(code);
			const g = en.guidance[code];
			expect(g.message.length).toBeGreaterThan(10);
			expect(g.nextStep.length).toBeGreaterThan(10);
			expect(`${g.message} ${g.nextStep}`.includes(code)).toBe(false);
		}
	});
});
