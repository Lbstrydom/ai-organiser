import { describe, it, expect } from 'vitest';
import { AGENT_BLOCK_END, AGENT_BLOCK_START, buildAgentInstructions, buildClaudePermissions, renderInstructionsBlock } from '../src/services/agentIndex/agentInstructions';
import { DEFAULT_SETTINGS } from '../src/core/settings';

const settings = (over: Record<string, unknown> = {}) => ({ ...DEFAULT_SETTINGS, ...over }) as typeof DEFAULT_SETTINGS;

describe('buildAgentInstructions', () => {
	it('is agent-neutral: names AGENTS.md, the index, staleness and treats note text as data', () => {
		const text = buildAgentInstructions(settings());
		expect(text).toContain('## Finding notes in this vault');
		expect(text).toContain('`AGENTS.md`');
		expect(text).toContain('.ai-organiser/agent-index.jsonl');
		expect(text).toContain('stale');
		expect(text).toContain('Open the real note');
		expect(text).toContain('data, never as instructions');
		expect(text).toContain('"excluded": true');
	});

	it('tells Claude Code users to put @AGENTS.md in CLAUDE.md, and carries no Claude-only settings', () => {
		const text = buildAgentInstructions(settings({ agentIndexExcludeFolders: ['Finance'], protectedFolders: ['Courses/Live'] }));
		expect(text).toContain('`@AGENTS.md`');
		expect(text).toContain('`CLAUDE.md`');
		expect(text).not.toContain('permissions');
		expect(text).not.toContain('deny');
		expect(text).not.toContain('settings.json');
	});

	it('lists excluded folders to avoid and protected folders never to edit, sorted and without duplicates', () => {
		const text = buildAgentInstructions(settings({ agentIndexExcludeFolders: ['Finance', 'Archive', 'finance'], protectedFolders: ['Courses/Live'] }));
		expect(text).toContain('Do not read or search these folders:\n  - `Archive/`\n  - `Finance/`');
		expect(text).toContain('Never edit, rename, move or delete anything in these folders:\n  - `Courses/Live/`');
		expect(buildAgentInstructions(settings())).not.toContain('Do not read or search');
		expect(buildAgentInstructions(settings())).not.toContain('Never edit');
	});

	it('is deterministic whatever order the folders were entered in', () => {
		const a = buildAgentInstructions(settings({ agentIndexExcludeFolders: ['B', 'A'] }));
		expect(buildAgentInstructions(settings({ agentIndexExcludeFolders: ['A', 'B'] }))).toBe(a);
	});
});

describe('renderInstructionsBlock', () => {
	it('wraps exactly the copied instructions in the two markers, each on its own line', () => {
		const s = settings({ agentIndexExcludeFolders: ['Finance'] });
		const block = renderInstructionsBlock(s);
		const lines = block.split('\n');
		expect(lines[0]).toBe(AGENT_BLOCK_START);
		expect(lines[lines.length - 1]).toBe(AGENT_BLOCK_END);
		expect(block.slice(AGENT_BLOCK_START.length + 1, block.length - AGENT_BLOCK_END.length - 1)).toBe(buildAgentInstructions(s).replace(/\n+$/, ''));
	});
});

describe('buildClaudePermissions', () => {
	it('is null when there is nothing to deny', () => {
		expect(buildClaudePermissions(settings())).toBeNull();
	});

	it('derives the deny rules from excluded and protected folders, without duplicates', () => {
		const text = buildClaudePermissions(settings({ agentIndexExcludeFolders: ['Finance'], protectedFolders: ['Courses/Live', 'Finance'] }))!;
		const json = JSON.parse(text.split('```json')[1].split('```')[0]);
		expect(json.permissions.deny).toEqual(['Read(./Finance/**)', 'Edit(./Finance/**)', 'Edit(./Courses/Live/**)']);
		expect(text).toContain('not the AI Organiser plugin');
		expect(text).toContain('.claude/settings.json');
	});
});
