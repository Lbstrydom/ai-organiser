import { Notice, Setting } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import type { AIOrganiserSettingTab } from './AIOrganiserSettingTab';
import { BaseSettingSection } from './BaseSettingSection';
import { describeError, formatGuidance } from '../../core/friendlyErrors';
import { normaliseShareFolders } from '../../services/aiWorkspaces/aiShareScope';
import { packFolderPath } from '../../services/aiWorkspaces/packStore';
import { logger } from '../../utils/logger';

/** AI workspaces: which folders may be shared with AI apps (default none), the opt-in for the connector, and the pack folder. */
export class AiWorkspacesSettingsSection extends BaseSettingSection {
    constructor(plugin: AIOrganiserPlugin, containerEl: HTMLElement, settingTab: AIOrganiserSettingTab) {
        super(plugin, containerEl, settingTab);
    }

    display(): void {
        const c = this.plugin.t.aiWorkspaces;
        const s = this.plugin.settings;
        this.createSectionHeader(c.sectionTitle, 'messages-square', 2);
        this.containerEl.createEl('p', { text: c.description, cls: 'setting-item-description' });
        const save = (): void => { void this.plugin.saveSettings().catch((e: unknown) => logger.error('AiWorkspaces', 'Could not save the settings', e)); };

        new Setting(this.containerEl).setName(c.shareFoldersName).setDesc(`${c.shareFoldersDesc} ${c.revokeNote}`)
            .addTextArea((ta) => {
                ta.setPlaceholder(c.shareFoldersPlaceholder).setValue((s.aiShareFolders ?? []).join('\n')).onChange((v) => {
                    s.aiShareFolders = normaliseShareFolders(v.split('\n'));
                    save();
                });
                ta.inputEl.rows = 4;
            });

        new Setting(this.containerEl).setName(c.packFolderName).setDesc(c.packFolderDesc)
            .addText((tx) => {
                tx.setValue(s.aiWorkspacePackFolder).onChange((v) => {
                    const checked = packFolderPath(v, s.protectedFolders);
                    if (!checked.ok) { new Notice(formatGuidance(describeError(this.plugin.t, checked.error)), 8000); return; }
                    s.aiWorkspacePackFolder = checked.value;
                    save();
                });
                tx.inputEl.setAttribute('aria-label', c.packFolderName);
            });
    }
}
