/**
 * Connect an AI app: the guide, and the vault map export for chat projects. The guide shows text to
 * copy and never edits another application's files; the export writes only into the folder the
 * person chose, behind a confirmation that names what leaves the computer when they upload it.
 */
import { Notice } from 'obsidian';
import type AIOrganiserPlugin from '../main';
import { Result, ok, err } from '../core/result';
import { describeError, formatGuidance } from '../core/friendlyErrors';
import { collectRecords, projectionScope, scopedFiles, scopeConfigFromSettings } from '../services/agentIndex/agentIndexService';
import { buildChatExport, CHAT_EXPORT_INSTRUCTIONS } from '../services/agentConnectors/chatExport';
import { connectorFolderPath, exportChatProject, exportRevision } from '../services/agentConnectors/connectorRuntime';
import { AgentConnectorsModal } from '../ui/modals/AgentConnectorsModal';
import { ConfirmationModal } from '../ui/modals/ConfirmationModal';
import { logger } from '../utils/logger';

export function openAgentConnectors(plugin: AIOrganiserPlugin): void {
    new AgentConnectorsModal(plugin.app, plugin, () => exportWithConfirmation(plugin)).open();
}

function confirm(plugin: AIOrganiserPlugin, title: string, body: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
        let answered = false;
        const modal = new ConfirmationModal(plugin.app, title, body, () => { answered = true; resolve(true); }, plugin);
        const close = modal.onClose.bind(modal);
        modal.onClose = () => { close(); if (!answered) resolve(false); };
        modal.open();
    });
}

const filesText = (plugin: AIOrganiserPlugin, count: number): string => (count === 1 ? plugin.t.agentConnectors.fileSingular : plugin.t.agentConnectors.filePlural.replace('{count}', String(count)));

/** How many notes the map would list, without writing anything. Bound to the revision the confirmation applies to. */
async function previewExport(plugin: AIOrganiserPlugin): Promise<Result<{ notes: number; revision: string }>> {
    const s = plugin.settings;
    const folder = connectorFolderPath(s.agentConnectorFolder, s.protectedFolders);
    if (!folder.ok) return err(folder.error);
    const revision = await exportRevision(plugin);
    const config = scopeConfigFromSettings(s);
    const collected = await collectRecords(plugin.app, scopedFiles(plugin.app, config), config);
    const built = buildChatExport({ records: collected.records, scope: projectionScope(config), instructions: CHAT_EXPORT_INSTRUCTIONS, generatedAt: '' });
    if (built.notes === 0) return err('export-nothing-in-scope');
    return ok({ notes: built.notes, revision });
}

/**
 * Preview, confirm, write. `ok(null)` means the person declined; nothing was written. The confirmation
 * is bound to the scope and folder it was shown for: if they changed, nothing is written.
 */
export async function exportWithConfirmation(plugin: AIOrganiserPlugin): Promise<Result<string | null>> {
    const t = plugin.t.agentConnectors;
    try {
        const preview = await previewExport(plugin);
        if (!preview.ok) return err(preview.error);
        const agreed = await confirm(plugin, t.chatConfirmTitle, t.chatConfirmBody.replace('{notes}', String(preview.value.notes)));
        if (!agreed) return ok(null);
        const res = await exportChatProject(plugin, { expectedRevision: preview.value.revision });
        if (!res.ok) return err(res.error);
        const folder = connectorFolderPath(plugin.settings.agentConnectorFolder, plugin.settings.protectedFolders);
        const where = folder.ok ? folder.value : plugin.settings.agentConnectorFolder;
        const lines = [t.chatDone.replace('{files}', filesText(plugin, res.value.paths.length)).replace('{folder}', where).replace('{notes}', String(res.value.notes))];
        if (res.value.removed > 0) lines.push(t.chatRetired.replace('{count}', String(res.value.removed)));
        return ok(lines.join(' '));
    } catch (e) {
        logger.error('Connector', 'Export failed', e);
        return err('write-failed');
    }
}

/** The command: same flow, with Notices instead of the guide's inline result. */
export async function runExportCommand(plugin: AIOrganiserPlugin): Promise<void> {
    const res = await exportWithConfirmation(plugin);
    if (!res.ok) {
        const text = res.error === 'baseline-changed' ? plugin.t.agentConnectors.chatChanged : formatGuidance(describeError(plugin.t, res.error));
        new Notice(text, 9000);
        return;
    }
    if (res.value) new Notice(res.value, 8000);
}

export function registerAgentConnectorCommands(plugin: AIOrganiserPlugin): void {
    const t = plugin.t;
    plugin.addCommand({ id: 'open-agent-connectors', name: t.commands.openAgentConnectors, icon: 'plug-zap', callback: () => openAgentConnectors(plugin) });
    plugin.addCommand({ id: 'export-vault-map', name: t.commands.exportVaultMap, icon: 'file-up', callback: () => { void runExportCommand(plugin); } });
}
