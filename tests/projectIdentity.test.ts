/**
 * Layer 0: project identity. Pure pieces first (keys, adoption, index, resolvers, PARA roots), then the Obsidian-facing
 * service with a faked vault, and the off path (no consumer enabled: nothing is built).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('obsidian', async () => await import('./mocks/obsidian'));
vi.mock('../src/services/noteEdit/applyNoteEdit', () => ({
  // The seam, reduced to what matters here: the recompute runs against the live text and its content is written.
  applyNoteEdit: vi.fn(async (_plugin: unknown, target: { filePath: string; recompute(current: string): { ok: boolean; value?: { content: string }; error?: string } }) => {
    const store = (globalThis as unknown as { __vault: Map<string, string> }).__vault;
    const res = target.recompute(store.get(target.filePath) ?? '');
    if (!res.ok) return { ok: false, error: res.error };
    store.set(target.filePath, res.value!.content);
    return { ok: true, value: undefined };
  }),
}));

import { createTFile } from './mocks/obsidian';
import { insertFrontmatterKeys, readFrontmatterRecord, yamlScalar } from '../src/utils/frontmatterKeys';
import { planAdoption } from '../src/services/projects/projectAdoption';
import {
  buildProjectIndex, isAioId, resolveAnchor, resolveProject, resolveSourceProject, searchProjects, statusOf, type NoteIdentity, type SourceProjectPort,
} from '../src/services/projects/projectIndex';
import { MAX_PARA_ROOTS, normaliseParaRoots, rootOf, validateParaRoots } from '../src/services/projects/paraRoots';
import { ProjectService, getProjectService, linkpathOf, peekProjectService, projectServiceActive } from '../src/services/projects/projectService';
import { DEFAULT_SETTINGS, migrateOldSettings } from '../src/core/settings';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const note = (path: string, frontmatter: Record<string, unknown> | null): NoteIdentity => ({ path, frontmatter });

describe('frontmatterKeys', () => {
  it('appends keys inside an existing block without touching what is there', () => {
    const text = '---\ntitle: X\ntags: [a, b]\n---\nBody\n';
    const out = insertFrontmatterKeys(text, [['aio-id', A], ['aio-role', 'project']]);
    expect(out).toEqual({ ok: true, value: { text: `---\ntitle: X\ntags: [a, b]\naio-id: ${A}\naio-role: project\n---\nBody\n`, frontmatterCreated: false } });
  });

  it('creates the block when the note has none, and keeps CRLF endings', () => {
    expect(insertFrontmatterKeys('Body', [['aio-role', 'area']])).toEqual({ ok: true, value: { text: '---\naio-role: area\n---\nBody', frontmatterCreated: true } });
    const crlf = insertFrontmatterKeys('---\r\ntitle: X\r\n---\r\nBody', [['aio-role', 'area']]);
    expect(crlf.ok && crlf.value.text).toBe('---\r\ntitle: X\r\naio-role: area\r\n---\r\nBody');
  });

  it('refuses frontmatter that cannot take keys, and keys that exist in any spelling', () => {
    for (const bad of ['---\ntitle: X\nBody never closes', '---\n[a, b]\n---\nx', '---\n{a: 1}\n---\nx', '---\nnull\n---\nx', '---\n: : :\n  - [\n---\nx']) {
      expect(insertFrontmatterKeys(bad, [['aio-role', 'project']])).toEqual({ ok: false, error: 'frontmatter-unreadable' });
    }
    expect(insertFrontmatterKeys('---\n"aio-role": project\n---\nx', [['aio-role', 'area']])).toEqual({ ok: false, error: 'frontmatter-key-exists' });
    expect(insertFrontmatterKeys('---\naio-role: project\n---\nx', [['aio-role', 'area']])).toEqual({ ok: false, error: 'frontmatter-key-exists' });
  });

  it('quotes scalars YAML would mistype, and reads a record back', () => {
    expect(yamlScalar('active')).toBe('active');
    expect(yamlScalar('true')).toBe('"true"');
    expect(yamlScalar('12')).toBe('"12"');
    expect(yamlScalar('a: b')).toBe('"a: b"');
    expect(readFrontmatterRecord('---\na: 1\n---\n')).toEqual({ a: 1 });
    expect(readFrontmatterRecord('no frontmatter')).toBeNull();
  });
});

describe('frontmatter insertion round trip', () => {
  it('refuses an insertion that would not read back as the intended strings', () => {
    // a root mapping written with indentation cannot take unindented keys
    expect(insertFrontmatterKeys('---\n  a: 1\n  b: 2\n---\nx', [['aio-role', 'project']])).toEqual({ ok: false, error: 'frontmatter-unreadable' });
    expect(insertFrontmatterKeys('---\na: 1\n---\nx', [['aio-role', 'project']]).ok).toBe(true);
  });
});

describe('planAdoption', () => {
  const fixed = () => A;

  it('adds id, role and an active status in one insertion', () => {
    const plan = planAdoption('---\nsummary: Acme\n---\nText\n', 'project', fixed);
    expect(plan.ok && plan.value.added).toEqual(['aio-id', 'aio-role', 'status']);
    expect(plan.ok && plan.value.text).toBe(`---\nsummary: Acme\naio-id: ${A}\naio-role: project\nstatus: active\n---\nText\n`);
  });

  it('keeps the note\'s own status, and gives an area or container no status at all', () => {
    const own = planAdoption('---\nstatus: on-hold\n---\nx', 'project', fixed);
    expect(own.ok && own.value.added).toEqual(['aio-id', 'aio-role']);
    const area = planAdoption('---\ntitle: Work\n---\nx', 'area', fixed);
    expect(area.ok && area.value.added).toEqual(['aio-id', 'aio-role']);
  });

  it('a note with an id but no role gets only the role, keeping its id', () => {
    const plan = planAdoption(`---\naio-id: ${A}\n---\nx`, 'project', () => B);
    expect(plan.ok && plan.value.aioId).toBe(A);
    expect(plan.ok && plan.value.added).toEqual(['aio-role', 'status']);
  });

  it('a note with the matching role but no id still gets its id', () => {
    const plan = planAdoption('---\naio-role: project\nstatus: active\n---\nx', 'project', () => A);
    expect(plan.ok && plan.value.added).toEqual(['aio-id']);
  });

  it('refuses a bad id, an existing role of another kind and an already adopted note', () => {
    expect(planAdoption('---\naio-id: nope\n---\nx', 'project')).toEqual({ ok: false, error: 'project-id-invalid' });
    expect(planAdoption(`---\naio-id: ${A}\naio-role: area\n---\nx`, 'project')).toEqual({ ok: false, error: 'project-role-conflict' });
    expect(planAdoption(`---\naio-id: ${A}\naio-role: project\nstatus: active\n---\nx`, 'project')).toEqual({ ok: false, error: 'project-already-adopted' });
    expect(planAdoption('---\ntitle: X\nunclosed', 'project')).toEqual({ ok: false, error: 'project-frontmatter-unreadable' });
  });

  it('the same input always plans the same bytes (preview equals write)', () => {
    const text = '---\nsummary: Acme\n---\nText\n';
    expect(planAdoption(text, 'project', fixed)).toEqual(planAdoption(text, 'project', fixed));
  });
});

describe('project index', () => {
  const notes = [
    note('Projects/Acme/Acme.md', { 'aio-id': A, 'aio-role': 'project', status: ' active ' }),
    note('Projects/Beta/Beta.md', { 'aio-id': B, 'aio-role': 'project', status: ['done', 'x'] }),
    note('Areas/Work.md', { 'aio-id': C, 'aio-role': 'area' }),
    note('Misc/No role.md', { 'aio-id': '44444444-4444-4444-8444-444444444444' }),
    note('Misc/Odd role.md', { 'aio-id': '55555555-5555-4555-8555-555555555555', 'aio-role': 'folder' }),
    note('Misc/Bad id.md', { 'aio-id': 'nope', 'aio-role': 'project' }),
    note('Misc/Plain.md', { title: 'x' }),
    note('Misc/None.md', null),
  ];
  const roots = [{ path: 'Projects', kind: 'projects' as const }, { path: 'Areas', kind: 'areas' as const }];
  const index = buildProjectIndex(notes, { roots });

  it('lists projects and anchors by role, with status and root kind, sorted by path', () => {
    expect(index.projects.map((p) => [p.notePath, p.status, p.rootKind, p.folder, p.pairing])).toEqual([
      ['Projects/Acme/Acme.md', 'active', 'projects', 'Projects/Acme', 'none'],
      ['Projects/Beta/Beta.md', 'done', 'projects', 'Projects/Beta', 'none'],
    ]);
    expect(index.anchors.map((a) => a.role)).toEqual(['area', 'project', 'project']);
  });

  it('a note with an id but no or an unknown role, or an invalid id, is offered for adoption', () => {
    expect(index.unadopted).toEqual([
      { path: 'Misc/Bad id.md', reason: 'invalid-id' },
      { path: 'Misc/No role.md', reason: 'no-role' },
      { path: 'Misc/Odd role.md', reason: 'unknown-role' },
    ]);
  });

  it('resolves by id: projects only for resolveProject, any role for resolveAnchor', () => {
    expect(resolveProject(index, A)).toMatchObject({ ok: true, value: { notePath: 'Projects/Acme/Acme.md' } });
    expect(resolveProject(index, C)).toEqual({ ok: false, error: 'project-not-found' });
    expect(resolveAnchor(index, C)).toMatchObject({ ok: true, value: { role: 'area' } });
    expect(resolveProject(index, '66666666-6666-4666-8666-666666666666')).toEqual({ ok: false, error: 'project-not-found' });
    expect(resolveProject(index, 'nope')).toEqual({ ok: false, error: 'project-id-invalid' });
    expect(resolveProject(index, A.toUpperCase())).toMatchObject({ ok: true });
  });

  it('a copied note gives a duplicate: both are listed, and nothing resolves for that id', () => {
    const dup = buildProjectIndex([...notes, note('Projects/Acme copy.md', { 'aio-id': A, 'aio-role': 'project' })], { roots });
    expect(dup.duplicates.get(A)).toEqual(['Projects/Acme copy.md', 'Projects/Acme/Acme.md']);
    expect(resolveProject(dup, A)).toEqual({ ok: false, error: 'duplicate-project-id' });
    expect(resolveAnchor(dup, A)).toEqual({ ok: false, error: 'duplicate-project-id' });
    expect(resolveProject(dup, B)).toMatchObject({ ok: true });
  });

  it('a valid id on a note with no role still counts as a carrier: it collides with an adopted note', () => {
    const idx = buildProjectIndex([
      note('P/Acme.md', { 'aio-id': A, 'aio-role': 'project' }),
      note('Copy/Acme copy.md', { 'aio-id': A }),
    ]);
    expect(idx.duplicates.get(A)).toEqual(['Copy/Acme copy.md', 'P/Acme.md']);
    expect(resolveProject(idx, A)).toEqual({ ok: false, error: 'duplicate-project-id' });
    expect(idx.unadopted).toEqual([{ path: 'Copy/Acme copy.md', reason: 'no-role' }]);
  });

  it('statusOf reads a string or the first string of a list, trimmed', () => {
    expect(statusOf({ status: ' x ' })).toBe('x');
    expect(statusOf({ status: ['', ' y '] })).toBe('y');
    expect(statusOf({ status: 5 })).toBe('');
    expect(statusOf(null)).toBe('');
    expect(isAioId(A)).toBe(true);
    expect(isAioId('1111')).toBe(false);
  });

  it('the picker search ranks exact, prefix, substring, then folder or status; empty query lists by name', () => {
    const list = buildProjectIndex([
      note('P/Alpha plan.md', { 'aio-id': A, 'aio-role': 'project', status: 'active' }),
      note('P/Plan.md', { 'aio-id': B, 'aio-role': 'project', status: 'done' }),
      note('Q/Zeta.md', { 'aio-id': C, 'aio-role': 'project', status: 'planning' }),
    ]).projects;
    expect(searchProjects(list, 'plan').map((p) => p.notePath)).toEqual(['P/Plan.md', 'P/Alpha plan.md', 'Q/Zeta.md']);
    expect(searchProjects(list, '').map((p) => p.notePath)).toEqual(['P/Alpha plan.md', 'P/Plan.md', 'Q/Zeta.md']);
    expect(searchProjects(list, 'nothing')).toEqual([]);
  });
});

describe('resolveSourceProject', () => {
  const mk = (extra: NoteIdentity[] = []) => buildProjectIndex([
    note('Projects/Acme/Acme.md', { 'aio-id': A, 'aio-role': 'project' }),
    note('Projects/Acme/Phase/Phase.md', { 'aio-id': B, 'aio-role': 'project' }),
    note('Projects/Shared/One.md', { 'aio-id': C, 'aio-role': 'project' }),
    note('Projects/Shared/Two.md', { 'aio-id': '77777777-7777-4777-8777-777777777777', 'aio-role': 'project' }),
    note('Root project.md', { 'aio-id': '88888888-8888-4888-8888-888888888888', 'aio-role': 'project' }),
    ...extra,
  ]);
  const port = (links: Record<string, string>, resolve: Record<string, string>): SourceProjectPort => ({ projectLink: (p) => links[p] ?? null, resolveLink: (l) => resolve[l] ?? null });

  it('1: a project note is its own project', () => {
    expect(resolveSourceProject(mk(), 'Projects/Acme/Acme.md')).toEqual({ kind: 'project', aioId: A });
  });

  it('2: a `project` link to a project note wins over containment', () => {
    const p = port({ 'Inbox/x.md': 'Acme' }, { Acme: 'Projects/Acme/Acme.md' });
    expect(resolveSourceProject(mk(), 'Inbox/x.md', p)).toEqual({ kind: 'project', aioId: A });
    // a link to something that is not a project note falls through
    expect(resolveSourceProject(mk(), 'Inbox/x.md', port({ 'Inbox/x.md': 'Other' }, { Other: 'Misc/Other.md' }))).toEqual({ kind: 'none' });
  });

  it('3: containment, innermost scope wins', () => {
    expect(resolveSourceProject(mk(), 'Projects/Acme/notes.md')).toEqual({ kind: 'project', aioId: A });
    expect(resolveSourceProject(mk(), 'Projects/Acme/Phase/deep/x.md')).toEqual({ kind: 'project', aioId: B });
  });

  it('two project notes in one folder give that folder no scope; a root project note has none', () => {
    expect(resolveSourceProject(mk(), 'Projects/Shared/x.md')).toEqual({ kind: 'none' });
    expect(resolveSourceProject(mk(), 'Elsewhere/x.md')).toEqual({ kind: 'none' });
  });

  it('a rename is followed: the index is rebuilt from the new paths', () => {
    const renamed = buildProjectIndex([note('Projects/Acme 2/Acme.md', { 'aio-id': A, 'aio-role': 'project' })]);
    expect(resolveSourceProject(renamed, 'Projects/Acme 2/x.md')).toEqual({ kind: 'project', aioId: A });
    expect(resolveSourceProject(renamed, 'Projects/Acme/x.md')).toEqual({ kind: 'none' });
  });

  it('a duplicated id is ambiguous, never a default', () => {
    const dup = mk([note('Copy/Acme.md', { 'aio-id': A, 'aio-role': 'project' })]);
    const out = resolveSourceProject(dup, 'Projects/Acme/Acme.md');
    expect(out).toMatchObject({ kind: 'ambiguous' });
    expect(out.kind === 'ambiguous' && out.candidates.length).toBe(2);
  });
});

describe('PARA roots', () => {
  it('normalises: drops unknown kinds, empty and duplicate paths, caps the list; [] stays []', () => {
    expect(normaliseParaRoots(undefined)).toEqual([]);
    expect(normaliseParaRoots('x')).toEqual([]);
    expect(normaliseParaRoots([{ path: '/Projects/', kind: 'projects' }, { path: 'projects', kind: 'projects' }, { path: '', kind: 'areas' }, { path: 'X', kind: 'nope' }, null, { path: 'Areas', kind: 'areas', driveRootId: ' d1 ' }]))
      .toEqual([{ path: 'Projects', kind: 'projects' }, { path: 'Areas', kind: 'areas', driveRootId: 'd1' }]);
    expect(normaliseParaRoots(Array.from({ length: 30 }, (_, i) => ({ path: `F${i}`, kind: 'projects' })))).toHaveLength(MAX_PARA_ROOTS);
  });

  it('validates existence, protection, output folders, inbox match and overlaps', () => {
    const ctx = { existingFolders: new Set(['Projects', 'Inbox', 'Secret', 'AI-Organiser/out', 'Areas', 'Areas/Sub']), protectedFolders: ['Secret'], outputRoots: ['AI-Organiser'], inboxFolders: ['Inbox'] };
    expect(validateParaRoots([{ path: 'Projects', kind: 'projects' }, { path: 'Inbox', kind: 'inbox' }], ctx)).toEqual([]);
    expect(validateParaRoots([{ path: 'Nope', kind: 'projects' }], ctx)).toEqual([{ code: 'root-missing', path: 'Nope' }]);
    expect(validateParaRoots([{ path: 'Secret', kind: 'projects' }], ctx)).toEqual([{ code: 'root-protected', path: 'Secret' }]);
    expect(validateParaRoots([{ path: 'Secret/Sub', kind: 'projects' }], { ...ctx, existingFolders: new Set([...ctx.existingFolders, 'Secret/Sub']) })).toEqual([{ code: 'root-protected', path: 'Secret/Sub' }]);
    // A protected folder inside a root (1 Projects/Capstone) does not flag the root: writes are guarded path by path.
    expect(validateParaRoots([{ path: 'Projects', kind: 'projects' }], { ...ctx, protectedFolders: ['Projects/Capstone'] })).toEqual([]);
    expect(validateParaRoots([{ path: 'AI-Organiser/out', kind: 'archive' }], ctx)).toEqual([{ code: 'root-output-folder', path: 'AI-Organiser/out' }]);
    expect(validateParaRoots([{ path: 'Projects', kind: 'inbox' }], ctx)).toEqual([{ code: 'inbox-mismatch', path: 'Projects' }]);
    expect(validateParaRoots([{ path: 'Areas', kind: 'areas' }, { path: 'Areas/Sub', kind: 'projects' }], ctx)).toEqual([{ code: 'root-overlap', path: 'Areas', other: 'Areas/Sub' }]);
  });

  it('finds the deepest root a path is in', () => {
    const roots = [{ path: 'A', kind: 'areas' as const }, { path: 'A/B', kind: 'projects' as const }];
    expect(rootOf('A/B/c.md', roots)?.kind).toBe('projects');
    expect(rootOf('A/c.md', roots)?.kind).toBe('areas');
    expect(rootOf('Z/c.md', roots)).toBeNull();
  });

  it('the setting defaults to [] and survives repeated migration', () => {
    expect(DEFAULT_SETTINGS.paraRoots).toEqual([]);
    const once = migrateOldSettings({ paraRoots: [{ path: '/P/', kind: 'projects' }, { path: 'x', kind: 'bad' }] } as never) as unknown as { paraRoots: unknown };
    expect(once.paraRoots).toEqual([{ path: 'P', kind: 'projects' }]);
    expect((migrateOldSettings(once as never) as unknown as { paraRoots: unknown }).paraRoots).toEqual([{ path: 'P', kind: 'projects' }]);
  });
});

describe('ProjectService (faked vault)', () => {
  function world(flags: Record<string, boolean>, files: Record<string, string>) {
    const vault = new Map(Object.entries(files));
    (globalThis as unknown as { __vault: Map<string, string> }).__vault = vault;
    const tfiles = () => [...vault.keys()].map((p) => createTFile(p));
    const registered: string[] = [];
    const frontmatterOf = (path: string): Record<string, unknown> | undefined => readFrontmatterRecord(vault.get(path) ?? '') ?? undefined;
    const plugin = {
      settings: { featureFlags: flags, paraRoots: [], protectedFolders: [] },
      registerEvent: (e: string) => registered.push(e),
      register: () => undefined,
      app: {
        vault: {
          getMarkdownFiles: () => tfiles(),
          getAbstractFileByPath: (p: string) => (vault.has(p) ? createTFile(p) : null),
          read: async (f: { path: string }) => vault.get(f.path) ?? '',
          on: (name: string) => `vault:${name}`,
        },
        metadataCache: {
          getFileCache: (f: { path: string }) => ({ frontmatter: frontmatterOf(f.path) }),
          getFirstLinkpathDest: (link: string) => tfiles().find((f) => f.basename === link) ?? null,
          on: (name: string) => `cache:${name}`,
        },
      },
    };
    return { plugin: plugin as never, vault, registered };
  }

  it('is off by default: no service is built, no listener is registered', () => {
    const w = world({}, { 'A.md': 'x' });
    expect(projectServiceActive((w.plugin as { settings: never }).settings)).toBe(false);
    expect(getProjectService(w.plugin)).toBeNull();
    expect(peekProjectService(w.plugin)).toBeNull();
    expect(w.registered).toEqual([]);
  });

  it('builds lazily while a consumer is on, registers its three listeners once, and returns the same service', () => {
    const w = world({ 'inbox-sweep': true, 'google-tasks-export': true }, { 'P.md': `---\naio-id: ${A}\naio-role: project\n---\n` });
    const service = getProjectService(w.plugin);
    expect(service).toBeInstanceOf(ProjectService);
    expect(getProjectService(w.plugin)).toBe(service);
    expect(peekProjectService(w.plugin)).toBe(service);
    expect(w.registered).toEqual(['cache:changed', 'cache:deleted', 'vault:rename']);
    expect(service!.projects().map((p) => p.notePath)).toEqual(['P.md']);
    expect(service!.resolveProject(A)).toMatchObject({ ok: true });
  });

  it('adoptProject writes one insertion and the new project is listed at once; a second adopt is refused', async () => {
    const w = world({ 'inbox-sweep': true, 'google-tasks-export': true }, { 'Projects/Acme.md': '---\nsummary: Acme\n---\nBody\n' });
    const service = getProjectService(w.plugin)!;
    const res = await service.adoptProject('Projects/Acme.md');
    expect(res.ok).toBe(true);
    const after = w.vault.get('Projects/Acme.md')!;
    expect(after).toMatch(/^---\nsummary: Acme\naio-id: [0-9a-f-]{36}\naio-role: project\nstatus: active\n---\nBody\n$/);
    expect(service.projects().map((p) => p.notePath)).toEqual(['Projects/Acme.md']);
    expect(await service.adoptProject('Projects/Acme.md')).toEqual({ ok: false, error: 'project-already-adopted' });
    expect(await service.adoptProject('Missing.md')).toEqual({ ok: false, error: 'project-not-found' });
    expect(w.vault.get('Projects/Acme.md')).toBe(after);
  });

  it('adoption refuses a note whose id another note also carries', async () => {
    const w = world({ 'inbox-sweep': true, 'google-tasks-export': true }, {
      'P/Acme.md': `---\naio-id: ${A}\naio-role: project\nstatus: active\n---\n`,
      'Copy/Acme copy.md': `---\naio-id: ${A}\n---\nBody\n`,
    });
    const service = getProjectService(w.plugin)!;
    const before = w.vault.get('Copy/Acme copy.md');
    expect(await service.adoptProject('Copy/Acme copy.md')).toEqual({ ok: false, error: 'duplicate-project-id' });
    expect(w.vault.get('Copy/Acme copy.md')).toBe(before);
  });

  it('adoptContainer gives an area no status', async () => {
    const w = world({ 'inbox-sweep': true, 'google-tasks-export': true }, { 'Areas/Work.md': 'Body' });
    const service = getProjectService(w.plugin)!;
    expect((await service.adoptContainer('Areas/Work.md', 'area')).ok).toBe(true);
    expect(w.vault.get('Areas/Work.md')).toMatch(/^---\naio-id: [0-9a-f-]{36}\naio-role: area\n---\nBody$/);
    expect(service.projects()).toEqual([]);
    expect(service.index().anchors.map((a) => a.role)).toEqual(['area']);
  });

  it('resolveSourceProject follows a `project` wikilink through the metadata cache', () => {
    const w = world({ 'inbox-sweep': true, 'google-tasks-export': true }, {
      'Projects/Acme.md': `---\naio-id: ${A}\naio-role: project\n---\n`,
      'Inbox/x.md': '---\nproject: "[[Acme]]"\n---\nTask\n',
    });
    expect(getProjectService(w.plugin)!.resolveSourceProject('Inbox/x.md')).toEqual({ kind: 'project', aioId: A });
    expect(linkpathOf('[[Acme|alias]]')).toBe('Acme');
    expect(linkpathOf('[[Folder/Acme#Heading]]')).toBe('Folder/Acme');
    expect(linkpathOf(' plain ')).toBe('plain');
  });
});

describe('registration (off path)', () => {
  it('the project commands ride on the Google Tasks export feature only, so with it off nothing is registered', async () => {
    const { REGISTER_BY_FEATURE } = await import('../src/commands/index');
    const { registerProjectCommands } = await import('../src/commands/projectCommands');
    const owners = Object.entries(REGISTER_BY_FEATURE).filter(([, fns]) => fns?.includes(registerProjectCommands)).map(([id]) => id);
    expect(owners).toEqual(['google-tasks-export']);
  }, 60_000);

  it('registers exactly the two commands, with the picker and the adopt flow behind them', async () => {
    const { registerProjectCommands } = await import('../src/commands/projectCommands');
    const added: string[] = [];
    registerProjectCommands({ addCommand: (c: { id: string }) => added.push(c.id), t: (await import('../src/i18n/en')).en } as never);
    expect(added).toEqual(['adopt-project', 'open-project']);
  });
});
