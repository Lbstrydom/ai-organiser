import { Notice, Platform } from 'obsidian';
import type AIOrganiserPlugin from '../main';
import { logger } from '../utils/logger';
import { MinutesCreationModal } from '../ui/modals/MinutesCreationModal';
import { extractMinutesJsonFromNote, generateMinutesDocx } from '../services/export/minutesDocxGenerator';
import { sanitizeFileName } from '../utils/minutesUtils';
import { desktopRequire, getFs } from '../utils/desktopRequire';

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

    if (!Platform.isMobile) {
        // Desktop: system Save dialog
        const saved = await saveDocxWithDialog(baseName, buffer);
        if (saved) {
            new Notice(`${plugin.t.minutes.exportDocxSuccess || 'Minutes exported to Word'}: ${saved}`);
        } else {
            // User cancelled or fallback failed — try vault save
            await saveDocxToVault(plugin, baseName, buffer);
        }
    } else {
        // Mobile: save to vault
        await saveDocxToVault(plugin, baseName, buffer);
    }
}

/**
 * Save DOCX via system Save dialog (desktop).
 * Returns the saved file path, or null if user cancelled.
 */
async function saveDocxWithDialog(baseName: string, buffer: ArrayBuffer): Promise<string | null> {
    const defaultName = `${baseName}.docx`;

    try {
        type ElectronRemote = { dialog: { showSaveDialog: (opts: { defaultPath: string; filters: Array<{ name: string; extensions: string[] }> }) => Promise<{ canceled: boolean; filePath?: string }> } };
        const remote = desktopRequire<ElectronRemote>('@electron/remote');
        const fsMod = getFs();
        if (!remote || !fsMod) {
            return null;
        }
        const result = await remote.dialog.showSaveDialog({
            defaultPath: defaultName,
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
 * Fallback: save DOCX into the vault's minutes output folder.
 */
async function saveDocxToVault(plugin: AIOrganiserPlugin, baseName: string, buffer: ArrayBuffer): Promise<void> {
    const { ensureFolderExists, getAvailableFilePath } = await import('../utils/minutesUtils');
    const { getMinutesOutputFullPath } = await import('../core/settings');

    const outputFolder = getMinutesOutputFullPath(plugin.settings);
    await ensureFolderExists(plugin.app.vault, outputFolder);

    const fileName = `${baseName}.docx`;
    const targetPath = await getAvailableFilePath(plugin.app.vault, outputFolder, fileName);
    await plugin.app.vault.createBinary(targetPath, buffer);

    new Notice(`${plugin.t.minutes.exportDocxSuccess || 'Minutes exported to Word'}: ${targetPath}`);
}
