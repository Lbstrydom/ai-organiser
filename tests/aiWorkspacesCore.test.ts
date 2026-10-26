import { describe, it, expect } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/core/settings';
import {
  isAiShareable, normaliseShareFolders, notShareableReason, sharePolicyRevision, shareFolderOf,
} from '../src/services/aiWorkspaces/aiShareScope';
import { normaliseWorkspace, normaliseWorkspaces, validateChatUrl, withPack, emptyWorkspace } from '../src/services/aiWorkspaces/workspaceRecord';
import { applyWorkspaceBlock, readWorkspaceBlock, renderWorkspaceBlock, stripWorkspaceBlock } from '../src/services/aiWorkspaces/workspaceBlock';
import { bodyWithoutOwned, buildWorkspaceInstructions, capBytes, sectionUnder } from '../src/services/aiWorkspaces/workspaceInstructions';
import { buildContextPack, verifyPrepared, PACK_BUDGET_BYTES } from '../src/services/aiWorkspaces/contextPack';
import { neutraliseByCache, type LinkOccurrence } from '../src/services/aiWorkspaces/linkNeutraliser';
import { renderHandoffContract } from '../src/services/aiWorkspaces/handoffGrammar';

const ID = '3f2b8f4e-1c2d-4e5f-8a6b-7c8d9e0f1a2b';
const settings = (over: Partial<typeof DEFAULT_SETTINGS> = {}) => ({ ...DEFAULT_SETTINGS, ...over });
const PACK_DIR = 'AI-Organiser/Workspace packs';

describe('AI share scope (default deny)', () => {
  it('shares nothing while the allow-list is empty', () => {
    expect(isAiShareable('2 Areas/A1/note.md', settings(), PACK_DIR)).toBe(false);
  });

  it('shares a note inside an entry and nothing outside it', () => {
    const s = settings({ aiShareFolders: ['2 Areas/A1'] });
    expect(isAiShareable('2 Areas/A1/note.md', s, PACK_DIR)).toBe(true);
    expect(isAiShareable('2 Areas/A1/deep/er/note.md', s, PACK_DIR)).toBe(true);
    expect(isAiShareable('2 Areas/A10/note.md', s, PACK_DIR)).toBe(false);
    expect(isAiShareable('2 Areas/A2/note.md', s, PACK_DIR)).toBe(false);
  });

  it('keeps hidden, excluded, protected and pack-folder notes out even inside an entry', () => {
    const s = settings({ aiShareFolders: ['Work'], agentIndexExcludeFolders: ['Work/Private'], protectedFolders: ['Work/Course'] });
    expect(isAiShareable('Work/ok.md', s, PACK_DIR)).toBe(true);
    expect(isAiShareable('Work/Private/x.md', s, PACK_DIR)).toBe(false);
    expect(isAiShareable('Work/Course/x.md', s, PACK_DIR)).toBe(false);
    expect(notShareableReason('Work/Private/x.md', s, PACK_DIR)).toBe('kept-out');
    const packInside = settings({ aiShareFolders: ['AI-Organiser'] });
    expect(isAiShareable(`${PACK_DIR}/p/latest.json`, packInside, PACK_DIR)).toBe(false);
    expect(notShareableReason(`${PACK_DIR}/p/x.md`, packInside, PACK_DIR)).toBe('in-pack-folder');
    expect(notShareableReason('Elsewhere/x.md', s, PACK_DIR)).toBe('outside-allow-list');
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

/** A stand-in for Obsidian's cache in these tests: the wikilinks and embeds of a text, at their offsets. */
function wikiCache(text: string): LinkOccurrence[] {
  return [...text.matchAll(/(!?)\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g)].map((m) => ({ link: m[2], displayText: m[3] ?? m[2], original: m[0], start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, embed: m[1] === '!' }));
}

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
    resolveLink: (l: string) => (/\.[a-z]+$/i.test(l) ? l : `Work/${l}.md`),
    linksOf: (n: { text: string }) => wikiCache(n.text),
    sharePolicyRevision: 'rev1',
    ...over,
  });

  it('includes shareable notes, renders links to others as [not shared] and never includes attachments', async () => {
    const res = await buildContextPack(base());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.text).toContain('Secret [not shared]');
    // shareable but not part of this pack: told so, not left as a dead link
    expect(res.value.text).toContain('Open [not in this pack]');
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

  it('a note whose links cannot be checked is left out, and the project note then refuses with its own code', async () => {
    const src = await buildContextPack(base({ sources: [note('Work/Ok.md', 'ok words [[Open]]')], linksOf: (n: { path: string; text: string }) => (n.path === 'Work/Ok.md' ? null : wikiCache(n.text)) }));
    expect(src.ok && src.value.skipped).toEqual([{ path: 'Work/Ok.md', reason: 'links-unverified' }]);
    expect(src.ok && src.value.text).not.toContain('ok words');
    expect(await buildContextPack(base({ linksOf: () => null }))).toEqual({ ok: false, error: 'pack-links-unverified' });
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

});


describe('audit round 2 pins', () => {
  it('rejects a ChatGPT address with a suffix or an injected link', () => {
    expect(validateChatUrl('chatgpt', 'https://chatgpt.com/project/x)](https://evil.example')).toBeNull();
    expect(validateChatUrl('chatgpt', 'https://chatgpt.com/g/g-abc/project/extra')).toBeNull();
  });
  it('a tilde fence is not closed by a backtick fence', () => {
    expect(sectionUnder('## AI context\n~~~\n```\n## inner\n~~~\nafter\n## B\nz', 'AI context')).toBe('~~~\n```\n## inner\n~~~\nafter');
  });
});

describe('audit round 3 pins', () => {
  it('a fence closes only on a bare closer of the same character and length', () => {
    expect(sectionUnder('## AI context\n```js\n```not a closer\n## inner\n```\nafter\n## B\nz', 'AI context')).toBe('```js\n```not a closer\n## inner\n```\nafter');
    expect(sectionUnder('## AI context\n````\n```\n## inner\n````\nafter\n## B', 'AI context')).toBe('````\n```\n## inner\n````\nafter');
  });
  it('capBytes keeps the marker inside the budget and never splits a character', () => {
    const out = capBytes('a'.repeat(9000), 8 * 1024);
    expect(new TextEncoder().encode(out).length).toBeLessThanOrEqual(8 * 1024);
    expect(out).toContain('[cut:');
    const emoji = capBytes('😀'.repeat(3000), 1000);
    expect(new TextEncoder().encode(emoji).length).toBeLessThanOrEqual(1000);
    expect(emoji).not.toContain('�');
  });
});


describe('links come from the metadata cache and fail closed', () => {
  const policy = { reasonNotShareable: (p: string) => (p.includes('Private') ? 'outside-allow-list' : null), resolveLink: (l: string) => l };
  /** Occurrences as Obsidian would report them for `text`: every listed source string, at its real offset. */
  const occ = (text: string, originals: Array<{ original: string; link: string; displayText?: string; embed?: boolean }>): LinkOccurrence[] => {
    let from = 0;
    return originals.map((o) => { const start = text.indexOf(o.original, from); from = start + o.original.length; return { link: o.link, displayText: o.displayText, original: o.original, start, end: start + o.original.length, embed: o.embed === true }; });
  };
  const run = (text: string, list: LinkOccurrence[] | null) => neutraliseByCache(text, 'a.md', list, policy);

  it('handles angle-bracket targets, titles and nested parentheses without parsing them', () => {
    const text = 'a [x](<Work/Private (1).md>) b [y](Work/Team(Plans(Private))/S.md "t") c [ok](Work/A(B(C)).md "title") d';
    const list = occ(text, [
      { original: '[x](<Work/Private (1).md>)', link: 'Work/Private (1).md', displayText: 'x' },
      { original: '[y](Work/Team(Plans(Private))/S.md "t")', link: 'Work/Team(Plans(Private))/S.md', displayText: 'y' },
      { original: '[ok](Work/A(B(C)).md "title")', link: 'Work/A(B(C)).md', displayText: 'ok' },
    ]);
    expect(run(text, list)).toEqual({ ok: true, value: 'a x [not shared] b y [not shared] c [ok](Work/A(B(C)).md "title") d' });
  });

  it('wikilinks and embeds: private hidden, attachments never included, shareable embed shows its text', () => {
    const text = 'see [[Private plan|plan]] and ![[Private plan]] and ![[pic.png]] and [[Open]]';
    const list = occ(text, [
      { original: '[[Private plan|plan]]', link: 'Private plan', displayText: 'plan' },
      { original: '![[Private plan]]', link: 'Private plan', embed: true },
      { original: '![[pic.png]]', link: 'pic.png', embed: true },
      { original: '[[Open]]', link: 'Open', displayText: 'Open' },
    ]);
    expect(run(text, list)).toEqual({ ok: true, value: 'see plan [not shared] and [not shared] and [attachment not included] and [[Open]]' });
  });

  it('leaves web links alone and does not count links inside fenced code', () => {
    const text = '[w](https://example.com)\n```\n[[Private x]] and [c](Private/y.md)\n```\n';
    const list = occ(text, [{ original: '[w](https://example.com)', link: 'https://example.com', displayText: 'w' }]);
    expect(run(text, list)).toEqual({ ok: true, value: text });
  });

  it('a stale cache fails closed: moved offsets, a missing cache, or a link the cache never saw', () => {
    const text = 'x [[Open]] y';
    const good = occ(text, [{ original: '[[Open]]', link: 'Open' }]);
    expect(run(text, good).ok).toBe(true);
    expect(run('XX' + text, good)).toEqual({ ok: false, error: 'links-unverified' });
    expect(run(text, null)).toEqual({ ok: false, error: 'links-unverified' });
    expect(run(text + ' [[Added later]]', good)).toEqual({ ok: false, error: 'links-unverified' });
    expect(run(text + ' [new](Private/z.md)', good)).toEqual({ ok: false, error: 'links-unverified' });
    expect(run(text, [{ ...good[0], end: 999 }])).toEqual({ ok: false, error: 'links-unverified' });
    expect(run(text, [...good, ...good])).toEqual({ ok: false, error: 'links-unverified' });
  });
});

describe('the pack folder is always excluded', () => {
  it('a missing or empty pack folder shares nothing rather than everything', () => {
    const s = settings({ aiShareFolders: ['Work'] });
    expect(isAiShareable('Work/a.md', s, '')).toBe(false);
    expect(isAiShareable('Work/a.md', s, '   ')).toBe(false);
    expect(isAiShareable('Work/a.md', s, 'Work/Packs')).toBe(true);
    expect(isAiShareable('Work/Packs/p.md', s, 'Work/Packs')).toBe(false);
  });
});

describe('pack files are never shareable notes', () => {
  it('a file named like a pack is refused wherever it sits', async () => {
    const { looksLikePack } = await import('../src/services/aiWorkspaces/aiShareScope');
    expect(looksLikePack('Anywhere/Deep/pack-20261026-090507-aaaaaaaaaaaa.md')).toBe(true);
    expect(looksLikePack('Work/pack-notes.md')).toBe(false);
    const s = settings({ aiShareFolders: ['Work'] });
    expect(isAiShareable('Work/pack-20261026-090507-aaaaaaaaaaaa.md', s, 'Somewhere/Else')).toBe(false);
    expect(notShareableReason('Work/pack-20261026-090507-aaaaaaaaaaaa.md', s, 'Somewhere/Else')).toBe('in-pack-folder');
  });
});

describe('external web links are not links the cache missed (persona F1)', () => {
  const policy = { reasonNotShareable: (p: string) => (p.includes('Private') ? 'outside-allow-list' : null), resolveLink: (l: string) => l };
  const run = (text: string, list: LinkOccurrence[] = []) => neutraliseByCache(text, 'a.md', list, policy);

  it('a note with a workspace link (and other web links and images) is fine with no cache entries for them', () => {
    const text = '# P\n\nSee [Acme migration](https://claude.ai/project/abc-123) and ![logo](https://example.com/a.png) and [mail](mailto:a@b.co) and [angle](<https://x.test/a b>).\n';
    expect(run(text)).toEqual({ ok: true, value: text });
  });

  it('still fails closed for vault links the cache did not report, even next to a web link', () => {
    expect(run('[ok](https://example.com) and [secret](Private/plan.md)')).toEqual({ ok: false, error: 'links-unverified' });
    expect(run('![x](Private/plan.png)')).toEqual({ ok: false, error: 'links-unverified' });
    expect(run('[x](httpsx://nope) [y](ftp://host/a)')).toEqual({ ok: false, error: 'links-unverified' });
    expect(run('[[Private plan]] [w](https://example.com)')).toEqual({ ok: false, error: 'links-unverified' });
  });
});

describe('a second pack after the workspace link was written (persona F1 regression)', () => {
  const note = (path: string, text: string) => ({ path, text });
  const base = (projectText: string) => ({
    vaultId: 'vault', aioId: ID, projectName: 'P',
    project: note('Work/P.md', projectText),
    sources: [] as Array<{ path: string; text: string }>,
    reasonNotShareable: () => null,
    resolveLink: (l: string) => l,
    // Obsidian reports no entry for an external link
    linksOf: (n: { text: string }) => wikiCache(n.text),
    sharePolicyRevision: 'rev',
  });

  it('the first pack builds, the workspace block is written, and the second pack and the instructions still build', async () => {
    const first = await buildContextPack(base('# P\n\nGoal: ship.\n'));
    expect(first.ok).toBe(true);
    const withBlock = '# P\n\nGoal: ship.\n\n<!-- aio:workspace -->\n## AI workspace\n- [Acme migration](https://claude.ai/project/abc-123) (Claude)\n- Last pack: 2026-10-26\n<!-- /aio:workspace -->\n';
    const second = await buildContextPack(base(withBlock));
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.instructions).toContain('Goal: ship.');
    // the plugin-owned block is not the person's words and is not in the pack
    expect(second.value.text).not.toContain('claude.ai/project');
    // the block never makes a pack stale
    if (first.ok) expect(second.value.sources[0].contentHash).toBe(first.value.sources[0].contentHash);
  });

  it('a project note that links a web page in its own text also builds', async () => {
    const res = await buildContextPack(base('# P\n\nSpec: [the spec](https://example.com/spec).\n'));
    expect(res.ok).toBe(true);
  });
});

describe('a pack holds each note once (persona P3)', () => {
  const note = (path: string, text: string) => ({ path, text });
  const make = (sources: Array<{ path: string; text: string }> = []) => buildContextPack({
    vaultId: 'v', aioId: ID, projectName: 'P',
    project: note('Work/P.md', '# P\n\nUNIQUE-PROJECT-WORDS see [[Budget]] and [[Included]].\n'),
    area: note('Work/Area.md', '# Area\n\n## AI context\n\nUNIQUE-AREA-RULES\n'),
    sources,
    reasonNotShareable: () => null,
    resolveLink: (l: string) => `Work/${l}.md`,
    linksOf: (n: { text: string }) => wikiCache(n.text),
    sharePolicyRevision: 'rev',
  });

  it('the project and Area words appear once in the pack, while the copied instructions still carry them', async () => {
    const res = await make();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.text.match(/UNIQUE-PROJECT-WORDS/g)).toHaveLength(1);
    expect(res.value.text.match(/UNIQUE-AREA-RULES/g)).toHaveLength(1);
    expect(res.value.text).toContain('The project note is included in full below.');
    expect(res.value.instructions).toContain('UNIQUE-PROJECT-WORDS');
    expect(res.value.instructions).toContain('UNIQUE-AREA-RULES');
  });

  it('a link to a note that is in the pack stays a link; one that is shareable but not in it says so', async () => {
    const res = await make([note('Work/Included.md', 'included words')]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.text).toContain('[[Included]]');
    expect(res.value.text).toContain('Budget [not in this pack]');
    expect(res.value.text).not.toContain('[[Budget]]');
  });
});
