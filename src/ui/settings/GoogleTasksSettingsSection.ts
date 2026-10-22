import { Setting } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import type { AIOrganiserSettingTab } from './AIOrganiserSettingTab';
import { BaseSettingSection } from './BaseSettingSection';
import { evaluateSetup } from '../../core/setupState';
import { renderSetupStatusRow } from '../setup/SetupStatusRow';
import { openTasksSetup, runSendApproved, tasksConfigKey } from '../../commands/inboxSweepCommands';
import { exportable, pendingApprovals } from '../../services/inboxSweep/sweepLedger';

/** Google Tasks export settings: a status row, the chosen list, and the send button. */
export class GoogleTasksSettingsSection extends BaseSettingSection {
    constructor(plugin: AIOrganiserPlugin, containerEl: HTMLElement, settingTab: AIOrganiserSettingTab) {
        super(plugin, containerEl, settingTab);
    }

    display(): void {
        const t = this.plugin.t;
        const c = t.googleTasks;
        const s = this.plugin.settings;
        this.createSectionHeader(c.sectionTitle, 'list-checks', 2);

        renderSetupStatusRow({
            container: this.containerEl,
            t,
            name: c.statusName,
            evaluation: evaluateSetup('google-tasks', s, {
                configHash: tasksConfigKey(s.tasksScriptUrl, s.tasksListId),
                connection: s.tasksLastTest,
            }),
            onOpen: () => openTasksSetup(this.plugin, () => this.settingTab.display()),
        });
        this.containerEl.createEl('p', { text: c.description, cls: 'setting-item-description' });
        if (s.tasksListName) this.containerEl.createDiv({ cls: 'setting-item-description', text: `${c.listName}: ${s.tasksListName}` });

        const waiting = pendingApprovals(s.sweepApprovals, true).reduce((n, r) => n + exportable(r).length, 0);
        if (waiting > 0) this.containerEl.createDiv({ cls: 'setting-item-description', text: c.pendingLine.replace('{count}', String(waiting)) });

        new Setting(this.containerEl).setClass('ai-organiser-button-row')
            .addButton((b) => b.setButtonText(c.setupButton).setCta().onClick(() => openTasksSetup(this.plugin, () => this.settingTab.display())))
            .addButton((b) => b.setButtonText(c.sendNow).onClick(() => { void runSendApproved(this.plugin); }));
    }
}
