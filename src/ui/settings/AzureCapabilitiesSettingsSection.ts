/**
 * Azure capabilities settings — per-capability 3-state rows (Use Azure / Bring
 * your own / Off) rendered from the capability registry. Only shown in Azure
 * mode. Each row states the Azure situation (✓ has / ⚠ partial / ✗ none) so a
 * feature your Azure can't serve is surfaced, never a silent failure.
 *
 * Plan: docs/plans/azure-capability-flexibility.md (Phase 3 / Cluster B).
 */

import { Setting, Notice } from 'obsidian';
import { BaseSettingSection } from './BaseSettingSection';
import { isAzureMode } from '../../services/azure/endpointResolver';
import { isFeatureEnabled } from '../../services/featureService';
import {
    listCapabilities,
    type AzureCapabilityDef,
    type AzureCapabilityId,
} from '../../services/azure/azureCapabilities';
import { capabilityChoice, isByoConfigured } from '../../services/azure/resolveAzureCapability';
import { resolveAzureSpeechCredential, isAzureSpeechFastTranscriptionConfigured } from '../../services/azure/azureSpeechCredential';
import { listVoices, clearVoiceCatalogCache } from '../../services/tts/voiceCatalogService';

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

        this.renderSpeechSection();
    }

    /**
     * Azure AI Speech (azure-audio plan Phase 5) — region, endpoint, key,
     * catalog-backed voice picker (UI-state matrix M2: loading / error / empty /
     * configured), max speakers, strict mode, diarization provider.
     */
    private renderSpeechSection(): void {
        const t = this.plugin.t.settings.azureSpeech;
        const s = this.plugin.settings;
        this.containerEl.createEl('h4', { text: t.title });
        this.containerEl.createEl('p', { text: t.description, cls: 'setting-item-description' });

        // Legacy Global-Standard disclosure (DP-1): visible while Speech is
        // unconfigured and strict mode is off.
        if (!s.azureSpeechRequired && (!s.azureSpeechRegion || !s.azureSpeechVoice)) {
            this.containerEl.createDiv({ cls: 'setting-item-description', text: t.legacyGlobalStandardNotice });
        }

        new Setting(this.containerEl)
            .setName(t.region)
            .setDesc(t.regionDesc)
            .addText((text) => text
                .setPlaceholder(t.regionPlaceholder)
                .setValue(s.azureSpeechRegion)
                .onChange((value) => {
                    s.azureSpeechRegion = value.trim();
                    clearVoiceCatalogCache();
                    void this.plugin.saveSettings();
                }));

        new Setting(this.containerEl)
            .setName(t.endpoint)
            .setDesc(t.endpointDesc)
            .addText((text) => text
                .setPlaceholder(t.endpointPlaceholder)
                .setValue(s.azureSpeechEndpoint)
                .onChange((value) => {
                    s.azureSpeechEndpoint = value.trim();
                    void this.plugin.saveSettings();
                }));

        new Setting(this.containerEl)
            .setName(t.apiKey)
            .setDesc(t.apiKeyDesc)
            .addText((text) => {
                text.inputEl.type = 'password';
                text.setValue(s.azureSpeechApiKey ?? '');
                text.onChange((value) => {
                    // Transient — migrated to SecretStorage (AZURE_SPEECH) on save.
                    s.azureSpeechApiKey = value;
                    void this.plugin.saveSettings();
                });
            });

        this.renderVoicePicker();

        new Setting(this.containerEl)
            .setName(t.maxSpeakers)
            .setDesc(t.maxSpeakersDesc)
            .addSlider((slider) => slider
                .setLimits(1, 10, 1)
                .setValue(s.azureSpeechMaxSpeakers || 4)
                .setDynamicTooltip()
                .onChange((value) => {
                    s.azureSpeechMaxSpeakers = value;
                    void this.plugin.saveSettings();
                }));

        new Setting(this.containerEl)
            .setName(t.strictMode)
            .setDesc(t.strictModeDesc)
            .addToggle((toggle) => toggle
                .setValue(s.azureSpeechRequired)
                .onChange((value) => {
                    s.azureSpeechRequired = value;
                    void this.plugin.saveSettings();
                    this.settingTab.display();
                }));

        // Diarization provider (Azure mode): the coordinator prefers the
        // in-region azure-speech surface once configured; this row controls
        // whether diarization is offered at all + the private fallback.
        new Setting(this.containerEl)
            .setName(this.plugin.t.diarization.providerLabel)
            .setDesc(this.plugin.t.diarization.providerDesc)
            .addDropdown((dd) => dd
                .addOption('none', this.plugin.t.diarization.providerOff)
                .addOption('azure-speech', this.plugin.t.diarization.providerAzureSpeech)
                .addOption('deepgram', this.plugin.t.diarization.providerDeepgram)
                .setValue(['azure-speech', 'deepgram'].includes(s.audioDiarisationProvider) ? s.audioDiarisationProvider : 'none')
                .onChange((value) => {
                    s.audioDiarisationProvider = value as 'none' | 'deepgram' | 'azure-speech';
                    void this.plugin.saveSettings();
                    void this.refreshDiarizationStatus(statusLine);
                }));

        // Effective-provider status (user feedback 2026-06-11): the dropdown is
        // the stored CHOICE, but the coordinator routes azure mode to the
        // in-region surface once configured — show what will ACTUALLY run.
        const statusLine = this.containerEl.createDiv({ cls: 'setting-item-description' });
        void this.refreshDiarizationStatus(statusLine);
    }

    /** Mirror AudioAttachCoordinator's selection logic for display. */
    private async refreshDiarizationStatus(el: HTMLElement): Promise<void> {
        const tDia = this.plugin.t.diarization;
        const s = this.plugin.settings;
        try {
            if (s.audioDiarisationProvider !== 'deepgram' && s.audioDiarisationProvider !== 'azure-speech') {
                el.setText(tDia.statusNotConfigured);
                return;
            }
            if (await isAzureSpeechFastTranscriptionConfigured(this.plugin)) {
                el.setText(tDia.statusAzureSpeech);
                return;
            }
            if (s.audioDiarisationProvider === 'deepgram') {
                el.setText(tDia.statusDeepgram);
                return;
            }
            el.setText(tDia.statusNotConfigured);
        } catch {
            el.setText(tDia.statusNotConfigured);
        }
    }

    /** Catalog-backed voice picker with the M2 state matrix. */
    private renderVoicePicker(): void {
        const t = this.plugin.t.settings.azureSpeech;
        const s = this.plugin.settings;
        const setting = new Setting(this.containerEl)
            .setName(t.voice)
            .setDesc(t.voiceDesc);

        const statusEl = this.containerEl.createDiv({ cls: 'setting-item-description' });

        setting.addText((text) => text
            .setPlaceholder(t.voicePlaceholder)
            .setValue(s.azureSpeechVoice)
            .onChange((value) => {
                s.azureSpeechVoice = value.trim();
                void this.plugin.saveSettings();
            }));

        setting.addButton((btn) => btn
            .setButtonText(t.voicesRetry)
            .setTooltip(t.voicesLoading)
            .onClick(() => { void this.loadVoicesInto(statusEl); }));
    }

    /** Fetch the regional voice catalog and surface the M2 states. */
    private async loadVoicesInto(statusEl: HTMLElement): Promise<void> {
        const t = this.plugin.t.settings.azureSpeech;
        statusEl.setText(t.voicesLoading);
        const cred = await resolveAzureSpeechCredential(this.plugin);
        if (!cred.ok) {
            statusEl.setText(`${t.voicesError} (${t.reasonNoKey})`);
            return;
        }
        const r = await listVoices(this.plugin.settings, cred.value.key, { forceRefresh: true });
        if (!r.ok) {
            statusEl.setText(r.error === 'no-region' ? t.reasonNoRegion : t.voicesError);
            return;
        }
        if (r.value.length === 0) {
            statusEl.setText(t.voicesEmpty);
            return;
        }
        const loaded = this.plugin.t.diarization.voicesLoaded.replace('{count}', String(r.value.length));
        statusEl.setText(loaded);
        new Notice(loaded);
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
