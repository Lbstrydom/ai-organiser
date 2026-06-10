/**
 * Visual search consent + status panel (plan §10b Settings registration, C15/C17/C18).
 *
 * Mounted INSIDE the Semantic Search settings block, deliberately UNGATED on the
 * `visual-search` feature flag (C17): the user must be able to read the destination/
 * privacy copy and click Enable BEFORE the feature is on. Only indexing workers,
 * retrieval, and destructive teardown gate on `isFeatureEnabled('visual-search')`.
 *
 * The pre-enable copy names ALL THREE vault-exit flows (C18): page images → embedding
 * backend; matching page text → active LLM (default on, named); rendered page images →
 * active vision LLM (default off, C5). BYO key entry is allowed pre-enable, but indexing
 * does not start until Enable is confirmed (C15).
 */
import { Notice, Setting } from 'obsidian';
import { BaseSettingSection } from './BaseSettingSection';
import { PLUGIN_SECRET_IDS } from '../../core/secretIds';
import { isFeatureEnabled, resolveEnable, resolveDisable } from '../../services/featureService';
import { selectVisualBackend, fnv1a64Hex, type VisualBackendSelection } from '../../services/visualEmbedding/visualBackendResolver';
import { probeAzureCohereV4Image } from '../../services/visualEmbedding/azureCohereV4ImageProbe';
import { isAzureMode } from '../../services/azure/endpointResolver';
import { logger } from '../../utils/logger';

export class VisualSearchSettingsSection extends BaseSettingSection {
    private probeRunning = false;

    async display(): Promise<void> {
        const t = this.plugin.t.settings.visualSearch;
        const container = this.containerEl;
        const enabled = isFeatureEnabled(this.plugin.settings, 'visual-search');
        const selection = await selectVisualBackend(this.plugin);

        container.createEl('p', { text: t.description, cls: 'setting-item-description' });

        // ── Consent copy: the three named transmissions (C18) — ALWAYS visible ──
        const consent = container.createDiv({ cls: 'ai-organiser-visual-consent' });
        consent.createEl('strong', { text: t.consentHeading });
        const list = consent.createEl('ul');
        const backendName = this.backendDisplayName(selection);
        list.createEl('li', { text: t.consentIndexing.replace('{backend}', backendName) });
        list.createEl('li', { text: t.consentPageText });
        list.createEl('li', { text: t.consentSynthesisImages });

        // ── Status line (one state machine — C17) ──
        const statusText = this.statusLine(enabled, selection);
        const status = container.createEl('p', { text: statusText, cls: 'setting-item-description' });
        status.addClass('ai-organiser-visual-status');

        // ── Probe action (azure path, unverified config) ──
        if (selection.kind === 'probe-needed') {
            new Setting(container)
                .setName(t.probeButton)
                .setDesc(t.statusProbeNeeded)
                .addButton((btn) => btn
                    .setButtonText(t.probeButton)
                    .setCta()
                    .onClick(() => { void this.runProbe(selection); }));
        }

        // ── BYO Cohere key — allowed pre-enable (C15), dedicated secret (C22) ──
        this.renderApiKeyField({
            name: t.byoKeyName,
            desc: t.byoKeyDesc,
            secretId: PLUGIN_SECRET_IDS.COHERE_VISUAL,
            onChange: () => { void this.rerender(); },
        });

        // ── Enable / disable (the consent action — C15) ──
        new Setting(container)
            .setName(enabled ? t.disableButton : t.enableButton)
            .addButton((btn) => {
                btn.setButtonText(enabled ? t.disableButton : t.enableButton);
                if (!enabled) btn.setCta(); else btn.setWarning();
                btn.onClick(() => {
                    if (enabled) {
                        const { flags } = resolveDisable(this.plugin.settings, 'visual-search');
                        void this.plugin.applyFeatureFlags(flags);
                    } else {
                        const { flags } = resolveEnable(this.plugin.settings.featureFlags, 'visual-search');
                        void this.plugin.applyFeatureFlags(flags);
                    }
                });
            });

        // ── Per-flow consent toggles (C18 #2 / C5 #3) ──
        new Setting(container)
            .setName(t.pageTextToggle)
            .setDesc(t.pageTextToggleDesc)
            .addToggle((toggle) => toggle
                .setValue(this.plugin.settings.allowVisualPageTextInRag)
                .onChange(async (value) => {
                    this.plugin.settings.allowVisualPageTextInRag = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(container)
            .setName(t.synthesisImagesToggle)
            .setDesc(t.synthesisImagesToggleDesc)
            .addToggle((toggle) => toggle
                .setValue(this.plugin.settings.allowVisualSynthesisImages)
                .onChange(async (value) => {
                    this.plugin.settings.allowVisualSynthesisImages = value;
                    await this.plugin.saveSettings();
                }));

        // ── Index tuning ──
        new Setting(container)
            .setName(t.dimLabel)
            .setDesc(t.dimDesc)
            .addDropdown((dd) => dd
                .addOptions({ '256': '256', '512': '512', '1024': '1024', '1536': '1536' })
                .setValue(String(this.plugin.settings.visualEmbeddingDim))
                .onChange(async (value) => {
                    this.plugin.settings.visualEmbeddingDim = Number(value);
                    await this.plugin.saveSettings();
                }));

        new Setting(container)
            .setName(t.maxPagesLabel)
            .setDesc(t.maxPagesDesc)
            .addSlider((slider) => slider
                .setLimits(1, 100, 1)
                .setValue(this.plugin.settings.maxVisualPagesPerAttachment)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.maxVisualPagesPerAttachment = value;
                    await this.plugin.saveSettings();
                }));

        container.createEl('p', { text: t.pptGuidance, cls: 'setting-item-description' });
    }

    private backendDisplayName(selection: VisualBackendSelection): string {
        if (selection.kind === 'unavailable') {
            return isAzureMode(this.plugin.settings) ? 'Azure / Cohere' : 'Cohere';
        }
        return selection.cfg.backend === 'azure-cohere-v4'
            ? `Azure "${selection.cfg.modelId}"`
            : 'Cohere';
    }

    private statusLine(enabled: boolean, selection: VisualBackendSelection): string {
        const t = this.plugin.t.settings.visualSearch;
        if (this.probeRunning) return t.statusProbeRunning;
        if (!enabled) return t.statusDisabled;
        if (this.plugin.visualIndexNeedsRebuild) return t.statusNeedsRebuild;
        switch (selection.kind) {
            case 'ready':
                return selection.cfg.backend === 'azure-cohere-v4'
                    ? t.statusEnabledAzure.replace('{deployment}', selection.cfg.modelId)
                    : t.statusEnabledNative;
            case 'probe-needed':
                return t.statusProbeNeeded;
            case 'unavailable':
                switch (selection.reason) {
                    case 'off': return t.statusOff;
                    case 'missing-key': return t.statusMissingKey;
                    case 'no-deployment': return t.statusNoDeployment;
                    case 'no-endpoint': return t.statusNoEndpoint;
                    case 'no-key': return t.statusNoKey;
                    case 'azure-unsupported-no-byo': return t.statusAzureUnsupportedNoByo;
                }
        }
    }

    /** Run the DP-2 probe; persist ONLY definitive results (CA2 — never `needs-retry`). */
    private async runProbe(selection: Extract<VisualBackendSelection, { kind: 'probe-needed' }>): Promise<void> {
        if (this.probeRunning) return;
        this.probeRunning = true;
        const t = this.plugin.t.settings.visualSearch;
        const notice = new Notice(t.statusProbeRunning, 0);
        try {
            const result = await probeAzureCohereV4Image(selection.cfg, fnv1a64Hex, () => Date.now());
            if (result.status === 'needs-retry') {
                new Notice(t.probeRetry.replace('{reason}', result.reason ?? 'unknown'));
            } else {
                this.plugin.settings.azureVisualImageProbe = result;
                await this.plugin.saveSettings();
                new Notice(result.status === 'supported'
                    ? t.probeSupported
                    : t.probeUnsupported.replace('{reason}', result.reason ?? 'unknown'));
            }
        } catch (e) {
            // probeAzureCohereV4Image never throws by contract — belt and braces.
            logger.error('Search', `Visual probe failed unexpectedly: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
            notice.hide();
            this.probeRunning = false;
            await this.rerender();
        }
    }

    private async rerender(): Promise<void> {
        await this.settingTab.render();
    }
}
