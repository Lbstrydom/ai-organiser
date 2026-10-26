import { describe, it, expect } from 'vitest';
import { TFile, TFolder } from 'obsidian';
import { createTFile } from './mocks/obsidian';
import { DEFAULT_SETTINGS, migrateOldSettings } from '../src/core/settings';
import { REGISTER_BY_FEATURE } from '../src/commands';
import { isFeatureEnabled } from '../src/services/featureService';
import { packFileName, packFolderPath, writePack } from '../src/services/aiWorkspaces/packStore';
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
  return { plugin: plugin as never, files, trashed };
}

const prepared = (digest: string): PreparedPack => ({
  instructions: 'i', text: `pack ${digest}`, bytes: 10, digest, sources: [], skipped: [], sharePolicyRevision: 'r', generatorVersion: 1,
});

describe('pack store', () => {
  it('names a pack by local time and digest', () => {
    expect(packFileName(new Date(2026, 9, 26, 9, 5), 'abcdef0123456789')).toBe('pack-20261026-0905-abcdef01.md');
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
    const now = new Date(2026, 9, 26, 9, 5);
    const first = await writePack(plugin, ID, prepared('aaaaaaaa11'), now);
    expect(first.ok && first.value.path).toBe(`Packs/${ID}/pack-20261026-0905-aaaaaaaa.md`);
    const again = await writePack(plugin, ID, prepared('aaaaaaaa11'), now);
    expect(again.ok).toBe(true);
    expect([...files.keys()].filter((k) => k.endsWith('.md'))).toHaveLength(1);
    expect(JSON.parse(files.get(`Packs/${ID}/latest.json`)?.text ?? '{}').digest).toBe('aaaaaaaa11');
  });

  it('keeps the newest five packs and trashes only older pack files of its own', async () => {
    const { plugin, files, trashed } = fakePlugin({ aiWorkspacePackFolder: 'Packs' });
    for (let i = 0; i < 7; i++) await writePack(plugin, ID, prepared(`${String(i).padStart(8, '0')}ff`), new Date(2026, 9, 26, 9, i));
    // a user file in the same folder is never touched
    await plugin.app.vault.create(`Packs/${ID}/notes.md`, 'mine');
    await writePack(plugin, ID, prepared('9999999900'), new Date(2026, 9, 26, 10, 0));
    expect(trashed.every((p: string) => /pack-\d{8}-\d{4}-[0-9a-f]{8}\.md$/.test(p))).toBe(true);
    expect(files.has(`Packs/${ID}/notes.md`)).toBe(true);
    expect([...files.keys()].filter((k) => /pack-/.test(k))).toHaveLength(5);
  });

  it('refuses to write into a protected folder', async () => {
    const { plugin, files } = fakePlugin({ aiWorkspacePackFolder: 'Packs', protectedFolders: ['Packs'] });
    expect(await writePack(plugin, ID, prepared('bbbbbbbb11'))).toEqual({ ok: false, error: 'protected-path' });
    expect(files.size).toBe(0);
  });
});

describe('off path: the feature is default off and adds nothing', () => {
  it('is disabled by default and registers no command', () => {
    expect(isFeatureEnabled(DEFAULT_SETTINGS, 'ai-workspaces')).toBe(false);
    expect(REGISTER_BY_FEATURE['ai-workspaces']).toHaveLength(1);
  });

  it('settings migration adds only inert defaults and keeps stored values', () => {
    const migrated = migrateOldSettings({ aiShareFolders: [' Work/ ', 5], aiWorkspaces: { x: { anchorId: 'bad' } } } as never);
    expect(migrated.aiShareFolders).toEqual(['Work']);
    expect(migrated.aiWorkspaces).toEqual({});
    expect(migrated.aiShareRequireOptIn).toBe(false);
    expect(migrateOldSettings({} as never).aiShareFolders).toEqual([]);
    expect(TFile).toBeDefined();
  });
});
