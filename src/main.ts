import { addIcon, App, debounce, MarkdownView, Notice, Platform, Plugin, TFile, TFolder } from 'obsidian';
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
import { IEmbeddingService, createEmbeddingServiceFromSettings } from './services/embeddings';
import { AdapterType } from './services/adapters';
import cloudEndpoints from './services/adapters/cloudEndpoints.json';
import { EMBEDDING_PROVIDER_TO_SECRET_ID, PLUGIN_SECRET_IDS } from './core/secretIds';
import { SourcePackService } from './services/notebooklm/sourcePackService';
import { DEFAULT_PDF_CONFIG } from './services/notebooklm/types';
import type { SourcePackConfig } from './services/notebooklm/types';
import { buildFolderContext, FolderContext } from './utils/folderContextUtils';
import { resetBusyState, withBusyIndicator } from './utils/busyIndicator';
import { TaxonomyGuardrailService } from './services/taxonomyGuardrailService';
import { MermaidChangeDetector } from './services/mermaidChangeDetector';
import { findAllMermaidBlocks } from './utils/mermaidUtils';
import { mermaidStalenessGutterExtension } from './ui/editor/mermaidStalenessGutter';
import { NewsletterService, LAST_FETCH_DATA_KEY } from './services/newsletter/newsletterService';
import { showNewsletterFetchResultNotice } from './commands/newsletterCommands';

export default class AIOrganiserPlugin extends Plugin {
    public settings = {...DEFAULT_SETTINGS};
    private lastEmbeddingConfig = {
        provider: DEFAULT_SETTINGS.embeddingProvider,
        model: DEFAULT_SETTINGS.embeddingModel,
        enabled: DEFAULT_SETTINGS.enableSemanticSearch
    };
    public llmService: SummarizableLLMService;
    public configService: ConfigurationService;
    public secretStorageService: SecretStorageService;
    public basesService: BasesService;
    public embeddingService: IEmbeddingService | null = null;
    public vectorStore: IVectorStore | null = null;
    public vectorStoreService: VectorStoreService | null = null;
    public sourcePackService: SourcePackService | null = null;
    private readonly eventHandlers: EventHandlers;
    private readonly tagNetworkManager: TagNetworkManager;
    private readonly tagOperations: TagOperations;
    public t = getTranslations(this.settings.interfaceLanguage);
    public busyStatusBarEl: HTMLElement | null = null;
    public notebookLMStatusBarEl: HTMLElement | null = null;
    /** Shared change detector — persists diagram snapshots across modal sessions (§4.4.2) */
    public mermaidChangeDetector = new MermaidChangeDetector();
    private newsletterFetchTimer: ReturnType<typeof setInterval> | null = null;
    private newsletterFetching = false;
    public newsletterLastFetchTime = 0;
    public newsletterSeenIds: string[] = [];
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

    constructor(app: App, manifest: any) {
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
            enabled: this.settings.enableSemanticSearch
        };
        try {
            this.newsletterLastFetchTime = oldSettings?.[LAST_FETCH_DATA_KEY] ?? 0;
        } catch { /* best-effort */ }
        this.lastNewsletterConfig = {
            enabled: this.settings.newsletterEnabled,
            autoFetch: this.settings.newsletterAutoFetch,
            intervalMins: this.settings.newsletterAutoFetchIntervalMins,
        };
    }

    public async saveSettings(): Promise<void> {
        const embeddingSettingsChanged =
            this.settings.embeddingProvider !== this.lastEmbeddingConfig.provider ||
            this.settings.embeddingModel !== this.lastEmbeddingConfig.model ||
            this.settings.enableSemanticSearch !== this.lastEmbeddingConfig.enabled;

        const newsletterSettingsChanged =
            this.settings.newsletterEnabled !== this.lastNewsletterConfig.enabled ||
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
            enabled: this.settings.enableSemanticSearch
        };
        this.t = getTranslations(this.settings.interfaceLanguage);
        if (newsletterSettingsChanged) {
            this.startNewsletterScheduler();
        }
        this.lastNewsletterConfig = {
            enabled: this.settings.newsletterEnabled,
            autoFetch: this.settings.newsletterAutoFetch,
            intervalMins: this.settings.newsletterAutoFetchIntervalMins,
        };
    }

    /**
     * Initialize or reinitialize the embedding service based on current settings
     */
    private async initializeEmbeddingService(): Promise<void> {
        // Dispose existing embedding service
        await this.embeddingService?.dispose();
        this.embeddingService = null;

        // Only create if semantic search is enabled
        if (this.settings.enableSemanticSearch) {
            // Resolve API key from SecretStorage with inheritance chain
            const apiKey = await this.resolveEmbeddingApiKey();
            this.embeddingService = await createEmbeddingServiceFromSettings(this.settings, apiKey || undefined);

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
    private initializeSourcePackService(): void {
        const pdfConfig = {
            ...DEFAULT_PDF_CONFIG,
            pageSize: this.settings.notebooklmPdfPageSize,
            fontName: this.settings.notebooklmPdfFontName,
            fontSize: this.settings.notebooklmPdfFontSize,
            includeFrontmatter: this.settings.notebooklmPdfIncludeFrontmatter,
            includeTitle: this.settings.notebooklmPdfIncludeTitle
        };

        const config: SourcePackConfig = {
            selectionTag: this.settings.notebooklmSelectionTag,
            exportFolder: getNotebookLMExportFullPath(this.settings),
            postExportTagAction: this.settings.notebooklmPostExportTagAction,
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

    private getProviderEndpoint(type: AdapterType): string {
        if (type === 'openai-compatible') {
            return this.settings.cloudEndpoint || 'http://your-api-endpoint/v1/chat/completions';
        }
        if (type === this.settings.cloudServiceType && this.settings.cloudEndpoint) {
            return this.settings.cloudEndpoint;
        }
        const endpointMap = cloudEndpoints as Record<string, string>;
        return endpointMap[type] || this.settings.cloudEndpoint;
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
        await this.llmService?.dispose();

        let serviceType = this.settings.serviceType;
        let localEndpoint = this.settings.localEndpoint;
        let localModel = this.settings.localModel;
        let cloudType = this.settings.cloudServiceType;
        let cloudEndpoint = this.settings.cloudEndpoint;
        let cloudModel = this.settings.cloudModel;

        // Get API key from SecretStorage first, fallback to settings
        let cloudApiKey = await this.secretStorageService.getProviderKey(cloudType) ||
                          this.settings.cloudApiKey;

        if (Platform.isMobile) {
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

        this.llmService.setDebugMode(this.settings.debugMode);
        this.llmService.setSummarizeTimeout(this.settings.summarizeTimeoutSeconds);
        setGlobalDebugMode(this.settings.debugMode);
        logger.setDebugMode(this.settings.debugMode);
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
                (this.app as any).commands.executeCommandById('ai-organiser:notebooklm-export');
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

        // Initialize vector store for semantic search
        if (this.settings.enableSemanticSearch) {
            try {
                // Resolve API key from SecretStorage with inheritance chain
                const embeddingApiKey = await this.resolveEmbeddingApiKey();
                this.embeddingService = await createEmbeddingServiceFromSettings(this.settings, embeddingApiKey || undefined);

                // Create vector store service
                this.vectorStoreService = new VectorStoreService(
                    this.app,
                    this.settings,
                    this.embeddingService
                );
                this.vectorStore = await this.vectorStoreService.createVectorStore();

                // Register file event handlers for auto-indexing
                if (this.settings.autoIndexNewNotes) {
                    this.vectorStoreService.registerFileEventHandlers();
                }

                if (this.embeddingService) {
                    logger.debug('Core', `Semantic search initialized with ${this.settings.embeddingProvider}/${this.settings.embeddingModel}`);
                } else {
                    logger.debug('Core', 'Vector store initialized without embedding service - configure API key in settings');
                }
            } catch (error) {
                logger.error('Core', 'Failed to initialize vector store', error);
                new Notice('Failed to initialize semantic search: ' + (error as any).message, 5000);
            }
        }

        // Initialize NotebookLM source pack service
        this.initializeSourcePackService();

        // §4.4.2 Mermaid diagram staleness notification (opt-in)
        if (this.settings.mermaidChatStalenessNotice) {
            this.registerEvent(
                this.app.metadataCache.on('changed', debounce((file: TFile) => {
                    void this.checkDiagramStaleness(file);
                }, 5000))
            );
        }

        // §4.4.3 Mermaid staleness gutter (opt-in, desktop only)
        if (this.settings.mermaidChatStalenessGutter && !Platform.isMobile) {
            this.registerEditorExtension([mermaidStalenessGutterExtension(this)]);
        }

        this.eventHandlers.registerEventHandlers();
        this.addSettingTab(new AIOrganiserSettingTab(this.app, this));
        registerCommands(this);
        this.startNewsletterScheduler();

        // Register tag network view
        this.registerView(
            TAG_NETWORK_VIEW_TYPE,
            (leaf) => new TagNetworkView(leaf, this.tagNetworkManager, () => this.getNonExcludedMarkdownFiles(), this)
        );

        // Register related notes view
        this.registerView(
            RELATED_NOTES_VIEW_TYPE,
            (leaf) => new RelatedNotesView(leaf, this)
        );

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

        this.addRibbonIcon(
            'tags',
            this.t.messages.analyzeTagCurrentNote,
            () => this.analyzeAndTagCurrentNote()
        );

        this.addRibbonIcon(
            'git-graph',
            this.t.messages.viewTagNetwork,
            () => this.showTagNetwork()
        );
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
                (this.app as any).commands.executeCommandById('ai-organiser:edit-mermaid-diagram');
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
        if (!this.settings.newsletterAutoFetch || !this.settings.newsletterEnabled) {
            logger.debug('Newsletter', `Scheduler skipped: enabled=${this.settings.newsletterEnabled}, autoFetch=${this.settings.newsletterAutoFetch}`);
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
        if (!this.settings.newsletterEnabled || !this.settings.newsletterScriptUrl?.trim()) {
            logger.debug('Newsletter', `Scheduled fetch skipped: enabled=${this.settings.newsletterEnabled}, hasUrl=${!!this.settings.newsletterScriptUrl?.trim()}`);
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
        void this.llmService?.dispose();
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
            (this.app as any).commands.executeCommandById(commandId);
        });

        const modal = new CommandPickerModal(this.app, this.t, categories);
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
            new Notice(this.t.messages.failedToBuildNetwork + ': ' + (error as any).message, 4000);
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
            } catch (_error) {
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
            if (!silent) { new Notice('Failed to update tags: No result returned', 3000); } // eslint-disable-line obsidianmd/ui/sentence-case
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

        const statusNotice = new Notice(`Analyzing ${files.length} files...`, 0);
        // Start collecting novel disciplines for batch suggest-back
        this.novelDisciplineCollector = new Set();

        try {
            let processed = 0, successful = 0;
            let lastNotice = Date.now();

            for (const file of files) {
                try {
                    const content = await this.app.vault.read(file);
                    if (!content.trim()) continue;

                    const result = await this.analyzeAndTagNote(file, content);

                    if (result.success) { successful++; }
                    this.handleTagUpdateResult(result, true);
                    processed++;

                    if (Date.now() - lastNotice >= 15000) {
                        new Notice(`Progress: ${processed}/${files.length} files processed`, 3000);
                        lastNotice = Date.now();
                    }
                } catch (_error) {
                    new Notice(`Error processing ${file.path}`, 4000);
                }
            }

            // Suggest-back novel disciplines at end of batch
            await this.suggestBackNovelDisciplines();

            new Notice(`Successfully tagged ${successful} out of ${files.length} files`, 4000);
        } catch (_error) {
            new Notice('Failed to complete batch processing', 4000);
        } finally {
            this.novelDisciplineCollector = null;
            statusNotice.hide();
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
        } catch (_error) {
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
        options?: { folderScope?: string }
    ): Promise<TagOperationResult> {
        try {
            let tags: string[];
            let suggestedTitle: string | undefined;
            let suggestedFolder: string | undefined;

            if (typeof contentOrAnalysis === 'string') {
                const content = contentOrAnalysis.trim();
                if (!content) {
                    return { success: false, message: 'Cannot analyze empty note' };
                }

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

                // Get tags from LLM
                const response = await withBusyIndicator(this, () => this.llmService.generateTags(prompt));

                if (!response.success || !response.tags) {
                    return { success: false, message: response.error || 'Failed to generate tags' };
                }

                // Format tags
                tags = TagUtils.formatTags(response.tags);

                // Taxonomy guardrail: validate theme & discipline
                let taxonomy;
                if (this.settings.enableTaxonomyGuardrail) {
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
