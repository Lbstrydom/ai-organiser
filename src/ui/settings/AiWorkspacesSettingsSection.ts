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
        // A sharing setting that did not save may leave the connector on the previous scope: the person is told, not just the log.
        // `undo` puts the previous value back: a sharing setting that did not save must not look applied.
        const save = (undo?: () => void): void => {
            this.plugin.saveSettings().catch((e: unknown) => {
                logger.error('AiWorkspaces', 'Could not save the settings', e);
                undo?.();
                new Notice(formatGuidance(describeError(this.plugin.t, 'unknown')), 9000);
                this.settingTab.display();
            });
        };

        new Setting(this.containerEl).setName(c.shareFoldersName).setDesc(`${c.shareFoldersDesc} ${c.revokeNote}`)
            .addTextArea((ta) => {
                // The allow-list decides what leaves the vault, so half-typed lines are a draft: it takes effect when the field is left.
                let draft = (s.aiShareFolders ?? []).join('\n');
                ta.setPlaceholder(c.shareFoldersPlaceholder).setValue(draft).onChange((v) => { draft = v; });
                ta.inputEl.rows = 4;
                ta.inputEl.addEventListener('blur', () => {
                    const next = normaliseShareFolders(draft.split('\n'));
                    if (JSON.stringify(next) === JSON.stringify(s.aiShareFolders ?? [])) return;
                    const before = s.aiShareFolders;
                    s.aiShareFolders = next;
                    // Put back only if nothing newer replaced it meanwhile.
                    save(() => { if (s.aiShareFolders === next) s.aiShareFolders = before; });
                });
            });

        new Setting(this.containerEl).setName(c.optInName).setDesc(c.optInDesc)
            .addToggle((tg) => tg.setValue(s.aiShareRequireOptIn === true).onChange((v) => { const before = s.aiShareRequireOptIn; s.aiShareRequireOptIn = v; save(() => { if (s.aiShareRequireOptIn === v) s.aiShareRequireOptIn = before; }); }));

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
