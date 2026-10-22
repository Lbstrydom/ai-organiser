import { describe, it, expect } from 'vitest';
import {
	evaluateSetup,
	evaluateScriptCompat,
	toFolderSet,
	SETUP_SPECS,
	SETUP_REASONS,
	type SetupObservations,
} from '../src/core/setupState';
import { DEFAULT_SETTINGS, migrateOldSettings } from '../src/core/settings';

const baseSettings = (over: Record<string, unknown> = {}) => ({ ...DEFAULT_SETTINGS, ...over });

describe('evaluateSetup: protected folders', () => {
	it('is not set up for an empty list', () => {
		expect(evaluateSetup('protected-folders', baseSettings())).toEqual({ state: 'not-set-up', reason: 'no-config' });
	});

	it('is ready when folders are chosen (and no observations are given)', () => {
		expect(evaluateSetup('protected-folders', baseSettings({ protectedFolders: ['Courses/Live'] })).state).toBe('ready');
	});

	it('needs attention when a chosen folder no longer exists', () => {
		const obs: SetupObservations = { existingFolders: toFolderSet(['Other']) };
		const res = evaluateSetup('protected-folders', baseSettings({ protectedFolders: ['Courses/Live'] }), obs);
		expect(res).toEqual({ state: 'needs-attention', reason: 'missing-folder' });
	});

	it('matches folders case-insensitively and ignores slash style', () => {
		const obs: SetupObservations = { existingFolders: toFolderSet(['courses/live']) };
		expect(evaluateSetup('protected-folders', baseSettings({ protectedFolders: ['Courses\\Live\\'] }), obs).state).toBe('ready');
	});
});

describe('evaluateSetup: generic rules (driven through a temporary spec)', () => {
	const specs = SETUP_SPECS as Record<string, unknown>;

	function withSpec(id: string, spec: unknown, fn: () => void) {
		specs[id] = spec;
		try { fn(); } finally { delete specs[id]; }
	}

	it('returns not-set-up for an id with no spec (a feature can never read as ready by accident)', () => {
		expect(evaluateSetup('google-tasks', baseSettings()).state).toBe('not-set-up');
	});

	it('separates an untouched default from a finished wizard via featureSetupCompletedAt', () => {
		withSpec('agent-index', { required: ['x'], folderKeys: [], needsCompletionMarker: true, needsConnection: false }, () => {
			const untouched = evaluateSetup('agent-index', baseSettings({ x: 'a' }));
			expect(untouched).toEqual({ state: 'not-set-up', reason: 'incomplete' });
			const done = evaluateSetup('agent-index', baseSettings({ x: 'a', featureSetupCompletedAt: { 'agent-index': '2026-01-01' } }));
			expect(done.state).toBe('ready');
		});
	});

	it('does not count a switch that is off, or an empty list, as a value', () => {
		withSpec('agent-index', { required: ['x'], folderKeys: [], needsCompletionMarker: true, needsConnection: false }, () => {
			const done = { featureSetupCompletedAt: { 'agent-index': '2026-01-01' } };
			expect(evaluateSetup('agent-index', baseSettings({ x: false, ...done }))).toEqual({ state: 'needs-attention', reason: 'incomplete' });
			expect(evaluateSetup('agent-index', baseSettings({ x: [], ...done }))).toEqual({ state: 'needs-attention', reason: 'incomplete' });
			expect(evaluateSetup('agent-index', baseSettings({ x: true, ...done })).state).toBe('ready');
		});
	});

	it('needs attention once a finished wizard loses a required value', () => {
		withSpec('agent-index', { required: ['x'], folderKeys: [], needsCompletionMarker: true, needsConnection: false }, () => {
			const res = evaluateSetup('agent-index', baseSettings({ x: '', featureSetupCompletedAt: { 'agent-index': '2026-01-01' } }));
			expect(res).toEqual({ state: 'needs-attention', reason: 'incomplete' });
		});
	});

	it('treats an untested, failed and stale connection as needs-attention, and a matching pass as ready', () => {
		withSpec('cloud-inventory', { required: ['url'], folderKeys: [], needsCompletionMarker: true, needsConnection: true }, () => {
			const s = baseSettings({ url: 'u', featureSetupCompletedAt: { 'cloud-inventory': 't' } });
			expect(evaluateSetup('cloud-inventory', s, {}).reason).toBe('connection-untested');
			expect(evaluateSetup('cloud-inventory', s, { connection: { ok: false, configHash: 'a' } }).reason).toBe('connection-failed');
			expect(evaluateSetup('cloud-inventory', s, { configHash: 'b', connection: { ok: true, configHash: 'a' } }).reason).toBe('connection-stale');
			expect(evaluateSetup('cloud-inventory', s, { configHash: 'a', connection: { ok: true, configHash: 'a' } }).state).toBe('ready');
		});
	});

	it('maps script compatibility to needs-attention only when incompatible or mismatched', () => {
		withSpec('cloud-inventory', { required: ['url'], folderKeys: [], needsCompletionMarker: true, needsConnection: true }, () => {
			const s = baseSettings({ url: 'u', featureSetupCompletedAt: { 'cloud-inventory': 't' } });
			const ok = { ok: true, configHash: 'a' };
			const expected = { minSupported: 2, current: 3, configHash: 'h' };
			expect(evaluateSetup('cloud-inventory', s, { configHash: 'a', connection: ok, script: { report: { scriptVersion: 1, configHash: 'h' }, expected } }).reason).toBe('script-incompatible');
			expect(evaluateSetup('cloud-inventory', s, { configHash: 'a', connection: ok, script: { report: { scriptVersion: 3, configHash: 'x' }, expected } }).reason).toBe('script-config-mismatch');
			expect(evaluateSetup('cloud-inventory', s, { configHash: 'a', connection: ok, script: { report: { scriptVersion: 2, configHash: 'h' }, expected } }).state).toBe('ready');
		});
	});
});

describe('evaluateScriptCompat', () => {
	const expected = { minSupported: 2, current: 4, configHash: 'h' };

	it('is incompatible below the minimum or when nothing was reported', () => {
		expect(evaluateScriptCompat({ scriptVersion: 1, configHash: 'h' }, expected)).toBe('incompatible');
		expect(evaluateScriptCompat(null, expected)).toBe('incompatible');
		expect(evaluateScriptCompat({ scriptVersion: Number.NaN }, expected)).toBe('incompatible');
	});

	it('keeps version compatibility distinct from configuration matching', () => {
		expect(evaluateScriptCompat({ scriptVersion: 4, configHash: 'other' }, expected)).toBe('config-mismatch');
		expect(evaluateScriptCompat({ scriptVersion: 3, configHash: 'h' }, expected)).toBe('hint');
		expect(evaluateScriptCompat({ scriptVersion: 4, configHash: 'h' }, expected)).toBe('ok');
	});

	it('ignores the config hash when none is expected', () => {
		expect(evaluateScriptCompat({ scriptVersion: 4 }, { minSupported: 2, current: 4 })).toBe('ok');
	});
});

describe('settings migration for the F1 / F2 / onboarding keys', () => {
	it('coerces missing and invalid values to the defaults', () => {
		const out = migrateOldSettings({
			protectedFolders: 7,
			featureSetupCompletedAt: ['x'],
			attachmentLargeFileMB: -5,
			attachmentDuplicateMaxMB: 'abc',
			attachmentLinkHeading: '   ',
		}) as Record<string, unknown>;
		expect(out.protectedFolders).toEqual([]);
		expect(out.featureSetupCompletedAt).toEqual({});
		expect(out.attachmentLargeFileMB).toBe(20);
		expect(out.attachmentDuplicateMaxMB).toBe(50);
		expect(out.attachmentLinkHeading).toBe('Attachments');
	});

	it('keeps a lone string as one protected folder rather than silently dropping protection', () => {
		const out = migrateOldSettings({ protectedFolders: 'Courses/Live' }) as Record<string, unknown>;
		expect(out.protectedFolders).toEqual(['Courses/Live']);
	});

	it('keeps valid values and is idempotent', () => {
		const once = migrateOldSettings({
			protectedFolders: ['A', '', 5, 'B'],
			featureSetupCompletedAt: { 'agent-index': 't', bad: 5 },
			attachmentLargeFileMB: 8.7,
		}) as Record<string, unknown>;
		expect(once.protectedFolders).toEqual(['A', 'B']);
		expect(once.featureSetupCompletedAt).toEqual({ 'agent-index': 't' });
		expect(once.attachmentLargeFileMB).toBe(8);
		const twice = migrateOldSettings(structuredClone(once)) as Record<string, unknown>;
		expect(twice).toEqual(once);
	});
});

describe('reasons', () => {
	it('lists every reason once', () => {
		expect(new Set(SETUP_REASONS).size).toBe(SETUP_REASONS.length);
	});
});
