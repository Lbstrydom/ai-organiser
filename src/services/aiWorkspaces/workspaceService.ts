/**
 * AI workspaces, the vault side: reads the notes a pack is made from, prepares a pack for the preview, and after the person
 * confirms it re-checks everything, writes the pack and records it in the workspace block (one reviewed edit).
 *
 * Nothing here talks to an AI app. The plugin only prepares text; the person copies or uploads it.
 */
import { TFile } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import { Result, ok, err } from '../../core/result';
import { isFeatureEnabled } from '../featureService';
import { applyNoteEdit } from '../noteEdit/applyNoteEdit';
import { getProjectService, linkpathOf } from '../projects/projectService';
import type { AnchorRef } from '../projects/projectIndex';
import { logger } from '../../utils/logger';
import { notShareableReason, sharePolicyRevision } from './aiShareScope';
import { buildContextPack, packSha256, verifyPrepared, type PackNote, type PreparedPack } from './contextPack';
import { writePack } from './packStore';
import type { LinkOccurrence } from './linkNeutraliser';
import { applyWorkspaceBlock, renderWorkspaceBlock, stripWorkspaceBlock } from './workspaceBlock';
import { emptyWorkspace, normaliseWorkspace, withPack, type PackEntry, type WorkspaceRecord } from './workspaceRecord';

export const aiWorkspacesActive = (plugin: AIOrganiserPlugin): boolean => isFeatureEnabled(plugin.settings, 'ai-workspaces');

export function getWorkspace(plugin: AIOrganiserPlugin, aioId: string): WorkspaceRecord {
    return normaliseWorkspace(plugin.settings.aiWorkspaces[aioId]) ?? emptyWorkspace(aioId);
}

/** Store the record and bring the block in the note up to date (a reviewed edit the person can decline). */
export async function saveWorkspace(plugin: AIOrganiserPlugin, record: WorkspaceRecord): Promise<Result<true>> {
    if (!aiWorkspacesActive(plugin)) return err('unknown');
    const normalised = normaliseWorkspace(record);
    if (!normalised) return err('project-id-invalid');
    try {
        plugin.settings.aiWorkspaces = { ...plugin.settings.aiWorkspaces, [normalised.anchorId]: normalised };
        await plugin.saveSettings();
    } catch (e) {
        logger.error('AiWorkspaces', 'Could not save the workspace record', e);
        return err('pack-write-failed');
    }
    return writeBlock(plugin, normalised);
}

async function writeBlock(plugin: AIOrganiserPlugin, record: WorkspaceRecord): Promise<Result<true>> {
    try {
        const anchor = getProjectService(plugin)?.resolveAnchor(record.anchorId);
        if (!anchor?.ok) return err(anchor ? anchor.error : 'project-not-found');
        const file = plugin.app.vault.getAbstractFileByPath(anchor.value.notePath);
        if (!(file instanceof TFile)) return err('project-not-found');
        const t = plugin.t.aiWorkspaces;
        const block = renderWorkspaceBlock(record, { title: t.blockTitle, none: t.blockNone, pack: t.blockPack, released: t.blockReleased });
        const baseline = await plugin.app.vault.read(file);
        const first = applyWorkspaceBlock(baseline, block);
        if (!first.ok) return err(first.error);
        if (first.value === baseline) return ok(true);
        const res = await applyNoteEdit(plugin, {
            kind: 'composite',
            filePath: file.path,
            baseline,
            recompute: (current) => {
                const next = applyWorkspaceBlock(current, block);
                return next.ok ? ok({ content: next.value }) : err(next.error);
            },
        });
        if (!res.ok) return err(res.error);
        return ok(true);
    } catch (e) {
        logger.error('AiWorkspaces', 'Could not update the workspace block', e);
        return err('workspace-block-conflict');
    }
}

async function readNote(plugin: AIOrganiserPlugin, path: string): Promise<PackNote | null> {
    const file = plugin.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile) || file.extension !== 'md') return null;
    return { path: file.path, text: await plugin.app.vault.cachedRead(file) };
}

/** The Area note of a project: the frontmatter property `area`, resolved as a link. Never guessed from folders. */
function areaPathOf(plugin: AIOrganiserPlugin, anchor: AnchorRef): string | null {
    if (anchor.role !== 'project') return null;
    const file = plugin.app.vault.getAbstractFileByPath(anchor.notePath);
    if (!(file instanceof TFile)) return null;
    const raw = (plugin.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined)?.area;
    if (typeof raw !== 'string' || raw.trim() === '') return null;
    return plugin.app.metadataCache.getFirstLinkpathDest(linkpathOf(raw), anchor.notePath)?.path ?? null;
}

/** Links and embeds with positions, straight from Obsidian's cache; null when the note has none. */
function linksFromCache(plugin: AIOrganiserPlugin, path: string): LinkOccurrence[] | null {
    const file = plugin.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return null;
    const cache = plugin.app.metadataCache.getFileCache(file);
    if (!cache) return null;
    const out: LinkOccurrence[] = [];
    for (const [list, embed] of [[cache.links, false], [cache.embeds, true]] as const) {
        for (const l of list ?? []) {
            out.push({ link: l.link, displayText: l.displayText, original: l.original, start: l.position.start.offset, end: l.position.end.offset, embed });
        }
    }
    return out;
}

export interface PreparedWorkspacePack {
    aioId: string;
    pack: PreparedPack;
}

/** Everything a preview shows: built from the notes as they are right now. */
export async function preparePack(plugin: AIOrganiserPlugin, aioId: string): Promise<Result<PreparedWorkspacePack>> {
    try {
        if (!aiWorkspacesActive(plugin)) return err('unknown');
        const service = getProjectService(plugin);
        const anchor = service?.resolveAnchor(aioId);
        if (!anchor?.ok) return err(anchor ? anchor.error : 'project-not-found');
        const s = plugin.settings;
        const record = getWorkspace(plugin, aioId);
        const project = await readNote(plugin, anchor.value.notePath);
        if (!project) return err('project-not-found');
        const areaPath = areaPathOf(plugin, anchor.value);
        const area = areaPath ? await readNote(plugin, areaPath) : null;
        const sources: PackNote[] = [];
        const missing: string[] = [];
        for (const path of record.contextSources) {
            const note = await readNote(plugin, path);
            if (note) sources.push(note); else missing.push(path);
        }
        const built = await buildContextPack({
            vaultId: plugin.app.vault.getName(),
            aioId,
            projectName: project.path.slice(project.path.lastIndexOf('/') + 1).replace(/\.md$/i, ''),
            project,
            ...(area ? { area } : {}),
            sources,
            reasonNotShareable: (path) => notShareableReason(path, s, s.aiWorkspacePackFolder),
            resolveLink: (link, from) => plugin.app.metadataCache.getFirstLinkpathDest(link, from)?.path ?? null,
            linksOf: (note) => linksFromCache(plugin, note.path),
            sharePolicyRevision: await sharePolicyRevision(s, s.aiWorkspacePackFolder),
        });
        if (!built.ok) return err(built.error);
        const skipped = [...built.value.skipped, ...missing.map((path) => ({ path, reason: 'missing' as const }))];
        return ok({ aioId, pack: { ...built.value, skipped } });
    } catch (e) {
        logger.error('AiWorkspaces', 'Could not prepare the pack', e);
        return err('pack-write-failed');
    }
}

/** The hashes of the sources as they are NOW, to compare with a preview. */
async function currentHashes(plugin: AIOrganiserPlugin, prepared: PreparedPack): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const source of prepared.sources) {
        const note = await readNote(plugin, source.path);
        if (note) out.set(source.path, await packSha256(stripWorkspaceBlock(note.text)));
    }
    return out;
}

/** Refuse a stale preview. Sources are read FIRST and the policy revision taken after, so a revocation during the reads is seen. */
async function stillFresh(plugin: AIOrganiserPlugin, pack: PreparedPack): Promise<Result<true>> {
    try {
        const hashes = await currentHashes(plugin, pack);
        const s = plugin.settings;
        return verifyPrepared(pack, { sharePolicyRevision: await sharePolicyRevision(s, s.aiWorkspacePackFolder), hashes });
    } catch (e) {
        logger.error('AiWorkspaces', 'Could not re-check the preview', e);
        return err('pack-preview-stale');
    }
}

/** After the person confirmed the preview: refuse a stale one, write the pack, record it. */
const confirmQueue = new WeakMap<object, Promise<unknown>>();

/** Confirmations run one at a time per plugin: the record is read, extended and saved without another confirmation in between. */
export function confirmPack(plugin: AIOrganiserPlugin, prepared: PreparedWorkspacePack): Promise<Result<PackEntry>> {
    const run = (confirmQueue.get(plugin) ?? Promise.resolve()).then(() => confirmOne(plugin, prepared));
    confirmQueue.set(plugin, run.catch(() => undefined));
    return run;
}

async function confirmOne(plugin: AIOrganiserPlugin, prepared: PreparedWorkspacePack): Promise<Result<PackEntry>> {
    if (!aiWorkspacesActive(plugin)) return err('unknown');
    const check = await stillFresh(plugin, prepared.pack);
    if (!check.ok) return err(check.error);
    const written = await writePack(plugin, prepared.aioId, prepared.pack);
    if (!written.ok) return err(written.error);
    const record = withPack(getWorkspace(plugin, prepared.aioId), written.value);
    // The pack is already safe on disk; a declined or failed block edit does not undo it.
    const saved = await saveWorkspace(plugin, record);
    if (!saved.ok && saved.error !== 'rejected') logger.warn('AiWorkspaces', `Pack saved but the block was not updated: ${saved.error}`);
    return ok(written.value);
}

/** Copy needs the same fresh check as a pack: what is copied is what the preview showed. */
export async function confirmInstructions(plugin: AIOrganiserPlugin, prepared: PreparedWorkspacePack): Promise<Result<string>> {
    if (!aiWorkspacesActive(plugin)) return err('unknown');
    const check = await stillFresh(plugin, prepared.pack);
    return check.ok ? ok(prepared.pack.instructions) : err(check.error);
}
