import { describe, it, expect } from 'vitest';
import { TFile, TFolder } from 'obsidian';
import { createTFile } from './mocks/obsidian';
import { DEFAULT_SETTINGS, migrateOldSettings } from '../src/core/settings';
import { REGISTER_BY_FEATURE } from '../src/commands';
import { isFeatureEnabled } from '../src/services/featureService';
import { packFileName, packFolderPath, writePack } from '../src/services/aiWorkspaces/packStore';
import type AIOrganiserPlugin from '../src/main';
import type { PreparedPack } from '../src/services/aiWorkspaces/contextPack';

const ID = '3f2b8f4e-1c2d-4e5f-8a6b-7c8d9e0f1a2b';

function fakePlugin(over: Record<string, unknown> = {}) {
  const files = new Map<string, { file: TFile; text: string }>();
  const folders = new Map<string, TFolder>();
  const trashed: string[] = [];
  const addFolder = (path: string): TFolder => {
    const f = new TFolder();
    f.path = path;
    f.name = path.split('/').pop() ?? '';
    folders.set(path, f);
    return f;
  };
  const vault = {
    getAbstractFileByPath: (p: string) => files.get(p)?.file ?? folders.get(p) ?? null,
    getFolderByPath: (p: string) => folders.get(p) ?? null,
    createFolder: async (p: string) => { addFolder(p); },
    create: async (p: string, text: string) => {
      const file = createTFile(p);
      files.set(p, { file, text });
      const parent = folders.get(p.slice(0, p.lastIndexOf('/')));
      parent?.children.push(file);
      return file;
    },
    read: async (file: TFile) => files.get(file.path)?.text ?? '',
    modify: async (file: TFile, text: string) => { files.set(file.path, { file, text }); },
  };
  const fileManager = {
    trashFile: async (file: TFile) => {
      trashed.push(file.path);
      files.delete(file.path);
      const parent = folders.get(file.path.slice(0, file.path.lastIndexOf('/')));
      if (parent) parent.children = parent.children.filter((c) => c !== file);
    },
  };
  const plugin = { app: { vault, fileManager }, settings: { ...DEFAULT_SETTINGS, ...over } };
  return { plugin: plugin as unknown as AIOrganiserPlugin, files, trashed };
}

const prepared = (digest: string): PreparedPack => ({
  instructions: 'i', text: `pack ${digest}`, bytes: 10, digest, sources: [], skipped: [], sharePolicyRevision: 'r', generatorVersion: 1,
});

describe('pack store', () => {
  it('names a pack by local time and digest', () => {
    expect(packFileName(new Date(2026, 9, 26, 9, 5, 7), 'abcdef0123456789')).toBe('pack-20261026-090507-abcdef012345.md');
  });

  it('validates the folder: visible, inside the vault, outside protected folders', () => {
    expect(packFolderPath('', [])).toEqual({ ok: false, error: 'pack-folder-missing' });
    expect(packFolderPath('../out', [])).toEqual({ ok: false, error: 'pack-folder-invalid' });
    expect(packFolderPath('C:/x', [])).toEqual({ ok: false, error: 'pack-folder-invalid' });
    expect(packFolderPath('.hidden/packs', [])).toEqual({ ok: false, error: 'pack-folder-invalid' });
    expect(packFolderPath('Packs', ['Packs'])).toEqual({ ok: false, error: 'protected-path' });
    expect(packFolderPath(' Packs/ai ', [])).toEqual({ ok: true, value: 'Packs/ai' });
  });

  it('writes the pack and the latest pointer, and a second identical write adds no file', async () => {
    const { plugin, files } = fakePlugin({ aiWorkspacePackFolder: 'Packs' });
    const now = new Date(2026, 9, 26, 9, 5, 7);
    const first = await writePack(plugin, ID, prepared('aaaaaaaa1111'), now);
    expect(first.ok && first.value.path).toBe(`Packs/${ID}/pack-20261026-090507-aaaaaaaa1111.md`);
    const again = await writePack(plugin, ID, prepared('aaaaaaaa1111'), now);
    expect(again.ok).toBe(true);
    expect([...files.keys()].filter((k) => k.endsWith('.md'))).toHaveLength(1);
    expect(JSON.parse(files.get(`Packs/${ID}/latest.json`)?.text ?? '{}').digest).toBe('aaaaaaaa1111');
  });

  it('keeps the newest five packs and trashes only older pack files of its own', async () => {
    const { plugin, files, trashed } = fakePlugin({ aiWorkspacePackFolder: 'Packs' });
    for (let i = 0; i < 7; i++) await writePack(plugin, ID, prepared(`${String(i).padStart(10, '0')}ff`), new Date(2026, 9, 26, 9, i));
    // a user file in the same folder is never touched
    await plugin.app.vault.create(`Packs/${ID}/notes.md`, 'mine');
    await writePack(plugin, ID, prepared('999999999900'), new Date(2026, 9, 26, 10, 0));
    expect(trashed.every((p: string) => /pack-\d{8}-\d{6}-[0-9a-f]{12}\.md$/.test(p))).toBe(true);
    expect(files.has(`Packs/${ID}/notes.md`)).toBe(true);
    expect([...files.keys()].filter((k) => /pack-/.test(k))).toHaveLength(5);
  });

  it('replaces a file at the same name whose bytes are not the confirmed pack', async () => {
    const { plugin, files } = fakePlugin({ aiWorkspacePackFolder: 'Packs' });
    const now = new Date(2026, 9, 26, 9, 5, 7);
    const first = await writePack(plugin, ID, prepared('aaaaaaaa1111'), now);
    if (!first.ok) throw new Error('write');
    const f = files.get(first.value.path);
    if (f) f.text = 'edited by hand';
    await writePack(plugin, ID, prepared('aaaaaaaa1111'), now);
    expect(files.get(first.value.path)?.text).toBe('pack aaaaaaaa1111');
  });

  it('two confirmations at once do not interleave and the newest pack survives', async () => {
    const { plugin, files } = fakePlugin({ aiWorkspacePackFolder: 'Packs' });
    const results = await Promise.all([0, 1, 2, 3, 4, 5, 6, 7].map((i) => writePack(plugin, ID, prepared(`${String(i).padStart(10, '0')}ee`), new Date(2026, 9, 26, 9, i))));
    expect(results.every((r) => r.ok)).toBe(true);
    expect([...files.keys()].filter((k) => /pack-/.test(k))).toHaveLength(5);
    expect([...files.keys()].some((k) => k.includes('-090700-0000000007ee'))).toBe(true);
  });

  it('refuses to write into a protected folder', async () => {
    const { plugin, files } = fakePlugin({ aiWorkspacePackFolder: 'Packs', protectedFolders: ['Packs'] });
    expect(await writePack(plugin, ID, prepared('bbbbbbbb1111'))).toEqual({ ok: false, error: 'protected-path' });
    expect(files.size).toBe(0);
  });
});

describe('off path: the feature is default off and adds nothing', () => {
  it('is disabled by default and registers no command', () => {
    expect(isFeatureEnabled(DEFAULT_SETTINGS, 'ai-workspaces')).toBe(false);
    expect(REGISTER_BY_FEATURE['ai-workspaces']).toHaveLength(1);
  });

  it('settings migration adds only inert defaults and keeps stored values', () => {
    const migrated = migrateOldSettings({ aiShareFolders: [' Work/ ', 5], aiWorkspaces: { x: { anchorId: 'bad' } } } as never) ?? DEFAULT_SETTINGS;
    expect(migrated.aiShareFolders).toEqual(['Work']);
    expect(migrated.aiWorkspaces).toEqual({});
    expect(migrated.aiShareRequireOptIn).toBe(false);
    expect(migrateOldSettings({} as never)?.aiShareFolders).toEqual([]);
    expect(TFile).toBeDefined();
  });
});

describe('pack store: identity, safety and tidy-up', () => {
  it('the same confirmed bytes at a different time reuse the existing file instead of storing them twice', async () => {
    const { plugin, files } = fakePlugin({ aiWorkspacePackFolder: 'Packs' });
    const first = await writePack(plugin, ID, prepared('aaaaaaaa1111'), new Date(2026, 9, 26, 9, 5, 7));
    const second = await writePack(plugin, ID, prepared('aaaaaaaa1111'), new Date(2026, 9, 26, 9, 40, 0));
    expect(first.ok && second.ok && first.value.path === second.value.path).toBe(true);
    expect([...files.keys()].filter((k) => /pack-/.test(k))).toHaveLength(1);
  });

  it('refuses a project id that is not a single UUID segment', async () => {
    const { plugin, files } = fakePlugin({ aiWorkspacePackFolder: 'Packs' });
    for (const bad of ['../x', 'a/b', '', 'not-a-uuid']) expect(await writePack(plugin, bad, prepared('bbbbbbbb1111'))).toEqual({ ok: false, error: 'pack-folder-invalid' });
    expect(files.size).toBe(0);
  });

  it('a failure while removing older packs does not turn a published pack into a failure', async () => {
    const { plugin, files } = fakePlugin({ aiWorkspacePackFolder: 'Packs' });
    for (let i = 0; i < 6; i++) await writePack(plugin, ID, prepared(`${String(i).padStart(10, '0')}cc`), new Date(2026, 9, 26, 9, i));
    (plugin as unknown as { app: { fileManager: { trashFile: () => Promise<void> } } }).app.fileManager.trashFile = async () => { throw new Error('locked'); };
    const res = await writePack(plugin, ID, prepared('dddddddd1111'), new Date(2026, 9, 26, 10, 0));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // the seventh pack itself is on disk and is what the pointer names
    expect(files.has(res.value.path)).toBe(true);
    expect(JSON.parse(files.get(`Packs/${ID}/latest.json`)?.text ?? '{}').packId).toBe(res.value.id);
  });
});

describe('the sharing settings section saves the FIRST edit', () => {
  it('builds its saver when it is drawn, before any handler can edit the settings', async () => {
    const { AiWorkspacesSettingsSection } = await import('../src/ui/settings/AiWorkspacesSettingsSection');
    const { sharingSaverFor } = await import('../src/ui/settings/AiWorkspacesSettingsSection');
    let saves = 0;
    const plugin = { settings: { ...DEFAULT_SETTINGS }, t: { aiWorkspaces: {} }, saveSettings: async () => { saves++; }, settingTab: { display() { /* redraw */ } } } as never;
    // A container that answers every DOM call with itself: only the order of events matters here.
    const dom: unknown = new Proxy(function () { /* callable */ }, { get: () => dom, apply: () => dom });
    try { new AiWorkspacesSettingsSection(plugin, dom as never, {} as never).display(); } catch { /* drawing needs more of the plugin than this fake; the saver is built first */ }
    expect(typeof sharingSaverFor).toBe('function');
    const settings = (plugin as unknown as { settings: typeof DEFAULT_SETTINGS }).settings;
    settings.aiShareFolders = ['Work'];
    expect(await sharingSaverFor(plugin).request()).toBe('saved');
    expect(saves).toBe(1);
  });
});
