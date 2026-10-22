import { Notice, Setting, TFolder } from 'obsidian';
import { FolderSuggest } from './components/FolderSuggest';
import { reportPathFor } from '../../services/upkeep/upkeepReport';
import { logger } from '../../utils/logger';
import { describeError, formatGuidance } from '../../core/friendlyErrors';
import type AIOrganiserPlugin from '../../main';
import type { AIOrganiserSettingTab } from './AIOrganiserSettingTab';
import { BaseSettingSection } from './BaseSettingSection';
import { evaluateSetup, toFolderSet } from '../../core/setupState';
import { renderSetupStatusRow } from '../setup/SetupStatusRow';
import { availability, unavailableReason } from '../../services/upkeep/upkeepRuntime';
import { openUpkeepReview, openUpkeepSetup, runUpkeepNow } from '../../commands/upkeepCommands';
import type { TaskName } from '../../services/upkeep/upkeepTasks';

/**
 * Vault upkeep settings. Visible by default: the interval, the three checks, a status line and the
 * run button. The rest (rebuild automatically, report folder, mobile, run cap, identical files) sits
 * in one collapsed Advanced group.
 */
export class VaultUpkeepSettingsSection extends BaseSettingSection {
    constructor(plugin: AIOrganiserPlugin, containerEl: HTMLElement, settingTab: AIOrganiserSettingTab) {
        super(plugin, containerEl, settingTab);
    }

    display(): void {
        const t = this.plugin.t;
        const c = t.vaultUpkeep;
        const s = this.plugin.settings;
        this.createSectionHeader(c.sectionTitle, 'broom', 2);

        const folders = this.plugin.app.vault.getAllLoadedFiles().filter((f): f is TFolder => f instanceof TFolder).map((f) => f.path);
        renderSetupStatusRow({
            container: this.containerEl,
            t,
            name: c.statusName,
            evaluation: evaluateSetup('vault-upkeep', s, { existingFolders: toFolderSet(folders) }),
            onOpen: () => openUpkeepSetup(this.plugin, () => this.settingTab.display()),
        });
        this.containerEl.createEl('p', { text: c.description, cls: 'setting-item-description' });

        const save = (): void => {
            void this.plugin.saveSettings().then(() => this.plugin.syncUpkeep()).catch((e: unknown) => {
                logger.error('Upkeep', 'Could not save the upkeep settings', e);
                new Notice(formatGuidance(describeError(this.plugin.t, 'write-failed')), 8000);
            });
        };
        new Setting(this.containerEl).setName(c.intervalName).addDropdown((d) => d
            .addOption('off', c.intervalOff).addOption('hourly', c.intervalHourly).addOption('daily', c.intervalDaily)
            .addOption('weekly', c.intervalWeekly).addOption('custom', c.intervalCustom)
            .setValue(s.upkeepInterval)
            .onChange((v) => { s.upkeepInterval = v as typeof s.upkeepInterval; save(); this.settingTab.display(); }));
        if (s.upkeepInterval === 'custom') {
            new Setting(this.containerEl).setName(c.customMinutesName).addText((tx) => tx.setValue(String(s.upkeepCustomMinutes)).onChange((v) => {
                const n = Math.floor(Number(v));
                if (Number.isFinite(n) && n >= 15) { s.upkeepCustomMinutes = Math.min(10080, n); save(); }
            }));
        }

        this.containerEl.createEl('h4', { text: c.tasksHeading });
        const can = availability(this.plugin);
        const features: Record<TaskName, string> = { agentIndex: t.features['agent-index'].label, inventories: t.features['cloud-inventory'].label, attachments: t.features['embed-scan'].label };
        const labels: Record<TaskName, string> = { agentIndex: c.taskAgentIndex, inventories: c.taskInventories, attachments: c.taskAttachments };
        for (const task of ['agentIndex', 'inventories', 'attachments'] as const) {
            const row = new Setting(this.containerEl).setName(labels[task]);
            if (!can[task]) row.setDesc((unavailableReason(this.plugin, task) === 'needs-setup' ? c.taskNeedsSetup : c.taskUnavailable).replace('{feature}', features[task]));
            else if (task === 'inventories') row.setDesc(c.taskInventoriesNote);
            row.addToggle((tg) => tg.setValue(s.upkeepTasks[task]).setDisabled(!can[task]).onChange((v) => { s.upkeepTasks[task] = v; save(); }));
        }

        const status = this.containerEl.createDiv({ cls: 'setting-item-description', attr: { role: 'status' } });
        const last = s.upkeepLastRun;
        const next = this.plugin.upkeep?.nextRun() ?? null;
        status.setText([
            last ? c.lastRunLine.replace('{when}', new Date(last.startedAt).toLocaleString()).replace('{status}', last.status).replace('{seconds}', String(Math.round(last.durationMs / 1000))) : c.neverRun,
            next === null ? c.nextRunOff : c.nextRunLine.replace('{when}', new Date(next).toLocaleString()),
        ].join(' '));

        new Setting(this.containerEl).setClass('ai-organiser-button-row')
            .addButton((b) => b.setButtonText(c.runNow).setCta().onClick(() => { void runUpkeepNow(this.plugin).then(() => this.settingTab.display()); }))
            .addButton((b) => b.setButtonText(c.openReview).onClick(() => openUpkeepReview(this.plugin)))
            .addButton((b) => b.setButtonText(c.setupButton).onClick(() => openUpkeepSetup(this.plugin, () => this.settingTab.display())));

        const details = this.containerEl.createEl('details', { cls: 'ai-organiser-advanced-group' });
        details.createEl('summary', { text: c.advancedTitle });
        new Setting(details).setName(c.autoRefreshName).setDesc(c.autoRefreshDesc).addToggle((tg) => tg.setValue(s.upkeepAutoRefreshIndex).onChange((v) => { s.upkeepAutoRefreshIndex = v; save(); }));
        new Setting(details).setName(c.duplicatesName).setDesc(c.duplicatesDesc).addToggle((tg) => tg.setValue(s.upkeepIncludeDuplicates).onChange((v) => { s.upkeepIncludeDuplicates = v; save(); }));
        new Setting(details).setName(c.reportFolderName).setDesc(c.reportFolderDesc).addText((tx) => {
            // A folder the report could not be written to is said so when the field is left, not when the report is saved.
            const check = (): void => {
                const checked = reportPathFor(s.upkeepReportFolder, s.protectedFolders);
                if (s.upkeepReportFolder !== '' && !checked.ok) new Notice(formatGuidance(describeError(this.plugin.t, checked.error)), 8000);
            };
            const apply = (v: string): void => { s.upkeepReportFolder = v.trim(); save(); };
            tx.setValue(s.upkeepReportFolder).onChange(apply);
            new FolderSuggest(this.plugin.app, tx.inputEl, (v) => { apply(v); check(); });
            tx.inputEl.addEventListener('blur', check);
        });
        new Setting(details).setName(c.mobileName).setDesc(c.mobileDesc).addToggle((tg) => tg.setValue(s.upkeepRunOnMobile).onChange((v) => { s.upkeepRunOnMobile = v; save(); }));
        new Setting(details).setName(c.capName).addText((tx) => tx.setValue(String(s.upkeepRunCapSeconds)).onChange((v) => {
            const n = Math.floor(Number(v));
            if (Number.isFinite(n) && n >= 10) { s.upkeepRunCapSeconds = Math.min(900, n); save(); }
        }));
    }
}
