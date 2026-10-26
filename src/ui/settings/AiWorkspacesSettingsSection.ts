import { Notice, Setting } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import type { AIOrganiserSettingTab } from './AIOrganiserSettingTab';
import { BaseSettingSection } from './BaseSettingSection';
import { describeError, formatGuidance } from '../../core/friendlyErrors';
import { normaliseShareFolders } from '../../services/aiWorkspaces/aiShareScope';
import { SharingSaver } from '../../services/aiWorkspaces/sharingSaver';
import { packFolderPath } from '../../services/aiWorkspaces/packStore';
import { logger } from '../../utils/logger';

/**
 * One saver per plugin, not per redraw: the settings page is rebuilt often, and two savers could overlap their saves. Sharing settings
 * are access control: saves run one at a time and a failed one puts back the last value that really saved (see SharingSaver).
 */
const savers = new WeakMap<AIOrganiserPlugin, SharingSaver>();
export function sharingSaverFor(plugin: AIOrganiserPlugin): SharingSaver {
    let saver = savers.get(plugin);
    if (!saver) {
        const s = plugin.settings;
        saver = new SharingSaver({
            read: () => ({ folders: s.aiShareFolders ?? [], optIn: s.aiShareRequireOptIn === true }),
            write: (v) => { s.aiShareFolders = [...v.folders]; s.aiShareRequireOptIn = v.optIn; },
            persist: () => plugin.saveSettings(),
            onFailed: (e) => {
                logger.error('AiWorkspaces', 'Could not save the sharing settings', e);
                new Notice(formatGuidance(describeError(plugin.t, 'unknown')), 9000);
                plugin.settingTab?.display();
            },
        });
        savers.set(plugin, saver);
    }
    return saver;
}

/** AI workspaces: which folders may be shared with AI apps (default none), the opt-in for the connector, and the pack folder. */
export class AiWorkspacesSettingsSection extends BaseSettingSection {
    constructor(plugin: AIOrganiserPlugin, containerEl: HTMLElement, settingTab: AIOrganiserSettingTab) {
        super(plugin, containerEl, settingTab);
    }

    display(): void {
        const c = this.plugin.t.aiWorkspaces;
        const s = this.plugin.settings;
        // The saver remembers the values as they are NOW as the last saved ones, so it must exist before any handler below can edit them.
        sharingSaverFor(this.plugin);
        this.createSectionHeader(c.sectionTitle, 'messages-square', 2);
        this.containerEl.createEl('p', { text: c.description, cls: 'setting-item-description' });
        const saveSharing = (): void => { void sharingSaverFor(this.plugin).request(); };
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
