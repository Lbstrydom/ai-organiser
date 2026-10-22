import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/services/noteEdit/applyNoteEdit', () => ({
	applyNoteEdit: async (plugin: { __vault: Map<string, string> }, target: { filePath: string; recompute: (c: string) => { ok: boolean; value?: { content: string }; error?: string } }) => {
		const current = plugin.__vault.get(target.filePath) ?? '';
		const res = target.recompute(current);
		if (!res.ok) return { ok: false, error: res.error };
		plugin.__vault.set(target.filePath, res.value!.content);
		return { ok: true, value: undefined };
	},
}));

import { applyInstructions, planInstructions, previewInstructions, validateInstructionsPath } from '../src/services/agentIndex/agentInstructionsWriter';
import { AGENT_BLOCK_END, AGENT_BLOCK_START, renderInstructionsBlock } from '../src/services/agentIndex/agentInstructions';
import { DEFAULT_SETTINGS, migrateOldSettings } from '../src/core/settings';
import { TFile } from './mocks/obsidian';

function makePlugin(over: Record<string, unknown> = {}, notes: Record<string, string> = {}) {
	const vault = new Map<string, string>(Object.entries(notes));
	const created: string[] = [];
	const settings = { ...structuredClone(DEFAULT_SETTINGS), agentInstructionsWrite: true, ...over } as typeof DEFAULT_SETTINGS;
	const plugin = {
		__vault: vault,
		settings,
		app: {
			vault: {
				getAbstractFileByPath: (p: string) => { if (vault.has(p)) { const f = new TFile(); f.path = p; return f; } return null; },
				read: async (f: { path: string }) => vault.get(f.path) ?? '',
				create: async (p: string, c: string) => { vault.set(p, c); created.push(p); },
				createFolder: async () => undefined,
			},
		},
	};
	return { plugin: plugin as never, vault, created, settings };
}

describe('validateInstructionsPath', () => {
	it('accepts a vault-relative Markdown path and normalises it', () => {
		expect(validateInstructionsPath('AGENTS.md', [])).toEqual({ ok: true, value: 'AGENTS.md' });
		expect(validateInstructionsPath(' Docs\\AGENTS.md ', [])).toEqual({ ok: true, value: 'Docs/AGENTS.md' });
	});

	it.each(['', 'AGENTS.txt', '/abs/AGENTS.md', 'C:/x/AGENTS.md', '../AGENTS.md', '.obsidian/AGENTS.md', 'a/.hidden/AGENTS.md'])('refuses %j', (p) => {
		expect(validateInstructionsPath(p, []).ok).toBe(false);
	});

	it('refuses a protected location', () => {
		expect(validateInstructionsPath('Course/AGENTS.md', ['Course'])).toEqual({ ok: false, error: 'protected-path' });
	});
});

describe('planInstructions', () => {
	const block = `${AGENT_BLOCK_START}\nnew\n${AGENT_BLOCK_END}`;

	it('creates, appends, replaces and reports no change', () => {
		expect(planInstructions(null, block)).toEqual({ ok: true, value: { next: `${block}\n`, before: null, changed: true } });
		expect(planInstructions('# Mine\n', block)).toEqual({ ok: true, value: { next: `# Mine\n\n${block}\n`, before: null, changed: true } });
		const old = `a\n${AGENT_BLOCK_START}\nold\n${AGENT_BLOCK_END}\nz\n`;
		expect(planInstructions(old, block)).toEqual({ ok: true, value: { next: `a\n${block}\nz\n`, before: `${AGENT_BLOCK_START}\nold\n${AGENT_BLOCK_END}`, changed: true } });
		expect(planInstructions(`a\n${block}\nz\n`, block)).toMatchObject({ ok: true, value: { changed: false } });
	});

	it('reports a conflict for damaged markers', () => {
		expect(planInstructions(`${block}\n${block}`, block)).toEqual({ ok: false, error: 'marker-conflict' });
	});
});

describe('preview and apply', () => {
	it('creates the file when it is absent, with exactly the block', async () => {
		const h = makePlugin();
		const preview = await previewInstructions(h.plugin);
		expect(preview).toMatchObject({ ok: true, value: { path: 'AGENTS.md', creates: true, changed: true } });
		if (!preview.ok) return;
		expect(await applyInstructions(h.plugin, preview.value)).toEqual({ ok: true, value: 'created' });
		expect(h.vault.get('AGENTS.md')).toBe(`${renderInstructionsBlock(h.settings)}\n`);
	});

	it('changes only the block and leaves the user\'s text byte-identical', async () => {
		const h = makePlugin({}, { 'AGENTS.md': `# My rules\n\nBe kind.\n\n${AGENT_BLOCK_START}\nold text\n${AGENT_BLOCK_END}\n\n## Other\nStuff.\n` });
		const preview = await previewInstructions(h.plugin);
		if (!preview.ok) throw new Error(preview.error);
		expect(preview.value.before).toContain('old text');
		expect(await applyInstructions(h.plugin, preview.value)).toEqual({ ok: true, value: 'updated' });
		const text = h.vault.get('AGENTS.md')!;
		expect(text.startsWith('# My rules\n\nBe kind.\n\n')).toBe(true);
		expect(text.endsWith('\n\n## Other\nStuff.\n')).toBe(true);
		expect(text).not.toContain('old text');
		expect(text).toContain(renderInstructionsBlock(h.settings));
	});

	it('appends a block to an existing file that has none', async () => {
		const h = makePlugin({}, { 'AGENTS.md': '# Mine\n' });
		const preview = await previewInstructions(h.plugin);
		if (!preview.ok) throw new Error(preview.error);
		await applyInstructions(h.plugin, preview.value);
		expect(h.vault.get('AGENTS.md')!.startsWith('# Mine\n\n')).toBe(true);
	});

	it('a second run changes nothing', async () => {
		const h = makePlugin();
		const first = await previewInstructions(h.plugin);
		if (!first.ok) throw new Error(first.error);
		await applyInstructions(h.plugin, first.value);
		const before = h.vault.get('AGENTS.md');
		const second = await previewInstructions(h.plugin);
		expect(second).toMatchObject({ ok: true, value: { changed: false } });
		if (!second.ok) return;
		expect(await applyInstructions(h.plugin, second.value)).toEqual({ ok: true, value: 'unchanged' });
		expect(h.vault.get('AGENTS.md')).toBe(before);
	});

	it('refuses, and writes nothing, when the markers are damaged', async () => {
		const bad = `${AGENT_BLOCK_START}\na\n${AGENT_BLOCK_END}\n${AGENT_BLOCK_START}\nb\n${AGENT_BLOCK_END}\n`;
		const h = makePlugin({}, { 'AGENTS.md': bad });
		expect(await previewInstructions(h.plugin)).toEqual({ ok: false, error: 'instructions-conflict' });
		expect(h.vault.get('AGENTS.md')).toBe(bad);
	});

	it('stops when the note changed after the preview in a way the user did not see', async () => {
		const h = makePlugin({}, { 'AGENTS.md': '# Mine\n' });
		const preview = await previewInstructions(h.plugin);
		if (!preview.ok) throw new Error(preview.error);
		// A block appears while the preview is open.
		h.vault.set('AGENTS.md', `# Mine\n\n${AGENT_BLOCK_START}\nsomeone else\n${AGENT_BLOCK_END}\n`);
		expect(await applyInstructions(h.plugin, preview.value)).toEqual({ ok: false, error: 'baseline-changed' });
		expect(h.vault.get('AGENTS.md')).toContain('someone else');
		// The file appears while a create was previewed.
		const h2 = makePlugin();
		const p2 = await previewInstructions(h2.plugin);
		if (!p2.ok) throw new Error(p2.error);
		h2.vault.set('AGENTS.md', 'created meanwhile');
		expect(await applyInstructions(h2.plugin, p2.value)).toEqual({ ok: false, error: 'baseline-changed' });
		expect(h2.vault.get('AGENTS.md')).toBe('created meanwhile');
	});

	it('stops when the path setting changed after the preview', async () => {
		const h = makePlugin();
		const preview = await previewInstructions(h.plugin);
		if (!preview.ok) throw new Error(preview.error);
		h.settings.agentInstructionsPath = 'Other.md';
		expect(await applyInstructions(h.plugin, preview.value)).toEqual({ ok: false, error: 'baseline-changed' });
		expect(h.vault.size).toBe(0);
	});

	it('refuses a protected path before reading anything', async () => {
		const h = makePlugin({ protectedFolders: ['Course'], agentInstructionsPath: 'Course/AGENTS.md' });
		expect(await previewInstructions(h.plugin)).toEqual({ ok: false, error: 'protected-path' });
	});
});

describe('settings', () => {
	it('ships off, with AGENTS.md as the default path, and repairs bad values', () => {
		expect(DEFAULT_SETTINGS.agentInstructionsWrite).toBe(false);
		expect(DEFAULT_SETTINGS.agentInstructionsPath).toBe('AGENTS.md');
		const out = migrateOldSettings({ agentInstructionsWrite: 'yes', agentInstructionsPath: '   ' }) as Record<string, unknown>;
		expect(out.agentInstructionsWrite).toBe(false);
		expect(out.agentInstructionsPath).toBe('AGENTS.md');
	});
});
