/**
 * The parts of the connector feature that touch the vault: where the generated files go, and the
 * chat-project export. Everything that decides what the file says is pure and lives next to it
 * (`chatExport.ts`, `connectorGuides.ts`); this file only reads notes through the same collector the
 * index uses and writes through the same guarded seam as the other plugin-owned output.
 */
import { FileSystemAdapter, TFile, TFolder } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import { Result, ok, err } from '../../core/result';
import { assertWritable, isInsideOrEqual, normalisePath, type ProtectedSource } from '../../core/protectedPaths';
import { applyNoteEdit } from '../noteEdit/applyNoteEdit';
import { collectRecords, projectionScope, scopedFiles, scopeConfigFromSettings, scopeHashOf } from '../agentIndex/agentIndexService';
import { isFeatureEnabled } from '../featureService';
import { looksLikePack, normaliseShareFolders, shareFolderOf, shareOptInActive } from '../aiWorkspaces/aiShareScope';
import type { ProjectionScope } from '../agentIndex/agentIndexProjection';
import { logger } from '../../utils/logger';
import { buildChatExport, CHAT_EXPORT_INSTRUCTIONS, CHAT_EXPORT_NAME_PATTERN, isOwnExport } from './chatExport';
import { validateVaultPath } from './connectorGuides';

/** The vault's folder on disk. Desktop only: other adapters have no such path. */
export function vaultBasePath(plugin: AIOrganiserPlugin): Result<string> {
    const adapter = plugin.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) return err('connector-vault-path-unavailable');
    return validateVaultPath(adapter.getBasePath());
}

/**
 * The folder generated files go in: chosen by the user, vault-relative, visible (no hidden segment),
 * outside protected folders. Empty is not a default: the person has to choose.
 */
export function connectorFolderPath(raw: string, protectedFolders: ProtectedSource): Result<string> {
    const trimmed = raw.trim();
    if (trimmed === '') return err('connector-folder-missing');
    if (/^([a-zA-Z]:|[\\/])/.test(trimmed) || trimmed.split(/[\\/]/).includes('..')) return err('connector-folder-invalid');
    const dir = normalisePath(trimmed);
    if (dir === '' || dir.split('/').some((s) => s.startsWith('.'))) return err('connector-folder-invalid');
    if (!assertWritable(protectedFolders, 'create', `${dir}/x`).ok) return err('protected-path');
    return ok(dir);
}

async function ensureFolder(plugin: AIOrganiserPlugin, dir: string): Promise<void> {
    let current = '';
    for (const part of dir.split('/')) {
        current = current ? `${current}/${part}` : part;
        if (!plugin.app.vault.getAbstractFileByPath(current)) await plugin.app.vault.createFolder(current);
    }
}

/** The scope and folder a confirmation applies to. Captured when the confirmation is shown, compared before writing. */
export async function exportRevision(plugin: AIOrganiserPlugin): Promise<string> {
    const s = plugin.settings;
    // With the AI sharing opt-in on, the allow-list is part of what a confirmation was given for; off, the revision is what it always was.
    const share = isFeatureEnabled(s, 'ai-workspaces') ? `|share:${shareOptInActive(s) ? JSON.stringify(normaliseShareFolders(s.aiShareFolders).sort()) : 'packs'}|${s.aiWorkspacePackFolder.trim()}` : '';
    return `${await scopeHashOf(scopeConfigFromSettings(s))}|${s.agentConnectorFolder.trim()}|${JSON.stringify(s.protectedFolders)}${share}`;
}

export interface ExportSummary {
    paths: string[];
    notes: number;
    /** Older parts of ours that the new export no longer needs and that were moved to the trash */
    removed: number;
}

/**
 * Write the vault map. Reads the same notes the index reads (the one scope function), writes only into
 * the chosen folder, replaces only files that carry the export marker, and never touches note text.
 *
 * Nothing is written until every destination is known to be free or ours, and the scope, the folder,
 * the protected list and the feature switch are checked again right before writing and again before
 * any superseded part is trashed. Never throws.
 */
/** The vault map's scope with the AI sharing opt-in applied: a note appears only if it is also inside the allow-list. Off: unchanged. */
export function optedInScope(scope: ProjectionScope, s: Parameters<typeof shareOptInActive>[0] & Pick<AIOrganiserPlugin['settings'], 'aiShareFolders' | 'aiWorkspacePackFolder'>): ProjectionScope {
    // While AI workspaces are on, packs are never listed (the server refuses them as notes too); with the opt-in the allow-list applies as well.
    if (!isFeatureEnabled(s, 'ai-workspaces')) return scope;
    const optIn = shareOptInActive(s);
    return { ...scope, isIncluded: (path: string) => scope.isIncluded(path) && !isPackPath(path, s.aiWorkspacePackFolder) && (!optIn || shareFolderOf(path, s) !== null) };
}

const isPackPath = (path: string, packFolder: string): boolean => looksLikePack(path) || (packFolder.trim() !== '' && isInsideOrEqual(normalisePath(path), normalisePath(packFolder)));

export async function exportChatProject(plugin: AIOrganiserPlugin, options: { expectedRevision?: string } = {}): Promise<Result<ExportSummary>> {
    try {
        const s = plugin.settings;
        if (!isFeatureEnabled(s, 'agent-connectors')) return err('connector-feature-off');
        const folder = connectorFolderPath(s.agentConnectorFolder, s.protectedFolders);
        if (!folder.ok) return err(folder.error);

        // The scope this export is made for. The confirmation the person gave was for the same one.
        const startRevision = await exportRevision(plugin);
        if (options.expectedRevision !== undefined && startRevision !== options.expectedRevision) return err('baseline-changed');
        /** True while nothing that authorises this export has changed. */
        const unchanged = async (): Promise<boolean> =>
            isFeatureEnabled(plugin.settings, 'agent-connectors') && (await exportRevision(plugin)) === startRevision;

        const config = scopeConfigFromSettings(s);
        const collected = await collectRecords(plugin.app, scopedFiles(plugin.app, config), config);
        const built = buildChatExport({
            records: collected.records,
            scope: optedInScope(projectionScope(config), s),
            instructions: CHAT_EXPORT_INSTRUCTIONS,
            generatedAt: new Date().toISOString(),
        });
        if (built.notes === 0) return err('export-nothing-in-scope');

        const vault = plugin.app.vault;
        // Every destination first: a foreign file at part 3 must not leave parts 1 and 2 already replaced.
        const targets: Array<{ path: string; text: string; existing: TFile | null; baseline: string }> = [];
        for (const part of built.parts) {
            const path = `${folder.value}/${part.name}`;
            if (!assertWritable(plugin.settings.protectedFolders, 'create', path).ok) return err('protected-path');
            const existing = vault.getAbstractFileByPath(path);
            if (existing === null) { targets.push({ path, text: part.text, existing: null, baseline: '' }); continue; }
            if (!(existing instanceof TFile)) return err('connector-file-not-ours');
            const baseline = await vault.read(existing);
            if (!isOwnExport(baseline)) return err('connector-file-not-ours');
            targets.push({ path, text: part.text, existing, baseline });
        }

        if (!(await unchanged())) return err('baseline-changed');
        const written: string[] = [];
        for (const target of targets) {
            if (!(await unchanged())) return err('baseline-changed');
            if (!assertWritable(plugin.settings.protectedFolders, 'create', target.path).ok) return err('protected-path');
            if (target.existing === null) {
                await ensureFolder(plugin, folder.value);
                // Everything that authorised this export (the scope, the sharing allow-list, the folder, the feature) is checked again after the wait.
                if (!(await unchanged())) return err('baseline-changed');
                if (!assertWritable(plugin.settings.protectedFolders, 'create', target.path).ok) return err('protected-path');
                if (vault.getAbstractFileByPath(target.path)) return err('connector-file-not-ours');
                await vault.create(target.path, target.text);
            } else {
                const res = await applyNoteEdit(plugin, { kind: 'full-replace', filePath: target.path, baseline: target.baseline, nextContent: target.text }, { review: false });
                if (!res.ok) return err(res.error);
            }
            written.push(target.path);
        }

        // Parts left over from a larger earlier export: only our own, only by name pattern and marker,
        // and only while everything that authorised this export still holds.
        let removed = 0;
        const dir = vault.getAbstractFileByPath(folder.value);
        if (dir instanceof TFolder) {
            for (const child of [...dir.children]) {
                if (!(child instanceof TFile) || !CHAT_EXPORT_NAME_PATTERN.test(child.name) || written.includes(child.path)) continue;
                if (!isOwnExport(await vault.read(child))) continue;
                // Checked after the read, immediately before the trash.
                if (!(await unchanged())) return err('baseline-changed');
                if (!assertWritable(plugin.settings.protectedFolders, 'delete', child.path).ok) continue;
                await plugin.app.fileManager.trashFile(child);
                removed++;
            }
        }
        return ok({ paths: written, notes: built.notes, removed });
    } catch (e) {
        logger.error('Connector', 'Export failed', e);
        return err('write-failed');
    }
}
