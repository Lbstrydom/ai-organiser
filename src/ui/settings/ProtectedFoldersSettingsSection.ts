import { Notice, Setting } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import type { AIOrganiserSettingTab } from './AIOrganiserSettingTab';
import { BaseSettingSection } from './BaseSettingSection';
import { evaluateSetup, toFolderSet } from '../../core/setupState';
import { renderSetupStatusRow } from '../setup/SetupStatusRow';
import { FolderListEditor } from '../setup/FolderListEditor';
import { openProtectedFoldersSetup, applyProtectedFolders, refreshProtectedFolderBadge } from '../../commands/protectedFolderCommands';
import { TFolder } from 'obsidian';
import { describeError, formatGuidance } from '../../core/friendlyErrors';
import { logger } from '../../utils/logger';

let shieldSaveQueue: Promise<void> = Promise.resolve();

/**
 * Settings section for protected folders (F1). A status row, the folder list (picker, not
 * typed paths) and nothing else: one job, one small surface.
 */
export class ProtectedFoldersSettingsSection extends BaseSettingSection {
    constructor(plugin: AIOrganiserPlugin, containerEl: HTMLElement, settingTab: AIOrganiserSettingTab) {
        super(plugin, containerEl, settingTab);
    }

    display(): void {
        const t = this.plugin.t;
        this.createSectionHeader(t.protectedFolders.sectionTitle, 'shield', 2);
        const evaluation = evaluateSetup('protected-folders', this.plugin.settings, {
            existingFolders: toFolderSet(
                this.plugin.app.vault.getAllLoadedFiles().filter((f): f is TFolder => f instanceof TFolder).map((f) => f.path),
            ),
        });
        renderSetupStatusRow({
            container: this.containerEl,
            t,
            name: t.protectedFolders.statusName,
            evaluation,
            onOpen: () => openProtectedFoldersSetup(this.plugin, () => this.settingTab.display()),
        });
        this.containerEl.createEl('p', { text: t.protectedFolders.description, cls: 'setting-item-description' });

        const editor = new FolderListEditor({
            app: this.plugin.app,
            container: this.containerEl,
            t,
            getFolders: () => this.plugin.settings.protectedFolders,
            emptyText: t.protectedFolders.empty,
            onChange: async (next) => {
                const res = await applyProtectedFolders(this.plugin, next);
                if (!res.ok) {
                    new Notice(res.error, 8000);
                    return;
                }
                this.settingTab.display();
            },
        });
        editor.render();

        this.renderShieldToggle();
    }

    private renderShieldToggle(): void {
        const t = this.plugin.t;
        new Setting(this.containerEl)
            .setName(t.protectedFolders.showBadgeName)
            .setDesc(t.protectedFolders.showBadgeDesc)
            .addToggle((toggle) => toggle
                .setValue(this.plugin.settings.showProtectedFolderShield)
                .onChange((value) => {
                    void this.setShieldVisible(value);
                }));
    }

    /** Saves run one at a time, so a failed save can only restore the value that was current when it started. */
    private setShieldVisible(value: boolean): Promise<void> {
        shieldSaveQueue = shieldSaveQueue.then(() => this.saveShieldVisible(value));
        return shieldSaveQueue;
    }

    /** Store the toggle, repaint, and put the previous value back if saving fails (same discipline as the list). */
    private async saveShieldVisible(value: boolean): Promise<void> {
        const previous = this.plugin.settings.showProtectedFolderShield;
        this.plugin.settings.showProtectedFolderShield = value;
        try {
            await this.plugin.saveSettings();
        } catch (e) {
            this.plugin.settings.showProtectedFolderShield = previous;
            logger.error('Protected', 'Could not save the shield setting', e);
            new Notice(formatGuidance(describeError(this.plugin.t, 'write-failed')), 8000);
            this.settingTab.display();
        }
        refreshProtectedFolderBadge();
    }
}
