/**
 * Import from Claude: registered only while `claude-import` is on. The import itself runs on a desktop computer; on a phone
 * the command explains where it runs.
 */
import { Notice } from 'obsidian';
import type AIOrganiserPlugin from '../main';
import { actionName } from '../core/actionRegistry';
import { describeError, formatGuidance } from '../core/friendlyErrors';
import { openSettingsSection } from '../utils/noticeUtils';
import { ClaudeImportResultModal } from '../ui/modals/ClaudeImportResultModal';
import { logger } from '../utils/logger';

const guidance = (plugin: AIOrganiserPlugin, code: string): void => {
    new Notice(formatGuidance(describeError(plugin.t, code)), 9000);
};

/** Run now and show what happened. Shared by the command and the settings button. */
export async function importFromClaudeNow(plugin: AIOrganiserPlugin): Promise<void> {
    const runtime = plugin.claudeImport;
    if (!runtime) { guidance(plugin, 'claude-import-desktop-only'); return; }
    try {
        const res = await runtime.run('manual');
        if (!res.ok) { guidance(plugin, res.error); return; }
        new ClaudeImportResultModal(plugin.app, plugin, runtime, res.value).open();
    } catch (e) {
        logger.error('ClaudeImport', 'Import from Claude failed', e);
        guidance(plugin, 'claude-import-failed');
    }
}

export function registerClaudeImportCommands(plugin: AIOrganiserPlugin): void {
    plugin.addCommand({
        id: 'import-from-claude',
        name: actionName(plugin.t, 'import-from-claude'),
        icon: 'download',
        callback: () => { void importFromClaudeNow(plugin); },
    });
    plugin.addCommand({
        id: 'open-claude-import-settings',
        name: actionName(plugin.t, 'open-claude-import-settings'),
        icon: 'settings',
        callback: () => openSettingsSection(plugin, 'integrations', 'sub-claude-import'),
    });
}
