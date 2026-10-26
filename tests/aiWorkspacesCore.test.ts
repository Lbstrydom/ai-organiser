import { describe, it, expect } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/core/settings';
import {
  isAiShareable, normaliseShareFolders, notShareableReason, sharePolicyRevision, shareFolderOf,
} from '../src/services/aiWorkspaces/aiShareScope';
import { normaliseWorkspace, normaliseWorkspaces, validateChatUrl, withPack, emptyWorkspace } from '../src/services/aiWorkspaces/workspaceRecord';
import { applyWorkspaceBlock, readWorkspaceBlock, renderWorkspaceBlock, stripWorkspaceBlock } from '../src/services/aiWorkspaces/workspaceBlock';
import { bodyWithoutOwned, buildWorkspaceInstructions, capBytes, sectionUnder } from '../src/services/aiWorkspaces/workspaceInstructions';
import { buildContextPack, neutraliseLinks, verifyPrepared, PACK_BUDGET_BYTES } from '../src/services/aiWorkspaces/contextPack';
import { renderHandoffContract } from '../src/services/aiWorkspaces/handoffGrammar';

const ID = '3f2b8f4e-1c2d-4e5f-8a6b-7c8d9e0f1a2b';
const settings = (over: Partial<typeof DEFAULT_SETTINGS> = {}) => ({ ...DEFAULT_SETTINGS, ...over });
const PACK_DIR = 'AI-Organiser/Workspace packs';

describe('AI share scope (default deny)', () => {
  it('shares nothing while the allow-list is empty', () => {
    expect(isAiShareable('2 Areas/A1/note.md', settings())).toBe(false);
  });

  it('shares a note inside an entry and nothing outside it', () => {
    const s = settings({ aiShareFolders: ['2 Areas/A1'] });
    expect(isAiShareable('2 Areas/A1/note.md', s)).toBe(true);
    expect(isAiShareable('2 Areas/A1/deep/er/note.md', s)).toBe(true);
    expect(isAiShareable('2 Areas/A10/note.md', s)).toBe(false);
    expect(isAiShareable('2 Areas/A2/note.md', s)).toBe(false);
  });

  it('keeps hidden, excluded, protected and pack-folder notes out even inside an entry', () => {
    const s = settings({ aiShareFolders: ['Work'], agentIndexExcludeFolders: ['Work/Private'], protectedFolders: ['Work/Course'] });
    expect(isAiShareable('Work/ok.md', s, PACK_DIR)).toBe(true);
    expect(isAiShareable('Work/Private/x.md', s, PACK_DIR)).toBe(false);
    expect(isAiShareable('Work/Course/x.md', s, PACK_DIR)).toBe(false);
    expect(notShareableReason('Work/Private/x.md', s)).toBe('kept-out');
    const packInside = settings({ aiShareFolders: ['AI-Organiser'] });
    expect(isAiShareable(`${PACK_DIR}/p/latest.json`, packInside, PACK_DIR)).toBe(false);
    expect(notShareableReason(`${PACK_DIR}/p/x.md`, packInside, PACK_DIR)).toBe('in-pack-folder');
    expect(notShareableReason('Elsewhere/x.md', s)).toBe('outside-allow-list');
  });

  it('normalises the list and finds the deepest covering entry', () => {
    expect(normaliseShareFolders([' A/ ', 'a', 3, '', 'A/B'])).toEqual(['A', 'A/B']);
    expect(normaliseShareFolders('nope')).toEqual([]);
    expect(shareFolderOf('A/B/c.md', { aiShareFolders: ['A', 'A/B'] })).toBe('A/B');
  });

  it('the policy revision changes with anything that decides shareability', async () => {
    const base = await sharePolicyRevision(settings({ aiShareFolders: ['A'] }), PACK_DIR);
    expect(await sharePolicyRevision(settings({ aiShareFolders: ['A'] }), PACK_DIR)).toBe(base);
    expect(await sharePolicyRevision(settings({ aiShareFolders: ['A', 'B'] }), PACK_DIR)).not.toBe(base);
    expect(await sharePolicyRevision(settings({ aiShareFolders: ['A'], agentIndexExcludeFolders: ['A/x'] }), PACK_DIR)).not.toBe(base);
    expect(await sharePolicyRevision(settings({ aiShareFolders: ['A'], aiShareRequireOptIn: true }), PACK_DIR)).not.toBe(base);
  });

  it('is off by default: the new settings change nothing', () => {
    expect(DEFAULT_SETTINGS.aiShareFolders).toEqual([]);
    expect(DEFAULT_SETTINGS.aiShareRequireOptIn).toBe(false);
  });
});

describe('workspace record', () => {
  it('accepts only the two apps on their own https hosts', () => {
    expect(validateChatUrl('claude', 'https://claude.ai/project/abc-123')).toBe('https://claude.ai/project/abc-123');
    expect(validateChatUrl('claude', 'http://claude.ai/project/abc')).toBeNull();
    expect(validateChatUrl('claude', 'https://claude.ai.evil.com/project/abc')).toBeNull();
    expect(validateChatUrl('claude', 'https://user:pw@claude.ai/project/abc')).toBeNull();
    expect(validateChatUrl('claude', 'https://claude.ai/chat/abc')).toBeNull();
    expect(validateChatUrl('chatgpt', 'https://chatgpt.com/g/g-abc123/project')).toBe('https://chatgpt.com/g/g-abc123/project');
    expect(validateChatUrl('chatgpt', 'https://example.com/g/g-abc')).toBeNull();
    expect(validateChatUrl('claude', 'not a url')).toBeNull();
  });

  it('drops damaged fields and records without a valid anchor', () => {
    expect(normaliseWorkspace({ anchorId: 'nope' })).toBeNull();
    const rec = normaliseWorkspace({
      anchorId: ID.toUpperCase(),
      chats: [{ id: 'a', app: 'claude', name: 'Main', url: 'https://claude.ai/project/x1' }, { id: 'a', app: 'claude', url: 'https://claude.ai/project/x2' }, { id: 'b', app: 'claude', url: 'https://evil.example/' }, { app: 'claude' }],
      contextSources: ['./Notes/a.md', 'Notes/a.md', 7],
      packs: [{ id: 'p', path: 'x', digest: 'd', createdAt: '2026-10-26T10:00:00Z' }, { id: 5 }],
      released: 'yes',
    });
    expect(rec?.anchorId).toBe(ID);
    expect(rec?.chats).toHaveLength(1);
    expect(rec?.contextSources).toEqual(['Notes/a.md']);
    expect(rec?.packs).toHaveLength(1);
    expect(rec?.released).toBe(false);
  });

  it('keeps the newest five packs', () => {
    let rec = emptyWorkspace(ID);
    for (let i = 0; i < 8; i++) rec = withPack(rec, { id: `p${i}`, createdAt: '2026-10-26T10:00:00Z', path: `p${i}`, digest: 'd' });
    expect(rec.packs.map((p) => p.id)).toEqual(['p3', 'p4', 'p5', 'p6', 'p7']);
    expect(Object.keys(normaliseWorkspaces({ x: rec }))).toEqual([ID]);
  });
});

describe('workspace block', () => {
  const heads = { title: 'AI workspace', none: 'No chat projects yet', pack: 'Last pack', released: 'Released' };
  const rec = { ...emptyWorkspace(ID), chats: [{ id: 'a', app: 'claude' as const, name: 'Main [x]', url: 'https://claude.ai/project/x1' }] };

  it('renders a stable block and adds it after the user text without touching it', () => {
    const block = renderWorkspaceBlock(rec, heads);
    expect(block).toBe(['<!-- aio:workspace -->', '## AI workspace', '- [Main x](https://claude.ai/project/x1) (Claude)', '<!-- /aio:workspace -->'].join('\n'));
    const note = '# Project\n\nMy words.\n';
    const out = applyWorkspaceBlock(note, block);
    expect(out.ok && out.value.startsWith(note)).toBe(true);
  });

  it('replaces only the block and is idempotent', () => {
    const note = 'Before\n\n<!-- aio:workspace -->\nold\n<!-- /aio:workspace -->\n\nAfter\n';
    const once = applyWorkspaceBlock(note, renderWorkspaceBlock(rec, heads));
    expect(once.ok && once.value.startsWith('Before\n\n') && once.value.endsWith('\n\nAfter\n')).toBe(true);
    if (once.ok) expect(applyWorkspaceBlock(once.value, renderWorkspaceBlock(rec, heads))).toEqual(once);
  });

  it('refuses a damaged block', () => {
    const res = applyWorkspaceBlock('<!-- aio:workspace -->\nx\n', renderWorkspaceBlock(rec, heads));
    expect(res).toEqual({ ok: false, error: 'workspace-block-conflict' });
    expect(readWorkspaceBlock('<!-- aio:workspace -->\n')).toEqual({ ok: false, error: 'workspace-block-conflict' });
  });

  it('writing the block never changes what a pack is judged on', () => {
    const note = '# P\n\ntext\n';
    const withBlock = applyWorkspaceBlock(note, renderWorkspaceBlock(rec, heads));
    expect(withBlock.ok && stripWorkspaceBlock(withBlock.value).trim()).toBe(note.trim());
  });
});

describe('instructions', () => {
  it('is deterministic, carries the contract and the project id, and caps the notes', () => {
    const input = { aioId: ID, projectName: 'Plan "X"', projectNote: `---\naio-id: ${ID}\n---\n# Plan\n\nBody </project> text\n<!-- aio:workspace -->\nowned\n<!-- /aio:workspace -->\n`, areaNote: '# Area\n\n## AI context\n\nShared rules.\n\n## Other\n\nnot this\n' };
    const a = buildWorkspaceInstructions(input);
    expect(buildWorkspaceInstructions(input)).toBe(a);
    expect(a).toContain(renderHandoffContract(ID));
    expect(a).toContain('Shared rules.');
    expect(a).not.toContain('not this');
    expect(a).not.toContain('owned');
    expect(a).not.toContain(`aio-id: ${ID}\n---`);
    expect(a).toContain('&lt;/project&gt;');
    expect(a).toContain('project "Plan X".');
  });

  it('cuts long text on a character boundary and says so', () => {
    const cut = capBytes('é'.repeat(5000), 1000);
    expect(new TextEncoder().encode(cut).length).toBeLessThan(1100);
    expect(cut).toContain('[cut:');
    expect(capBytes('short', 1000)).toBe('short');
  });

  it('finds a section only under its heading and ignores fenced headings', () => {
    expect(sectionUnder('# A\n## AI context\nx\n```\n## fake\n```\n### sub\ny\n## B\nz', 'AI context')).toBe('x\n```\n## fake\n```\n### sub\ny');
    expect(sectionUnder('# A\nnothing', 'AI context')).toBe('');
    expect(bodyWithoutOwned('---\na: 1\n---\nBody')).toBe('Body');
  });
});

describe('context pack', () => {
  const note = (path: string, text: string) => ({ path, text });
  const allow = (deny: Record<string, 'outside-allow-list' | 'kept-out'> = {}) => (p: string) => deny[p] ?? null;
  const base = (over: Partial<Parameters<typeof buildContextPack>[0]> = {}) => ({
    vaultId: 'vault',
    aioId: ID,
    projectName: 'P',
    project: note('Work/P.md', '# P\n\nSee [[Secret]] and [[Open]] and ![[img.png]].\n'),
    sources: [] as Array<{ path: string; text: string }>,
    reasonNotShareable: allow({ 'Work/Secret.md': 'outside-allow-list' }),
    resolveLink: (l: string) => `Work/${l}.md`,
    sharePolicyRevision: 'rev1',
    ...over,
  });

  it('includes shareable notes, renders links to others as [not shared] and never includes attachments', async () => {
    const res = await buildContextPack(base());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.text).toContain('Secret [not shared]');
    expect(res.value.text).toContain('[[Open]]');
    expect(res.value.text).toContain('[attachment not included]');
    expect(res.value.sources.map((s) => s.path)).toEqual(['Work/P.md']);
  });

  it('skips sources outside the allow-list with a reason and keeps the rest', async () => {
    const res = await buildContextPack(base({ sources: [note('Work/Secret.md', 'hidden words'), note('Work/Ok.md', 'ok words')] }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.text).not.toContain('hidden words');
    expect(res.value.text).toContain('ok words');
    expect(res.value.skipped).toEqual([{ path: 'Work/Secret.md', reason: 'outside-allow-list' }]);
  });

  it('refuses when the project note itself is not shareable', async () => {
    const res = await buildContextPack(base({ reasonNotShareable: allow({ 'Work/P.md': 'outside-allow-list' }) }));
    expect(res).toEqual({ ok: false, error: 'ai-share-empty' });
  });

  it('refuses over the budget and is byte-stable otherwise', async () => {
    const big = await buildContextPack(base({ sources: [note('Work/Big.md', 'x'.repeat(PACK_BUDGET_BYTES + 10))] }));
    expect(big).toEqual({ ok: false, error: 'pack-over-budget' });
    const a = await buildContextPack(base());
    const b = await buildContextPack(base());
    expect(a.ok && b.ok && a.value.digest === b.value.digest).toBe(true);
  });

  it('a stale preview is refused when a source or the policy changed', async () => {
    const res = await buildContextPack(base());
    if (!res.ok) throw new Error('pack');
    const hashes = new Map(res.value.sources.map((s) => [s.path, s.contentHash]));
    expect(verifyPrepared(res.value, { sharePolicyRevision: 'rev1', hashes }).ok).toBe(true);
    expect(verifyPrepared(res.value, { sharePolicyRevision: 'rev2', hashes })).toEqual({ ok: false, error: 'pack-preview-stale' });
    expect(verifyPrepared(res.value, { sharePolicyRevision: 'rev1', hashes: new Map([['Work/P.md', 'other']]) })).toEqual({ ok: false, error: 'pack-preview-stale' });
  });

  it('neutraliseLinks keeps an unresolved plain link and hides an unresolved embed', () => {
    const i = { reasonNotShareable: () => null, resolveLink: () => null };
    expect(neutraliseLinks('[[Ghost]] ![[Ghost]]', 'a.md', i)).toBe('[[Ghost]] [not shared]');
  });
});

describe('markdown links are neutralised like wikilinks', () => {
  const i = { reasonNotShareable: (p: string) => (p === 'Work/Secret.md' ? ('outside-allow-list' as const) : null), resolveLink: (l: string) => (l === 'ghost.md' ? null : l) };
  it('hides private targets, images and attachments; leaves web links and anchors', () => {
    const out = neutraliseLinks('[a](Work/Secret.md) [b](Work/Open.md) ![c](Work/Secret.md) ![d](img.png) [e](https://example.com) [f](#top) [g](<Work/Secret.md#h>) [h](ghost.md)', 'x.md', i);
    expect(out).toBe('a [not shared] [b](Work/Open.md) [not shared] [attachment not included] [e](https://example.com) [f](#top) g [not shared] h [not shared]');
  });
});
