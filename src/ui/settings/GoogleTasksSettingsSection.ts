import { Setting } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import type { AIOrganiserSettingTab } from './AIOrganiserSettingTab';
import { BaseSettingSection } from './BaseSettingSection';
import { evaluateSetup } from '../../core/setupState';
import { renderSetupStatusRow } from '../setup/SetupStatusRow';
import { openTasksSetup, tasksConfigKey } from '../../commands/inboxSweepCommands';
import { exportable, pendingApprovals } from '../../services/inboxSweep/sweepLedger';
import { renderTasksListsEditor } from './GoogleTasksListsEditor';

/**
 * Google Tasks export settings: a status row and the lists. Settings only: sending is an action
 * (the command picker, and automatically after Add in a review), and once setup is Ready the
 * status row's Review setup is the one way back into the setup.
 */
export class GoogleTasksSettingsSection extends BaseSettingSection {
    constructor(plugin: AIOrganiserPlugin, containerEl: HTMLElement, settingTab: AIOrganiserSettingTab) {
        super(plugin, containerEl, settingTab);
    }

    display(): void {
        const t = this.plugin.t;
        const c = t.googleTasks;
        const s = this.plugin.settings;
        this.createSectionHeader(c.sectionTitle, 'list-checks', 2);

        const evaluation = evaluateSetup('google-tasks', s, {
            configHash: tasksConfigKey(s.tasksScriptUrl, s.tasksListId),
            connection: s.tasksLastTest,
        });
        const openSetup = (): void => openTasksSetup(this.plugin, () => this.settingTab.display());
        renderSetupStatusRow({ container: this.containerEl, t, name: c.statusName, evaluation, onOpen: openSetup });
        this.containerEl.createEl('p', { text: c.description, cls: 'setting-item-description' });

        const waiting = pendingApprovals(s.sweepApprovals, true).reduce((n, r) => n + exportable(r).length, 0);
        if (waiting > 0) this.containerEl.createDiv({ cls: 'setting-item-description', text: `${c.pendingLine.replace('{count}', String(waiting))} ${t.inboxSweep.sendAgainHint}` });

        // While setup is not Ready the status row and this button both open it; once Ready, Review setup is the one way in.
        if (evaluation.state !== 'ready') {
            new Setting(this.containerEl).setClass('ai-organiser-button-row')
                .addButton((b) => b.setButtonText(c.setupButton).setCta().onClick(openSetup));
        }

        renderTasksListsEditor(this.containerEl, this.plugin, () => this.settingTab.display());
    }
}
