import { describe, it, expect } from 'vitest';
import { evaluateSetup, toFolderSet } from '../src/core/setupState';
import { DEFAULT_SETTINGS } from '../src/core/settings';
import { planOutput, buildAgentInstructions } from '../src/services/agentIndex/agentIndexService';

describe('setup state for the agent index', () => {
	const base = { ...structuredClone(DEFAULT_SETTINGS) } as Record<string, unknown>;

	it('is not set up until the wizard finishes', () => {
		expect(evaluateSetup('agent-index', base).state).toBe('not-set-up');
	});

	it('is ready after Finish with no folders chosen (whole vault minus protected)', () => {
		expect(evaluateSetup('agent-index', { ...base, featureSetupCompletedAt: { 'agent-index': 'T' } }).state).toBe('ready');
	});

	it('needs attention when a chosen folder no longer exists', () => {
		const s = { ...base, featureSetupCompletedAt: { 'agent-index': 'T' }, agentIndexIncludeFolders: ['Projects'] };
		const res = evaluateSetup('agent-index', s, { existingFolders: toFolderSet(['Other']) });
		expect(res).toEqual({ state: 'needs-attention', reason: 'missing-folder' });
		expect(evaluateSetup('agent-index', s, { existingFolders: toFolderSet(['projects']) }).state).toBe('ready');
	});
});

describe('planOutput', () => {
	it('accepts a vault-relative .jsonl path and derives its sidecar names', () => {
		const res = planOutput('.ai-organiser/agent-index.jsonl', []);
		expect(res.ok).toBe(true);
	});

	it.each([
		'', 'C:/x/index.jsonl', '/abs/index.jsonl', '../escape/index.jsonl', 'a/../../b.jsonl', 'notes/index.md', 'notes/index.txt',
	])('refuses %s', (path) => {
		expect(planOutput(path, []).ok).toBe(false);
	});

	it('refuses an output inside a protected folder', () => {
		expect(planOutput('Courses/Live/index.jsonl', ['Courses/Live']).ok).toBe(false);
		expect(planOutput('Courses/Other/index.jsonl', ['Courses/Live']).ok).toBe(true);
	});
});

describe('buildAgentInstructions', () => {
	it('names the index file and lists the excluded and protected folders', () => {
		const text = buildAgentInstructions({ agentIndexOutputPath: 'idx/agent.jsonl', agentIndexExcludeFolders: ['Private'], protectedFolders: ['Courses/Live'] });
		expect(text).toContain('idx/agent.jsonl');
		expect(text).toContain('Private');
		expect(text).toContain('Courses/Live');
	});

	it('is deterministic', () => {
		const args = { agentIndexOutputPath: 'a.jsonl', agentIndexExcludeFolders: ['B', 'A'], protectedFolders: [] };
		expect(buildAgentInstructions(args)).toBe(buildAgentInstructions({ ...args, agentIndexExcludeFolders: ['A', 'B'] }));
	});
});
