/**
 * Writes a prepared pack into the pack folder: `<folder>/<aio-id>/pack-YYYYMMDD-HHmm-<hash8>.md` plus a `latest.json` pointer,
 * keeping the newest five packs. Plugin-owned output: every path is checked against the protected folders before it is written,
 * the same pack (same digest) is never written twice, and only files that look like this store's own are ever trashed.
 */
import { TFile } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import { assertWritable, normalisePath } from '../../core/protectedPaths';
import { Result, ok, err } from '../../core/result';
import { logger } from '../../utils/logger';
import type { PreparedPack } from './contextPack';
import { isAioId } from '../projects/projectIndex';
import { MAX_PACKS_KEPT, type PackEntry } from './workspaceRecord';

const PACK_FILE = /^pack-\d{8}-\d{6}-[0-9a-f]{12}\.md$/;

/** The pack folder, validated: a visible vault-relative path outside the protected folders. */
export function packFolderPath(raw: string, protectedFolders: Parameters<typeof assertWritable>[0]): Result<string> {
    const trimmed = raw.trim();
    if (trimmed === '') return err('pack-folder-missing');
    if (/^([a-zA-Z]:|[\\/])/.test(trimmed) || trimmed.split(/[\\/]/).includes('..')) return err('pack-folder-invalid');
    const dir = normalisePath(trimmed);
    if (dir === '' || dir.split('/').some((s) => s.startsWith('.'))) return err('pack-folder-invalid');
    if (!assertWritable(protectedFolders, 'create', `${dir}/x`).ok) return err('protected-path');
    return ok(dir);
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** `pack-YYYYMMDD-HHmmss-<hash12>.md` (local time, like the rest of the plugin's file names). */
export function packFileName(now: Date, digest: string): string {
    return `pack-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${digest.slice(0, 12)}.md`;
}

async function ensureFolder(plugin: AIOrganiserPlugin, dir: string): Promise<void> {
    let current = '';
    for (const part of dir.split('/')) {
        current = current ? `${current}/${part}` : part;
        if (!plugin.app.vault.getAbstractFileByPath(current)) await plugin.app.vault.createFolder(current);
    }
}

/** The name of a pack in `dir` that already holds exactly these bytes, or null. */
async function samePack(plugin: AIOrganiserPlugin, dir: string, prepared: PreparedPack): Promise<string | null> {
    const folder = plugin.app.vault.getFolderByPath(dir);
    if (!folder) return null;
    const suffix = `-${prepared.digest.slice(0, 12)}.md`;
    for (const child of folder.children) {
        if (child instanceof TFile && PACK_FILE.test(child.name) && child.name.endsWith(suffix) && (await plugin.app.vault.read(child)) === prepared.text) return child.name;
    }
    return null;
}

const queues = new WeakMap<object, Promise<unknown>>();

/** Writes and pruning run one at a time per plugin, so two confirmations cannot interleave their publication and retention. */
export function writePack(plugin: AIOrganiserPlugin, aioId: string, prepared: PreparedPack, now: Date = new Date()): Promise<Result<PackEntry>> {
    const run = (queues.get(plugin) ?? Promise.resolve()).then(() => writeOne(plugin, aioId, prepared, now));
    queues.set(plugin, run.catch(() => undefined));
    return run;
}

async function writeOne(plugin: AIOrganiserPlugin, aioId: string, prepared: PreparedPack, now: Date): Promise<Result<PackEntry>> {
    try {
        const root = packFolderPath(plugin.settings.aiWorkspacePackFolder, plugin.settings.protectedFolders);
        if (!root.ok) return err(root.error);
        // The project id is one path segment (a UUID); nothing else is ever appended to the pack folder.
        if (!isAioId(aioId)) return err('pack-folder-invalid');
        const dir = `${root.value}/${aioId.toLowerCase()}`;
        // The same confirmed bytes are never stored twice: a pack with this digest and these exact bytes is reused whatever its timestamp.
        const name = (await samePack(plugin, dir, prepared)) ?? packFileName(now, prepared.digest);
        const path = `${dir}/${name}`;
        const pointer = `${dir}/latest.json`;
        if (!assertWritable(plugin.settings.protectedFolders, 'create', [path, pointer]).ok) return err('protected-path');
        await ensureFolder(plugin, dir);
        const { vault } = plugin.app;
        // A file at this name is trusted only when its bytes are the confirmed pack; anything else (an edit, a prefix clash) is replaced.
        const existing = vault.getAbstractFileByPath(path);
        if (!(existing instanceof TFile)) await vault.create(path, prepared.text);
        else if (await vault.read(existing) !== prepared.text) await vault.modify(existing, prepared.text);
        const entry: PackEntry = { id: name.replace(/\.md$/, ''), createdAt: now.toISOString(), path, digest: prepared.digest };
        const json = `${JSON.stringify({ packId: entry.id, path, digest: entry.digest, createdAt: entry.createdAt, generatorVersion: prepared.generatorVersion, sharePolicyRevision: prepared.sharePolicyRevision, sources: prepared.sources }, null, 2)}\n`;
        const latest = vault.getAbstractFileByPath(pointer);
        if (latest instanceof TFile) await vault.modify(latest, json);
        else await vault.create(pointer, json);
        // The pack and its pointer are committed. A failure while tidying older packs is logged; it never turns a published pack into a failure.
        try { await prune(plugin, dir, name); } catch (e) { logger.warn('AiWorkspaces', 'Could not remove older packs', e); }
        return ok(entry);
    } catch (e) {
        logger.error('AiWorkspaces', 'Could not write the pack', e);
        return err('pack-write-failed');
    }
}

/** Keep the newest packs; older ones of this store's own naming are moved to the trash. */
async function prune(plugin: AIOrganiserPlugin, dir: string, keep: string): Promise<void> {
    const folder = plugin.app.vault.getFolderByPath(dir);
    if (!folder) return;
    const packs = folder.children.filter((c): c is TFile => c instanceof TFile && PACK_FILE.test(c.name)).sort((a, b) => a.name.localeCompare(b.name));
    // The pack just written is never a candidate, whatever its name sorts to; the quota counts every pack.
    const candidates = packs.filter((p) => p.name !== keep);
    for (const old of candidates.slice(0, Math.max(0, packs.length - MAX_PACKS_KEPT))) {
        if (!assertWritable(plugin.settings.protectedFolders, 'delete', old.path).ok) continue;
        await plugin.app.fileManager.trashFile(old);
    }
}
