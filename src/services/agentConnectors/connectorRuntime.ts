/**
 * The parts of the connector feature that touch the vault: where the generated files go, and the
 * chat-project export. Everything that decides what the file says is pure and lives next to it
 * (`chatExport.ts`, `connectorGuides.ts`); this file only reads notes through the same collector the
 * index uses and writes through the same guarded seam as the other plugin-owned output.
 */
import { FileSystemAdapter, TFile, TFolder } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import { Result, ok, err } from '../../core/result';
import { assertWritable, normalisePath, type ProtectedSource } from '../../core/protectedPaths';
import { applyNoteEdit } from '../noteEdit/applyNoteEdit';
import { collectRecords, projectionScope, scopedFiles, scopeConfigFromSettings, scopeHashOf } from '../agentIndex/agentIndexService';
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
    return `${await scopeHashOf(scopeConfigFromSettings(s))}|${s.agentConnectorFolder.trim()}|${JSON.stringify(s.protectedFolders)}`;
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
 * Never throws.
 */
export async function exportChatProject(plugin: AIOrganiserPlugin, options: { expectedRevision?: string } = {}): Promise<Result<ExportSummary>> {
    try {
        const s = plugin.settings;
        const folder = connectorFolderPath(s.agentConnectorFolder, s.protectedFolders);
        if (!folder.ok) return err(folder.error);

        const config = scopeConfigFromSettings(s);
        const collected = await collectRecords(plugin.app, scopedFiles(plugin.app, config), config);
        // The confirmation the person gave was for one scope and folder; if either moved, write nothing.
        if (options.expectedRevision !== undefined && (await exportRevision(plugin)) !== options.expectedRevision) return err('baseline-changed');
        const built = buildChatExport({
            records: collected.records,
            scope: projectionScope(config),
            instructions: CHAT_EXPORT_INSTRUCTIONS,
            generatedAt: new Date().toISOString(),
        });
        if (built.notes === 0) return err('export-nothing-in-scope');

        const vault = plugin.app.vault;
        const written: string[] = [];
        for (const part of built.parts) {
            const path = `${folder.value}/${part.name}`;
            // Checked again here, after the reads above: settings may have changed while they ran.
            const again = connectorFolderPath(plugin.settings.agentConnectorFolder, plugin.settings.protectedFolders);
            if (!again.ok || again.value !== folder.value) return err('baseline-changed');
            if (!assertWritable(plugin.settings.protectedFolders, 'create', path).ok) return err('protected-path');
            const existing = vault.getAbstractFileByPath(path);
            if (!existing) {
                await ensureFolder(plugin, folder.value);
                if (!assertWritable(plugin.settings.protectedFolders, 'create', path).ok) return err('protected-path');
                if (vault.getAbstractFileByPath(path)) return err('connector-file-not-ours');
                await vault.create(path, part.text);
            } else {
                if (!(existing instanceof TFile)) return err('connector-file-not-ours');
                const baseline = await vault.read(existing);
                if (!isOwnExport(baseline)) return err('connector-file-not-ours');
                const res = await applyNoteEdit(plugin, { kind: 'full-replace', filePath: path, baseline, nextContent: part.text }, { review: false });
                if (!res.ok) return err(res.error);
            }
            written.push(path);
        }

        // Parts left over from a larger earlier export: only our own, only by name pattern and marker.
        let removed = 0;
        const dir = vault.getAbstractFileByPath(folder.value);
        if (dir instanceof TFolder) {
            for (const child of [...dir.children]) {
                if (!(child instanceof TFile) || !CHAT_EXPORT_NAME_PATTERN.test(child.name) || written.includes(child.path)) continue;
                if (!assertWritable(plugin.settings.protectedFolders, 'delete', child.path).ok) continue;
                if (!isOwnExport(await vault.read(child))) continue;
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
