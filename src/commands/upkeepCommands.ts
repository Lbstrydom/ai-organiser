/**
 * Vault upkeep: the commands, the guided setup and the review entry. The scheduler itself lives in
 * `UpkeepController` (`services/upkeep/upkeepRuntime.ts`); everything here only starts, shows or
 * configures it.
 */
import { Notice, Setting } from 'obsidian';
import type AIOrganiserPlugin from '../main';
import { Result, ok } from '../core/result';
import { describeError, formatGuidance } from '../core/friendlyErrors';
import { availability, previewUpkeep, unavailableReason } from '../services/upkeep/upkeepRuntime';
import { reviewCount } from '../services/upkeep/upkeepService';
import type { TaskName } from '../services/upkeep/upkeepTasks';
import type { IntervalChoice } from '../services/upkeep/intervalJob';
import { UpkeepReviewModal } from '../ui/modals/UpkeepReviewModal';
import { GuidedSetupModal } from '../ui/modals/GuidedSetupModal';
import { logger } from '../utils/logger';

export function openUpkeepReview(plugin: AIOrganiserPlugin): void {
    new UpkeepReviewModal(plugin.app, plugin).open();
}

/** A manual run: progress, then the review (or a plain "nothing to review"), or the failure guidance. */
export async function runUpkeepNow(plugin: AIOrganiserPlugin): Promise<void> {
    const t = plugin.t.vaultUpkeep;
    const upkeep = plugin.ensureUpkeep();
    if (!upkeep) { new Notice(formatGuidance(describeError(plugin.t, 'upkeep-feature-off')), 6000); return; }
    new Notice(t.runningNotice, 3000);
    try {
        const res = await upkeep.runNow();
        if (!res.ok) { new Notice(formatGuidance(describeError(plugin.t, res.error)), 8000); return; }
        const { summary } = res.value;
        if (summary.status === 'ok' && reviewCount(summary) === 0) { new Notice(t.nothingNotice, 5000); return; }
        openUpkeepReview(plugin);
    } catch (e) {
        logger.error('Upkeep', 'Run failed', e);
        new Notice(formatGuidance(describeError(plugin.t, 'unknown')), 8000);
    }
}

// ─── Guided setup ───────────────────────────────────────────────────────────

export function openUpkeepSetup(plugin: AIOrganiserPlugin, onDone?: () => void): void {
    const t = plugin.t;
    const c = t.vaultUpkeep;
    const s = plugin.settings;
    const can = availability(plugin);
    const draft = {
        interval: s.upkeepInterval as IntervalChoice, // never switches on a schedule the person did not pick
        minutes: s.upkeepCustomMinutes,
        // Preselect the checks whose feature is on; the user can only choose what can run.
        tasks: {
            agentIndex: can.agentIndex && (s.featureSetupCompletedAt['vault-upkeep'] ? s.upkeepTasks.agentIndex : true),
            inventories: can.inventories && (s.featureSetupCompletedAt['vault-upkeep'] ? s.upkeepTasks.inventories : true),
            attachments: can.attachments && (s.featureSetupCompletedAt['vault-upkeep'] ? s.upkeepTasks.attachments : true),
        } as Record<TaskName, boolean>,
        autoRefresh: s.upkeepAutoRefreshIndex,
    };
    const featureLabel: Record<TaskName, string> = { agentIndex: t.features['agent-index'].label, inventories: t.features['cloud-inventory'].label, attachments: t.features['embed-scan'].label };
    const taskLabel: Record<TaskName, string> = { agentIndex: c.taskAgentIndex, inventories: c.taskInventories, attachments: c.taskAttachments };

    new GuidedSetupModal(plugin.app, t, {
        title: c.wizardTitle,
        steps: [
            {
                id: 'when',
                title: c.stepWhen,
                validate: () => (Object.values(draft.tasks).some(Boolean) ? ok(undefined) : { ok: false as const, error: 'upkeep-no-tasks' }),
                render: (el) => {
                    el.createEl('p', { text: c.whenHelp });
                    new Setting(el).setName(c.intervalName).addDropdown((d) => d
                        .addOption('daily', c.intervalDaily).addOption('hourly', c.intervalHourly).addOption('weekly', c.intervalWeekly)
                        .addOption('custom', c.intervalCustom).addOption('off', c.intervalOff)
                        .setValue(draft.interval).onChange((v) => { draft.interval = v as IntervalChoice; }));
                    new Setting(el).setName(c.customMinutesName).addText((tx) => tx.setValue(String(draft.minutes)).onChange((v) => {
                        const n = Math.floor(Number(v));
                        if (Number.isFinite(n) && n > 0) draft.minutes = n;
                    }));
                    el.createEl('h4', { text: c.tasksHeading });
                    for (const task of ['agentIndex', 'inventories', 'attachments'] as const) {
                        const row = new Setting(el).setName(taskLabel[task]);
                        if (!can[task]) {
                            row.setDesc((unavailableReason(plugin, task) === 'needs-setup' ? c.taskNeedsSetup : c.taskUnavailable).replace('{feature}', featureLabel[task]));
                            row.addToggle((tg) => tg.setValue(false).setDisabled(true));
                        } else {
                            if (task === 'inventories') row.setDesc(c.taskInventoriesNote);
                            row.addToggle((tg) => tg.setValue(draft.tasks[task]).onChange((v) => { draft.tasks[task] = v; }));
                        }
                    }
                    new Setting(el).setName(c.autoRefreshName).setDesc(c.autoRefreshDesc).addToggle((tg) => tg.setValue(draft.autoRefresh).onChange((v) => { draft.autoRefresh = v; }));
                },
            },
            {
                id: 'preview',
                title: c.stepPreview,
                render: async (el) => {
                    el.createEl('p', { text: c.previewHelp });
                    const whenLabel: Record<IntervalChoice, string> = { off: c.intervalOff, hourly: c.intervalHourly, daily: c.intervalDaily, weekly: c.intervalWeekly, custom: c.intervalCustom };
                    el.createEl('p', { text: c.previewSchedule.replace('{when}', whenLabel[draft.interval].toLowerCase()), cls: 'setting-item-description' });
                    if (draft.tasks.inventories) el.createEl('p', { text: c.previewNetwork, cls: 'setting-item-description' });
                    const box = el.createDiv({ attr: { role: 'status' } });
                    box.setText(c.previewWorking);
                    const run = await previewUpkeep(plugin, draft.tasks);
                    if (!run.ok || run.value.summary.status === 'failed') box.setText(c.failedNotice);
                    else box.setText((run.value.summary.status === 'partial' ? c.previewPartial : c.previewResult).replace('{count}', String(reviewCount(run.value.summary))));
                },
            },
        ],
        onFinish: async (): Promise<Result<void>> => {
            s.upkeepInterval = draft.interval;
            s.upkeepCustomMinutes = draft.minutes;
            s.upkeepTasks = { ...draft.tasks };
            s.upkeepAutoRefreshIndex = draft.autoRefresh;
            s.featureSetupCompletedAt['vault-upkeep'] = new Date().toISOString();
            await plugin.saveSettings();
            plugin.syncUpkeep();
            onDone?.();
            return ok(undefined);
        },
    }).open();
}

export function registerUpkeepCommands(plugin: AIOrganiserPlugin): void {
    const t = plugin.t;
    plugin.addCommand({ id: 'run-vault-upkeep', name: t.commands.runVaultUpkeep, icon: 'broom', callback: () => { void runUpkeepNow(plugin); } });
    plugin.addCommand({ id: 'setup-vault-upkeep', name: t.commands.setupVaultUpkeep, icon: 'sparkles', callback: () => openUpkeepSetup(plugin) });
    plugin.addCommand({ id: 'open-upkeep-review', name: t.commands.openUpkeepReview, icon: 'clipboard-list', callback: () => openUpkeepReview(plugin) });
}
