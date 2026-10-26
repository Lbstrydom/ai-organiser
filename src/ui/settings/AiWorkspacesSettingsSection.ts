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
        // Sharing settings are access control. What was last SAVED is remembered; a save that fails puts exactly that back (never an
        // intermediate edit), says so, and redraws, so nothing looks applied that is not.
        let savedFolders = [...(s.aiShareFolders ?? [])];
        let savedOptIn = s.aiShareRequireOptIn === true;
        const saveSharing = (): void => {
            const folders = [...(s.aiShareFolders ?? [])];
            const optIn = s.aiShareRequireOptIn === true;
            this.plugin.saveSettings().then(() => { savedFolders = folders; savedOptIn = optIn; }).catch((e: unknown) => {
                logger.error('AiWorkspaces', 'Could not save the sharing settings', e);
                s.aiShareFolders = [...savedFolders];
                s.aiShareRequireOptIn = savedOptIn;
                new Notice(formatGuidance(describeError(this.plugin.t, 'unknown')), 9000);
                this.settingTab.display();
            });
        };
        const save = (): void => { this.plugin.saveSettings().catch((e: unknown) => logger.error('AiWorkspaces', 'Could not save the settings', e)); };

        new Setting(this.containerEl).setName(c.shareFoldersName).setDesc(`${c.shareFoldersDesc} ${c.revokeNote}`)
            .addTextArea((ta) => {
                // The allow-list decides what leaves the vault, so half-typed lines are a draft: it takes effect when the field is left.
                let draft = (s.aiShareFolders ?? []).join('\n');
                ta.setPlaceholder(c.shareFoldersPlaceholder).setValue(draft).onChange((v) => { draft = v; });
                ta.inputEl.rows = 4;
                ta.inputEl.onblur = () => {
                    const next = normaliseShareFolders(draft.split('\n'));
                    if (JSON.stringify(next) === JSON.stringify(s.aiShareFolders ?? [])) return;
                    s.aiShareFolders = next;
                    saveSharing();
                };
            });

        new Setting(this.containerEl).setName(c.optInName).setDesc(c.optInDesc)
            .addToggle((tg) => tg.setValue(s.aiShareRequireOptIn === true).onChange((v) => { s.aiShareRequireOptIn = v; saveSharing(); }));

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
