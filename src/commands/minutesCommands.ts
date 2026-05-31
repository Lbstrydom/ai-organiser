import { Notice, Platform } from 'obsidian';
import type AIOrganiserPlugin from '../main';
import { logger } from '../utils/logger';
import { MinutesCreationModal } from '../ui/modals/MinutesCreationModal';
import { extractMinutesJsonFromNote, generateMinutesDocx } from '../services/export/minutesDocxGenerator';
import { sanitizeFileName } from '../utils/minutesUtils';
import { desktopRequire, getFs, getPath } from '../utils/desktopRequire';

export function registerMinutesCommands(plugin: AIOrganiserPlugin): void {
    plugin.addCommand({
        id: 'create-meeting-minutes',
        name: plugin.t.commands.createMeetingMinutes || 'Create Meeting Minutes',
        callback: () => {
            new MinutesCreationModal(plugin.app, plugin).open();
        }
    });

    plugin.addCommand({
        id: 'export-minutes-docx',
        name: plugin.t.commands.exportMinutesDocx || 'Export minutes to Word',
        icon: 'file-output',
        checkCallback: (checking: boolean) => {
            const file = plugin.app.workspace.getActiveFile();
            if (!file || file.extension !== 'md') return false;
            if (checking) return true;

            exportMinutesToDocx(plugin).catch(err => {
                logger.error('Minutes', 'Minutes DOCX export error:', err);
                new Notice(plugin.t.minutes.exportDocxFailed || 'Failed to export minutes');
            });
            return true;
        }
    });
}

async function exportMinutesToDocx(plugin: AIOrganiserPlugin): Promise<void> {
    const file = plugin.app.workspace.getActiveFile();
    if (!file) return;

    const content = await plugin.app.vault.cachedRead(file);
    const json = extractMinutesJsonFromNote(content);

    if (!json) {
        new Notice(plugin.t.minutes.exportDocxNoMinutes || 'This note does not contain meeting minutes data');
        return;
    }

    const buffer = await generateMinutesDocx(json);
    const title = json.metadata?.title || file.basename;
    const date = json.metadata?.date || '';
    const baseName = sanitizeFileName(date ? `${date} ${title}` : title);

    // Default to the minutes note's own folder so the .docx lands next to
    // the .md (matches the "one folder per meeting" workflow). On desktop
    // the save dialog can resolve a vault-relative folder to an absolute
    // filesystem path via the adapter; falls back to undefined when that
    // isn't available, in which case the dialog opens at the OS default.
    const sourceFolder = (file.parent?.path && file.parent.path !== '/')
        ? file.parent.path
        : null;

    if (!Platform.isMobile) {
        // Desktop: system Save dialog
        const defaultDir = sourceFolder ? resolveVaultFolderAbsolute(plugin, sourceFolder) : undefined;
        const saved = await saveDocxWithDialog(baseName, buffer, defaultDir);
        if (saved) {
            new Notice(`${plugin.t.minutes.exportDocxSuccess || 'Minutes exported to Word'}: ${saved}`);
        } else {
            // User cancelled or fallback failed — try vault save
            await saveDocxToVault(plugin, baseName, buffer, sourceFolder);
        }
    } else {
        // Mobile: save to vault
        await saveDocxToVault(plugin, baseName, buffer, sourceFolder);
    }
}

/**
 * Resolve a vault-relative folder (e.g. "0 Inbox/Meetings/2026-05-22 X") to
 * its absolute filesystem path so the OS Save dialog opens there by default.
 * Returns undefined when the vault adapter doesn't expose a basePath (mobile
 * via this path is already guarded; this is desktop-only).
 */
function resolveVaultFolderAbsolute(plugin: AIOrganiserPlugin, vaultRelative: string): string | undefined {
    const adapter = plugin.app.vault.adapter as { basePath?: string; getBasePath?: () => string };
    const basePath = adapter.basePath ?? adapter.getBasePath?.();
    if (!basePath) return undefined;
    const pathMod = getPath();
    if (!pathMod) return undefined;
    return pathMod.join(basePath, vaultRelative);
}

/**
 * Save DOCX via system Save dialog (desktop).
 * Returns the saved file path, or null if user cancelled.
 */
async function saveDocxWithDialog(baseName: string, buffer: ArrayBuffer, defaultDir?: string): Promise<string | null> {
    const fileName = `${baseName}.docx`;
    // When a default directory is provided (active note's parent folder),
    // join it with the filename so the OS Save dialog opens to that
    // location with the filename pre-filled. Otherwise fall back to just
    // the filename, letting the OS pick its default location.
    let defaultPath = fileName;
    if (defaultDir) {
        const pathMod = getPath();
        if (pathMod) defaultPath = pathMod.join(defaultDir, fileName);
    }

    try {
        type ElectronRemote = { dialog: { showSaveDialog: (opts: { defaultPath: string; filters: Array<{ name: string; extensions: string[] }> }) => Promise<{ canceled: boolean; filePath?: string }> } };
        const remote = desktopRequire<ElectronRemote>('@electron/remote');
        const fsMod = getFs();
        if (!remote || !fsMod) {
            return null;
        }
        const result = await remote.dialog.showSaveDialog({
            defaultPath,
            filters: [
                { name: 'Word Documents', extensions: ['docx'] },
                { name: 'All Files', extensions: ['*'] }
            ]
        });

        if (!result.canceled && result.filePath) {
            fsMod.writeFileSync(result.filePath, Buffer.from(buffer));
            return result.filePath;
        }
        return null; // User cancelled
    } catch {
        // @electron/remote unavailable
        return null;
    }
}

/**
 * Fallback: save DOCX into the vault. Defaults to the source note's parent
 * folder (one-folder-per-meeting workflow); falls back to the configured
 * minutes folder when the source folder is missing or at vault root.
 */
async function saveDocxToVault(plugin: AIOrganiserPlugin, baseName: string, buffer: ArrayBuffer, preferredFolder?: string | null): Promise<void> {
    const { ensureFolderExists, getAvailableFilePath } = await import('../utils/minutesUtils');
    const { getMinutesOutputFullPath } = await import('../core/settings');

    const outputFolder = preferredFolder || getMinutesOutputFullPath(plugin.settings);
    await ensureFolderExists(plugin.app.vault, outputFolder);

    const fileName = `${baseName}.docx`;
    const targetPath = await getAvailableFilePath(plugin.app.vault, outputFolder, fileName);
    await plugin.app.vault.createBinary(targetPath, buffer);

    new Notice(`${plugin.t.minutes.exportDocxSuccess || 'Minutes exported to Word'}: ${targetPath}`);
}
