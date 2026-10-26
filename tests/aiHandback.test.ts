import { describe, it, expect } from 'vitest';
import { parseHandoff, itemId, handbackIdOf, MAX_ITEMS_PER_SECTION } from '../src/services/aiWorkspaces/handoffParser';
import { renderHandoffContract } from '../src/services/aiWorkspaces/handoffGrammar';
import { mappingKey, normaliseChatMap, rankProjects, type MatchEnvironment } from '../src/services/aiWorkspaces/handoffMatch';
import { freeze, normaliseHandbacks, prune, recoverApplying, setState, MAX_HANDBACK_RECORDS } from '../src/services/aiWorkspaces/handbackJournal';
import { addUnderHeading, appliedIds } from '../src/services/aiWorkspaces/handoffNoteEdit';
import { DEFAULT_SETTINGS, migrateOldSettings } from '../src/core/settings';
import type { ProjectRef } from '../src/services/projects/projectIndex';

const ID = '3f2b8f4e-1c2d-4e5f-8a6b-7c8d9e0f1a2b';
const OTHER = '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d';
const CTX = ['@computer', '@phone', '@office'];

describe('handoff parser', () => {
  const block = (extra = '') => `Intro text\n\n## Handoff\nProject ID: ${ID}\nChat project: Website brain (claude)\n\n### Decisions\n- Suggested: Use a static site\n- Decided: Launch in March\n- A decision with no claim\n\n### Next actions\n- [ ] Email Dana @phone (due: 2026-11-06)\n- [ ] Chase quote\n  and then call back (waiting: Sam)\n- [ ] Book room (due: 2026-02-30)\n\n### Deliverables\n- plan_v03.docx: the plan (released)\n- notes.md: rough notes\n\n### Questions\n- Who signs off?\n${extra}`;

  it('reads every section of a well-formed block', () => {
    const p = parseHandoff(block(), CTX);
    expect(p.status).toBe('ok');
    expect(p.projectId).toBe(ID);
    expect(p.chat).toEqual({ name: 'Website brain', app: 'claude' });
    expect(p.decisions.map((d) => [d.claim, d.text])).toEqual([['suggested', 'Use a static site'], ['decided', 'Launch in March'], ['suggested', 'A decision with no claim']]);
    expect(p.warnings.some((w) => w.code === 'missing-claim')).toBe(true);
    expect(p.actions[0]).toMatchObject({ text: 'Email Dana', contexts: ['@phone'], due: '2026-11-06' });
    expect(p.actions[1]).toMatchObject({ waiting: 'Sam' });
    expect(p.actions[1].text).toContain('and then call back');
    expect(p.actions[2].due).toBeUndefined();
    expect(p.warnings.some((w) => w.code === 'bad-date')).toBe(true);
    expect(p.deliverables.map((d) => [d.fileName, d.status])).toEqual([['plan_v03.docx', 'released'], ['notes.md', 'draft']]);
    expect(p.questions.map((q) => q.text)).toEqual(['Who signs off?']);
  });

  it('parses the contract the instructions show: the template echoed back yields no items and is malformed only by its header', () => {
    const p = parseHandoff(renderHandoffContract(ID), CTX);
    expect(p.status).toBe('ok');
    expect(p.decisions).toHaveLength(0);
    expect(p.actions).toHaveLength(0);
    expect(p.deliverables).toHaveLength(0);
    expect(p.questions).toHaveLength(0);
  });

  it('malformed: no section, no header, conflicting or invalid ids, with reasons', () => {
    expect(parseHandoff('Just some notes.', CTX)).toMatchObject({ status: 'malformed', reasons: ['no-section'] });
    expect(parseHandoff('## Handoff\n\n### Decisions\n- Decided: x', CTX)).toMatchObject({ status: 'malformed', reasons: ['no-header'] });
    expect(parseHandoff(`## Handoff\nProject ID: ${ID}\nProject ID: ${OTHER}\n`, CTX)).toMatchObject({ status: 'malformed', reasons: ['conflicting-project'] });
    expect(parseHandoff('## Handoff\nProject ID: not-an-id\n', CTX)).toMatchObject({ status: 'malformed', reasons: ['project-id-invalid'] });
    expect(parseHandoff('## Handoff\nProject ID: not-an-id\n', CTX).projectId).toBeUndefined();
  });

  it('a Handoff heading inside a code fence is not a section, and a second block is warned about', () => {
    expect(parseHandoff('```\n## Handoff\nProject ID: ' + ID + '\n```\n', CTX).reasons).toEqual(['no-section']);
    const two = parseHandoff(`${block()}\n## Handoff\nProject ID: ${OTHER}\n`, CTX);
    expect(two.projectId).toBe(ID);
    expect(two.warnings.some((w) => w.code === 'extra-block')).toBe(true);
  });

  it('only known contexts are attributes; an escaped one is text; unknown subsections are warned about', () => {
    const p = parseHandoff(`## Handoff\nProject ID: ${ID}\n### Next actions\n- Call @nobody\n- Email \\@phone\n- Ring @office\n### Notes\n- ignored\n`, CTX);
    expect(p.actions.map((a) => [a.text, a.contexts])).toEqual([['Call @nobody', []], ['Email @phone', []], ['Ring', ['@office']]]);
    expect(p.warnings.some((w) => w.code === 'unknown-key' && w.detail === 'Notes')).toBe(true);
  });

  it('nothing is silently truncated: long items are flagged and items past the cap are counted', () => {
    const many = Array.from({ length: MAX_ITEMS_PER_SECTION + 3 }, (_, i) => `- Item ${i}`).join('\n');
    const p = parseHandoff(`## Handoff\nProject ID: ${ID}\n### Questions\n${many}\n- ${'x'.repeat(600)}\n`, CTX);
    expect(p.questions).toHaveLength(MAX_ITEMS_PER_SECTION);
    expect(p.more.questions).toBe(4);
    const long = parseHandoff(`## Handoff\nProject ID: ${ID}\n### Questions\n- ${'y'.repeat(600)}\n`, CTX);
    expect(long.questions[0].longItem).toBe(true);
    expect(long.questions[0].text).toHaveLength(600);
  });

  it('item ids are stable, computed by the plugin, and differ by section, text and ordinal', async () => {
    const hb = await handbackIdOf(block());
    const a = await itemId(hb, { section: 'questions', text: 'Who signs off?', ordinal: 0 });
    expect(await itemId(hb, { section: 'questions', text: '  who SIGNS off? ', ordinal: 0 })).toBe(a);
    expect(await itemId(hb, { section: 'questions', text: 'Who signs off?', ordinal: 1 })).not.toBe(a);
    expect(await itemId(hb, { section: 'decisions', text: 'Who signs off?', ordinal: 0 })).not.toBe(a);
    expect(await handbackIdOf(block('- another\n'))).not.toBe(hb);
  });
});

describe('project matching: suggest, never auto-file', () => {
  const project = (aioId: string, notePath: string): ProjectRef => ({ aioId, notePath, folder: notePath.slice(0, notePath.lastIndexOf('/')), rootKind: 'projects', status: 'active', pairing: 'none' });
  const A = project(ID, '1 Projects/Website/Website relaunch.md');
  const B = project(OTHER, '1 Projects/Garden/Garden plan.md');
  const env = (over: Partial<MatchEnvironment> = {}): MatchEnvironment => ({ candidates: [{ project: A, chatNames: [] }, { project: B, chatNames: [] }], duplicates: new Set(), chatMap: {}, ...over });
  const signals = { title: 'Session notes', fileName: 'handoff-2026-10-26', subfolder: '' };

  it('an id that resolves to exactly one project is exact', () => {
    expect(rankProjects({ ...signals, projectId: ID }, env()).exact).toBe(A);
  });

  it('an unknown or duplicated id is rejected with no default and no guessing', () => {
    const unknown = rankProjects({ ...signals, projectId: '11111111-1111-4111-8111-111111111111', title: 'Website relaunch' }, env());
    expect(unknown).toMatchObject({ rejected: 'unknown-id', ranked: [] });
    expect(unknown.preselect).toBeUndefined();
    expect(rankProjects({ ...signals, projectId: ID }, env({ duplicates: new Set([ID]) }))).toMatchObject({ rejected: 'duplicate-id', ranked: [] });
  });

  it('the remembered mapping is the strongest signal and is pre-selected', () => {
    const r = rankProjects({ ...signals, chat: { name: 'Website  Brain', app: 'claude' } }, env({ chatMap: { [mappingKey({ name: 'website brain', app: 'claude' })]: ID } }));
    expect(r.preselect).toBe(A);
    expect(r.ranked[0]).toMatchObject({ reason: 'mapping', score: 1 });
  });

  it('a chat name without an app matches the mapping only as a weaker suggestion', () => {
    const r = rankProjects({ ...signals, chat: { name: 'Website brain' } }, env({ chatMap: { 'claude:website brain': ID, 'any:website brain': ID } }));
    expect(r.ranked[0].score).toBeLessThan(1);
  });

  it('a low-confidence or tied match has no default', () => {
    const weak = rankProjects({ ...signals, title: 'garden' }, env());
    expect(weak.ranked[0].project).toBe(B);
    expect(weak.preselect).toBeUndefined();
    const tie = rankProjects({ ...signals, chat: { name: 'Shared', app: 'claude' } }, env({ candidates: [{ project: A, chatNames: ['Shared'] }, { project: B, chatNames: ['Shared'] }] }));
    expect(tie.preselect).toBeUndefined();
    expect(tie.ranked).toHaveLength(2);
  });

  it('a workspace chat name is a clear signal when only one project has it', () => {
    const r = rankProjects({ ...signals, chat: { name: 'Site brain', app: 'claude' } }, env({ candidates: [{ project: A, chatNames: ['site brain'] }, { project: B, chatNames: [] }] }));
    expect(r.preselect).toBe(A);
    expect(r.ranked[0].reason).toBe('workspace-chat');
  });

  it('duplicated projects are never candidates, and the stored map keeps only well-formed entries', () => {
    expect(rankProjects({ ...signals, chat: { name: 'Shared', app: 'claude' } }, env({ duplicates: new Set([ID]), candidates: [{ project: A, chatNames: ['Shared'] }, { project: B, chatNames: [] }] })).ranked).toEqual([]);
    expect(normaliseChatMap({ 'claude:ok': ID.toUpperCase(), 'bad key': ID, 'claude:x': 'nope', 'any:': ID })).toEqual({ 'claude:ok': ID });
  });
});

describe('hand-back journal', () => {
  it('freezes items once and a re-read never changes or resets them', () => {
    const first = freeze(undefined, 'hb', 'a.md', 't', [{ id: 'i1', section: 'questions' }]);
    const applied = setState(first, 'i1', 'applied');
    const again = freeze(applied, 'hb', 'moved/a.md', 't2', [{ id: 'i1', section: 'questions' }, { id: 'i2', section: 'actions' }]);
    expect(again.items.i1.state).toBe('applied');
    expect(again.items.i2.state).toBe('pending');
    expect(again.notePath).toBe('moved/a.md');
  });

  it('an applied item is final; a failed one can be retried; an interrupted apply goes back to pending', () => {
    let r = freeze(undefined, 'hb', 'a.md', 't', [{ id: 'i1', section: 'decisions' }, { id: 'i2', section: 'decisions' }]);
    r = setState(r, 'i1', 'applied');
    expect(setState(r, 'i1', 'failed', 'x').items.i1.state).toBe('applied');
    r = setState(r, 'i2', 'applying');
    expect(recoverApplying(r).items.i2.state).toBe('pending');
    expect(setState(setState(r, 'i2', 'failed', 'storage'), 'i2', 'applied').items.i2.state).toBe('applied');
  });

  it('normalises stored data and prunes finished records first', () => {
    expect(normaliseHandbacks({ x: { id: 'x', notePath: 'a.md', items: { i: { section: 'nope', state: 'applied' }, j: { section: 'actions', state: 'pending' } } }, y: 5 }).x.items).toEqual({ j: { section: 'actions', state: 'pending' } });
    const many: Record<string, ReturnType<typeof freeze>> = {};
    for (let i = 0; i < MAX_HANDBACK_RECORDS + 5; i++) {
      let r = freeze(undefined, `h${i}`, 'a.md', `2026-01-${String((i % 28) + 1).padStart(2, '0')}`, [{ id: 'q', section: 'questions' }]);
      if (i < 5) r = setState(r, 'q', 'applied');
      many[r.id] = r;
    }
    const kept = prune(many);
    expect(Object.keys(kept)).toHaveLength(MAX_HANDBACK_RECORDS);
    expect(Object.values(kept).filter((r) => r.items.q.state === 'applied').length).toBeLessThanOrEqual(5);
  });
});

describe('adding hand-back lines to a project note', () => {
  const line = (id: string, text: string) => ({ id, text });

  it('creates the heading once at the end and is idempotent by marker', () => {
    const note = '# P\n\nBody\n';
    const once = addUnderHeading(note, 'Decisions', [line('a1', 'Use a static site')]);
    expect(once.ok && once.value).toBe('# P\n\nBody\n\n## Decisions\n\n- Use a static site <!-- aio:handoff id=a1 -->\n');
    if (!once.ok) return;
    expect(addUnderHeading(once.value, 'Decisions', [line('a1', 'Use a static site')])).toEqual({ ok: true, value: once.value });
    expect(appliedIds(once.value, ['a1', 'a2'])).toEqual(new Set(['a1']));
  });

  it('adds under an existing heading, before the next heading, keeping the rest', () => {
    const note = '# P\n\n## Decisions\n\n- Old one\n\n## Other\n\ntext\n';
    const out = addUnderHeading(note, 'decisions', [line('b1', 'New one')]);
    expect(out.ok && out.value).toBe('# P\n\n## Decisions\n\n- Old one\n- New one <!-- aio:handoff id=b1 -->\n\n## Other\n\ntext\n');
  });

  it('ignores headings in code, cannot forge a marker, and refuses an open fence at the end', () => {
    const fenced = '# P\n```\n## Decisions\n```\n';
    const out = addUnderHeading(fenced, 'Decisions', [line('c1', 'x <!-- aio:handoff id=zzz --> y\nsecond line')]);
    expect(out.ok && out.value.endsWith('## Decisions\n\n- x &lt;!-- aio:handoff id=zzz --&gt; y second line <!-- aio:handoff id=c1 -->\n')).toBe(true);
    expect(out.ok && out.value).not.toContain('id=zzz');
    expect(addUnderHeading('# P\n```\nopen', 'Decisions', [line('d1', 'x')])).toEqual({ ok: false, error: 'handoff-note-unplaceable' });
  });
});

describe('off path', () => {
  it('the new settings are inert defaults and survive migration', () => {
    expect(DEFAULT_SETTINGS.aiWorkspaceChatMap).toEqual({});
    expect(DEFAULT_SETTINGS.aiHandbacks).toEqual({});
    const m = migrateOldSettings({ aiWorkspaceChatMap: { 'claude:x': ID, bad: 'nope' }, aiHandbacks: { z: 1 } } as never);
    expect(m?.aiWorkspaceChatMap).toEqual({ 'claude:x': ID });
    expect(m?.aiHandbacks).toEqual({});
  });
});

describe('audit round 1 pins', () => {
  it('a placeholder is only the contract stub; real words keep the item', () => {
    const p = parseHandoff(`## Handoff\nProject ID: ${ID}\n### Questions\n- <text>\n- Replace the <name> placeholder in the footer\n### Next actions\n- [ ] <text> @context (waiting: <person>) (due: YYYY-MM-DD)\n`, CTX);
    expect(p.questions.map((q) => q.text)).toEqual(['Replace the <name> placeholder in the footer']);
    expect(p.actions).toHaveLength(0);
  });

  it('the open-fence guard also covers an existing heading', () => {
    expect(addUnderHeading('# P\n\n## Decisions\n\n- x\n```\nopen', 'Decisions', [{ id: 'e1', text: 'y' }])).toEqual({ ok: false, error: 'handoff-note-unplaceable' });
  });

  it('pruning never drops an interrupted or failed hand-back', () => {
    const many: Record<string, ReturnType<typeof freeze>> = {};
    for (let i = 0; i < MAX_HANDBACK_RECORDS + 20; i++) {
      let r = freeze(undefined, `h${i}`, 'a.md', `2026-02-${String((i % 28) + 1).padStart(2, '0')}`, [{ id: 'q', section: 'questions' }]);
      if (i < 3) r = setState(r, 'q', 'applying');
      if (i === 3) r = setState(r, 'q', 'failed', 'storage');
      many[r.id] = r;
    }
    const kept = prune(many);
    expect(Object.keys(kept)).toHaveLength(MAX_HANDBACK_RECORDS);
    for (const k of ['h0', 'h1', 'h2', 'h3']) expect(kept[k]).toBeDefined();
  });

  it('with more than 500 candidates there is no default', () => {
    const mk = (n: number) => ({ project: { aioId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, notePath: `P/Website ${n}.md`, folder: 'P', rootKind: 'projects' as const, status: '', pairing: 'none' as const }, chatNames: n === 0 ? ['Site brain'] : [] });
    const env = { candidates: Array.from({ length: 501 }, (_, i) => mk(i)), duplicates: new Set<string>(), chatMap: {} };
    expect(rankProjects({ title: 't', fileName: 'f', subfolder: '', chat: { name: 'Site brain', app: 'claude' as const } }, env).preselect).toBeUndefined();
    expect(rankProjects({ title: 't', fileName: 'f', subfolder: '', chat: { name: 'Site brain', app: 'claude' as const } }, { ...env, candidates: env.candidates.slice(0, 5) }).preselect).toBeDefined();
  });

  it('a mapping to a project that is not adoptable gives no suggestion', () => {
    const A = { aioId: ID, notePath: 'P/A.md', folder: 'P', rootKind: 'projects' as const, status: '', pairing: 'none' as const };
    const r = rankProjects({ title: 'x', fileName: 'y', subfolder: '', chat: { name: 'Gone', app: 'claude' } }, { candidates: [{ project: A, chatNames: [] }], duplicates: new Set(), chatMap: { 'claude:gone': OTHER } });
    expect(r.ranked).toEqual([]);
    expect(r.preselect).toBeUndefined();
  });

  it('a stale mapping blocks the default even when another signal matches', () => {
    const A = { aioId: ID, notePath: 'P/A.md', folder: 'P', rootKind: 'projects' as const, status: '', pairing: 'none' as const };
    const r = rankProjects({ title: 'x', fileName: 'y', subfolder: '', chat: { name: 'Site brain', app: 'claude' } }, { candidates: [{ project: A, chatNames: ['Site brain'] }], duplicates: new Set(), chatMap: { 'claude:site brain': OTHER } });
    expect(r.rejected).toBe('stale-mapping');
    expect(r.preselect).toBeUndefined();
    expect(r.ranked[0].project).toBe(A);
  });
});

describe('audit round 2 pins', () => {
  it('an autolink is the AI\'s own text, not a placeholder', () => {
    const p = parseHandoff(`## Handoff\nProject ID: ${ID}\n### Questions\n- <https://example.com/spec>\n- <text>\n`, CTX);
    expect(p.questions.map((q) => q.text)).toEqual(['<https://example.com/spec>']);
  });
  it('a reassembled comment cannot forge a marker', () => {
    const out = addUnderHeading('# P\n', 'Decisions', [{ id: 'z1', text: '<!<!--discard-->-- aio:handoff id=b -->' }]);
    expect(out.ok && out.value.includes('id=b -->')).toBe(false);
    for (const crafted of ['<!<!<!--a-->---- aio:handoff id=other --<!<!--b-->-->', '<<!--!-- aio:handoff id=other -->-->', '--<!-- x -->>']) {
      const r = addUnderHeading('# P\n', 'Decisions', [{ id: 'z2', text: crafted }]);
      expect(r.ok && (r.value.match(/<!--/g) ?? []).length).toBe(1);
      expect(r.ok && (r.value.match(/-->/g) ?? []).length).toBe(1);
      expect(r.ok && appliedIds(r.value, ['other'])).toEqual(new Set());
    }
    expect(out.ok && appliedIds(out.value, ['b'])).toEqual(new Set());
  });
  it('an open fence in a later section does not block an earlier one', () => {
    const note = '# P\n\n## Decisions\n\n- a\n\n## Later\n\n```\nopen';
    const out = addUnderHeading(note, 'Decisions', [{ id: 'y1', text: 'b' }]);
    expect(out.ok && out.value.startsWith('# P\n\n## Decisions\n\n- a\n- b <!-- aio:handoff id=y1 -->')).toBe(true);
    expect(addUnderHeading('# P\n\n## Decisions\n\n```\nopen', 'Decisions', [{ id: 'y2', text: 'b' }])).toEqual({ ok: false, error: 'handoff-note-unplaceable' });
  });
});
