import { Notice } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import type { AIOrganiserSettingTab } from './AIOrganiserSettingTab';
import { BaseSettingSection } from './BaseSettingSection';
import { evaluateSetup, toFolderSet } from '../../core/setupState';
import { renderSetupStatusRow } from '../setup/SetupStatusRow';
import { FolderListEditor } from '../setup/FolderListEditor';
import { openProtectedFoldersSetup, applyProtectedFolders } from '../../commands/protectedFolderCommands';
import { TFolder } from 'obsidian';

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
    }
}
