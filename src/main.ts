import { addIcon, App, debounce, loadPdfJs, MarkdownView, Notice, Platform, Plugin, TFile, TFolder, type EventRef } from 'obsidian';
import {
    ConnectionTestError,
    ConnectionTestResult,
    SummarizableLLMService,
    LocalLLMService,
    CloudLLMService,
    LLMResponse,
    SecretStorageService,
    BasesService
} from './services';
import { buildTaxonomyTagPrompt } from './services/prompts/tagPrompts';
import { VisionService } from './services/visionService';
import { PdfService } from './services/pdfService';
import { DocumentExtractionService } from './services/documentExtractionService';
import { ConfirmationModal } from './ui/modals/ConfirmationModal';
import { SuggestionModal, SuggestionResult } from './ui/modals/SuggestionModal';
import { CommandPickerModal, buildCommandCategories } from './ui/modals/CommandPickerModal';
import { TagUtils, TagOperationResult, setGlobalDebugMode } from './utils/tagUtils';
import { logger } from './utils/logger';
import { registerCommands } from './commands/index';
import { isFeatureEnabled } from './services/featureService';
import { FEATURE_REGISTRY, type FeatureId } from './core/features';
import { DEFAULT_SETTINGS, getConfigFolderFullPath, getNotebookLMExportFullPath, getPluginManagedFolders, migrateOldSettings } from './core/settings';
import { AIOrganiserSettingTab } from './ui/settings/AIOrganiserSettingTab';
import { EventHandlers } from './utils/eventHandlers';
import { TagNetworkManager } from './utils/tagNetworkUtils';
import { TagNetworkView, TAG_NETWORK_VIEW_TYPE } from './ui/views/TagNetworkView';
import { RelatedNotesView, RELATED_NOTES_VIEW_TYPE } from './ui/views/RelatedNotesView';
import { TagOperations } from './utils/tagOperations';
import { BatchProcessResult } from './utils/batchProcessor';
import { getTranslations } from './i18n';
import { ConfigurationService, CURRENT_PERSONA_SCHEMA_VERSION } from './services/configurationService';
import { VectorStoreService, IVectorStore } from './services/vector';
import { AttachmentLifecycleCoordinator } from './services/attachmentLifecycleCoordinator';
import { ALL_DOCUMENT_EXTENSIONS } from './core/constants';
import { IEmbeddingService, createEmbeddingServiceFromSettings } from './services/embeddings';
import { AdapterType } from './services/adapters';
import cloudEndpoints from './services/adapters/cloudEndpoints.json';
import { EMBEDDING_PROVIDER_TO_SECRET_ID, PLUGIN_SECRET_IDS } from './core/secretIds';
import { getAzureApiKey, resolveEndpoint } from './services/apiKeyHelpers';
import { isAzureMode } from './services/azure/endpointResolver';
import { ProviderProfile, resolveProviderProfile } from './services/providerProfile';
import { NullLLMService } from './services/llm/nullLLMService';
import { ForegroundGate } from './services/foregroundGate';
import { EmbeddingCooldown } from './services/embeddings/embeddingCooldown';
import { EmbeddingQueue, GenericEmbeddingQueue } from './services/vector/embeddingQueue';
import { PdfHandlePool } from './services/pdf/pdfHandlePool';
import { VisualIndexRepository } from './services/visualEmbedding/visualIndexRepository';
import { VisualIndexService } from './services/visualEmbedding/visualIndexService';
import { createVisualEmbedderProvider, createVisualEmbedBackend, type VisualEmbedderProvider } from './services/visualEmbedding/visualEmbedBackend';
import { VisualRetrievalService } from './services/visualEmbedding/visualRetrievalService';
import { selectVisualBackend, shouldAutoEnableVisualSearch } from './services/visualEmbedding/visualBackendResolver';
import type { VisualPageTask } from './services/visualEmbedding/types';
import { setAzurePacerPolicy, setDeploymentRpm, disposeAzurePacers } from './services/azure/azureRequestPacer';
import { resolveAzureTriageRoute } from './services/azure/azureTriageRouting';
import { SourcePackService } from './services/notebooklm/sourcePackService';
import { DEFAULT_PDF_CONFIG } from './services/notebooklm/types';
import type { SourcePackConfig } from './services/notebooklm/types';
import { buildFolderContext, FolderContext } from './utils/folderContextUtils';
import { resetBusyState, withBusyIndicator } from './utils/busyIndicator';
import { TaxonomyGuardrailService } from './services/taxonomyGuardrailService';
import { MermaidChangeDetector } from './services/mermaidChangeDetector';
import { NarrationJobRegistry } from './services/audioNarration/narrationJobRegistry';
import { findAllMermaidBlocks } from './utils/mermaidUtils';
import { mermaidStalenessGutterExtension } from './ui/editor/mermaidStalenessGutter';
import { enhanceAudioPlayersIn } from './ui/components/audioPlayerEnhancer';
import { NewsletterService, LAST_FETCH_DATA_KEY } from './services/newsletter/newsletterService';
import { showNewsletterFetchResultNotice } from './commands/newsletterCommands';
import { LongRunningOpController } from './services/longRunningOp/progressController';
import { computeSmartTagBudget } from './services/smartTagBudgets';
import { createTagProgressStatusBar } from './ui/components/TagProgressStatusBar';

export default class AIOrganiserPlugin extends Plugin {
    public settings = {...DEFAULT_SETTINGS};
    private lastEmbeddingConfig = {
        provider: DEFAULT_SETTINGS.embeddingProvider,
        model: DEFAULT_SETTINGS.embeddingModel,
        enabled: isFeatureEnabled(DEFAULT_SETTINGS, 'semantic-search'),
        allowLocalOnnx: DEFAULT_SETTINGS.enableLocalOnnxEmbeddings
    };
    public llmService: SummarizableLLMService;
    /** Dedicated Azure triage service for high-volume tagging, bound to the fast
     *  deployment (Phase 3). Lazily built, cached, and invalidated on every
     *  initializeLLMService re-init. Null when not Azure / no fast model. */
    private azureTriageService: CloudLLMService | null = null;
    /** Snapshot of the route the cached triage service was built for, so a
     *  settings change that alters the route rebuilds it. */
    private azureTriageRouteKey: string | null = null;
    /** Resolved, validated active-provider profile (D1 SSOT). Null pre-init. */
    public providerProfile: ProviderProfile | null = null;
    /** Listeners fired after `providerProfile` is recomputed (badge re-render, R2-M4). */
    private readonly profileChangeListeners = new Set<() => void>();
    /** Guards the one-time misconfigured-Azure Notice (re-armed when valid again). */
    private azureMisconfigNoticeShown = false;
    /** Monotonic init epoch — overlapping initializeLLMService calls: latest wins (H5). */
    private llmInitEpoch = 0;
    /** Long-lived coordination SSOTs (D0/D3/D4) — constructed once, live for the
     *  plugin lifetime. NEVER reconstructed in initializeLLMService. */
    public readonly foregroundGate = new ForegroundGate();
    public readonly embeddingCooldown = new EmbeddingCooldown();
    public embeddingQueue: EmbeddingQueue | null = null;
    /** Visual index metadata mismatch flag (C8) — set by the Phase-6 visual lane on load
     *  when the persisted index identity differs from the selected backend; the settings
     *  panel surfaces it as `needs-rebuild` and the lane blocks writes+search until rebuilt. */
    public visualIndexNeedsRebuild = false;
    // ── Visual-search lane (Phase 6) — lazily initialized, torn down on disable (C14) ──
    public visualRepository: VisualIndexRepository | null = null;
    public visualService: VisualIndexService | null = null;
    /** Phase 7: the visual lane's QUERY side (owns query embedding, C1). Consumed by
     *  RAG construction sites; null whenever the lane is down. */
    public visualRetrieval: VisualRetrievalService | null = null;
    private visualQueue: GenericEmbeddingQueue<VisualPageTask> | null = null;
    private visualPool: PdfHandlePool | null = null;
    private visualCooldown: EmbeddingCooldown | null = null;
    private visualEmbedderProvider: VisualEmbedderProvider | null = null;
    private visualNoteEventRefs: EventRef[] = [];
    private readonly visualNoteModifyTimers = new Map<string, number>();
    /** Logical user-facing LLM call count (D5), bumped via CloudLLMService.onCall. */
    public llmCallCounter = 0;
    public configService: ConfigurationService;
    public secretStorageService: SecretStorageService;
    public basesService: BasesService;
    public embeddingService: IEmbeddingService | null = null;
    public vectorStore: IVectorStore | null = null;
    public vectorStoreService: VectorStoreService | null = null;
    /** The single attachment-event ingress (azure-capability-completion-v2 C16); dispatches
     *  modify/delete/rename of non-markdown attachments to the registered index consumers. */
    public attachmentCoordinator: AttachmentLifecycleCoordinator | null = null;
    /** Per-attachment-path modify debounce timers (attachments fire rapid `modify` events). */
    private readonly attachmentModifyTimers = new Map<string, number>();
    public sourcePackService: SourcePackService | null = null;
    /** The settings tab instance — kept so `applyFeatureFlags` can await a re-render (FT-5). */
    public settingTab: AIOrganiserSettingTab | null = null;
    /** Single-flight guard: serialises feature-flag writes so two rapid toggles can't
     *  interleave saveSettings/teardown/re-render. The in-flight apply re-renders the tab
     *  at the end, so a dropped concurrent toggle is reflected correctly on that render. */
    private applyingFeatureFlags = false;
    private readonly eventHandlers: EventHandlers;
    private readonly tagNetworkManager: TagNetworkManager;
    private readonly tagOperations: TagOperations;
    public t = getTranslations(this.settings.interfaceLanguage);
    public busyStatusBarEl: HTMLElement | null = null;
    public notebookLMStatusBarEl: HTMLElement | null = null;
    /** Shared change detector — persists diagram snapshots across modal sessions (§4.4.2) */
    public mermaidChangeDetector = new MermaidChangeDetector();
    public narrationJobs = new NarrationJobRegistry();
    private newsletterFetchTimer: ReturnType<typeof setInterval> | null = null;
    private newsletterFetching = false;
    public newsletterLastFetchTime = 0;
    public newsletterSeenIds: string[] = [];
    /** First-time-per-session Deepgram diarization disclosure shown? Reset on plugin reload. */
    public diarizationDisclosureShownThisSession = false;
    /** Once-per-session "large file → Sync impact" advisory shown? Reset on plugin reload. */
    public diarizationLargeFileWarningShownThisSession = false;
    private lastNewsletterConfig = { enabled: false, autoFetch: false, intervalMins: 60 };
    private readonly mermaidNoticeRateLimit = new Map<string, number>();
    private readonly taxonomyGuardrailService: TaxonomyGuardrailService;
    /** Collector for novel disciplines discovered during batch tagging */
    private novelDisciplineCollector: Set<string> | null = null;

    // ── Lazy singletons for stateless services ──
    private _visionService: VisionService | null = null;
    private _pdfService: PdfService | null = null;
    private _documentExtractionService: DocumentExtractionService | null = null;

    get visionService(): VisionService {
        return this._visionService ??= new VisionService(this);
    }
    get pdfService(): PdfService {
        return this._pdfService ??= new PdfService(this.app);
    }
    get documentExtractionService(): DocumentExtractionService {
        return this._documentExtractionService ??= new DocumentExtractionService(this.app);
    }

    constructor(app: App, manifest: import('obsidian').PluginManifest) {
        super(app, manifest);
        this.llmService = new LocalLLMService({
            endpoint: DEFAULT_SETTINGS.localEndpoint,
            modelName: DEFAULT_SETTINGS.localModel,
            language: DEFAULT_SETTINGS.language
        }, app);
        this.configService = new ConfigurationService(app, getConfigFolderFullPath(DEFAULT_SETTINGS));
        this.secretStorageService = new SecretStorageService(app, this);
        this.basesService = new BasesService(app, this);
        this.eventHandlers = new EventHandlers(this);
        this.tagNetworkManager = new TagNetworkManager(app);
        this.tagOperations = new TagOperations(app);
        this.taxonomyGuardrailService = new TaxonomyGuardrailService(DEFAULT_SETTINGS.debugMode);
    }

    public async loadSettings(): Promise<void> {
        const oldSettings = await this.loadData();
        const migrated = migrateOldSettings(oldSettings);
        this.settings = Object.assign({}, DEFAULT_SETTINGS, migrated);
        this.t = getTranslations(this.settings.interfaceLanguage);
        this.lastEmbeddingConfig = {
            provider: this.settings.embeddingProvider,
            model: this.settings.embeddingModel,
            // FT-11: snapshot the FEATURE state (semantic-search absorbed the legacy
            // enableSemanticSearch master) so a feature toggle is detected as a change.
            enabled: isFeatureEnabled(this.settings, 'semantic-search'),
            // npm-audit-remediation Cluster 4 (audit H1 round 3): without this,
            // toggling enableLocalOnnxEmbeddings while embeddingProvider stays
            // 'local-onnx' unchanged would never trigger reinitialization —
            // "revoked" consent would leave the OLD, already-constructed
            // LocalOnnxEmbeddingService instance alive in memory.
            allowLocalOnnx: this.settings.enableLocalOnnxEmbeddings
        };
        try {
            this.newsletterLastFetchTime = oldSettings?.[LAST_FETCH_DATA_KEY] ?? 0;
        } catch { /* best-effort */ }
        this.lastNewsletterConfig = {
            // FT-11: snapshot the FEATURE state (newsletter absorbed newsletterEnabled).
            enabled: isFeatureEnabled(this.settings, 'newsletter'),
            autoFetch: this.settings.newsletterAutoFetch,
            intervalMins: this.settings.newsletterAutoFetchIntervalMins,
        };

        // Async secret-id migration (plan §9): the pure `migrateAzureSettings`
        // can't touch SecretStorage. Move any transient plaintext Azure key into
        // the keychain on load. Best-effort, never throws.
        await this.migrateAzureSecretOnLoad();
    }

    /**
     * One-time, forward-safe Azure secret migration (plan §9).
     *
     * The public repo never shipped a legacy Azure secret id, so there is nothing
     * to rename. The only real work is hardening: if a transient plaintext
     * `azureApiKey` is present and SecretStorage is available, the user just
     * typed it — persist it into the shared `AZURE_AI_FOUNDRY` secret (always
     * overwriting any stale stored value), clear the plaintext, and mark it
     * stored. Mirrors how other transient keys are moved into SecretStorage.
     * Endpoints/keys are never logged (plan §8).
     */
    private async migrateAzureSecretOnLoad(): Promise<void> {
        try {
            const plaintext = this.settings.azureApiKey?.trim();
            if (!plaintext) return;
            if (!this.secretStorageService.isAvailable()) return;

            // A non-empty transient plaintext key means the user just typed it —
            // that value is the authoritative user intent. ALWAYS write/overwrite
            // it into the keychain (a stale or wrong stored secret must not win),
            // then clear + flag so the plaintext never lingers in persisted settings.
            await this.secretStorageService.setSecret(PLUGIN_SECRET_IDS.AZURE_AI_FOUNDRY, plaintext);

            this.settings.azureApiKey = '';
            this.settings.azureKeyStored = true;
            // Persist via the central path so reinit + sanitization run. Never log the key.
            await this.saveSettings();
            logger.debug('Core', 'Cleared transient Azure key from settings (SecretStorage authoritative)');
        } catch (err) {
            logger.warn('Core', `Azure secret migration skipped: ${err instanceof Error ? err.message : 'unknown error'}`);
        }
    }

    public async saveSettings(): Promise<void> {
        const embeddingSettingsChanged =
            this.settings.embeddingProvider !== this.lastEmbeddingConfig.provider ||
            this.settings.embeddingModel !== this.lastEmbeddingConfig.model ||
            isFeatureEnabled(this.settings, 'semantic-search') !== this.lastEmbeddingConfig.enabled ||
            this.settings.enableLocalOnnxEmbeddings !== this.lastEmbeddingConfig.allowLocalOnnx;

        const newsletterSettingsChanged =
            isFeatureEnabled(this.settings, 'newsletter') !== this.lastNewsletterConfig.enabled ||
            this.settings.newsletterAutoFetch !== this.lastNewsletterConfig.autoFetch ||
            this.settings.newsletterAutoFetchIntervalMins !== this.lastNewsletterConfig.intervalMins;

        await this.saveData(this.settings);
        await this.initializeLLMService();

        if (embeddingSettingsChanged) {
            await this.initializeEmbeddingService();

            // Auto-rebuild index after embedding change clears it
            if (this.settings.autoIndexNewNotes && this.vectorStoreService && this.embeddingService) {
                logger.debug('Core', 'Embedding settings changed — auto-rebuilding index...');
                void this.vectorStoreService.rebuildVault().then(result => {
                    if (result.indexed > 0) {
                        new Notice(`Index rebuilt: ${result.indexed} notes indexed`);
                    }
                });
            }
        }

        this.lastEmbeddingConfig = {
            provider: this.settings.embeddingProvider,
            model: this.settings.embeddingModel,
            // FT-11: snapshot the FEATURE state (semantic-search absorbed the legacy
            // enableSemanticSearch master) so a feature toggle is detected as a change.
            enabled: isFeatureEnabled(this.settings, 'semantic-search'),
            allowLocalOnnx: this.settings.enableLocalOnnxEmbeddings
        };
        this.t = getTranslations(this.settings.interfaceLanguage);
        if (newsletterSettingsChanged) {
            this.startNewsletterScheduler();
        }
        this.lastNewsletterConfig = {
            // FT-11: snapshot the FEATURE state (newsletter absorbed newsletterEnabled).
            enabled: isFeatureEnabled(this.settings, 'newsletter'),
            autoFetch: this.settings.newsletterAutoFetch,
            intervalMins: this.settings.newsletterAutoFetchIntervalMins,
        };
    }

    /**
     * Apply a new feature-flag set from the Features settings UI (FT-5/FT-12).
     *
     * 1. Persist via the canonical `saveSettings` path (which also re-inits embeddings /
     *    restarts the newsletter scheduler on the now-changed feature state).
     * 2. On persistence failure restore the FULL pre-mutation snapshot — a toggle may have
     *    cascaded dependency changes (auto-enable requires / cascade-disable dependents),
     *    so reverting one flag would leave the cascade half-applied (Gemini-R9-G3).
     * 3. Tear down active background work for any feature turned OFF, immediately
     *    (error-boundaried per FT-12 — a throwing teardown must not block the reload Notice).
     * 4. `await` the settings re-render (Obsidian `display()` is async — no floating promise)
     *    then show the reload-to-apply Notice. Command/view registration is a load-time
     *    snapshot (FT-5) — only a reload fully (un)registers them.
     */
    public async applyFeatureFlags(newFlags: Partial<Record<FeatureId, boolean>>): Promise<void> {
        // Single-flight: ignore a concurrent toggle while a write is in progress — the
        // in-flight apply re-renders the tab at the end, reflecting the true persisted state.
        if (this.applyingFeatureFlags) return;
        this.applyingFeatureFlags = true;
        try {
            const prev = { ...this.settings.featureFlags };
            const turnedOff = FEATURE_REGISTRY.filter((f) =>
                isFeatureEnabled({ featureFlags: prev }, f.id) && !isFeatureEnabled({ featureFlags: newFlags }, f.id),
            ).map((f) => f.id);

            this.settings.featureFlags = newFlags;
            try {
                await this.saveSettings();
            } catch (err) {
                this.settings.featureFlags = prev; // full-snapshot revert (cascade-safe)
                logger.error('Core', 'Failed to persist feature flags — reverted', err);
                await this.settingTab?.render();
                new Notice(this.t.features.saveError, 6000);
                return;
            }

            for (const id of turnedOff) {
                try {
                    this.teardownFeature(id);
                } catch (err) {
                    logger.error('Core', `Feature teardown for '${id}' threw`, err);
                }
            }

            // C23: visual-search starts WITHOUT a reload — its lane is fully lazy (no
            // commands/views to register) and the on-enable backfill must run from the
            // consent panel's Enable action.
            const visualTurnedOn = !isFeatureEnabled({ featureFlags: prev }, 'visual-search')
                && isFeatureEnabled({ featureFlags: newFlags }, 'visual-search');
            if (visualTurnedOn) void this.initVisualLane();

            await this.settingTab?.render();
            new Notice(this.t.features.reloadNotice, 8000);
        } finally {
            this.applyingFeatureFlags = false;
        }
    }

    /**
     * Stop a feature's ACTIVE background work on toggle-off (FT-12). Only features with a
     * running service need one: `semantic-search` (vector store + file-event handlers +
     * related-notes view) and `newsletter` (scheduler interval). The exact inverse of the
     * feature's `onload` init; nulls the refs so the codebase's null-guards observe the
     * absence. Commands/views still need a reload to fully unregister (FT-5).
     */
    private teardownFeature(id: FeatureId): void {
        if (id === 'visual-search') {
            // C14: disabling visual search purges the WHOLE visual namespace (no orphaned
            // vectors). CA3: the consumer is unregistered BEFORE disposal inside.
            this.teardownVisualLane(/*purge*/ true);
        } else if (id === 'semantic-search') {
            if (this.vectorStoreService) {
                void this.vectorStoreService.dispose();
                this.vectorStore = null;
                this.vectorStoreService = null;
            }
            void this.embeddingService?.dispose();
            this.embeddingService = null;
            this.app.workspace.detachLeavesOfType(RELATED_NOTES_VIEW_TYPE);
        } else if (id === 'newsletter') {
            this.stopNewsletterScheduler();
        }
        // Other features own no active background work → reload-deferred (FT-5).
    }

    /**
     * Initialize or reinitialize the embedding service based on current settings
     */
    private async initializeEmbeddingService(): Promise<void> {
        // Dispose existing embedding service
        await this.embeddingService?.dispose();
        this.embeddingService = null;

        // Only create if the semantic-search feature is enabled (FT-11/FT-12).
        if (isFeatureEnabled(this.settings, 'semantic-search')) {
            // Resolve API key from SecretStorage with inheritance chain
            const apiKey = await this.resolveEmbeddingApiKey();
            const { service, unavailableReason } = await createEmbeddingServiceFromSettings(this.settings, apiKey || undefined, this.embeddingCooldown);
            this.embeddingService = service;

            // This is the settings-change reinit path (vs. plugin-load) — the
            // one place a newly-introduced denial should be surfaced visibly,
            // since it's the direct result of the user's own action.
            if (!service && unavailableReason === 'local-onnx-not-consented') {
                new Notice(this.t.messages.localOnnxNotConsented);
            }

            // Update vector store service with new embedding service
            if (this.vectorStoreService) {
                await this.vectorStoreService.updateEmbeddingService(this.embeddingService, true);
            }
        }
    }

    /**
     * Resolve embedding API key via SecretStorage inheritance chain
     */
    private async resolveEmbeddingApiKey(): Promise<string | null> {
        const provider = this.settings.embeddingProvider;

        // Azure embeddings ride the `openai` provider but use the shared Azure
        // Foundry key (never the personal OpenAI key). Plan §3 — any azure-*
        // main provider routes openai-embeddings to Azure. No silent fallback:
        // in Azure mode return the Azure key (or null), never the personal-key
        // chain below — the factory surfaces "Azure embeddings not configured".
        if (provider === 'openai' && isAzureMode(this.settings)) {
            return await getAzureApiKey(this, 'azure-openai');
        }

        const secretId = EMBEDDING_PROVIDER_TO_SECRET_ID[provider];

        return await this.secretStorageService.resolveApiKey({
            primaryId: PLUGIN_SECRET_IDS.EMBEDDING,
            providerFallback: secretId ? provider as AdapterType : undefined,
            useMainKeyFallback: true,
            plainTextFallback: {
                primaryKey: this.settings.embeddingApiKey,
                providerKey: this.settings.providerSettings?.[provider as keyof typeof this.settings.providerSettings]?.apiKey,
                mainCloudKey: this.settings.cloudApiKey
            }
        });
    }

    private async getProviderApiKey(type: AdapterType): Promise<string> {
        // First check SecretStorage, then fallback to settings
        const secretKey = await this.secretStorageService.getProviderKey(type);
        if (secretKey) return secretKey;
        return this.settings.providerSettings?.[type]?.apiKey || this.settings.cloudApiKey;
    }

    /**
     * Initialize or reinitialize the NotebookLM source pack service
     */
    /**
     * Route non-markdown attachment vault events (modify/delete/rename) through the single
     * lifecycle coordinator (C16). Plugin-scoped (auto-unregistered on unload). Gated to the
     * document/PDF extensions we index; the registered consumers self-gate on their feature
     * flags. `modify` is per-path debounced (attachments fire bursts of modify events).
     */
    private registerAttachmentEventHandlers(): void {
        const coord = this.attachmentCoordinator;
        if (!coord) return;
        const docExts: readonly string[] = ALL_DOCUMENT_EXTENSIONS;
        const isIndexableAttachment = (f: unknown): f is TFile =>
            f instanceof TFile && f.extension !== 'md' && docExts.includes(f.extension.toLowerCase());

        this.registerEvent(this.app.vault.on('modify', (file) => {
            if (!isIndexableAttachment(file)) return;
            const path = file.path;
            const prev = this.attachmentModifyTimers.get(path);
            if (prev) window.clearTimeout(prev);
            this.attachmentModifyTimers.set(path, window.setTimeout(() => {
                this.attachmentModifyTimers.delete(path);
                void coord.handleChange('modify', path);
            }, 800));
        }));
        this.registerEvent(this.app.vault.on('delete', (file) => {
            if (!isIndexableAttachment(file)) return;
            void coord.handleChange('delete', file.path);
        }));
        this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
            if (!isIndexableAttachment(file)) return;
            void coord.handleChange('rename', file.path, oldPath);
        }));
    }

    /**
     * Lazily initialize the visual-search lane (Phase 6): repository (second Voy index) +
     * pointer queue + index service, registered as a consumer on the Phase-1 lifecycle
     * coordinator (C16) and on host-note events (C24). No-op unless the feature is enabled
     * AND the DP-2 selector reports a ready backend (probe green / BYO key present).
     * Called from onload and again when the feature is enabled at runtime (C23).
     */
    private async initVisualLane(): Promise<void> {
        if (this.visualService) return; // already up
        if (!isFeatureEnabled(this.settings, 'semantic-search')) return;
        if (!this.attachmentCoordinator) return; // semantic lane failed to init
        try {
            // Auto-adopt (2026-06-10): a configured READY backend switches the feature on
            // at startup — providing the dedicated key/deployment IS the consent act.
            // An EXPLICIT disable (flag === false) is respected; only an untouched flag
            // (undefined) auto-adopts. Persisted via saveData (no service-reinit cascade
            // mid-onload).
            if (!isFeatureEnabled(this.settings, 'visual-search')) {
                if (!shouldAutoEnableVisualSearch(this.settings.featureFlags)) return;
                const adopt = await selectVisualBackend(this);
                if (adopt.kind !== 'ready') return;
                this.settings.featureFlags['visual-search'] = true;
                await this.saveData(this.settings);
                logger.debug('Search', 'Visual search auto-enabled: a configured backend was detected');
            }
            const sel = await selectVisualBackend(this);
            if (sel.kind !== 'ready') {
                logger.debug('Search', `Visual lane not started: ${sel.kind === 'probe-needed' ? 'probe pending' : sel.reason}`);
                return;
            }
            const identity = { modelId: sel.cfg.modelId, backend: sel.cfg.backend, dim: sel.cfg.dim };

            // Separate cooldown bucket for the visual deployment (C2/M5 — a Cohere 429
            // must never pause TEXT indexing, and vice versa).
            this.visualCooldown = new EmbeddingCooldown();
            this.visualPool = new PdfHandlePool({
                loadPdfJs: () => loadPdfJs(),
                readBinary: (f) => this.app.vault.readBinary(f),
                createCanvas: (w, h) => {
                    const canvas = document.createElement('canvas');
                    canvas.width = w;
                    canvas.height = h;
                    const context = canvas.getContext('2d');
                    return context ? { canvas, context } : null;
                },
            });
            this.visualEmbedderProvider = createVisualEmbedderProvider(this);
            const backend = createVisualEmbedBackend({
                app: this.app,
                pool: this.visualPool,
                provider: this.visualEmbedderProvider,
                visualCooldown: this.visualCooldown,
            });
            this.visualQueue = new GenericEmbeddingQueue<VisualPageTask>({
                getBackend: () => backend,
                foregroundGate: this.foregroundGate,
                cooldown: this.visualCooldown,
            });
            this.visualRepository = new VisualIndexRepository(this.app, identity);
            const loaded = await this.visualRepository.load();
            if (!loaded.ok) logger.warn('Search', `Visual index load failed: ${loaded.error}`);
            this.visualIndexNeedsRebuild = this.visualRepository.needsRebuild;

            this.visualService = new VisualIndexService({
                app: this.app,
                repository: this.visualRepository,
                queue: this.visualQueue,
                pool: this.visualPool,
                isEnabled: () => isFeatureEnabled(this.settings, 'visual-search'),
                getIdentity: () => identity,
                getMaxPagesPerAttachment: () => this.settings.maxVisualPagesPerAttachment,
            });
            this.attachmentCoordinator.register(this.visualService);
            this.registerVisualNoteEventHandlers();

            // Phase 7: the query side — RAG construction sites read `plugin.visualRetrieval`.
            const provider = this.visualEmbedderProvider;
            this.visualRetrieval = new VisualRetrievalService({
                getRepository: () => this.visualRepository,
                getEmbedder: () => provider.getEmbedder(),
                isEnabled: () => isFeatureEnabled(this.settings, 'visual-search'),
            });

            // C23 backfill: make pre-existing linked PDFs retrievable without an edit
            // event. Cheap on re-runs (the C9 cache skips unchanged PDFs); paced by the
            // cap-1 queue, which yields to foreground work.
            if (!this.visualIndexNeedsRebuild) void this.visualService.backfillVault();
            logger.debug('Search', `Visual search lane initialized (${identity.backend}/${identity.modelId}/${identity.dim})`);
        } catch (error) {
            logger.error('Search', 'Failed to initialize visual search lane', error);
        }
    }

    /**
     * Tear the visual lane down. `purge=true` (feature disable, C14) deletes the WHOLE
     * visual namespace; `purge=false` (plugin unload) saves and releases. CA3: the
     * consumer is unregistered from the coordinator BEFORE anything is disposed, so
     * post-teardown vault events can't dispatch into a dead service.
     */
    private teardownVisualLane(purge: boolean): void {
        if (this.visualService && this.attachmentCoordinator) {
            this.attachmentCoordinator.unregister(this.visualService);
        }
        this.visualService?.cancelBackfill();
        for (const ref of this.visualNoteEventRefs) this.app.vault.offref(ref);
        this.visualNoteEventRefs = [];
        for (const timer of this.visualNoteModifyTimers.values()) window.clearTimeout(timer);
        this.visualNoteModifyTimers.clear();
        this.visualQueue?.dispose();
        this.visualQueue = null;
        this.visualPool?.disposeAll();
        this.visualPool = null;
        this.visualEmbedderProvider?.dispose();
        this.visualEmbedderProvider = null;
        this.visualCooldown = null;
        const repo = this.visualRepository;
        this.visualRepository = null;
        this.visualService = null;
        this.visualRetrieval = null;
        this.visualIndexNeedsRebuild = false;
        if (repo) void (purge ? repo.deleteAll() : repo.dispose());
    }

    /**
     * C24 — the visual store is keyed by HOST note, so it must react to `.md` events too:
     * delete → purge, rename → rekey, modify → reconcile the note's embedded-PDF set
     * (de-linked PDFs lose their vectors; newly-linked ones index). Refs are kept for
     * early teardown (feature disable) AND registered for unload safety.
     */
    private registerVisualNoteEventHandlers(): void {
        const isNote = (f: unknown): f is TFile => f instanceof TFile && f.extension === 'md';

        const modifyRef = this.app.vault.on('modify', (file) => {
            if (!isNote(file)) return;
            const path = file.path;
            const prev = this.visualNoteModifyTimers.get(path);
            if (prev) window.clearTimeout(prev);
            this.visualNoteModifyTimers.set(path, window.setTimeout(() => {
                this.visualNoteModifyTimers.delete(path);
                void this.visualService?.noteModified(path);
            }, 1500));
        });
        const deleteRef = this.app.vault.on('delete', (file) => {
            if (!isNote(file)) return;
            void this.visualService?.noteDeleted(file.path);
        });
        const renameRef = this.app.vault.on('rename', (file, oldPath) => {
            if (!isNote(file)) return;
            void this.visualService?.noteRenamed(oldPath, file.path);
        });
        this.visualNoteEventRefs = [modifyRef, deleteRef, renameRef];
        for (const ref of this.visualNoteEventRefs) this.registerEvent(ref);
    }

    private initializeSourcePackService(): void {
        const pdfConfig = {
            ...DEFAULT_PDF_CONFIG,
            pageSize: this.settings.notebooklmPdfPageSize,
            fontName: this.settings.notebooklmPdfFontName,
            fontSize: this.settings.notebooklmPdfFontSize,
            includeFrontmatter: this.settings.notebooklmIncludeFrontmatter,
            includeTitle: this.settings.notebooklmIncludeTitle
        };

        const config: SourcePackConfig = {
            selectionTag: this.settings.notebooklmSelectionTag,
            exportFolder: getNotebookLMExportFullPath(this.settings),
            postExportTagAction: this.settings.notebooklmPostExportTagAction,
            exportFormat: this.settings.notebooklmExportFormat,
            pdf: pdfConfig
        };

        this.sourcePackService = new SourcePackService(this.app, config);
        this.sourcePackService.initialize().catch(error => {
            logger.error('Core', 'Failed to initialize NotebookLM source pack service', error);
        });
    }

    private getProviderModel(type: AdapterType): string {
        return this.settings.providerSettings?.[type]?.model || this.settings.cloudModel;
    }

    /**
     * Resolve a provider's request endpoint. Delegates Azure to the single
     * Azure-aware SSOT `resolveEndpoint` (apiKeyHelpers) so EVERY endpoint path
     * — main service, mobile fallback, specialists — funnels Azure through one
     * place. Azure's `PROVIDER_ENDPOINT` entries are `''` (the URL lives in the
     * azure* settings), so any path that reads `cloudEndpoint`/`PROVIDER_ENDPOINT`
     * directly for an Azure provider would get an empty endpoint — this method is
     * the guard against that whole class of bug.
     */
    private getProviderEndpoint(type: AdapterType): string {
        if (type === 'openai-compatible') {
            return this.settings.cloudEndpoint || 'http://your-api-endpoint/v1/chat/completions';
        }
        if (type.startsWith('azure')) {
            return resolveEndpoint(type, this);
        }
        if (type === this.settings.cloudServiceType && this.settings.cloudEndpoint) {
            return this.settings.cloudEndpoint;
        }
        const endpointMap = cloudEndpoints as Record<string, string>;
        return endpointMap[type] || this.settings.cloudEndpoint;
    }

    /**
     * Replace a stale `cloudEndpoint` (one that matches a DIFFERENT provider's
     * default) with the current provider's default. Leaves custom endpoints
     * alone — detected as "does not match any known default URL".
     */
    private reconcileCloudEndpoint(cloudType: AdapterType, endpoint: string): string {
        const endpointMap = cloudEndpoints as Record<string, string>;
        const correctDefault = endpointMap[cloudType];
        if (!correctDefault) return endpoint;
        if (!endpoint) return correctDefault;
        if (endpoint === correctDefault) return endpoint;

        // If the stored endpoint matches ANY other provider's default, it's
        // stale leftover from a swap — replace it with the correct default.
        const knownDefaults = Object.values(endpointMap);
        if (knownDefaults.includes(endpoint)) return correctDefault;

        // Otherwise it's a custom endpoint — keep it.
        return endpoint;
    }

    private isLikelyLocalEndpoint(endpoint: string): boolean {
        try {
            const url = new URL(endpoint);
            const host = url.hostname.toLowerCase();
            return host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '::1';
        } catch {
            return false;
        }
    }

    private async initializeLLMService(): Promise<void> {
        // H5: claim an epoch up front. If a later init starts while this one is
        // awaiting (secret lookups, profile resolution), the stale call bails
        // before mutating `llmService`/`providerProfile` so the latest wins.
        const myEpoch = ++this.llmInitEpoch;
        await this.llmService?.dispose();
        // Invalidate the cached triage service — provider/key/endpoint/fast-model
        // may all have changed; it is rebuilt lazily on the next tagging call.
        await this.disposeAzureTriageService();

        let serviceType = this.settings.serviceType;
        let localEndpoint = this.settings.localEndpoint;
        let localModel = this.settings.localModel;
        let cloudType = this.settings.cloudServiceType;
        let cloudEndpoint = this.settings.cloudEndpoint;
        let cloudModel = this.settings.cloudModel;

        // Defense-in-depth: detect stale cloudEndpoint carried over from a
        // previous provider (can happen via settings migrations, hand-edited
        // data.json, or bugs that update cloudServiceType without also
        // updating cloudEndpoint). If the stored endpoint matches any other
        // provider's default, replace it with the current provider's default.
        // Custom endpoints (that don't match any known default) are left
        // alone — they're opt-in configuration users rely on.
        cloudEndpoint = this.reconcileCloudEndpoint(cloudType, cloudEndpoint);

        // Get API key from SecretStorage first, fallback to settings
        let cloudApiKey = await this.secretStorageService.getProviderKey(cloudType) ||
                          this.settings.cloudApiKey;

        // Azure providers are plain HTTPS (via requestUrl) — they work identically
        // on mobile, so there is NO mobile fallback in Azure mode: the main Azure
        // provider config is used as-is. Falling back to a non-Azure provider on
        // mobile would need a personal key and break the Azure-only constraint.
        if (Platform.isMobile && !isAzureMode(this.settings)) {
            const fallbackProvider = this.settings.mobileFallbackProvider || this.settings.cloudServiceType;
            const fallbackModel = this.settings.mobileFallbackModel || this.getProviderModel(fallbackProvider);

            if (this.settings.mobileProviderMode === 'cloud-only') {
                serviceType = 'cloud';
                cloudType = fallbackProvider;
                cloudModel = fallbackModel;
                cloudEndpoint = this.getProviderEndpoint(fallbackProvider);
                cloudApiKey = await this.getProviderApiKey(fallbackProvider);
            } else if (this.settings.mobileProviderMode === 'custom') {
                serviceType = 'local';
                localEndpoint = this.settings.mobileCustomEndpoint || this.settings.localEndpoint;
                localModel = this.settings.mobileFallbackModel || this.settings.localModel;
            } else if (this.settings.serviceType === 'local' && this.isLikelyLocalEndpoint(this.settings.localEndpoint)) {
                serviceType = 'cloud';
                cloudType = fallbackProvider;
                cloudModel = fallbackModel;
                cloudEndpoint = this.getProviderEndpoint(fallbackProvider);
                cloudApiKey = await this.getProviderApiKey(fallbackProvider);
            }
        }

        // Azure: the main LLM endpoint lives in the azure* settings, NOT `cloudEndpoint`
        // (which is '' for Azure). Resolve it via the single `getProviderEndpoint`
        // accessor (→ `resolveEndpoint` SSOT) + the shared Foundry key. Without this the
        // main service (chat, presentations, tagging, summarize, …) gets an empty
        // endpoint → "API endpoint is not configured". The mobile block above is gated
        // on `!isAzureMode`, so it never touches these values.
        if (serviceType === 'cloud' && isAzureMode(this.settings)) {
            cloudEndpoint = this.getProviderEndpoint(cloudType);
            // D2: NO `|| cloudApiKey` fallback — an Azure provider must never
            // silently borrow the user's personal Claude/OpenAI key. A missing
            // Azure key yields the fail-closed NullLLMService below.
            cloudApiKey = (await getAzureApiKey(this, cloudType as 'azure-claude' | 'azure-openai')) || '';
        }

        // D1: resolve the validated provider profile (SSOT) and cache it for the
        // badge + per-call attribution. Recomputed on every init (saveSettings).
        const profile = await resolveProviderProfile(this);

        // H5: a newer init superseded us while awaiting — abandon this result.
        if (myEpoch !== this.llmInitEpoch) return;
        this.providerProfile = profile;

        // Azure rate-limit pacing: push the current cap/RPM into the shared pacer
        // policy (set once here; runs on load + every saveSettings re-init).
        setAzurePacerPolicy({
            maxConcurrent: this.settings.azureMaxConcurrentRequests,
            maxRpm: this.settings.azureMaxRpm,
        });
        // Per-deployment RPM overrides (Phase 2): applied after the global policy so
        // each override survives a global change. Live-updates running pacers (M3).
        setDeploymentRpm(this.settings.azurePerDeploymentRpm);

        // D2: fail closed. A misconfigured Azure setup gets a NullLLMService —
        // no network path can fire — plus one actionable Notice per misconfig
        // episode (re-armed once the profile becomes valid again).
        if (profile.mode === 'azure' && !profile.valid) {
            this.llmService = new NullLLMService(profile.error ?? this.t.llmGateway.azureNotConfiguredNotice);
            if (!this.azureMisconfigNoticeShown) {
                new Notice(this.t.llmGateway.azureNotConfiguredNotice, 8000);
                this.azureMisconfigNoticeShown = true;
            }
        } else {
            this.azureMisconfigNoticeShown = false;
            this.llmService = serviceType === 'local'
                ? new LocalLLMService({
                    endpoint: localEndpoint,
                    modelName: localModel,
                    language: this.settings.language
                }, this.app)
                : new CloudLLMService({
                    endpoint: cloudEndpoint,
                    apiKey: cloudApiKey,
                    modelName: cloudModel,
                    type: cloudType,
                    language: this.settings.language,
                    thinkingMode: this.settings.claudeThinkingMode
                }, this.app);
        }

        this.llmService.setDebugMode(this.settings.debugMode);
        this.llmService.setSummarizeTimeout(this.settings.summarizeTimeoutSeconds);
        // D5: wire the logical-call counter. Only CloudLLMService emits onCall.
        if (this.llmService instanceof CloudLLMService) {
            this.llmService.setOnCall(() => { this.llmCallCounter++; });
        }
        setGlobalDebugMode(this.settings.debugMode);
        logger.setDebugMode(this.settings.debugMode);

        // Notify subscribers (badge) that the profile may have changed.
        this.fireProfileChange();
    }

    /**
     * The LLM service for high-volume TAGGING. In Azure mode with a configured
     * surface-matched fast deployment (Phase 3), returns a dedicated triage
     * `CloudLLMService` bound to that deployment (cheap/fast, works in both
     * routing modes — see `azureTriageRouting`). Otherwise falls back to the
     * main `llmService` (no regression for non-Azure / unset).
     *
     * The triage service is built lazily, cached, and rebuilt when the resolved
     * route changes; it is disposed on re-init + unload.
     */
    private async getTaggingService(): Promise<SummarizableLLMService> {
        const route = resolveAzureTriageRoute(this.settings);
        if (!route) {
            await this.disposeAzureTriageService();
            return this.llmService;
        }

        // The Azure key is never embedded in the route (secret-free resolver) —
        // resolve it here. A missing key means the main path is already fail-
        // closed (NullLLMService), so just fall back rather than build a broken
        // triage service.
        const apiKey = (await getAzureApiKey(this, route.type)) || '';
        if (!apiKey) {
            await this.disposeAzureTriageService();
            return this.llmService;
        }

        const routeKey = `${route.type}|${route.endpoint}|${route.modelName}|${apiKey.length}`;
        if (this.azureTriageService && this.azureTriageRouteKey === routeKey) {
            return this.azureTriageService;
        }

        await this.disposeAzureTriageService();
        const svc = new CloudLLMService({
            endpoint: route.endpoint,
            apiKey,
            modelName: route.modelName,
            type: route.type,
            language: this.settings.language,
            thinkingMode: this.settings.claudeThinkingMode,
        }, this.app);
        svc.setDebugMode(this.settings.debugMode);
        svc.setSummarizeTimeout(this.settings.summarizeTimeoutSeconds);
        svc.setOnCall(() => { this.llmCallCounter++; });
        this.azureTriageService = svc;
        this.azureTriageRouteKey = routeKey;
        return svc;
    }

    /** Dispose + clear the cached Azure triage service (re-init + unload). */
    private async disposeAzureTriageService(): Promise<void> {
        const svc = this.azureTriageService;
        this.azureTriageService = null;
        this.azureTriageRouteKey = null;
        await svc?.dispose();
    }

    /**
     * Run a user-initiated LLM op while the foreground gate is held (D3) so
     * background indexing yields. Leak-safe (the gate releases in finally).
     */
    public withForeground<T>(fn: () => Promise<T>): Promise<T> {
        return this.foregroundGate.withForeground(fn);
    }

    /**
     * Subscribe to provider-profile changes (badge re-render). Returns an
     * unsubscribe fn. Fired after each `initializeLLMService` recompute (R2-M4).
     */
    public onProfileChange(listener: () => void): () => void {
        this.profileChangeListeners.add(listener);
        return () => this.profileChangeListeners.delete(listener);
    }

    private fireProfileChange(): void {
        for (const listener of this.profileChangeListeners) {
            try {
                listener();
            } catch (e) {
                logger.warn('Core', 'profile-change listener threw', e);
            }
        }
    }

    public async onload(): Promise<void> {
        await this.loadSettings();
        await this.initializeLLMService();

        // Initialize configuration service with full path (pluginFolder/configFolderPath)
        const configFullPath = getConfigFolderFullPath(this.settings);
        this.configService.setConfigFolder(configFullPath);

        // Create default config files if they don't exist
        const configExists = await this.configService.configFilesExist();
        if (!configExists) {
            await this.configService.createDefaultConfigFiles();
            // Fresh install — stamp current version so migration doesn't fire
            this.settings.personaSchemaVersion = CURRENT_PERSONA_SCHEMA_VERSION;
            await this.saveSettings();
        }

        // Migrate persona config files if schema version has been bumped
        if ((this.settings.personaSchemaVersion ?? 0) < CURRENT_PERSONA_SCHEMA_VERSION) {
            await this.configService.migratePersonaConfigFiles(this.settings.personaSchemaVersion ?? 0);
            this.settings.personaSchemaVersion = CURRENT_PERSONA_SCHEMA_VERSION;
            await this.saveSettings();
        }

        // Initialize busy indicator status bar (desktop only)
        if (!Platform.isMobile) {
            this.busyStatusBarEl = this.addStatusBarItem();
            this.busyStatusBarEl.addClass('ai-organiser-busy-indicator');
        }

        // Initialize NotebookLM selection counter status bar (desktop only)
        if (!Platform.isMobile) {
            this.notebookLMStatusBarEl = this.addStatusBarItem();
            this.notebookLMStatusBarEl.addClass('ai-organiser-notebooklm-status');
            this.notebookLMStatusBarEl.hide();
            this.notebookLMStatusBarEl.addEventListener('click', () => {
                (this.app as App & { commands: { executeCommandById: (id: string) => void } }).commands.executeCommandById('ai-organiser:notebooklm-export');
            });

            // Debounced metadata listener to update count
            let notebookLMUpdateTimer: ReturnType<typeof setTimeout> | null = null;
            this.registerEvent(
                this.app.metadataCache.on('changed', () => {
                    if (notebookLMUpdateTimer) clearTimeout(notebookLMUpdateTimer);
                    notebookLMUpdateTimer = setTimeout(() => this.updateNotebookLMStatus(), 500);
                })
            );

            // Initial count on load
            this.updateNotebookLMStatus();
        }

        // Construct the plugin-scoped embedding queue ONCE (D0/D4.4) — it reaches
        // the CURRENT embedding service indirectly so a settings swap never leaves
        // it holding a stale instance. Disposed only in onunload.
        this.embeddingQueue = new EmbeddingQueue({
            getEmbeddingService: () => this.embeddingService,
            foregroundGate: this.foregroundGate,
            cooldown: this.embeddingCooldown,
        });

        // Initialize vector store for semantic search (gated on the feature — FT-12;
        // semantic-search absorbed the legacy enableSemanticSearch master switch).
        if (isFeatureEnabled(this.settings, 'semantic-search')) {
            try {
                // Resolve API key from SecretStorage with inheritance chain
                const embeddingApiKey = await this.resolveEmbeddingApiKey();
                const embeddingResolution = await createEmbeddingServiceFromSettings(this.settings, embeddingApiKey || undefined, this.embeddingCooldown);
                this.embeddingService = embeddingResolution.service;

                // Create vector store service
                this.vectorStoreService = new VectorStoreService(
                    this.app,
                    this.settings,
                    this.embeddingService,
                    this.embeddingQueue
                );
                this.vectorStore = await this.vectorStoreService.createVectorStore();

                // Register file event handlers for auto-indexing
                if (this.settings.autoIndexNewNotes) {
                    this.vectorStoreService.registerFileEventHandlers();
                }

                // Attachment lifecycle (C16): the single attachment-event ingress. The text
                // consumer self-gates on `indexAttachmentText`; Phase 6 registers the visual
                // consumer on the SAME coordinator. Created whenever semantic-search is on so
                // attachment events reach whichever lanes are enabled.
                this.attachmentCoordinator = new AttachmentLifecycleCoordinator(
                    () => this.vectorStoreService?.getLinkSource() ?? { resolvedLinks: {}, unresolvedLinks: {} },
                );
                this.attachmentCoordinator.register(this.vectorStoreService);
                this.registerAttachmentEventHandlers();

                // Visual-search lane (Phase 6): second consumer on the SAME coordinator
                // (C16); self-gates on the visual-search flag + a ready backend (DP-2).
                await this.initVisualLane();

                if (this.embeddingService) {
                    logger.debug('Core', `Semantic search initialized with ${this.settings.embeddingProvider}/${this.settings.embeddingModel}`);
                } else {
                    logger.debug('Core', 'Vector store initialized without embedding service - configure API key in settings');
                }
            } catch (error) {
                logger.error('Core', 'Failed to initialize vector store', error);
                new Notice('Failed to initialize semantic search: ' + (error instanceof Error ? error.message : String(error)), 5000);
            }
        }

        // Initialize NotebookLM source pack service
        this.initializeSourcePackService();

        // §4.4.2 Mermaid diagram staleness notification (opt-in; gated on mermaid-chat)
        if (this.settings.mermaidChatStalenessNotice && isFeatureEnabled(this.settings, 'mermaid-chat')) {
            this.registerEvent(
                this.app.metadataCache.on('changed', debounce((file: TFile) => {
                    void this.checkDiagramStaleness(file);
                }, 5000))
            );
        }

        // §4.4.3 Mermaid staleness gutter (opt-in, desktop only; gated on mermaid-chat — FT-12)
        if (this.settings.mermaidChatStalenessGutter && !Platform.isMobile && isFeatureEnabled(this.settings, 'mermaid-chat')) {
            this.registerEditorExtension([mermaidStalenessGutterExtension(this)]);
        }

        this.eventHandlers.registerEventHandlers();
        this.settingTab = new AIOrganiserSettingTab(this.app, this);
        this.addSettingTab(this.settingTab);
        registerCommands(this);
        this.startNewsletterScheduler();

        // Augment native <audio> embeds (e.g. newsletter daily-brief WAVs) with
        // a small playback-speed toolbar (0.75×…2×). Obsidian's default
        // controls expose no speed UI despite the browser supporting it.
        this.registerMarkdownPostProcessor((el) => enhanceAudioPlayersIn(el));

        // Register tag network view + related notes view. Obsidian throws
        // `Attempting to register an existing view type` if another plugin
        // (e.g. a sister fork of this codebase) already owns the same type
        // id. Without this guard a single collision aborts ALL later onload
        // work — commands, ribbons, settings — leaving the plugin half-loaded
        // with no user-visible signal. Logging + continuing keeps the rest
        // of the plugin functional. (Persona-harness finding 2026-04-21.)
        this.safeRegisterView(TAG_NETWORK_VIEW_TYPE, (leaf) =>
            new TagNetworkView(leaf, this.tagNetworkManager, () => this.getNonExcludedMarkdownFiles(), this));
        // Related-notes view is a semantic-search surface — register only when enabled (FT-12).
        if (isFeatureEnabled(this.settings, 'semantic-search')) {
            this.safeRegisterView(RELATED_NOTES_VIEW_TYPE, (leaf) =>
                new RelatedNotesView(leaf, this));
        }

        // Register command picker command
        this.addCommand({
            id: 'open-picker',
            name: this.t.commands.openCommandPicker || 'Open command picker',
            icon: 'sparkles',
            callback: () => this.openCommandPicker()
        });

        // Register custom AI Organiser icon
        // Constellation icon — 5 asymmetric stars, two branching paths converging
        // "chaos in, structure out" — distinctive mini-brand silhouette
        addIcon('ai-organiser', `
            <path d="M20 22 L50 12 L80 34 L64 74 M20 22 L28 64 L64 74"
                stroke="currentColor" stroke-width="5" fill="none"
                stroke-linecap="round" stroke-linejoin="round"/>
            <circle cx="20" cy="22" r="9" fill="currentColor"/>
            <circle cx="50" cy="12" r="7" fill="currentColor"/>
            <circle cx="80" cy="34" r="11" fill="currentColor"/>
            <circle cx="28" cy="64" r="7" fill="currentColor"/>
            <circle cx="64" cy="74" r="9" fill="currentColor"/>
        `);
        this.addRibbonIcon(
            'ai-organiser',
            this.t.commands.ribbonTooltip || 'AI Organiser',
            () => this.openCommandPicker()
        );

        // Dedicated Chat ribbon icon (R5 menu audit 2026-04-21). Replaces the
        // tag-network icon — chat is the flagship feature and was 4 clicks
        // deep via the picker; the tag network moved to Vault → Visualizations
        // which is where all other graph/tag views live.
        this.addRibbonIcon(
            'message-circle',
            this.t.commands.chatWithAI || 'Chat with AI',
            () => { void import('./commands/chatCommands').then(m => m.openAIChat(this)); }
        );

        // First-run intro (FT-7 / L2): point existing + new users at the new Features
        // section. Once-only — the persisted `featuresIntroShown` marker is set + saved
        // immediately so it never re-fires across reloads. Fires after layout settles.
        if (!this.settings.featuresIntroShown) {
            this.settings.featuresIntroShown = true;
            void this.saveData(this.settings).catch((err) =>
                logger.warn('Core', 'Failed to persist featuresIntroShown marker', err));
            this.app.workspace.onLayoutReady(() => new Notice(this.t.features.intro, 8000));
        }
    }

    /**
     * registerView wrapped in a try/catch: if another plugin (e.g. a sister
     * fork) already owns the view type, log + continue instead of aborting
     * onload. Without this a single collision kills all subsequent command /
     * ribbon / settings registration silently.
     */
    private safeRegisterView(type: string, factory: Parameters<Plugin['registerView']>[1]): void {
        try {
            this.registerView(type, factory);
        } catch (e) {
            logger.warn('Core', `registerView('${type}') failed — likely a sister-plugin collision; continuing without this view`, e);
        }
    }

    // ── §4.4.2 Mermaid staleness notification ────────────────────────────────
    /**
     * Check whether any Mermaid diagrams in the changed file are stale
     * and show a dismissable Notice if so (rate-limited to 1 per file per 10 min).
     */
    private async checkDiagramStaleness(file: TFile): Promise<void> {
        if (!(file instanceof TFile) || file.extension !== 'md') return;

        // Rate-limit: one notice per file per 10 minutes
        const RATE_LIMIT_MS = 10 * 60 * 1000;
        const lastNotice = this.mermaidNoticeRateLimit.get(file.path) ?? 0;
        if (Date.now() - lastNotice < RATE_LIMIT_MS) return;

        let content: string;
        try {
            content = await this.app.vault.cachedRead(file);
        } catch {
            return;
        }

        const blocks = findAllMermaidBlocks(content);
        if (blocks.length === 0) return;

        for (const block of blocks) {
            const fp = block.code.slice(0, 80);
            if (!this.mermaidChangeDetector.hasSnapshot(fp)) continue;
            if (this.mermaidChangeDetector.isSnoozed(fp)) continue;

            const { isStale } = this.mermaidChangeDetector.checkStaleness(fp, content);
            if (!isStale) continue;

            // Update rate limit and show notice
            this.mermaidNoticeRateLimit.set(file.path, Date.now());

            const t = this.t.modals?.mermaidChat;
            const noticeText = t?.stalenessNotice ?? 'A diagram in this note may be outdated.';
            const updateText = t?.stalenessUpdate ?? 'Update diagram';
            const snoozeText = t?.stalenessSnooze ?? 'Dismiss';

            const frag = document.createDocumentFragment();
            const wrap = frag.createEl('div');
            wrap.createEl('p', { text: noticeText });
            const btnRow = wrap.createEl('div', { cls: 'ai-organiser-mermaid-notice-actions' });

            let noticeRef: Notice | null = null;
            const updateBtn = btnRow.createEl('button', { text: updateText, cls: 'mod-cta' });
            updateBtn.addClass('ai-organiser-mr-8');
            updateBtn.addEventListener('click', () => {
                (this.app as App & { commands: { executeCommandById: (id: string) => void } }).commands.executeCommandById('ai-organiser:edit-mermaid-diagram');
                noticeRef?.hide();
            });

            const snoozeBtn = btnRow.createEl('button', { text: snoozeText });
            snoozeBtn.addEventListener('click', () => {
                this.mermaidChangeDetector.snooze(fp);
                noticeRef?.hide();
            });

            noticeRef = new Notice(frag, 0); // 0 = stay until dismissed
            return; // One notice per file-change event
        }
    }

    /** Update NotebookLM status bar counter */
    public updateNotebookLMStatus(): void {
        if (!this.notebookLMStatusBarEl || !this.sourcePackService) return;
        const count = this.sourcePackService.getSelectionCount();
        if (count > 0) {
            const text = this.t.messages.notebookLMStatusSelected.replace('{count}', String(count));
            this.notebookLMStatusBarEl.setText(`NotebookLM: ${text}`);
            this.notebookLMStatusBarEl.show();
        } else {
            this.notebookLMStatusBarEl.hide();
        }
    }

    // ── Newsletter auto-fetch scheduler ──────────────────────────────────────

    /** Start (or restart) the newsletter auto-fetch scheduler. Call after settings change. */
    public startNewsletterScheduler(): void {
        this.stopNewsletterScheduler();
        // Gate on the newsletter feature (FT-12; it absorbed the legacy newsletterEnabled master).
        if (!this.settings.newsletterAutoFetch || !isFeatureEnabled(this.settings, 'newsletter')) {
            logger.debug('Newsletter', `Scheduler skipped: feature=${isFeatureEnabled(this.settings, 'newsletter')}, autoFetch=${this.settings.newsletterAutoFetch}`);
            return;
        }
        const intervalMs = this.settings.newsletterAutoFetchIntervalMins * 60 * 1000;
        logger.debug('Newsletter', `Scheduler started: interval=${this.settings.newsletterAutoFetchIntervalMins}min, lastFetch=${this.newsletterLastFetchTime}, scriptUrl=${this.settings.newsletterScriptUrl ? 'set' : 'missing'}`);
        // Check on startup whether a fetch is overdue, then poll on the interval
        void this.runScheduledNewsletterFetch();
        this.newsletterFetchTimer = setInterval(() => void this.runScheduledNewsletterFetch(), intervalMs);
    }

    public stopNewsletterScheduler(): void {
        if (this.newsletterFetchTimer !== null) {
            clearInterval(this.newsletterFetchTimer);
            this.newsletterFetchTimer = null;
        }
    }

    /** Runs a fetch only if enough time has passed since the last one. */
    private async runScheduledNewsletterFetch(): Promise<void> {
        if (!isFeatureEnabled(this.settings, 'newsletter') || !this.settings.newsletterScriptUrl?.trim()) {
            logger.debug('Newsletter', `Scheduled fetch skipped: feature=${isFeatureEnabled(this.settings, 'newsletter')}, hasUrl=${!!this.settings.newsletterScriptUrl?.trim()}`);
            return;
        }
        if (this.newsletterFetching) {
            logger.debug('Newsletter', 'Scheduled fetch skipped: already fetching');
            return;
        }
        const intervalMs = this.settings.newsletterAutoFetchIntervalMins * 60 * 1000;
        const elapsed = Date.now() - this.newsletterLastFetchTime;
        if (elapsed < intervalMs) {
            logger.debug('Newsletter', `Scheduled fetch skipped: ${Math.round(elapsed / 60000)}min elapsed, need ${this.settings.newsletterAutoFetchIntervalMins}min`);
            return;
        }
        logger.debug('Newsletter', 'Auto-fetch starting...');

        this.newsletterFetching = true;
        try {
            const service = new NewsletterService(this);
            await service.loadSeenIds();
            const result = await service.fetchAndProcess();
            await this.updateNewsletterLastFetchTime();
            // Only surface a notice when something happened
            if (result.totalNew > 0 || result.errors.length > 0) {
                showNewsletterFetchResultNotice(result, this);
            }
        } catch (e) {
            logger.error('Newsletter', 'Auto-fetch failed', e);
        } finally {
            this.newsletterFetching = false;
        }
    }

    /** Persist the current time as the last newsletter fetch timestamp. */
    public async updateNewsletterLastFetchTime(): Promise<void> {
        try {
            const data = (await this.loadData()) ?? {};
            data[LAST_FETCH_DATA_KEY] = Date.now();
            await this.saveData(data);
            this.newsletterLastFetchTime = data[LAST_FETCH_DATA_KEY];
        } catch { /* best-effort */ }
    }

    // ─────────────────────────────────────────────────────────────────────────

    public onunload(): void {
        this.stopNewsletterScheduler();
        this.narrationJobs.abortAll();
        // Clear pending attachment-modify debounce timers (audit H9 — no leaked timers/work
        // after unload). The vault event handlers themselves are auto-unregistered by Obsidian.
        for (const timer of this.attachmentModifyTimers.values()) window.clearTimeout(timer);
        this.attachmentModifyTimers.clear();
        // D4.4: the queue is plugin-scoped — disposed only here (symmetric with onload).
        this.embeddingQueue?.dispose();
        this.embeddingQueue = null;
        // Visual lane: save + release on unload (purge only on feature DISABLE — C14).
        this.teardownVisualLane(/*purge*/ false);
        // Azure rate-limit pacers are module-scoped — clear on unload.
        disposeAzurePacers();
        void this.llmService?.dispose();
        void this.disposeAzureTriageService();
        void this.embeddingService?.dispose();
        if (this.vectorStoreService) {
            void this.vectorStoreService.dispose();
            this.vectorStore = null;
            this.vectorStoreService = null;
        }
        this.embeddingService = null;
        this.eventHandlers.cleanup();
        resetBusyState();
        this.busyStatusBarEl = null;
        this.notebookLMStatusBarEl = null;
    }

    /**
     * Opens the command picker modal with all AI Organiser commands
     */
    public openCommandPicker(): void {
        const categories = buildCommandCategories(this.t, (commandId: string) => {
            // Execute the command via Obsidian's command system
            // @ts-ignore - commands API is internal but stable
            (this.app as App & { commands: { executeCommandById: (id: string) => void } }).commands.executeCommandById(commandId);
        }, this.settings.pickerPinnedCommandIds ?? []);

        const modal = new CommandPickerModal(this.app, this, this.t, categories);
        modal.open();
    }

    public async showTagNetwork(): Promise<void> {
        try {
            const statusNotice = new Notice(this.t.messages.buildingTagNetwork, 0);

            const files = this.getNonExcludedMarkdownFiles();
            await this.tagNetworkManager.buildTagNetwork(files);
            const networkData = this.tagNetworkManager.getNetworkData();

            statusNotice.hide();

            if (!networkData.nodes.length) {
                new Notice(this.t.messages.noTagsInVault, 3000);
                return;
            }

            if (!networkData.edges.length) {
                new Notice(this.t.messages.noTagConnections, 4000);
            }

            let leaf = this.app.workspace.getLeavesOfType(TAG_NETWORK_VIEW_TYPE)[0];
            let needsNewLeaf = false;

            if (leaf) {
                // Leaf exists — push fresh data and re-render
                const view = leaf.view as TagNetworkView;
                if (view && 'updateNetworkData' in view) {
                    view.updateNetworkData(networkData);
                    void this.app.workspace.revealLeaf(leaf);
                } else {
                    // View is invalid, close it and recreate
                    leaf.detach();
                    needsNewLeaf = true;
                }
            } else {
                needsNewLeaf = true;
            }

            if (needsNewLeaf) {
                const newLeaf = this.app.workspace.getRightLeaf(false);
                if (!newLeaf) {
                    throw new Error('Failed to create new workspace leaf');
                }

                await newLeaf.setViewState({
                    type: TAG_NETWORK_VIEW_TYPE,
                    active: true
                });

                // After creating the view, pass the network data
                const createdLeaf = this.app.workspace.getLeavesOfType(TAG_NETWORK_VIEW_TYPE)[0];
                if (createdLeaf) {
                    const view = createdLeaf.view as TagNetworkView;
                    if (view && 'updateNetworkData' in view) {
                        view.updateNetworkData(networkData);
                    }
                }
            }

            void this.app.workspace.revealLeaf(leaf);
        } catch (error) {
            logger.error('Core', 'Tag network error', error);
            new Notice(this.t.messages.failedToBuildNetwork + ': ' + (error instanceof Error ? error.message : String(error)), 4000);
        }
    }

    public async testConnection(): Promise<{ result: ConnectionTestResult; error?: ConnectionTestError }> {
        return await this.llmService.testConnection();
    }

    public async showConfirmationDialog(message: string): Promise<boolean> {
        return new Promise((resolve) => {
            const modal = new ConfirmationModal(
                this.app,
                this.t.modals.warning,
                message,
                () => resolve(true),
                this
            );
            modal.onClose = () => resolve(false);
            modal.open();
        });
    }

    /**
     * Get all exclusion patterns including plugin-managed folders
     */
    public getEffectiveExcludedFolders(): string[] {
        const userExclusions = this.settings.excludedFolders || [];
        const managed = getPluginManagedFolders(this.settings);
        const result = [...userExclusions];
        for (const folder of managed) {
            if (folder && !result.includes(folder)) result.push(folder);
        }
        return result;
    }

    public getNonExcludedMarkdownFiles(): TFile[] {
        return TagUtils.getNonExcludedMarkdownFiles(this.app, this.getEffectiveExcludedFolders());
    }

    public getNonExcludedMarkdownFilesFromFolder(folder: TFolder): TFile[] {
        return TagUtils.getNonExcludedMarkdownFiles(this.app, this.getEffectiveExcludedFolders(), folder);
    }

    public async clearAllNotesTags(): Promise<void> {
        const files = this.getNonExcludedMarkdownFiles();
        if (await this.showConfirmationDialog(
            `Remove all tags from ${files.length} notes? This action cannot be undone.`
        )) {
            try {
                await this.tagOperations.clearDirectoryTags(files);
                new Notice(this.t.messages.successfullyClearedAllVault, 3000);
            } catch {
                new Notice(this.t.messages.failedToClearVaultTags, 4000);
            }
        }
    }

    public async clearNoteTags(): Promise<void> {
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile) {
            new Notice('Please open a note before clearing tags', 3000);
            return;
        }

        const result = await this.tagOperations.clearNoteTags(activeFile);
        this.handleTagUpdateResult(result);
    }

    public async clearDirectoryTags(directory: TFile[]): Promise<BatchProcessResult> {
        return this.tagOperations.clearDirectoryTags(directory);
    }

    public handleTagUpdateResult(result: TagOperationResult | null | undefined, silent = false): void {
        if (!result) {
            if (!silent) { new Notice('Failed to update tags: no result returned', 3000); }
            return;
        }

        const view = this.app.workspace.getActiveViewOfType(MarkdownView);

        if (result.success) {
            if (view?.getMode() === 'source') {
                view.editor.refresh();
            }
            this.app.workspace.trigger('layout-change');
            if (!silent) { new Notice(result.message, 3000); }
        } else {
            if (!silent) { new Notice(`Failed to update tags: ${result.message || 'Unknown error'}`, 4000); }
        }
    }

    public async analyzeAndTagFiles(files: TFile[]): Promise<void> {
        if (!files?.length) return;

        this.novelDisciplineCollector = new Set();

        const t = this.t.smartTag;
        const budget = computeSmartTagBudget(files.length);
        const hardMinutes = Math.round(budget.hardBudgetMs / 60_000);
        const abortController = new AbortController();

        const statusBar = createTagProgressStatusBar(this, () => {
            if (!abortController.signal.aborted) abortController.abort();
        });
        statusBar.update(0, files.length, 0);

        const startedAt = Date.now();
        const controller = new LongRunningOpController({
            softBudgetMs: budget.softBudgetMs,
            hardBudgetMs: budget.hardBudgetMs,
            expected: files.length,
            abortController,
            onSoftBudget: (elapsedMs) => {
                const msg = (t?.softBudgetNotice || 'Still tagging — {elapsed} elapsed (hard cap {hardMinutes}m)')
                    .replace('{elapsed}', formatElapsedForNotice(elapsedMs))
                    .replace('{hardMinutes}', String(hardMinutes));
                new Notice(msg, 6000);
            },
            onHardBudget: () => {
                const msg = (t?.hardCapped || 'Tagging exceeded the {budgetMinutes}-minute budget; stopped after {done} of {total} files')
                    .replace('{budgetMinutes}', String(hardMinutes))
                    .replace('{done}', String(controller.getLastProgress()))
                    .replace('{total}', String(files.length));
                new Notice(msg, 8000);
            },
        });

        let processed = 0, successful = 0;
        let aborted = false;
        try {
            for (const file of files) {
                if (abortController.signal.aborted) { aborted = true; break; }
                try {
                    const content = await this.app.vault.read(file);
                    if (!content.trim()) { processed++; controller.recordProgress(processed); statusBar.update(processed, files.length, Date.now() - startedAt); continue; }

                    const result = await this.analyzeAndTagNote(file, content);

                    if (result.success) { successful++; }
                    this.handleTagUpdateResult(result, true);
                } catch {
                    new Notice(`Error processing ${file.path}`, 4000);
                }
                processed++;
                controller.recordProgress(processed);
                statusBar.update(processed, files.length, Date.now() - startedAt);
            }

            if (aborted) {
                const msg = (t?.cancelled || 'Tagging cancelled — {done} of {total} done')
                    .replace('{done}', String(processed))
                    .replace('{total}', String(files.length));
                new Notice(msg, 4000);
            } else {
                await this.suggestBackNovelDisciplines();
                const msg = (t?.complete || 'Tagging complete — {successful} of {total} tagged')
                    .replace('{successful}', String(successful))
                    .replace('{total}', String(files.length));
                new Notice(msg, 4000);
            }
        } catch {
            new Notice('Failed to complete batch processing', 4000);
        } finally {
            this.novelDisciplineCollector = null;
            controller.dispose();
            statusBar.dispose();
        }
    }

    public async analyzeAndTagCurrentNote(): Promise<void> {
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile) {
            new Notice('Please open a note before analyzing', 3000);
            return;
        }

        const content = await this.app.vault.read(activeFile);
        if (!content.trim()) {
            new Notice('Cannot analyze empty note', 3000);
            return;
        }

        // Temporary collector for single-note novel disciplines
        this.novelDisciplineCollector = new Set();
        try {
            const result = await this.analyzeAndTagNote(activeFile, content);
            this.handleTagUpdateResult(result);

            // Suggest-back novel disciplines
            await this.suggestBackNovelDisciplines();

            // Show suggestion modal if there are title or folder suggestions
            if (result.success && (result.suggestedTitle || result.suggestedFolder)) {
                await this.showSuggestionModal(activeFile, result.suggestedTitle, result.suggestedFolder);
            }
        } catch {
            new Notice('Failed to analyze note. Please check console for details.', 4000);
        } finally {
            this.novelDisciplineCollector = null;
        }
    }

    /**
     * Analyzes note content and applies tags using taxonomy-based approach
     * @param file - File to analyze and tag
     * @param contentOrAnalysis - Note content string or pre-analyzed LLMResponse
     * @param options - Optional settings including folder scope
     */
    public async analyzeAndTagNote(
        file: TFile,
        contentOrAnalysis: string | LLMResponse,
        options?: { folderScope?: string; onProgress?: (phase: string) => void }
    ): Promise<TagOperationResult> {
        const onProgress = options?.onProgress;
        try {
            let tags: string[];
            let suggestedTitle: string | undefined;
            let suggestedFolder: string | undefined;

            if (typeof contentOrAnalysis === 'string') {
                const content = contentOrAnalysis.trim();
                if (!content) {
                    return { success: false, message: 'Cannot analyze empty note' };
                }

                onProgress?.('Reading vault taxonomy…');
                // Get taxonomy from config service
                const taxonomyPrompt = await this.configService.getTaxonomyForPrompt();
                const excludedTags = await this.configService.getExcludedTags();

                // Build folder context if scope provided
                let folderContext: FolderContext | undefined;
                if (options?.folderScope) {
                    folderContext = buildFolderContext(this.app, options.folderScope);
                    logger.debug('Core', 'Folder scope: ' + options.folderScope);
                    logger.debug('Core', 'Folder context:', folderContext);
                }

                // Build the prompt with optional folder context
                const prompt = buildTaxonomyTagPrompt(
                    content,
                    taxonomyPrompt,
                    this.settings.maxTags,
                    this.settings.language,
                    folderContext
                );

                onProgress?.('Analysing note with AI…');
                // Get tags from LLM — routed through the Azure fast/triage
                // deployment when configured (Phase 3), else the main service.
                const taggingService = await this.getTaggingService();
                const response = await withBusyIndicator(this, () => taggingService.generateTags(prompt));

                if (!response.success || !response.tags) {
                    return { success: false, message: response.error || 'Failed to generate tags' };
                }

                // Format tags
                tags = TagUtils.formatTags(response.tags);

                // Taxonomy guardrail: validate theme & discipline
                let taxonomy;
                if (this.settings.enableTaxonomyGuardrail) {
                    onProgress?.('Validating against taxonomy…');
                    taxonomy = await this.configService.getTaxonomy();
                    const guardrailResult = await this.taxonomyGuardrailService.validateTags(
                        tags, taxonomy, this.llmService
                    );

                    if (!guardrailResult.success) {
                        logger.debug('Core', 'Guardrail failed:', guardrailResult.error);
                        return { success: false, message: guardrailResult.error || this.t.messages.taxonomyGuardrailSkipped };
                    }

                    tags = guardrailResult.tags;

                    // Collect novel disciplines for batch suggest-back
                    if (guardrailResult.discipline.classification === 'novel' && this.novelDisciplineCollector) {
                        this.novelDisciplineCollector.add(guardrailResult.discipline.resolved);
                    }

                    logger.debug('Core', 'Guardrail result:', {
                        theme: guardrailResult.theme,
                        discipline: guardrailResult.discipline,
                        usedLLMRepair: guardrailResult.usedLLMRepair
                    });
                }

                // Enforce tag constraints (maxTags, dedup) — always runs, even without taxonomy guardrail
                // Topic validation only runs when taxonomy is available
                const enforcement = this.taxonomyGuardrailService.enforceTagConstraints(tags, {
                    maxTags: this.settings.maxTags,
                    taxonomy
                });
                tags = enforcement.data;

                if (enforcement.issues.length > 0) {
                    logger.debug('Core', 'Tag enforcement:', enforcement.issues);
                }

                // Filter out excluded tags (only topics at positions 2+, never theme/discipline)
                const excludedSet = new Set(excludedTags.map(t => t.toLowerCase()));
                tags = tags.filter((tag, index) => {
                    if (index < 2) return true;
                    return !excludedSet.has(tag.toLowerCase());
                });

                // Capture title and folder suggestions
                suggestedTitle = response.suggestedTitle;
                suggestedFolder = response.suggestedFolder;

                logger.debug('Core', 'Generated tags:', tags);
                logger.debug('Core', 'Suggested title:', suggestedTitle);
                logger.debug('Core', 'Suggested folder:', suggestedFolder);
            } else {
                // Use provided analysis (backward compatibility)
                const analysis = contentOrAnalysis;
                tags = [...(analysis.suggestedTags || []), ...(analysis.matchedExistingTags || [])];
                tags = TagUtils.formatTags(tags);
            }

            if (tags.length === 0) {
                return { success: false, message: 'No valid tags were generated' };
            }

            // Update the note with tags
            const result = await TagUtils.updateNoteTags(
                this.app,
                file,
                tags,
                [],
                false,
                this.settings.replaceTags
            );

            // Add suggestions to result
            result.suggestedTitle = suggestedTitle;
            result.suggestedFolder = suggestedFolder;

            logger.debug('Core', 'Update result:', result);

            return result;
        } catch (error) {
            return {
                success: false,
                message: error instanceof Error ? error.message : 'Unknown error occurred'
            };
        }
    }

    /**
     * Suggest-back novel disciplines: append unique new disciplines to taxonomy.md
     * Called after single-note or batch tagging completes.
     */
    private async suggestBackNovelDisciplines(): Promise<void> {
        if (!this.novelDisciplineCollector || this.novelDisciplineCollector.size === 0) return;
        if (!this.settings.autoAddNovelDisciplines) return;

        const entries = Array.from(this.novelDisciplineCollector).map(name => ({
            name,
            description: `Auto-discovered from note content`,
            useWhen: `Content related to ${name}`
        }));

        const added = await this.configService.appendDisciplines(entries);

        if (added > 0) {
            const names = Array.from(this.novelDisciplineCollector).slice(0, 3).join(', ');
            const suffix = this.novelDisciplineCollector.size > 3 ? '...' : '';
            new Notice(`${this.t.messages.novelDisciplinesAdded}: ${names}${suffix}`, 6000);
        }
    }

    /**
     * Shows the suggestion modal and applies user-selected changes
     */
    public async showSuggestionModal(file: TFile, suggestedTitle?: string, suggestedFolder?: string): Promise<void> {
        if (!suggestedTitle && !suggestedFolder) {
            return;
        }

        return new Promise((resolve) => {
            const modal = new SuggestionModal(
                this.app,
                this.t,
                file,
                suggestedTitle || '',
                suggestedFolder || '',
                (result: SuggestionResult | null) => { void (async () => {
                    if (result) {
                        await this.applySuggestions(file, result);
                    }
                    resolve();
                })(); }
            );
            modal.open();
        });
    }

    /**
     * Applies the user-selected title and folder suggestions
     */
    private async applySuggestions(file: TFile, suggestions: SuggestionResult): Promise<void> {
        try {
            let currentFile = file;

            // Apply folder change first (if selected)
            if (suggestions.applyFolder && suggestions.folder) {
                const newFolder = suggestions.folder;

                // Create folder if it doesn't exist
                const folderExists = this.app.vault.getAbstractFileByPath(newFolder);
                if (!folderExists) {
                    await this.app.vault.createFolder(newFolder);
                }

                // Move file to new folder
                const newPath = `${newFolder}/${file.name}`;
                await this.app.fileManager.renameFile(file, newPath);

                // Update reference to the moved file
                const movedFile = this.app.vault.getAbstractFileByPath(newPath);
                if (movedFile instanceof TFile) {
                    currentFile = movedFile;
                }

                logger.debug('Core', `Moved file to: ${newPath}`);
            }

            // Apply title change (if selected)
            if (suggestions.applyTitle && suggestions.title) {
                const newTitle = suggestions.title;
                const sanitizedTitle = newTitle.replace(/[\\/:*?"<>|]/g, '-');
                const folder = currentFile.parent?.path || '';
                const newPath = folder ? `${folder}/${sanitizedTitle}.md` : `${sanitizedTitle}.md`;

                // Check if a file with this name already exists
                const existingFile = this.app.vault.getAbstractFileByPath(newPath);
                if (existingFile && existingFile !== currentFile) {
                    new Notice(this.t.messages.fileAlreadyExists || `A file named "${sanitizedTitle}.md" already exists`, 4000);
                    return;
                }

                await this.app.fileManager.renameFile(currentFile, newPath);

                logger.debug('Core', `Renamed file to: ${newPath}`);
            }

            new Notice(this.t.messages.suggestionsApplied || 'Suggestions applied successfully', 3000);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            new Notice(`${this.t.messages.failedToApplySuggestions || 'Failed to apply suggestions'}: ${errorMessage}`, 4000);
        }
    }
}

function formatElapsedForNotice(ms: number): string {
    const totalSec = Math.floor(ms / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    return min > 0 ? `${min}m ${sec.toString().padStart(2, '0')}s` : `${sec}s`;
}
