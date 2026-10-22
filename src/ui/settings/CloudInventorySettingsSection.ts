import { Notice, Setting } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import type { AIOrganiserSettingTab } from './AIOrganiserSettingTab';
import { BaseSettingSection } from './BaseSettingSection';
import { evaluateSetup } from '../../core/setupState';
import { describeError, formatGuidance } from '../../core/friendlyErrors';
import { renderSetupStatusRow } from '../setup/SetupStatusRow';
import { validateScriptUrl } from '../../services/appsScriptClient';
import { approvedRoots, inventoryConfigKey, testConnection, toTestResult } from '../../services/cloudInventory/cloudInventoryService';
import { getInventorySecret, openCloudInventorySetup, runRefresh } from '../../commands/cloudInventoryCommands';

/**
 * Drive folder inventory settings: a status row, the paired folders, the script link with a
 * "Test connection" button, and a collapsed Advanced group for the traversal limits.
 */
export class CloudInventorySettingsSection extends BaseSettingSection {
    constructor(plugin: AIOrganiserPlugin, containerEl: HTMLElement, settingTab: AIOrganiserSettingTab) {
        super(plugin, containerEl, settingTab);
    }

    display(): void {
        const t = this.plugin.t;
        const c = t.cloudInventory;
        const s = this.plugin.settings;
        this.createSectionHeader(c.sectionTitle, 'cloud', 2);

        renderSetupStatusRow({
            container: this.containerEl,
            t,
            name: c.statusName,
            evaluation: evaluateSetup('cloud-inventory', s, {
                configHash: inventoryConfigKey(s.cloudInventoryScriptUrl, s.cloudInventoryPairs),
                connection: s.cloudInventoryLastTest,
            }),
            onOpen: () => openCloudInventorySetup(this.plugin, () => this.settingTab.display()),
        });
        this.containerEl.createEl('p', { text: c.description, cls: 'setting-item-description' });

        this.containerEl.createEl('h4', { text: c.pairsHeading });
        if (s.cloudInventoryPairs.length === 0) {
            this.containerEl.createDiv({ cls: 'setting-item-description', text: c.noPairs });
        }
        for (const pair of s.cloudInventoryPairs) {
            new Setting(this.containerEl)
                .setName(pair.label || pair.vaultFolder || '/')
                .setDesc(c.pairSummary.replace('{vault}', pair.vaultFolder || '/').replace('{id}', pair.driveFolderId.slice(0, 8) + '…'))
                .addExtraButton((b) => b.setIcon('trash-2').setTooltip(c.removePair).onClick(() => {
                    s.cloudInventoryPairs = s.cloudInventoryPairs.filter((p) => p.id !== pair.id);
                    void this.plugin.saveSettings().then(() => this.settingTab.display());
                }));
        }
        new Setting(this.containerEl)
            .addButton((b) => b.setButtonText(c.addPair).setCta().onClick(() => openCloudInventorySetup(this.plugin, () => this.settingTab.display())))
            .addButton((b) => b.setButtonText(c.refreshAll).onClick(() => { void runRefresh(this.plugin); }));

        const status = this.containerEl.createDiv({ cls: 'setting-item-description', attr: { role: 'status' } });
        status.setText(s.cloudInventoryLastTest ? (s.cloudInventoryLastTest.ok ? c.connectedNoFolder : c.notTested) : c.notTested);
        new Setting(this.containerEl)
            .setName(c.scriptUrlName)
            .setDesc(c.scriptUrlDesc)
            .addText((tx) => tx.setValue(s.cloudInventoryScriptUrl).onChange((v) => {
                s.cloudInventoryScriptUrl = v.trim();
                void this.plugin.saveSettings();
            }))
            .addButton((b) => b.setButtonText(c.testConnection).onClick(() => {
                void (async () => {
                    status.setText(c.testing);
                    const secret = await getInventorySecret(this.plugin);
                    const url = validateScriptUrl(s.cloudInventoryScriptUrl);
                    const key = inventoryConfigKey(s.cloudInventoryScriptUrl, s.cloudInventoryPairs);
                    const code = !secret ? 'no-secret' : !url.ok ? url.error : null;
                    if (code || !secret) { status.setText(formatGuidance(describeError(t, code ?? 'no-secret'))); return; }
                    const res = await testConnection({ url: s.cloudInventoryScriptUrl, secret, roots: approvedRoots(s.cloudInventoryPairs) });
                    s.cloudInventoryLastTest = toTestResult(key, res.ok ? res.value : null, new Date().toISOString());
                    await this.plugin.saveSettings();
                    if (!res.ok) { status.setText(formatGuidance(describeError(t, res.error))); new Notice(formatGuidance(describeError(t, res.error)), 8000); return; }
                    status.setText(c.connectedNoFolder);
                })();
            }));

        const details = this.containerEl.createEl('details', { cls: 'ai-organiser-advanced-group' });
        details.createEl('summary', { text: c.advancedTitle });
        const num = (name: string, get: () => number, set: (n: number) => void): void => {
            new Setting(details).setName(name).addText((tx) => tx.setValue(String(get())).onChange((v) => {
                const n = Math.floor(Number(v));
                if (Number.isFinite(n) && n > 0) { set(n); void this.plugin.saveSettings(); }
            }));
        };
        num(c.maxFoldersName, () => s.cloudInventoryMaxFolders, (n) => { s.cloudInventoryMaxFolders = n; });
        num(c.maxFilesName, () => s.cloudInventoryMaxFiles, (n) => { s.cloudInventoryMaxFiles = n; });
        num(c.deadlineName, () => s.cloudInventoryDeadlineMinutes, (n) => { s.cloudInventoryDeadlineMinutes = n; });
    }
}
