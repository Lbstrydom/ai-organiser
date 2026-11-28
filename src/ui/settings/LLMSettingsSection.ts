import { Setting, ButtonComponent, Notice, requestUrl } from 'obsidian';
import { ConnectionTestResult } from '../../services';
import { BaseSettingSection } from './BaseSettingSection';
import { PROVIDER_ENDPOINT, PROVIDER_DEFAULT_MODEL, buildProviderOptions } from '../../services/adapters/providerRegistry';
import { getAzureClaudeModels, getAzureModelPresets } from '../../core/modelCatalog';
import { adviseGatewaySettings, applyGatewayFixes, type GatewayFix } from '../../services/azure/gatewayAdvisor';
import { getProviderModels, hasModelList } from '../../services/adapters/modelRegistry';
import {
    getCachedModels,
    getLiveModels,
    providerSupportsLiveFetch,
} from '../../services/adapters/dynamicModelService';
import { PLUGIN_SECRET_IDS, PROVIDER_TO_SECRET_ID } from '../../core/secretIds';
import { MigrationConfirmModal } from '../modals/MigrationConfirmModal';
import { ReplaceModelNameModal } from '../modals/ReplaceModelNameModal';
import { AzureConfigImportModal } from '../modals/AzureConfigImportModal';
import { isAzureMode } from '../../services/azure/endpointResolver';
import { applyAzureClaudeDeployment, applyAzureGptModel } from '../../services/azure/azureModelSync';
import { capabilityChoice, usesWhisperDeployment } from '../../services/azure/resolveAzureCapability';
import { getCapability, type AzureCapabilityId } from '../../services/azure/azureCapabilities';
import {
    AZURE_ADVANCED,
    countAdvancedOverrides,
    endpointIsAdvanced,
    resolveDeploymentField,
    setDeploymentField,
    standardAdvancedSettings,
    type AdvancedSetting,
    type AzureAdvancedId,
    type DeploymentFieldId,
    type StandardAdvancedId,
} from '../../services/azure/azureEffectiveFields';
import { isFeatureEnabled } from '../../services/featureService';
import { AzureCapabilitiesSettingsSection } from './AzureCapabilitiesSettingsSection';

export class LLMSettingsSection extends BaseSettingSection {
    private statusContainer: HTMLElement = null!;
    private statusEl: HTMLElement = null!;
    /** Escape-hatch: when true, reveal the full provider dropdown even in
     *  streamlined Azure mode. Resets each settings-tab open (instance-local). */
    private azureShowFullProvider = false;
    /** Whether Advanced is open, remembered per settings tab so a re-render keeps it. */
    private static readonly advancedOpen = new WeakMap<object, boolean>();

    /**
     * Streamlined Azure UX is active when Azure-first mode is on, the main
     * provider is an Azure surface, and the user hasn't clicked the
     * "Use a different provider" escape hatch. In this state the generic full
     * provider dropdown + getting-started box are suppressed (redundant with
     * the Azure section, which owns the azure-claude vs azure-openai choice).
     */
    private isStreamlinedAzure(): boolean {
        return (
            !!this.plugin.settings.azureFirstMode &&
            isAzureMode(this.plugin.settings) &&
            !this.azureShowFullProvider
        );
    }

    display(): void {
        this.createSectionHeader(this.plugin.t.settings.llm.title, 'bot');
        this.renderSecretStorageMigrationNotice();
        if (this.plugin.settings.azureFirstMode) {
            this.renderAzureLayout();
        } else {
            this.renderStandardLayout();
        }

        // Check local service status when loading settings if local service is selected
        if (this.plugin.settings.serviceType === 'local') {
            void this.checkLocalService(this.plugin.settings.localEndpoint);
        }
    }

    /** Azure-first layout: connection, then one group per capability, then Advanced. */
    private renderAzureLayout(): void {
        this.renderAzureFirstToggle();
        this.renderAzureConnection();
        this.renderAzureChat();
        this.renderAzureSearch();
        this.renderAzureTranscription();
        this.renderAzureReadAloud();
        this.renderAzureWebSearch();
        this.renderReplaceModelName();
        // The honest list of what has no Azure path and needs a separate key.
        if (isAzureMode(this.plugin.settings)) this.renderProviderCapabilityBanner();
        this.renderAzureAdvanced();
    }

    /** Every other setup: provider, key and model first; the rest under Advanced. */
    private renderStandardLayout(): void {
        this.renderServiceType();
        if (this.plugin.settings.serviceType === 'local') {
            this.displayLocalSettings();
        } else {
            this.renderProviderDropdown();
            this.displayCloudSettings();
        }
        this.renderReplaceModelName();
        this.renderStandardAdvanced();
        this.containerEl.createEl('h4', { text: this.plugin.t.settings.llm.azure.usingAzureHeading });
        this.renderAzureFirstToggle();
    }

    private renderReplaceModelName(): void {
        new Setting(this.containerEl)
            .setName(this.plugin.t.commands.replaceModelName)
            .setDesc(this.plugin.t.modals.modelReplace.settingDesc)
            .addButton(button => button
                .setButtonText(this.plugin.t.modals.modelReplace.settingButton)
                .onClick(() => new ReplaceModelNameModal(this.plugin, () => { void this.settingTab.display(); }).open()));
    }

    private renderDebugMode(): void {
        new Setting(this.containerEl)
            .setName(this.plugin.t.settings.llm.debugMode)
            .setDesc(this.plugin.t.settings.llm.debugModeDesc)
            .addToggle(toggle =>
                toggle
                    .setValue(this.plugin.settings.debugMode)
                    .onChange((value) => {
                        this.plugin.settings.debugMode = value;
                        void this.plugin.saveSettings();
                        new Notice(value ? this.plugin.t.settings.llm.debugEnabled : this.plugin.t.settings.llm.debugDisabled);
                    })
            );
    }

    /** Render a block into another container (the Advanced disclosure). */
    private into(container: HTMLElement, render: () => void): void {
        const previous = this.containerEl;
        this.containerEl = container;
        try {
            render();
        } finally {
            this.containerEl = previous;
        }
    }

    /**
     * The one Advanced disclosure: closed by default, its summary counting the
     * settings inside that differ from their defaults.
     */
    private renderAdvanced<Id extends string>(
        list: ReadonlyArray<AdvancedSetting<Id>>,
        render: (id: Id) => void,
    ): void {
        const az = this.plugin.t.settings.llm.azure;
        const details = this.containerEl.createEl('details', { cls: 'ai-organiser-settings-advanced' });
        details.open = LLMSettingsSection.advancedOpen.get(this.settingTab) ?? false;
        const summary = details.createEl('summary');
        let speechKeySet = false;
        const refresh = (): void => {
            const n = countAdvancedOverrides(this.plugin.settings, list, { speechKeySet });
            summary.setText(n === 0 ? az.advanced
                : n === 1 ? az.advancedOneOverride
                    : az.advancedOverrides.replace('{count}', String(n)));
        };
        details.addEventListener('toggle', () => LLMSettingsSection.advancedOpen.set(this.settingTab, details.open));
        // Settings write synchronously in their own handlers; recount just after.
        for (const type of ['change', 'input', 'click']) {
            details.addEventListener(type, () => { window.setTimeout(refresh, 0); });
        }
        this.into(details, () => { for (const item of list) render(item.id); });
        refresh();

        const secrets = this.plugin.secretStorageService;
        if (list.some(item => item.id === 'speech-key') && secrets.isAvailable()) {
            void secrets.hasSecret(PLUGIN_SECRET_IDS.AZURE_SPEECH)
                .then((has) => { speechKeySet = has; refresh(); })
                .catch(() => { /* the count then covers only the stored settings */ });
        }
    }

    private renderStandardAdvanced(): void {
        this.renderAdvanced(standardAdvancedSettings(this.plugin.settings), (id) => this.renderStandardAdvancedRow(id));
    }

    private renderStandardAdvancedRow(id: StandardAdvancedId): void {
        if (id === 'endpoint') this.renderCloudEndpoint();
        else if (id === 'thinking') this.renderThinkingMode();
        else this.renderDebugMode();
    }

    private renderAzureAdvanced(): void {
        const s = this.plugin.settings;
        // A non-Azure main provider (reached through "Use a different provider") keeps its own advanced rows.
        const extra = isAzureMode(s) ? [] : standardAdvancedSettings(s).filter(item => item.id !== 'debug');
        const list: ReadonlyArray<AdvancedSetting<AzureAdvancedId | StandardAdvancedId>> = [...extra, ...AZURE_ADVANCED];
        const az = this.plugin.t.settings.llm.azure;
        this.renderAdvanced(list, (id) => {
            switch (id) {
                case 'endpoint': return this.renderCloudEndpoint();
                case 'thinking': return this.renderThinkingMode();
                case 'routing': return this.renderRoutingMode();
                case 'claude-gateway': return this.renderClaudeGateway();
                case 'max-concurrent': return this.renderMaxConcurrent();
                case 'max-rpm': return this.renderMaxRpm();
                // Per-deployment RPM overrides: user-entered quotas, nothing shipped or derived.
                case 'deployment-rpm': return this.renderPerDeploymentRpmEditor(az);
                case 'speech-key': return this.azureCapabilityRows()?.renderSpeechKey();
                case 'max-speakers': return this.azureCapabilityRows()?.renderMaxSpeakers();
                case 'in-region-only': return this.azureCapabilityRows()?.renderStrictMode();
                case 'youtube': return this.azureCapabilityRows()?.renderCapability('youtube');
                case 'debug': return this.renderDebugMode();
            }
        });
    }

    /** Per-capability and Speech rows drawn into the current container; Azure main providers only. */
    private azureCapabilityRows(): AzureCapabilitiesSettingsSection | null {
        if (!isAzureMode(this.plugin.settings)) return null;
        return new AzureCapabilitiesSettingsSection(this.plugin, this.containerEl, this.settingTab);
    }

    /** Whether a capability's source row is on screen (its feature enabled, Azure main provider). */
    private showsCapability(id: AzureCapabilityId): boolean {
        return isAzureMode(this.plugin.settings)
            && getCapability(id).featureFlags.some(f => isFeatureEnabled(this.plugin.settings, f));
    }

    private renderGroupHeading(text: string): void {
        this.containerEl.createEl('h4', { text, cls: 'ai-organiser-settings-group' });
    }

    /**
     * Azure-first mode toggle. It changes the main provider and model: ON selects
     * Azure (remembering the personal provider and model), OFF restores them.
     */
    private renderAzureFirstToggle(): void {
        const az = this.plugin.t.settings.llm.azure;
        new Setting(this.containerEl)
            .setName(az.firstMode)
            .setDesc(az.firstModeDesc)
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.azureFirstMode ?? false)
                .onChange((value) => {
                    // The toggle is a CORPORATE ↔ PERSONAL switch: ON selects Azure for
                    // all routing; OFF restores the personal provider the user had before
                    // (e.g. direct Anthropic). We snapshot on enter and restore on exit so
                    // a private-PC user flips back to their own provider, not stranded on Azure.
                    const s = this.plugin.settings;
                    if (value) {
                        if (!isAzureMode(s)) {
                            s.preAzureFirstProvider = s.cloudServiceType; // remember personal (e.g. 'claude')
                            if (!s.providerSettings) s.providerSettings = {};
                            const ps = s.providerSettings[s.cloudServiceType] ?? (s.providerSettings[s.cloudServiceType] = {});
                            if (s.cloudModel) ps.model = s.cloudModel;
                            s.cloudServiceType = 'azure-claude';
                            s.cloudEndpoint = '';
                            s.cloudModel = s.taskModels?.chat || PROVIDER_DEFAULT_MODEL['azure-claude'];
                        }
                        s.azureFirstMode = true;
                    } else {
                        s.azureFirstMode = false;
                        if (s.cloudServiceType.startsWith('azure')) {
                            const target = (s.preAzureFirstProvider && !s.preAzureFirstProvider.startsWith('azure'))
                                ? s.preAzureFirstProvider : 'claude';
                            const t = target as typeof s.cloudServiceType;
                            const saved = s.providerSettings?.[t];
                            s.cloudServiceType = t;
                            s.cloudEndpoint = PROVIDER_ENDPOINT[t] ?? '';
                            s.cloudModel = saved?.model || PROVIDER_DEFAULT_MODEL[t] || 'latest-sonnet';
                            const secretId = PROVIDER_TO_SECRET_ID[t];
                            s.cloudApiKey = (this.plugin.secretStorageService.isAvailable() && secretId)
                                ? '' : (saved?.apiKey || '');
                        }
                        s.preAzureFirstProvider = '';
                    }
                    void this.plugin.saveSettings();
                    this.settingTab.display();
                })
            );
    }

    /**
     * Dropdown of catalog presets + any stored value that isn't one (kept as a
     * passthrough, e.g. a tenant codename) + "Custom deployment name…", which
     * reveals a free-text box on the same row. Azure deployment names are
     * tenant-chosen, so typing a name stays possible — it is just no longer the
     * only way. `set` mutates settings; this method saves.
     */
    private addAzureModelPicker(
        setting: Setting,
        kind: 'chat' | 'embedding' | 'claude',
        get: () => string,
        set: (value: string) => void,
        placeholder: string,
    ): void {
        const az = this.plugin.t.settings.llm.azure;
        const CUSTOM = '__custom__';
        const presets = getAzureModelPresets(kind);
        const isPreset = (v: string): boolean => presets.some(p => p.id === v);
        const current = get();
        const textRef: { el: HTMLInputElement | null } = { el: null };
        const commit = (value: string): void => {
            set(value);
            void this.plugin.saveSettings();
        };

        setting.addDropdown(dropdown => {
            for (const p of presets) dropdown.addOption(p.id, `${p.name} (${p.id})`);
            if (current && !isPreset(current)) dropdown.addOption(current, current);
            dropdown.addOption(CUSTOM, az.modelCustom);
            dropdown
                .setValue(current || CUSTOM)
                .onChange((value) => {
                    if (value === CUSTOM) {
                        textRef.el?.show();
                        textRef.el?.focus();
                        return;
                    }
                    textRef.el?.hide();
                    commit(value);
                });
        });
        setting.addText(text => {
            textRef.el = text.inputEl;
            text.setPlaceholder(placeholder)
                .setValue(current && !isPreset(current) ? current : '')
                .onChange((value) => {
                    if (value.trim()) commit(value.trim());
                });
        });
        // Free text only when the saved value is a custom one (or nothing is set yet).
        if (current && isPreset(current)) textRef.el?.hide();
    }

    private renderAzureConnection(): void {
        const az = this.plugin.t.settings.llm.azure;
        this.renderGroupHeading(az.groupConnection);

        // API key — plain password field (transient; migrated to SecretStorage on save).
        new Setting(this.containerEl)
            .setName(az.apiKey)
            .setDesc(az.apiKeyDesc)
            .addText(text => {
                text.setPlaceholder(az.apiKeyPlaceholder)
                    .setValue(this.plugin.settings.azureApiKey ? '••••••••' : '')
                    .onChange((value) => {
                        if (value !== '••••••••') {
                            this.plugin.settings.azureApiKey = value;
                            void this.plugin.saveSettings();
                        }
                    });
                text.inputEl.type = 'password';
                return text;
            });

        new Setting(this.containerEl)
            .setName(az.aiEndpoint)
            .setDesc(az.aiEndpointDesc)
            .addText(text => text
                .setPlaceholder('https://<your-resource>.services.ai.azure.com')
                .setValue(this.plugin.settings.azureAIEndpoint)
                .onChange((value) => {
                    this.plugin.settings.azureAIEndpoint = value;
                    void this.plugin.saveSettings();
                }));

        new Setting(this.containerEl)
            .setName(az.openAIEndpoint)
            .setDesc(az.openAIEndpointDesc)
            .addText(text => text
                .setPlaceholder('https://<your-resource>.openai.azure.com')
                .setValue(this.plugin.settings.azureOpenAIEndpoint)
                .onChange((value) => {
                    this.plugin.settings.azureOpenAIEndpoint = value;
                    void this.plugin.saveSettings();
                }));

        this.renderGatewayAdviceBanner();

        // Live connection test — pre-flight validates config, then makes real
        // minimal round-trips to each configured Azure surface. Results render
        // per-surface (✓/✗ + redacted message) under the button.
        const resultsEl = this.containerEl.createDiv({ cls: 'ai-organiser-azure-test-results' });
        new Setting(this.containerEl)
            .setName(az.testConfig)
            .setDesc(az.testConfigDesc)
            .addButton(button => button
                .setButtonText(az.testButton)
                .onClick(async () => {
                    button.setButtonText(az.testingButton);
                    button.setDisabled(true);
                    resultsEl.empty();
                    try {
                        const { testAzureConnection } = await import('../../services/azure/azureConnectionTest');
                        const report = await testAzureConnection(this.plugin);
                        this.renderAzureTestReport(resultsEl, report);
                    } catch (err) {
                        const msg = err instanceof Error ? err.message : String(err);
                        resultsEl.createDiv({ cls: 'ai-organiser-azure-test-row error', text: `✗ ${msg}` });
                    } finally {
                        button.setButtonText(az.testButton);
                        button.setDisabled(false);
                    }
                }));

        // Config export/import — copies every Azure setting on this screen
        // (endpoints, routing, deployment names, RPM overrides, default model,
        // Speech region/voice) as one JSON blob so a team on a shared Azure
        // resource can sync in one paste instead of a field-by-field
        // walkthrough. NEVER includes the API key — each person still enters
        // their own.
        new Setting(this.containerEl)
            .setName(az.configTransfer)
            .setDesc(az.configTransferDesc)
            .addButton(button => button
                .setButtonText(az.exportButton)
                .onClick(async () => {
                    const { buildAzureConfigExport } = await import('../../services/azure/azureConfigTransfer');
                    const json = JSON.stringify(buildAzureConfigExport(this.plugin.settings), null, 2);
                    try {
                        await navigator.clipboard.writeText(json);
                        new Notice(az.exportCopied);
                    } catch {
                        new Notice(az.exportCopyFailed);
                    }
                }))
            .addButton(button => button
                .setButtonText(az.importButton)
                .onClick(() => {
                    new AzureConfigImportModal(this.plugin.app, az, async (raw) => {
                        const { applyAzureConfigImport } = await import('../../services/azure/azureConfigTransfer');
                        let parsed: unknown;
                        try {
                            parsed = JSON.parse(raw);
                        } catch {
                            new Notice(az.importInvalidJson);
                            return;
                        }
                        const result = applyAzureConfigImport(this.plugin.settings, parsed);
                        if (!result.ok) {
                            new Notice(az.importNoFields);
                            return;
                        }
                        await this.plugin.saveSettings();
                        new Notice(az.importApplied.replace('{count}', String(result.appliedFields.length)));
                        this.settingTab.display();
                    }).open();
                }));
    }

    private renderAzureChat(): void {
        const az = this.plugin.t.settings.llm.azure;
        const s = this.plugin.settings;
        this.renderGroupHeading(az.groupChat);

        // Main-provider choice (azure-claude vs azure-openai) lives INSIDE the
        // Azure section in streamlined mode — the generic full dropdown is
        // suppressed below. Both surfaces are still served automatically.
        if (this.isStreamlinedAzure()) {
            const current = isAzureMode(this.plugin.settings)
                ? this.plugin.settings.cloudServiceType
                : 'azure-claude';
            new Setting(this.containerEl)
                .setName(az.mainProviderChoice)
                .setDesc(az.mainProviderChoiceDesc)
                .addDropdown(dropdown => dropdown
                    .addOption('azure-claude', az.providerAzureClaude)
                    .addOption('azure-openai', az.providerAzureOpenAI)
                    .setValue(current)
                    .onChange((value) => {
                        this.plugin.settings.cloudServiceType = value as typeof this.plugin.settings.cloudServiceType;
                        this.plugin.settings.cloudEndpoint = PROVIDER_ENDPOINT[value as keyof typeof PROVIDER_ENDPOINT] || '';
                        // cloudModel is what the runtime sends as the deployment name —
                        // keep it in step with the surface instead of leaving a stale id.
                        this.plugin.settings.cloudModel = value === 'azure-openai'
                            ? (this.plugin.settings.azureGPTModel || PROVIDER_DEFAULT_MODEL['azure-openai'])
                            : (this.plugin.settings.taskModels?.chat || PROVIDER_DEFAULT_MODEL['azure-claude']);
                        void this.plugin.saveSettings();
                        this.settingTab.display();
                    }));
        }

        this.renderClaudeDeployment();


        this.renderGptModel();

        if (s.azureRoutingMode === 'deployment-based') {
            this.addAzureModelPicker(
                new Setting(this.containerEl).setName(az.chatDeployment).setDesc(az.chatDeploymentDesc),
                'chat',
                () => this.plugin.settings.azureDeployments?.chat || '',
                (value) => {
                    if (!this.plugin.settings.azureDeployments) this.plugin.settings.azureDeployments = {};
                    this.plugin.settings.azureDeployments.chat = value;
                },
                az.gptModelPlaceholder,
            );
        }

        // A local or non-Azure setup keeps its service and provider controls here.
        if (s.serviceType === 'local' || !this.isStreamlinedAzure()) {
            this.renderServiceType();
            if (s.serviceType === 'local') {
                this.displayLocalSettings();
            } else {
                this.renderProviderDropdown();
                if (!isAzureMode(s)) this.displayCloudSettings();
            }
        }

        // Escape hatch — reveal the full provider dropdown for users who want a
        // non-Azure provider while keeping Azure-first mode on.
        if (this.isStreamlinedAzure()) {
            const hatch = this.containerEl.createDiv({ cls: 'setting-item-description ai-organiser-mt-4' });
            const link = hatch.createEl('a', {
                text: az.useDifferentProvider,
                cls: 'ai-organiser-cursor-pointer',
            });
            link.addEventListener('click', () => {
                this.azureShowFullProvider = true;
                this.settingTab.display();
            });
        }
    }

    /**
     * The Claude deployment (a catalog preset or a typed name), then, when Claude
     * is the main provider, the optional model behind it.
     */
    private renderClaudeDeployment(): void {
        const az = this.plugin.t.settings.llm.azure;
        let showModel: ((value: string) => void) | null = null;
        this.addAzureModelPicker(
            new Setting(this.containerEl).setName(az.defaultModel).setDesc(az.defaultModelDesc),
            'claude',
            () => {
                const s = this.plugin.settings;
                return (s.cloudServiceType === 'azure-claude' && s.cloudModel)
                    || s.taskModels?.tagging
                    || PROVIDER_DEFAULT_MODEL['azure-claude'];
            },
            (value) => {
                applyAzureClaudeDeployment(this.plugin.settings, value);
                // A changed deployment drops the Claude model: show that.
                showModel?.(this.plugin.settings.azureClaudeModel);
            },
            az.customModelNamePlaceholder,
        );
        if (this.plugin.settings.cloudServiceType === 'azure-claude') showModel = this.renderClaudeModel();
    }

    /**
     * Optional: describes a custom deployment name; never sent in a request. Picked
     * from the catalog so it cannot be mistyped; an unlisted stored value is kept.
     * Returns how to show a value changed elsewhere.
     */
    private renderClaudeModel(): (value: string) => void {
        const az = this.plugin.t.settings.llm.azure;
        const models = getAzureClaudeModels();
        const current = this.plugin.settings.azureClaudeModel;
        let show: (value: string) => void = () => {};
        new Setting(this.containerEl)
            .setName(az.claudeModel)
            .setDesc(az.claudeModelDesc)
            .addDropdown(dropdown => {
                dropdown.addOption('', az.claudeModelNone);
                for (const m of models) dropdown.addOption(m.id, `${m.name} (${m.id})`);
                if (current && !models.some(m => m.id === current)) dropdown.addOption(current, current);
                dropdown
                    .setValue(current)
                    .onChange((value) => {
                        this.plugin.settings.azureClaudeModel = value;
                        void this.plugin.saveSettings();
                    });
                show = (value) => { if (dropdown.getValue() !== value) dropdown.setValue(value); };
            });
        return show;
    }

    /** "GPT model", with a notice when chat is stored as sending something else. */
    private renderGptModel(): void {
        const az = this.plugin.t.settings.llm.azure;
        const s = this.plugin.settings;
        let notice: HTMLElement | null = null;
        // GPT model — also the chat model when Azure OpenAI is the main provider.
        this.addAzureModelPicker(
            new Setting(this.containerEl).setName(az.gptModel).setDesc(az.gptModelDesc),
            'chat',
            () => this.plugin.settings.azureGPTModel,
            (value) => {
                applyAzureGptModel(this.plugin.settings, value);
                notice?.hide();
            },
            az.gptModelPlaceholder,
        );
        const gpt = s.azureGPTModel?.trim();
        if (s.cloudServiceType !== 'azure-openai' || !s.cloudModel || !gpt || s.cloudModel === gpt) return;
        // Values that already differ are only changed by this button or the picker.
        notice = this.containerEl.createDiv({ cls: 'setting-item-description ai-organiser-azure-model-mismatch' });
        notice.createSpan({ text: `${az.chatModelMismatch.replace('{chat}', s.cloudModel).replace('{gpt}', gpt)} ` });
        new ButtonComponent(notice)
            .setButtonText(az.useForChat.replace('{gpt}', gpt))
            .onClick(() => {
                applyAzureGptModel(this.plugin.settings, gpt);
                void this.plugin.saveSettings();
                this.settingTab.display();
            });
    }

    private renderAzureSearch(): void {
        const az = this.plugin.t.settings.llm.azure;
        this.renderGroupHeading(az.groupSearch);
        this.azureCapabilityRows()?.renderCapability('embeddings', { label: az.source, withDeployment: false });

        // Embedding model — sent in the request body and sizes the index.
        this.addAzureModelPicker(
            new Setting(this.containerEl).setName(az.embeddingModel).setDesc(az.embeddingModelDesc),
            'embedding',
            () => this.plugin.settings.embeddingModel,
            (value) => { this.plugin.settings.embeddingModel = value; },
            az.embeddingModelPlaceholder,
        );

        if (this.plugin.settings.azureRoutingMode === 'deployment-based'
            && capabilityChoice(this.plugin, 'embeddings').mode === 'azure') {
            this.renderEmbeddingsDeployment();
        }
        this.azureCapabilityRows()?.renderCapability('visual-embeddings');
    }

    private renderEmbeddingsDeployment(): void {
        const az = this.plugin.t.settings.llm.azure;
        const field = resolveDeploymentField(this.plugin.settings, 'embeddings');
        if (field.source === 'capability') {
            this.renderDeploymentText('embeddings', az.embeddingsDeploymentDesc);
            return;
        }
        this.addAzureModelPicker(
            new Setting(this.containerEl).setName(az.embeddingsDeployment).setDesc(az.embeddingsDeploymentDesc),
            'embedding',
            () => this.plugin.settings.azureDeployments?.embeddings || '',
            (value) => { setDeploymentField(this.plugin.settings, 'embeddings', 'legacy', value); },
            az.embeddingModelPlaceholder,
        );
    }

    /** A deployment text field that edits whichever stored value is in effect. */
    private renderDeploymentText(
        id: DeploymentFieldId,
        desc: string,
        name: string = this.plugin.t.settings.llm.azure.deployment,
    ): Setting {
        const az = this.plugin.t.settings.llm.azure;
        const field = resolveDeploymentField(this.plugin.settings, id);
        return new Setting(this.containerEl)
            .setName(name)
            .setDesc(field.isOverride ? `${desc} ${az.overrideNote}`.trim() : desc)
            .addText(text => {
                text.setPlaceholder(this.plugin.t.settings.azureCapabilities.deploymentPlaceholder)
                    .setValue(field.value)
                    .onChange((value) => {
                        setDeploymentField(this.plugin.settings, id, field.source, value);
                        void this.plugin.saveSettings();
                    });
                if (field.isOverride) {
                    // Clearing an override puts the shared value back in effect: show it.
                    text.inputEl.addEventListener('blur', () => {
                        if (!resolveDeploymentField(this.plugin.settings, id).isOverride) this.settingTab.display();
                    });
                }
            });
    }

    private renderAzureTranscription(): void {
        const az = this.plugin.t.settings.llm.azure;
        this.renderGroupHeading(az.groupTranscription);
        this.azureCapabilityRows()?.renderCapability('transcription', { label: az.source, withDeployment: false });
        this.azureCapabilityRows()?.renderSpeechEndpoint();
        const whisper = this.renderDeploymentText('transcription', az.whisperDeploymentDesc, az.whisperDeployment);
        // Asked only when Whisper would be called; the stored value is kept either way.
        void usesWhisperDeployment(this.plugin).then(used => { if (!used) whisper.settingEl.hide(); });
        this.azureCapabilityRows()?.renderDiarization();
    }

    private renderAzureReadAloud(): void {
        const az = this.plugin.t.settings.llm.azure;
        this.renderGroupHeading(az.groupReadAloud);
        this.azureCapabilityRows()?.renderCapability('tts', { label: az.source, withDeployment: false });
        // The deployment name is sent as the model, so it shows in either routing mode.
        if (this.showsCapability('tts') && capabilityChoice(this.plugin, 'tts').mode === 'azure') {
            this.renderDeploymentText('tts', az.ttsDeploymentDesc);
        }
        const rows = this.azureCapabilityRows();
        rows?.renderLegacyNotice();
        rows?.renderSpeechRegion();
        rows?.renderVoicePicker();
    }

    private renderAzureWebSearch(): void {
        const az = this.plugin.t.settings.llm.azure;
        if (!this.showsCapability('websearch')) return;
        this.renderGroupHeading(az.groupWebSearch);
        this.azureCapabilityRows()?.renderCapability('websearch', { label: az.source, withDeployment: false });
        // With Claude as the main provider, web search uses the Claude deployment.
        if (this.plugin.settings.cloudServiceType === 'azure-openai'
            && capabilityChoice(this.plugin, 'websearch').mode === 'azure') {
            this.renderDeploymentText('websearch', '');
        }
    }

    private renderRoutingMode(): void {
        const az = this.plugin.t.settings.llm.azure;
        // Routing mode — deployment-based reveals named deployment fields.
        new Setting(this.containerEl)
            .setName(az.routingMode)
            .setDesc(az.routingModeDesc)
            .addDropdown(dropdown => dropdown
                .addOption('model-based', az.routingModel)
                .addOption('deployment-based', az.routingDeployment)
                .setValue(this.plugin.settings.azureRoutingMode)
                .onChange((value) => {
                    this.plugin.settings.azureRoutingMode = value as 'model-based' | 'deployment-based';
                    void this.plugin.saveSettings();
                    this.settingTab.display();
                }));
    }

    private renderClaudeGateway(): void {
        const az = this.plugin.t.settings.llm.azure;
        new Setting(this.containerEl)
            .setName(az.claudeViaGateway)
            .setDesc(az.claudeViaGatewayDesc)
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.azureClaudeViaOpenAIGateway)
                .onChange((value) => {
                    this.plugin.settings.azureClaudeViaOpenAIGateway = value;
                    void this.plugin.saveSettings();
                }));
    }

    private renderMaxConcurrent(): void {
        const az = this.plugin.t.settings.llm.azure;
        // Rate-limit pacing — Azure deployments ship with low default quotas;
        // pace request starts to stay under them. Defaults: 4 concurrent / 60 RPM.
        new Setting(this.containerEl)
            .setName(az.maxConcurrent)
            .setDesc(az.maxConcurrentDesc)
            .addText(text => text
                .setPlaceholder('4')
                .setValue(String(this.plugin.settings.azureMaxConcurrentRequests))
                .onChange((value) => {
                    const n = Math.floor(Number(value));
                    this.plugin.settings.azureMaxConcurrentRequests = Number.isFinite(n) ? Math.min(10, Math.max(1, n)) : 4;
                    void this.plugin.saveSettings();
                }));
    }

    private renderMaxRpm(): void {
        const az = this.plugin.t.settings.llm.azure;
        new Setting(this.containerEl)
            .setName(az.maxRpm)
            .setDesc(az.maxRpmDesc)
            .addText(text => text
                .setPlaceholder('60')
                .setValue(String(this.plugin.settings.azureMaxRpm))
                .onChange((value) => {
                    const n = Math.floor(Number(value));
                    this.plugin.settings.azureMaxRpm = Number.isFinite(n) ? Math.min(600, Math.max(1, n)) : 60;
                    void this.plugin.saveSettings();
                }));
    }

    /**
     * Per-deployment RPM editor (Phase 2): name→rpm rows. Numeric validation,
     * duplicate-name last-wins, delete-row. Add/delete re-render only the local
     * rows container (not the whole tab) so a freshly-added blank row survives.
     * Persists a clean `Record<string,number>` (blanks/invalid dropped).
     */
    private renderPerDeploymentRpmEditor(az: typeof this.plugin.t.settings.llm.azure): void {
        new Setting(this.containerEl)
            .setName(az.perDeploymentRpm)
            .setDesc(az.perDeploymentRpmDesc);

        // Live read-only summary so it's obvious each LISTED deployment paces at its
        // OWN ceiling (not the fallback above) — addresses the "everything's capped at
        // 60" misread where the fallback box looks like a global cap.
        const summaryEl = this.containerEl.createDiv({ cls: 'ai-organiser-azure-rpm-summary setting-item-description' });

        // Working model held in closure — survives add/delete re-renders of the
        // rows container without thrashing the persisted map on every keystroke.
        const rows: { name: string; rpm: string }[] = Object.entries(
            this.plugin.settings.azurePerDeploymentRpm,
        ).map(([name, rpm]) => ({ name, rpm: String(rpm) }));

        const rowsEl = this.containerEl.createDiv({ cls: 'ai-organiser-azure-rpm-rows' });

        // The deployments this config actually uses (computed once) — to flag any that
        // silently fall through to the fallback RPM because they aren't listed.
        const activeDeployments = this.collectActiveAzureDeployments();

        const renderSummary = (): void => {
            summaryEl.empty();
            const active = rows
                .map(r => ({ name: r.name.trim(), rpm: Math.floor(Number(r.rpm)) }))
                .filter(r => r.name && Number.isFinite(r.rpm) && r.rpm >= 1)
                .sort((a, b) => b.rpm - a.rpm);
            if (active.length === 0) {
                summaryEl.createDiv({ text: az.perDeploymentRpmActiveNone });
            } else {
                const line = summaryEl.createDiv();
                line.createSpan({ text: `${az.perDeploymentRpmActiveLabel} ` });
                line.createSpan({
                    cls: 'ai-organiser-azure-rpm-summary-list',
                    text: active.map(r => `${r.name} ${r.rpm}`).join(' · '),
                });
            }

            // Option 2: warn about ACTIVE deployments not listed → silently on the
            // fallback RPM. `latest-*` sentinels resolve to a concrete id at runtime
            // (which IS seeded), so they're excluded to avoid false positives.
            const listed = new Set(active.map(r => r.name.toLowerCase()));
            const missing = activeDeployments.filter(
                n => !n.toLowerCase().startsWith('latest-') && !listed.has(n.toLowerCase()),
            );
            if (missing.length > 0) {
                const warn = summaryEl.createDiv({ cls: 'ai-organiser-azure-rpm-missing' });
                warn.createSpan({
                    text: `${az.perDeploymentRpmMissingWarning.replace('{rpm}', String(this.plugin.settings.azureMaxRpm))} `,
                });
                warn.createSpan({ cls: 'ai-organiser-azure-rpm-summary-list', text: missing.join(' · ') });
            }
        };

        const persist = (): void => {
            const map: Record<string, number> = {};
            for (const r of rows) {
                const name = r.name.trim();
                const n = Math.floor(Number(r.rpm));
                // Duplicate names: last entry wins. Blank/invalid: dropped.
                if (name && Number.isFinite(n) && n >= 1) map[name] = n;
            }
            this.plugin.settings.azurePerDeploymentRpm = map;
            void this.plugin.saveSettings();
            renderSummary();
        };

        const renderRows = (): void => {
            rowsEl.empty();
            rows.forEach((row, i) => {
                const setting = new Setting(rowsEl)
                    .addText(text => text
                        .setPlaceholder(az.perDeploymentRpmNamePlaceholder)
                        .setValue(row.name)
                        .onChange((value) => { row.name = value; persist(); }))
                    .addText(text => {
                        text.setPlaceholder(az.perDeploymentRpmValuePlaceholder)
                            .setValue(row.rpm)
                            .onChange((value) => { row.rpm = value; persist(); });
                        text.inputEl.type = 'number';
                        text.inputEl.min = '1';
                        return text;
                    })
                    .addExtraButton(btn => btn
                        .setIcon('trash-2')
                        .setTooltip(az.perDeploymentRpmRemove)
                        .onClick(() => { rows.splice(i, 1); persist(); renderRows(); }));
                setting.settingEl.addClass('ai-organiser-azure-rpm-row');
            });
            new Setting(rowsEl)
                .addButton(btn => btn
                    .setIcon('plus')
                    .setButtonText(az.perDeploymentRpmAdd)
                    .onClick(() => { rows.push({ name: '', rpm: '' }); renderRows(); }));
        };

        renderSummary();
        renderRows();
    }

    /** The deployment/model identities this Azure config actually fires requests at —
     *  main model, embeddings, Whisper, GPT, fast-tier, per-task overrides, and any
     *  per-capability Azure deployment. Deduped case-insensitively. Used to flag a
     *  deployment that silently falls through to the fallback RPM (not listed). */
    private collectActiveAzureDeployments(): string[] {
        const s = this.plugin.settings;
        const out: string[] = [];
        const push = (v: unknown): void => { if (typeof v === 'string' && v.trim()) out.push(v.trim()); };
        push(s.cloudModel);
        push(s.azureWhisperDeployment);
        push(s.azureGPTModel);
        push(s.azureFastModel?.openai);
        push(s.azureFastModel?.claude);
        // Only deployments the per-deployment PACER governs are "active" here. Embeddings
        // run through the cap-1 embedding queue (not the pacer), so an RPM override is a
        // no-op — excluding the embedding model + the taskModels.embeddings entry avoids a
        // false "not listed" warning for it.
        if (s.taskModels) {
            for (const [k, v] of Object.entries(s.taskModels)) {
                if (k === 'embeddings') continue;
                push(v);
            }
        }
        if (s.azureCapabilities) {
            for (const [id, cap] of Object.entries(s.azureCapabilities)) {
                if (id === 'embeddings') continue;
                if (cap && cap.mode === 'azure') push(cap.deployment);
            }
        }
        const seen = new Set<string>();
        const dedup: string[] = [];
        for (const n of out) {
            const k = n.toLowerCase();
            if (!seen.has(k)) { seen.add(k); dedup.push(n); }
        }
        return dedup;
    }

    /** Render a live Azure test report as a per-surface result list. */
    private renderAzureTestReport(
        container: HTMLElement,
        report: import('../../services/azure/azureConnectionTest').AzureTestReport,
    ): void {
        const az = this.plugin.t.settings.llm.azure;
        container.empty();

        if (!report.preflightOk) {
            container.createDiv({
                cls: 'ai-organiser-azure-test-row error',
                text: `✗ ${az.configInvalid} ${report.preflightErrors.join('; ')}`,
            });
            return;
        }

        container.createEl('h4', { text: az.liveTestHeading });
        const labels: Record<string, string> = {
            'azure-claude': az.surfaceClaude,
            'azure-openai-chat': az.surfaceOpenAIChat,
            'azure-openai-embeddings': az.surfaceEmbeddings,
            'azure-openai-whisper': az.surfaceWhisper,
            'azure-tts': az.surfaceTts,
            'azure-websearch': az.surfaceWebsearch,
            'azure-speech-tts': az.surfaceSpeechTts,
            'azure-speech-stt': az.surfaceSpeechStt,
        };
        const mainChatSurface = this.plugin.settings.cloudServiceType === 'azure-openai' ? 'azure-openai-chat' : 'azure-claude';
        for (const s of report.surfaces) {
            const label = s.surface === mainChatSurface ? az.chatTarget : labels[s.surface] ?? s.surface;
            let called = s.target && s.deployment
                ? az.targetDeployment.replace('{model}', s.target).replace('{deployment}', s.deployment)
                : s.target;
            if (called && s.capabilityModel) {
                called = az.targetModel.replace('{target}', called).replace('{model}', s.capabilityModel);
            }
            container.createDiv({
                cls: `ai-organiser-azure-test-row ${s.ok ? 'success' : 'error'}`,
                text: `${s.ok ? '✓' : '✗'} ${label}: ${called ? `${called} — ` : ''}${s.message}`,
            });
        }

        // A failed check against an API Management gateway left on the defaults is
        // the common first-run failure — point at the one-click fix right here.
        if (report.surfaces.some(r => !r.ok) && adviseGatewaySettings(this.plugin.settings).length > 0) {
            const hint = container.createDiv({ cls: 'ai-organiser-azure-test-row' });
            hint.createSpan({ text: `${az.gatewayAdviceTestHint} ` });
            new ButtonComponent(hint)
                .setButtonText(az.gatewayAdviceApply)
                .onClick(() => { void this.applyGatewayAdvice(); });
        }
    }

    private gatewayFixLabel(fix: GatewayFix): string {
        const az = this.plugin.t.settings.llm.azure;
        switch (fix) {
            case 'routing': return az.gatewayFixRouting;
            case 'claude-gateway': return az.gatewayFixClaude;
            case 'chat-deployment': return az.gatewayFixChatDeployment;
            case 'embeddings-deployment': return az.gatewayFixEmbeddingsDeployment;
        }
    }

    /** One-click apply of the API Management gateway recommendations. */
    private async applyGatewayAdvice(): Promise<void> {
        applyGatewayFixes(this.plugin.settings);
        await this.plugin.saveSettings();
        new Notice(this.plugin.t.settings.llm.azure.gatewayAdviceApplied);
        this.settingTab.display();
    }

    /**
     * Advice, not automation: when the OpenAI endpoint is an `*.azure-api.net`
     * gateway and the settings are still at the defaults that break behind one,
     * list the recommended changes with an apply button (and a dismiss, for a
     * gateway that already works the way it is).
     */
    private renderGatewayAdviceBanner(): void {
        const s = this.plugin.settings;
        if (s.azureGatewayAdviceDismissed) return;
        const fixes = adviseGatewaySettings(s);
        if (fixes.length === 0) return;
        const az = this.plugin.t.settings.llm.azure;

        const box = this.containerEl.createDiv({ cls: 'ai-organiser-azure-banner ai-organiser-azure-gateway-advice' });
        box.createEl('strong', { text: az.gatewayAdviceTitle });
        box.createEl('p', { text: az.gatewayAdviceIntro });
        const list = box.createEl('ul');
        for (const fix of fixes) list.createEl('li', { text: this.gatewayFixLabel(fix) });
        const actions = box.createDiv({ cls: 'ai-organiser-azure-gateway-actions' });
        new ButtonComponent(actions)
            .setButtonText(az.gatewayAdviceApply)
            .setCta()
            .onClick(() => { void this.applyGatewayAdvice(); });
        new ButtonComponent(actions)
            .setButtonText(az.gatewayAdviceDismiss)
            .onClick(() => {
                s.azureGatewayAdviceDismissed = true;
                void this.plugin.saveSettings();
                this.settingTab.display();
            });
    }

    private renderServiceType(): void {
        if (!this.plugin.settings.serviceType) {
            this.plugin.settings.serviceType = 'cloud';
        }
        new Setting(this.containerEl)
            .setName(this.plugin.t.settings.llm.serviceType)
            .setDesc(this.plugin.t.settings.llm.serviceTypeDesc)
            .addDropdown(dropdown =>
                dropdown
                    .addOptions({
                        'local': this.plugin.t.dropdowns.localLLM,
                        'cloud': this.plugin.t.dropdowns.cloudService
                    })
                    .setValue(this.plugin.settings.serviceType)
                    .onChange((value) => {
                        this.plugin.settings.serviceType = value as 'local' | 'cloud';
                        void this.plugin.saveSettings();
                        this.settingTab.display();
                    })
            );

    }

    private renderProviderDropdown(): void {
        // In streamlined Azure mode the azure-claude/azure-openai choice lives
        // in the Chat group — suppress the redundant full dropdown here.
        if (!this.isStreamlinedAzure()) {
            new Setting(this.containerEl)
                .setName(this.plugin.t.settings.llm.cloudProvider)
                .setDesc(this.plugin.t.settings.llm.cloudProviderDesc)
                .addDropdown(dropdown =>
                    dropdown
                        .addOptions(this.getProviderOptions())
                        .setValue(this.plugin.settings.cloudServiceType)
                        .onChange((value) => {
                            const oldType = this.plugin.settings.cloudServiceType;
                            const newType = value as typeof this.plugin.settings.cloudServiceType;

                            // Initialize providerSettings if needed
                            if (!this.plugin.settings.providerSettings) {
                                this.plugin.settings.providerSettings = {};
                            }

                            // Save current API key and model to provider-specific storage before switching
                            if (!this.plugin.settings.providerSettings[oldType]) {
                                this.plugin.settings.providerSettings[oldType] = {};
                            }
                            const secretStorage = this.plugin.secretStorageService;
                            const oldSecretId = PROVIDER_TO_SECRET_ID[oldType];
                            const shouldPersistPlainKey = !secretStorage.isAvailable() || !oldSecretId;

                            if (this.plugin.settings.cloudApiKey && shouldPersistPlainKey) {
                                this.plugin.settings.providerSettings[oldType].apiKey = this.plugin.settings.cloudApiKey;
                            }
                            if (this.plugin.settings.cloudModel) {
                                this.plugin.settings.providerSettings[oldType].model = this.plugin.settings.cloudModel;
                            }

                            this.plugin.settings.cloudServiceType = newType;

                            // Restore API key and model for the new provider (if previously saved)
                            const savedSettings = this.plugin.settings.providerSettings[newType];
                            const newSecretId = PROVIDER_TO_SECRET_ID[newType];
                            if (!secretStorage.isAvailable() || !newSecretId) {
                                if (savedSettings?.apiKey) {
                                    this.plugin.settings.cloudApiKey = savedSettings.apiKey;
                                } else {
                                    this.plugin.settings.cloudApiKey = '';
                                }
                            } else {
                                this.plugin.settings.cloudApiKey = '';
                            }

                            this.plugin.settings.cloudEndpoint = PROVIDER_ENDPOINT[newType];

                            // Restore saved model or use default
                            if (savedSettings?.model) {
                                this.plugin.settings.cloudModel = savedSettings.model;
                            } else {
                                this.plugin.settings.cloudModel = PROVIDER_DEFAULT_MODEL[newType] || PROVIDER_DEFAULT_MODEL.openai;
                            }

                            // Picking a NON-Azure provider exits Azure-first mode so the
                            // two never diverge (else the load-time reconcile would flip
                            // the provider back to Azure and fight the user's choice).
                            if (this.plugin.settings.azureFirstMode && !newType.startsWith('azure')) {
                                this.plugin.settings.azureFirstMode = false;
                            }

                            void this.plugin.saveSettings();
                            this.settingTab.display();
                        })
                );
        }
    }

    private getProviderOptions(): Record<string, string> {
        return buildProviderOptions(this.plugin.t.dropdowns);
    }

    private displayLocalSettings(): void {
        new Setting(this.containerEl)
            .setName(this.plugin.t.settings.llm.localEndpoint)
            .setDesc(this.plugin.t.settings.llm.localEndpointDesc)
            .addText(text => {
                const endpointPlaceholder = 'http://localhost:11434/v1/chat/completions';
                return text
                    .setPlaceholder(endpointPlaceholder)
                    .setValue(this.plugin.settings.localEndpoint)
                    .onChange((value) => {
                        this.plugin.settings.localEndpoint = value;
                        void this.plugin.saveSettings();

                        // Refresh the settings to update the model dropdown
                        this.settingTab.display();
                    });
            });

        new Setting(this.containerEl)
            .setName(this.plugin.t.settings.llm.modelName)
            .setDesc(this.plugin.t.settings.llm.modelNameDesc)
            .addText(text => text
                .setPlaceholder('Model name (e.g., mistral, llama2, GPT-3.5-turbo)')
                .setValue(this.plugin.settings.localModel)
                .onChange((value) => {
                    this.plugin.settings.localModel = value;
                    void this.plugin.saveSettings();
                }));

        // Add a tips section about common local LLM tools
        const tipsEl = this.containerEl.createEl('div', {
            cls: 'ai-organiser-tips-block'
        });

        tipsEl.createEl('h3', { text: this.plugin.t.settings.llm.tipsPopularTools });

        const tipsList = tipsEl.createEl('ul');
        tipsList.createEl('li', { text: `${this.plugin.t.dropdowns.ollama}: http://localhost:11434/v1/chat/completions` });
        tipsList.createEl('li', { text: `${this.plugin.t.dropdowns.localai}: http://localhost:8080/v1/chat/completions` });
        tipsList.createEl('li', { text: `${this.plugin.t.dropdowns.lmStudio}: http://localhost:1234/v1/chat/completions` });
        tipsList.createEl('li', { text: `${this.plugin.t.dropdowns.jan}: http://localhost:1337/v1/chat/completions` });
        tipsList.createEl('li', { text: `${this.plugin.t.dropdowns.koboldcpp}: http://localhost:5001/v1/chat/completions` });

        // Style the tips block
        tipsEl.setCssProps({ '--bg': 'rgba(100, 100, 100, 0.1)' }); tipsEl.addClass('ai-organiser-bg-custom');
        tipsEl.setCssProps({ '--pad': '8px 12px' }); tipsEl.addClass('ai-organiser-pad-custom');
        tipsEl.addClass('ai-organiser-rounded');
        tipsEl.addClass('ai-organiser-mb-16');
        tipsEl.addClass('ai-organiser-text-ui-small');

        this.createTestButton();
    }

    private createTestButton(): void {
        const testContainer = this.containerEl.createDiv('ai-organiser-connection-test-container');

        const testSetting = new Setting(testContainer)
            .setName(this.plugin.t.settings.llm.connectionTest)
            .setDesc(this.plugin.t.settings.llm.connectionTestDesc);

        const buttonContainer = testSetting.settingEl.createDiv('setting-item-control');
        const button = new ButtonComponent(buttonContainer)
            .setButtonText(this.plugin.t.settings.llm.testConnection)
            .onClick(async () => {
                // Disable button during test
                button.setButtonText(this.plugin.t.settings.llm.testing);
                button.setDisabled(true);

                // Clear previous status
                if (this.statusContainer) {
                    this.statusContainer.addClass('ai-organiser-block');
                    this.statusEl.textContent = '';
                    this.statusEl.className = '';
                }

                try {
                    const testResult = await this.plugin.llmService.testConnection();

                    if (testResult.result === ConnectionTestResult.Success) {
                        this.setStatusMessage(this.plugin.t.settings.llm.connectionSuccessful, 'success');
                    } else {
                        this.setStatusMessage(`${this.plugin.t.settings.llm.connectionFailed}: ${testResult.error?.message || 'Unknown error'}`, 'error');
                    }
                } catch (error) {
                    this.setStatusMessage(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`, 'error');
                } finally {
                    // Re-enable button
                    button.setButtonText(this.plugin.t.settings.llm.testConnection);
                    button.setDisabled(false);
                }
            });

        this.statusContainer = testContainer.createDiv('ai-organiser-connection-test-status');
        this.statusEl = this.statusContainer.createSpan();

        // Hide status container initially
        if (this.statusContainer) {
            this.statusContainer.addClass('ai-organiser-hidden');
        }
    }

    // Predefined model lists for providers with known models
    // Model lists are now centralized in modelRegistry.ts (DRY/SOLID)
    // See: src/services/adapters/modelRegistry.ts

    private displayCloudSettings(): void {
        const serviceType = this.plugin.settings.cloudServiceType;

        // Azure providers are configured ENTIRELY via the Azure section (its own
        // key, endpoints, models, and live connection test). The generic cloud
        // config below (API endpoint / key / model / generic test) doesn't apply
        // to Azure — its endpoint lives in the Azure fields, so the generic test
        // fails with "API endpoint is not configured". Suppress it here. Provider
        // SWITCHING still works via the cloud-provider dropdown in
        // createServiceTypeDropdown (shown when the "use a different provider"
        // escape hatch is expanded) — pick a non-Azure provider and this generic
        // config renders for it.
        if (isAzureMode(this.plugin.settings)) {
            // The generic cloud config is suppressed in Azure mode, but the
            // capability banner MUST still render — it's the honest list of what
            // has NO Azure path and needs a separate key (YouTube + audio
            // narration/podcast via Gemini). Without this the banner was dead
            // code in Azure mode and the gaps were silent.
            this.renderProviderCapabilityBanner();
            return;
        }

        // Getting Started info box — suppressed in streamlined Azure mode
        // (the Azure section already owns the provider guidance).
        if (!this.isStreamlinedAzure()) {
            this.renderGettingStartedBox(serviceType);
        }

        const apiKeyPlaceholder =
            this.plugin.settings.cloudServiceType === 'openai' ? 'sk-...' :
            this.plugin.settings.cloudServiceType === 'gemini' ? 'AIza...' :
            this.plugin.settings.cloudServiceType === 'deepseek' ? 'deepseek-...' :
            this.plugin.settings.cloudServiceType === 'aliyun' ? 'sk-...' :
            this.plugin.settings.cloudServiceType === 'claude' ? 'sk-ant-...' :
            this.plugin.settings.cloudServiceType === 'groq' ? 'gsk_...' :
            this.plugin.settings.cloudServiceType === 'openrouter' ? 'sk-or-...' :
            this.plugin.settings.cloudServiceType === 'bedrock' ? 'aws-credentials' :
            this.plugin.settings.cloudServiceType === 'requesty' ? 'rq-...' :
            this.plugin.settings.cloudServiceType === 'cohere' ? 'co-...' :
            this.plugin.settings.cloudServiceType === 'grok' ? 'grok-...' :
            this.plugin.settings.cloudServiceType === 'mistral' ? 'mist-...' :
            this.plugin.settings.cloudServiceType === 'openai-compatible' ? 'your-api-key' :
            'your-api-key';

        const secretId = PROVIDER_TO_SECRET_ID[serviceType];
        const secretStorageAvailable = this.plugin.secretStorageService.isAvailable();

        if (secretId && secretStorageAvailable) {
            this.renderApiKeyField({
                name: this.plugin.t.settings.llm.apiKey,
                desc: this.plugin.t.settings.llm.apiKeyDesc,
                secretId,
                currentValue: this.plugin.settings.cloudApiKey,
                placeholder: apiKeyPlaceholder,
                onChange: (value) => {
                    this.plugin.settings.cloudApiKey = value;
                    void this.plugin.saveSettings();
                }
            });
        } else {
            new Setting(this.containerEl)
                .setName(this.plugin.t.settings.llm.apiKey)
                .setDesc(this.plugin.t.settings.llm.apiKeyDesc)
                .addText(text => {
                    const currentKey = this.plugin.settings.cloudApiKey || '';
                    const maskedKey = currentKey && currentKey.length > 6
                        ? currentKey.substring(0, 6) + '*'.repeat(Math.min(20, currentKey.length - 6))
                        : currentKey;

                    text.setPlaceholder(apiKeyPlaceholder)
                        .setValue(maskedKey)
                        .onChange((value) => {
                            if (value !== maskedKey) {
                                this.plugin.settings.cloudApiKey = value;
                                void this.plugin.saveSettings();
                            }
                        });

                    text.inputEl.type = 'password';
                    return text;
                });
        }

// For providers with known models (from centralized registry), show a dropdown
        const providerModels = getProviderModels(serviceType);
        const hasModels = hasModelList(serviceType);

        if (hasModels) {
            const models = providerModels;
            const defaultModel = PROVIDER_DEFAULT_MODEL[serviceType];

            // Merge any live-fetched models into the static list (live wins
            // on label; new IDs are appended). Lets users pick models that
            // shipped after the bundled registry snapshot.
            const cachedLive = getCachedModels(serviceType);
            const mergedModels: Record<string, string> = { ...models };
            if (cachedLive) {
                for (const m of cachedLive) {
                    if (!(m.id in mergedModels)) {
                        mergedModels[m.id] = m.label ?? m.id;
                    } else if (m.label) {
                        mergedModels[m.id] = m.label;
                    }
                }
            }

            new Setting(this.containerEl)
                .setName(this.plugin.t.settings.llm.modelName)
                .setDesc(this.plugin.t.settings.llm.modelNameDesc
                    + (cachedLive ? ` (${cachedLive.length} live models cached)` : ''))
                .addDropdown(dropdown => {
                    for (const [modelId, displayName] of Object.entries(mergedModels)) {
                        dropdown.addOption(modelId, displayName);
                    }
                    const currentModel = this.plugin.settings.cloudModel;
                    if (mergedModels[currentModel]) {
                        dropdown.setValue(currentModel);
                    } else {
                        dropdown.setValue(defaultModel);
                    }
                    dropdown.onChange((value) => {
                        this.plugin.settings.cloudModel = value;
                        void this.plugin.saveSettings();
                        this.settingTab.display();
                    });
                });

            // "Refresh models from provider" — fetches live catalog, merges,
            // and re-renders. Only shown for providers whose API exposes a
            // /models endpoint (Claude, OpenAI, Gemini, Groq, DeepSeek,
            // OpenRouter).
            if (providerSupportsLiveFetch(serviceType)) {
                new Setting(this.containerEl)
                    .setName('Refresh models from provider')
                    .setDesc('Fetch the live catalog from the provider\'s API. Newer models published after this plugin shipped will appear in the dropdown. `latest-*` selections pick up new releases automatically on the next refresh.')
                    .addButton(btn => btn
                        .setButtonText('Refresh now')
                        .onClick(async () => {
                            btn.setDisabled(true).setButtonText('Fetching…');
                            try {
                                const key = this.plugin.settings.cloudApiKey;
                                const live = await getLiveModels(serviceType, key, { forceRefresh: true });
                                new Notice(`Fetched ${live.length} models from ${serviceType}.`, 4000);
                                this.settingTab.display();
                            } catch (err) {
                                const msg = err instanceof Error ? err.message : String(err);
                                new Notice(`Model refresh failed: ${msg}`, 6000);
                            } finally {
                                btn.setDisabled(false).setButtonText('Refresh now');
                            }
                        }));
            }
        } else {
            // For other providers, use text input with placeholder hints
            // Use centralized default model placeholders

            new Setting(this.containerEl)
                .setName(this.plugin.t.settings.llm.modelName)
                .setDesc(this.plugin.t.settings.llm.modelNameDesc)
                .addText(text => text
                    .setPlaceholder(PROVIDER_DEFAULT_MODEL[serviceType] || 'model-name')
                    .setValue(this.plugin.settings.cloudModel)
                    .onChange((value) => {
                        this.plugin.settings.cloudModel = value;
                        void this.plugin.saveSettings();
                    }));
        }

        if (!endpointIsAdvanced(serviceType)) this.renderCloudEndpoint();
        this.renderProviderCapabilityBanner();

        this.createTestButton();
    }

    private renderCloudEndpoint(): void {
        const serviceType = this.plugin.settings.cloudServiceType;
        new Setting(this.containerEl)
            .setName(this.plugin.t.settings.llm.apiEndpoint)
            .setDesc(this.plugin.t.settings.llm.apiEndpointDesc)
            .addText(text => {
                const placeholder = this.plugin.settings.cloudEndpoint || PROVIDER_ENDPOINT[serviceType] ||
                    (serviceType === 'openai-compatible' ? 'http://your-api-endpoint/v1/chat/completions' : '');

                text.setPlaceholder(placeholder)
                    .setValue(this.plugin.settings.cloudEndpoint);

                text.onChange((value) => {
                    this.plugin.settings.cloudEndpoint = value;
                    void this.plugin.saveSettings();
                });

                return text;
            });
    }

    /** Offered only for Claude models that support adaptive thinking (see `showsThinkingMode`). */
    private renderThinkingMode(): void {
        new Setting(this.containerEl)
            .setName(this.plugin.t.settings.llm.thinkingMode)
            .setDesc(this.plugin.t.settings.llm.thinkingModeDesc)
            .addDropdown(dropdown =>
                dropdown
                    .addOption('adaptive', this.plugin.t.settings.llm.thinkingAdaptive)
                    .addOption('standard', this.plugin.t.settings.llm.thinkingStandard)
                    .setValue(this.plugin.settings.claudeThinkingMode)
                    .onChange((value) => {
                        this.plugin.settings.claudeThinkingMode = value as 'standard' | 'adaptive';
                        void this.plugin.saveSettings();
                    })
            );
    }

    private renderGettingStartedBox(serviceType: string): void {
        const t = this.plugin.t.settings.llm.gettingStarted;
        const boxEl = this.containerEl.createDiv({ cls: 'ai-organiser-settings-info' });

        boxEl.createEl('strong', { text: t.title });

        // Provider-specific API key guidance
        if (serviceType === 'claude') {
            const claudeP = boxEl.createEl('p', { cls: 'setting-item-description' });
            claudeP.appendText(t.claudeDesc + ' ');
            claudeP.createEl('a', {
                text: t.apiKeyLink,
                href: 'https://console.anthropic.com/',
            });
        }

        // "Other providers work too" message
        boxEl.createEl('p', {
            text: t.otherProviders,
            cls: 'setting-item-description'
        });

        // Local recommendation
        this.renderLocalRecommendation(boxEl);
    }

    private renderLocalRecommendation(parentEl: HTMLElement): void {
        const t = this.plugin.t.settings.llm.localRecommendation;
        const plugin = this.plugin;

        const localDiv = parentEl.createDiv();
        localDiv.addClass('ai-organiser-mt-8');
        localDiv.addClass('ai-organiser-border-t');
        localDiv.addClass('ai-organiser-pt-4');

        localDiv.createEl('strong', { text: t.title });
        localDiv.createEl('p', {
            text: t.description,
            cls: 'setting-item-description'
        });

        const wizardBtn = localDiv.createEl('button', { text: t.setupWizard });
        wizardBtn.classList.add('mod-cta');
        wizardBtn.addClass('ai-organiser-mt-4');
        wizardBtn.addEventListener('click', () => { void (async () => {
            const { LocalSetupWizardModal } = await import('../modals/LocalSetupWizardModal');
            new LocalSetupWizardModal(plugin.app, plugin).open();
        })(); });
    }

    private renderProviderCapabilityBanner(): void {
        const provider = this.plugin.settings.cloudServiceType;
        const t = this.plugin.t.settings.llm.providerCapabilities;

        const caps = {
            youtube: ['gemini'],
            audio: ['openai', 'groq'],
            pdf: ['claude', 'gemini'],
            embeddings: ['openai', 'gemini', 'cohere', 'voyage', 'openrouter', 'ollama']
        };

        const missing: string[] = [];
        if (provider.startsWith('azure')) {
            // In Azure mode, audio (Whisper), PDF (Azure Claude) and embeddings
            // (Azure OpenAI) are auto-handled by Azure. YouTube AND audio
            // narration/podcast (Gemini TTS) have no Azure path — both need a
            // separate Gemini key (narration TTS is "coming soon" on Azure).
            missing.push(t.youtube);
            missing.push(t.narration);
        } else {
            if (!caps.youtube.includes(provider)) missing.push(t.youtube);
            if (!caps.audio.includes(provider)) missing.push(t.audio);
            if (!caps.pdf.includes(provider)) missing.push(t.pdf);
            if (provider === 'claude') missing.push(t.embeddings);
            // Narration TTS is Gemini-only — any non-gemini main provider needs a key.
            if (provider !== 'gemini') missing.push(t.narration);
        }

        if (missing.length === 0) return;

        const bannerEl = this.containerEl.createDiv({ cls: 'ai-organiser-settings-info' });
        bannerEl.createEl('strong', { text: t.title });
        const list = bannerEl.createEl('ul');
        list.setCssProps({ '--margin': '4px 0 0 0' }); list.addClass('ai-organiser-margin-custom');
        list.setCssProps({ '--pl': '20px' }); list.addClass('ai-organiser-pl-custom');
        for (const item of missing) {
            list.createEl('li', { text: item, cls: 'setting-item-description' });
        }
    }

    private setStatusMessage(message: string, status: 'success' | 'error'): void {
        if (!this.statusContainer || !this.statusEl) return;

        this.statusContainer.addClass('ai-organiser-block');
        this.statusContainer.className = 'ai-organiser-connection-test-status ' + status;
        this.statusEl.textContent = message;
    }

    private async checkLocalService(endpoint: string): Promise<void> {
        const baseUrl = endpoint.trim().replace(/\/$/, '').replace(/\/v1\/chat\/completions$/, '');
        let checkUrl = `${baseUrl}/v1/models`;  // Default check URL for most services

        try {
            const response = await requestUrl({
                url: checkUrl,
                method: 'GET',
                headers: { 'Content-Type': 'application/json' }
            });

            if (response.status >= 400) {
                new Notice(this.plugin.t.messages.localServiceNotRunning, 10000);
            }
        } catch {
            new Notice(this.plugin.t.messages.localServiceNotAvailable, 10000);
        }
    }

    private hasPlainTextKeys(): boolean {
        const settings = this.plugin.settings;
        if (settings.cloudApiKey ||
            settings.embeddingApiKey ||
            settings.youtubeGeminiApiKey ||
            settings.pdfApiKey ||
            settings.audioTranscriptionApiKey ||
            settings.azureSpeechApiKey) {
            return true;
        }

        if (settings.providerSettings) {
            return Object.values(settings.providerSettings)
                .some((config) => !!config?.apiKey);
        }

        return false;
    }

    private renderSecretStorageMigrationNotice(): void {
        const secretStorage = this.plugin.secretStorageService;
        const t = this.plugin.t.settings.secretStorage;

        if (!secretStorage.isAvailable() || this.plugin.settings.secretStorageMigrated || !this.hasPlainTextKeys()) {
            return;
        }

        new Setting(this.containerEl)
            .setName(t.migrationTitle)
            .setDesc(t.migrationDesc)
            .addButton(btn => btn
                .setButtonText(t.migrateNow)
                .setCta()
                .onClick(async () => {
                    const confirmed = await new Promise<boolean>((resolve) => {
                        const modal = new MigrationConfirmModal(this.plugin.app, this.plugin, resolve);
                        modal.open();
                    });

                    if (!confirmed) {
                        new Notice(t.migrationDeclined);
                        return;
                    }

                    const result = await secretStorage.migrateFromPlainText();
                    if (result.migrated) {
                        new Notice(t.migrationComplete);
                        this.settingTab.display();
                    } else {
                        new Notice(result.reason || this.plugin.t.messages.unknownError || 'Migration failed');
                    }
                }));
    }
}
