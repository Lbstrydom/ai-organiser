/**
 * Azure capabilities settings — per-capability 3-state rows (Use Azure / Bring
 * your own / Off) rendered from the capability registry. Only shown in Azure
 * mode. Each row states the Azure situation (✓ has / ⚠ partial / ✗ none) so a
 * feature your Azure can't serve is surfaced, never a silent failure.
 *
 * Plan: docs/plans/azure-capability-flexibility.md (Phase 3 / Cluster B).
 */

import { Setting } from 'obsidian';
import { BaseSettingSection } from './BaseSettingSection';
import { isAzureMode } from '../../services/azure/endpointResolver';
import { isFeatureEnabled } from '../../services/featureService';
import {
    listCapabilities,
    type AzureCapabilityDef,
    type AzureCapabilityId,
} from '../../services/azure/azureCapabilities';
import { capabilityChoice, isByoConfigured } from '../../services/azure/resolveAzureCapability';

export class AzureCapabilitiesSettingsSection extends BaseSettingSection {
    display(): void {
        if (!isAzureMode(this.plugin.settings)) return;
        const t = this.plugin.t.settings.azureCapabilities;
        this.containerEl.createEl('h4', { text: t.title });
        this.containerEl.createEl('p', { text: t.description, cls: 'setting-item-description' });

        for (const def of listCapabilities()) {
            // OR semantics — show the row if ANY dependent feature is enabled.
            if (!def.featureFlags.some((f) => isFeatureEnabled(this.plugin.settings, f))) continue;
            this.renderRow(def);
        }
    }

    private setMode(id: AzureCapabilityId, mode: 'azure' | 'byo' | 'off'): void {
        if (!this.plugin.settings.azureCapabilities) this.plugin.settings.azureCapabilities = {};
        const prev = this.plugin.settings.azureCapabilities[id];
        this.plugin.settings.azureCapabilities[id] = { mode, deployment: prev?.deployment };
    }

    private setDeployment(id: AzureCapabilityId, deployment: string): void {
        if (!this.plugin.settings.azureCapabilities) this.plugin.settings.azureCapabilities = {};
        const prev = this.plugin.settings.azureCapabilities[id];
        this.plugin.settings.azureCapabilities[id] = { mode: prev?.mode ?? 'azure', deployment };
    }

    private renderRow(def: AzureCapabilityDef): void {
        const t = this.plugin.t.settings.azureCapabilities as unknown as Record<string, string>;
        const choice = capabilityChoice(this.plugin, def.id);

        const setting = new Setting(this.containerEl)
            .setName(t[def.labelKey])
            .setDesc(t[def.descKey])
            .addDropdown((dd) => {
                if (def.support !== 'none') dd.addOption('azure', t.modeAzure);
                dd.addOption('byo', t.modeByo);
                dd.addOption('off', t.modeOff);
                dd.setValue(choice.mode);
                dd.onChange((value) => {
                    this.setMode(def.id, value as 'azure' | 'byo' | 'off');
                    void this.plugin.saveSettings();
                    this.settingTab.display();   // re-render to reveal/hide the deployment + status
                });
            });
        setting.setClass('ai-organiser-azure-capability-row');

        // Situation line (✓ has / ⚠ partial / ✗ none).
        const statusText = def.support === 'full' ? t.statusHas
            : def.support === 'partial' ? t.statusPartial : t.statusNone;
        this.containerEl.createDiv({ cls: 'setting-item-description', text: statusText });

        // Azure deployment field (only when Azure mode is selected + the surface needs a deployment).
        if (choice.mode === 'azure' && def.needsDeployment) {
            new Setting(this.containerEl)
                .setName(t.deploymentLabel)
                .addText((text) => text
                    .setPlaceholder(t.deploymentPlaceholder)
                    .setValue(choice.deployment ?? '')
                    .onChange((value) => {
                        this.setDeployment(def.id, value.trim());
                        void this.plugin.saveSettings();
                    }));
        }

        // BYO status — async (SecretStorage). "checking…" → configured / not set.
        if (choice.mode === 'byo' || def.support === 'none') {
            const byoEl = this.containerEl.createDiv({ cls: 'setting-item-description', text: '…' });
            void isByoConfigured(this.plugin, def.byoConfigKind)
                .then((ok) => { byoEl.setText(ok ? t.byoConfigured : t.byoNotConfigured); })
                .catch(() => { byoEl.setText(t.byoNotConfigured); });
        }
    }
}
