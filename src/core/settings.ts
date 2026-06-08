import { LanguageCode } from '../services/types';
import { AdapterType } from '../services/adapters';
import { SupportedLanguage, DEFAULT_LANGUAGE } from '../i18n';
import { DEFAULT_MAX_DOCUMENT_CHARS, DEFAULT_MULTI_SOURCE_MAX_DOCUMENT_CHARS, OversizedBehavior, MinutesStyle, DEFAULT_MINUTES_STYLE, MEDIA_SIZE_WARN_BYTES, DEFAULT_RECORDING_FOLDER } from './constants';
import type { KindleSyncState } from '../services/kindle/kindleTypes';
import { FEATURE_REGISTRY, type FeatureId } from './features';
import type { AzureCapabilityId, AzureCapabilityChoice } from '../services/azure/azureCapabilities';

// Per-provider settings storage - API keys and models persist when switching providers
export interface ProviderSettings {
    apiKey?: string;
    model?: string;
}

export interface ProviderSettingsMap {
    openai?: ProviderSettings;
    gemini?: ProviderSettings;
    deepseek?: ProviderSettings;
    aliyun?: ProviderSettings;
    claude?: ProviderSettings;
    groq?: ProviderSettings;
    vertex?: ProviderSettings;
    openrouter?: ProviderSettings;
    bedrock?: ProviderSettings;
    requesty?: ProviderSettings;
    cohere?: ProviderSettings;
    grok?: ProviderSettings;
    mistral?: ProviderSettings;
    'openai-compatible'?: ProviderSettings;
    'azure-claude'?: ProviderSettings;
    'azure-openai'?: ProviderSettings;

}

// Legacy interface kept for backward compatibility during migration
export interface ProviderApiKeys {
    openai?: string;
    gemini?: string;
    deepseek?: string;
    aliyun?: string;
    claude?: string;
    groq?: string;
    vertex?: string;
    openrouter?: string;
    bedrock?: string;
    requesty?: string;
    cohere?: string;
    grok?: string;
    mistral?: string;
    'openai-compatible'?: string;
}

export interface AIOrganiserSettings {
    serviceType: 'local' | 'cloud';
    localEndpoint: string;
    localModel: string;
    localServiceType?: 'ollama' | 'lm_studio' | 'localai' | 'openai_compatible';
    cloudEndpoint: string;
    cloudApiKey: string;
    cloudModel: string;
    cloudServiceType: AdapterType;
    // Per-provider settings storage - keys and models persist when switching providers
    providerSettings: ProviderSettingsMap;
    // Legacy field - kept for backward compatibility during migration
    providerApiKeys?: ProviderApiKeys;
    excludedFolders: string[];
    language: LanguageCode;
    interfaceLanguage: SupportedLanguage;
    replaceTags: boolean;
    enableTaxonomyGuardrail: boolean;    // Validate theme/discipline against taxonomy after LLM response
    autoAddNovelDisciplines: boolean;    // Auto-add novel disciplines to taxonomy.md
    maxTags: number;                     // Maximum number of tags to generate
    autoEnsureNoteStructure: boolean;    // Ensure References/Pending Integration sections after commands
    debugMode: boolean;
    // Web Summarization Settings
    enableWebSummarization: boolean;
    summaryLength: 'brief' | 'standard' | 'detailed';
    summaryLanguage: string;
    includeSummaryMetadata: boolean;
    defaultSummaryPersona: string;       // Default persona ID for summarization
    enableStudyCompanion: boolean;       // Create study companion notes alongside summaries
    // Transcript Settings
    saveTranscripts: 'none' | 'file';    // Whether to save full transcripts
    transcriptFolder: string;            // Subfolder for transcript files (under pluginFolder)
    // Advanced Summarization Settings
    summarizeTimeoutSeconds: number;     // Timeout for summarization requests (default: 120s)
    // Multi-source document settings
    multiSourceMaxDocumentChars: number; // Default: 100000
    multiSourceOversizedBehavior: 'truncate' | 'full' | 'ask'; // Default: 'full'
    // Meeting Minutes Settings
    minutesOutputFolder: string;         // Folder for meeting minutes notes
    /** Folder for transcript-only notes produced by the Transcribe Audio command (plan F3, R3 H4) */
    transcriptOutputFolder: string;
    minutesDefaultTimezone: string;      // Default timezone for meetings
    minutesStyle: MinutesStyle;          // Minutes output style (Phase 2 TRA)
    minutesObsidianTasksFormat: boolean; // Add actions as Obsidian Tasks
    minutesGTDOverlay: boolean;              // GTD-style action classification overlay
    enableSpeakerLabelling: boolean;          // LLM speaker-labelling pre-pass (Phase 4 TRA)
    audioDiarisationProvider: 'none' | 'assemblyai' | 'deepgram'; // Diarisation provider (v2: 'deepgram' enabled; 'assemblyai' reserved)
    deepgramApiKey?: string;             // Deepgram key — transient; migrated to SecretStorage on save
    maxDocumentChars: number;            // Minutes: max document size before truncation
    oversizedDocumentBehavior: 'truncate' | 'full' | 'ask'; // Minutes: oversized behavior
    // Export Settings (DOCX/PPTX)
    exportOutputFolder: string;          // Folder for exported documents
    exportFontFace: string;              // Font family for PPTX/DOCX exports
    exportFontSize: number;              // Body font size in points (10–18)
    exportColorScheme: string;           // Preset name or 'custom'
    exportPrimaryColor: string;          // Hex (no #) — used when exportColorScheme = 'custom'
    exportAccentColor: string;           // Hex (no #) — used when exportColorScheme = 'custom'
    exportMinFontBody: number;           // Universal min-font floor (pt) for body text on export
    exportMinFontCaption: number;        // Universal min-font floor (pt) for captions on export
    exportMinFontTable: number;          // Universal min-font floor (pt) for table text on export
    // Flashcard Settings
    flashcardFolder: string;             // Subfolder for flashcard exports (under pluginFolder)
    flashcardProvider: 'main' | AdapterType;  // LLM provider for flashcards ('main' = use main provider)
    flashcardModel: string;                    // Model override for flashcard provider (empty = provider default)
    // Plugin Folder Settings (unified structure)
    pluginFolder: string;                // Main plugin folder (contains Config, Transcripts, Flashcards)
    outputRootFolder: string;            // Root folder for generated output (empty = use pluginFolder)
    configFolderPath: string;            // Subfolder for config files (under pluginFolder)
    lastSummarizeSource: 'note' | 'url' | 'pdf' | 'youtube' | 'audio';

    // === CHAT EXPORT SETTINGS ===
    chatExportFolder: string;           // Subfolder under pluginFolder for chat exports
    aichatRefinementPasses: 1 | 2;       // Number of refinement passes in presentation build
    aichatBrandToggleDefault: boolean;   // Whether brand toggle is on by default
    presentationGroundWebSearch: boolean; // LLM-ground presentation web-search queries in attached notes + prompt (sends note-derived terms to the search provider)
    presentationConsultantMode: boolean; // DEFAULT for the per-deck "Plan" pill: when true a new presentation defaults to storyline-first (dot-dash) instead of straight-to-slides. The actual per-deck choice lives in CreationConfig.planMode; this is only the seed.
    presentationStorylineGate: 'review' | 'auto-build'; // When the deck's Plan = storyline: 'review' writes the dot-dash storyline note for sign-off first; 'auto-build' goes straight to slides
    // Per-role model selection for the consultant pipeline (plan Cluster B). Each value is a
    // provider id (CloudServiceType) or null = "Main" (use the configured main provider). The
    // concrete model resolves via the capability resolver + latest-* sentinel (so it can't rot).
    presentationModelRoles: { storyboardGenerator: string | null; independentCritic: string | null };
    presentationOutputFolder: string;    // Subfolder under pluginFolder for presentation exports (HTML/PPTX)
    presentationBrandGuidelinesPath: string; // DEPRECATED (Plan B): read-only migration source for brandFolderPath; no UI
    // === BRAND FIDELITY (Plan B) ===
    brandFolderPath: string;             // Vault folder holding brand-guidelines.md + logo-*.png + icons/
    onBrandByDefault: boolean;           // Apply the brand theme to exports by default
    presentationExportEngine: 'structured-ir'; // Only the structured-IR engine remains (legacy HTML retired 2026-06; migrateOldSettings coerces stored 'html-legacy')
    // Slides side-rail workspace layout (per-device UI prefs). railWidthPx is the
    // user's RAW chosen width — clamped only at apply time so a large-monitor
    // preference survives a temporary open on a small screen.
    presLayout: {
        railCollapsed: boolean;
        railWidthPx: number;       // raw; default 360 (= PRES_RAIL_DEFAULT_PX)
        filmstripCollapsed: boolean;
    };

    // === CHAT PERSISTENCE & PROJECTS ===
    chatRootFolder: string;              // Root folder for conversations and projects (default: 'AI Chat')
    enableChatPersistence: boolean;      // Auto-save conversations to vault
    chatAutoCompaction: boolean;         // Smart compaction vs hard truncation
    chatRetentionDays: number;           // Auto-prune inbox conversations (0 = never)

    // === CANVAS SETTINGS ===
    canvasOutputFolder: string;         // Subfolder under pluginFolder
    webReaderOutputFolder: string;      // Subfolder under pluginFolder for Web Reader notes
    canvasOpenAfterCreate: boolean;     // Open canvas file after creation
    canvasEnableEdgeLabels: boolean;    // Use LLM for edge labels (Investigation Board)
    canvasUseLLMClustering: boolean;    // Use LLM for cluster grouping (Cluster Board)

    // === MERMAID CHAT SETTINGS (Phase 4) ===
    mermaidChatIncludeNoteContext: boolean;   // Send current note heading path to LLM
    mermaidChatIncludeBacklinks: boolean;     // Include backlink titles in context
    mermaidChatIncludeRAG: boolean;           // Use semantic search context (requires enableSemanticSearch)
    mermaidChatRAGChunks: number;             // Number of RAG chunks to include (1-10)
    mermaidChatStalenessNotice: boolean;      // Show notice when diagram may be stale after note edits
    mermaidChatStalenessGutter: boolean;      // Show gutter indicator next to stale diagrams
    mermaidChatGenerateAltText: boolean;      // Auto-generate alt text on PNG export
    mermaidChatExportTheme: 'default' | 'dark' | 'forest' | 'neutral';  // Theme for SVG/PNG render
    mermaidChatExportScale: number;           // PNG pixel density multiplier (1-4)
    
    // === SEMANTIC SEARCH SETTINGS ===
    enableSemanticSearch: boolean;       // Master toggle for semantic search features
    
    // Embedding Provider Configuration
    // Note: Claude does not offer embedding APIs, so it's not a valid embedding provider
    embeddingProvider: 'openai' | 'gemini' | 'ollama' | 'openrouter' | 'cohere' | 'voyage' | 'local-onnx';
    embeddingModel: string;              // e.g., 'text-embedding-3-small', 'nomic-embed-text'
    embeddingApiKey: string;             // May differ from chat API key
    embeddingEndpoint: string;           // For local providers (Ollama URL)
    
    // Indexing Options
    autoIndexNewNotes: boolean;          // Auto-index notes on create/modify
    useSharedExcludedFolders: boolean;   // Use same excluded folders as tagging
    indexExcludedFolders: string[];      // Folders to skip during indexing (when not using shared)
    maxChunksPerNote: number;            // Limit chunks per note (default: 10)
    chunkSize: number;                   // Characters per chunk (default: 2000)
    chunkOverlap: number;                // Overlap characters (default: 200)
    
    // Search & RAG Settings
    enableVaultChat: boolean;            // Enable Chat with Vault (RAG) - Phase 2
    ragContextChunks: number;            // How many chunks to include in context (default: 5)
    ragIncludeMetadata: boolean;         // Include file path, headings in context
    relatedNotesCount: number;           // How many related notes to show (default: 15)

    // === OBSIDIAN BASES INTEGRATION ===
    enableStructuredMetadata: boolean;   // Use structured frontmatter properties for Bases
    includeModelInMetadata: boolean;     // Track which LLM model was used
    autoDetectContentType: boolean;      // Auto-classify content type

    // Mobile Settings
    mobileProviderMode: 'auto' | 'cloud-only' | 'custom';
    mobileFallbackProvider: AdapterType;
    mobileFallbackModel: string;
    mobileCustomEndpoint: string;
    mobileIndexingMode: 'disabled' | 'read-only' | 'full';
    mobileIndexSizeLimit: number;        // Max index size (MB) before skipping load

    // === NOTEBOOKLM INTEGRATION ===
    notebooklmSelectionTag: string;      // Tag to mark notes for export (default: 'notebooklm')
    notebooklmExportFolder: string;      // Root folder for pack exports (under pluginFolder)
    /**
     * After export action — what happens to the selection tag once a NotebookLM
     * source pack is exported. UX-09: 'keep' was added in April 2026 because
     * users building persistent collections were having their selection erased
     * on every export. New installs default to 'keep'; existing users keep
     * whatever value they already have stored (passive default-merge migration —
     * no active rewrite of stored 'clear' values).
     */
    notebooklmPostExportTagAction: 'keep' | 'clear' | 'archive';
    notebooklmExportFormat: 'text' | 'pdf';  // 'text' = clean .txt (default); 'pdf' = legacy jsPDF

    // Content settings (apply to both text and PDF formats)
    notebooklmIncludeFrontmatter: boolean;
    notebooklmIncludeTitle: boolean;

    // PDF-specific generation settings (only used when notebooklmExportFormat === 'pdf')
    notebooklmPdfPageSize: 'A4' | 'Letter' | 'Legal';
    notebooklmPdfFontName: string;
    notebooklmPdfFontSize: number;

    // === YOUTUBE SETTINGS ===
    // Gemini-native YouTube processing (more reliable than transcript scraping)
    youtubeGeminiApiKey: string;         // Dedicated Gemini key for YouTube (uses main key if provider is Gemini)
    youtubeGeminiModel: string;          // Gemini model for YouTube (default: latest-flash — auto-tracks newest)

    // === PDF SETTINGS ===
    // PDF processing requires multimodal models (Claude or Gemini only)
    pdfProvider: 'claude' | 'gemini' | 'auto';  // Which provider to use for PDFs
    pdfApiKey: string;                   // Dedicated API key for PDF provider (empty = use main key if compatible)
    pdfModel: string;                    // Model to use for PDF processing

    // === AUDIO TRANSCRIPTION SETTINGS ===
    // Whisper API for audio transcription (OpenAI or Groq)
    audioTranscriptionApiKey: string;    // Dedicated key for transcription (uses main key if provider supports Whisper)
    audioTranscriptionProvider: 'openai' | 'groq';  // Which Whisper provider to use

    // === RECORDING SETTINGS ===
    autoTranscribeRecordings: boolean;    // Auto-transcribe recordings under 25MB
    embedAudioInNote: boolean;            // Embed audio file link in note alongside transcript
    recordingQuality: 'speech' | 'high'; // 64kbps (speech) or 128kbps (high quality)
    postRecordingStorage: 'ask' | 'keep-original' | 'keep-compressed' | 'delete'; // What to do with raw audio after transcription

    // === KINDLE SETTINGS ===
    kindleOutputFolder: string;              // Subfolder under pluginFolder (default: 'Kindle')
    kindleAmazonRegion: string;              // Amazon domain suffix (default: 'com')
    kindleAutoTag: boolean;                  // Run AI tagging after import (default: true)
    kindleHighlightStyle: 'blockquote' | 'callout' | 'bullet';  // How highlights render
    kindleGroupByColor: boolean;             // Group highlights by color (default: false)
    kindleIncludeCoverImage: boolean;        // Embed cover image in note (default: true)
    kindleSyncState: KindleSyncState;        // Persisted sync state for differential sync
    // NOTE: Bright Data API key and Amazon cookies stored in SecretStorage, not here

    // === RESEARCH ASSISTANT SETTINGS ===
    researchProvider: 'tavily' | 'brightdata-serp' | 'claude-web-search';
    researchOutputFolder: string;
    researchPreferredSites: string;
    researchExcludedSites: string;
    researchDefaultOutput: 'cursor' | 'section' | 'pending';
    researchIncludeCitations: boolean;
    // Phase 3: Usage guardrails
    enableResearchUsageGuardrails: boolean;
    researchMonthlyBudgetUsd: number;
    researchWarnThresholdPercent: number;
    researchBlockAtLimit: boolean;
    // Phase 3: Quality scoring
    enableResearchQualityScoring: boolean;
    // Phase 3: Academic mode
    researchCitationStyle: 'numeric' | 'author-year';
    // Phase 3: Vault pre-check
    enableResearchVaultPrecheck: boolean;
    researchVaultPrecheckMinSimilarity: number;
    // Phase 3: Multi-perspective
    enableResearchPerspectiveQueries: boolean;
    researchPerspectivePreset: 'balanced' | 'critical' | 'historical' | 'custom';
    researchCustomPerspectives: string;
    // Claude Web Search settings
    researchClaudeMaxSearches: number;              // Max searches per request (cost control)
    researchClaudeUseDynamicFiltering: boolean;     // Dynamic filtering (requires Claude 4.6)
    // Phase 3: Feature-flagged (Track B)
    enableResearchStreamingSynthesis: boolean;
    enableResearchZoteroIntegration: boolean;
    researchZoteroCollection: string;

    // === SMART DIGITISATION SETTINGS (Phase 3) ===
    digitiseDefaultMode: 'auto' | 'handwriting' | 'diagram' | 'whiteboard' | 'mixed';  // Default digitisation mode
    digitiseMaxDimension: number;         // Max image dimension for vision LLM (default: 1536px)
    digitiseImageQuality: number;         // JPEG quality 0.1-1.0 (default: 0.85)

    // === SKETCH PAD SETTINGS (Phase 4) ===
    sketchOutputFolder: string;           // Where sketch PNG files are saved
    sketchAutoDigitise: boolean;          // Auto-run digitise command after saving
    sketchDefaultPenColour: string;       // Default pen color
    sketchDefaultPenWidth: number;        // Default pen width (1-8)

    // === MEDIA COMPRESSION SETTINGS (Phase 5) ===
    offerMediaCompression: 'always' | 'large-files' | 'never';  // When to offer vault replacement after processing
    mediaCompressionThreshold: number;    // Size threshold (bytes) for 'large-files' mode

    // === PERSONA SCHEMA VERSION ===
    // Tracks which generation of default persona config files the user has.
    // Bumped when default personas change — triggers config file migration on next load.
    personaSchemaVersion: number;

    // === REVIEWED EDITS ===
    enableReviewedEdits: boolean;                // Show diff preview before modifying notes (default: true)

    // === LLM AUDIT SETTINGS ===
    enableLLMAudit: boolean;                     // Feature flag for optional LLM audit layer (default: false)
    auditProvider: 'main' | AdapterType;         // Which provider to use for audit calls (default: 'main')
    auditModel: string;                          // Model override for audit provider (empty = provider default)

    // === QUICK PEEK SETTINGS ===
    quickPeekProvider: 'main' | AdapterType;     // Which provider to use for quick peek triage (default: 'main')
    quickPeekModel: string;                      // Model override for quick peek provider (empty = provider default)

    // === CLAUDE THINKING MODE ===
    // Controls adaptive thinking for Claude Opus 4.6
    claudeThinkingMode: 'standard' | 'adaptive';  // standard = no thinking, adaptive = Claude decides when to think

    // === FEATURE TOGGLES (outer feature flags — distinct from inner enable* configs) ===
    /** Per-feature on/off. Absent/undefined entries resolve to the registry's defaultOn (FT-3 coalesce). */
    featureFlags: Partial<Record<FeatureId, boolean>>;
    /** Once-only marker for the first-run "new Features section" Notice (L2). */
    featuresIntroShown: boolean;

    // === NEWSLETTER DIGEST ===
    newsletterEnabled: boolean;
    newsletterSource: 'apps-script' | 'gmail-api';
    newsletterScriptUrl: string;
    newsletterOutputFolder: string;
    newsletterAutoTag: boolean;
    newsletterGmailLabel: string;
    newsletterAutoFetch: boolean;
    newsletterAutoFetchIntervalMins: number;  // 30 | 60 | 120 | 360 | 720 | 1440
    newsletterFetchLimit: number;   // threads per fetch (default 20)
    newsletterPreferredLanguage: string; // '' = same as source, else ISO code (e.g., 'en', 'zh-cn')
    newsletterDailyBrief: boolean;       // Synthesise a deduplicated daily brief at top of digest
    newsletterAudioPodcast: boolean;     // Generate TTS audio from the daily brief (requires Gemini)
    newsletterPodcastVoice: string;      // Gemini TTS voice name: 'Charon' | 'Puck' | 'Kore'
    newsletterPodcastMaxMins: number;   // Maximum podcast length in minutes (1-15, default 5)
    newsletterBriefCutoffHour: number;  // Hour (0-23) when "today" rolls over for brief grouping
    newsletterRetentionDays: number;    // Days to keep newsletter notes (0 = keep forever)

    // === AUDIO NARRATION ===
    audioNarrationProvider: 'gemini';                                    // v1: Gemini only; v1.1 expands to other TTS providers
    audioNarrationVoice: string;                                         // Voice id (default 'Charon')
    audioNarrationOutputFolder: string;                                  // Subfolder under output root
    audioNarrationEmbedInNote: boolean;                                  // Embed 🎧 link at top of source note
    audioNarrationCodeBlockMode: 'placeholder' | 'omit' | 'read-inline'; // Transformer behaviour for fenced code
    audioNarrationTableMode: 'row-prose' | 'header-summary' | 'omit';    // Transformer behaviour for tables
    audioNarrationImageMode: 'alt-text' | 'omit';                        // Transformer behaviour for images
    // LLM enhancement pre-pass (off by default — zero behaviour change)
    audioNarrationLlmEnhancement: 'off' | 'on';                          // Master toggle for LLM markdown enhancement before TTS
    audioNarrationLlmProvider: 'gemini' | 'haiku';                       // Which LLM provider performs the enhancement
    llmEnhancerGeminiApiKey?: string;                                    // Transient — migrated to SecretStorage on save
    llmEnhancerAnthropicApiKey?: string;                                 // Transient — migrated to SecretStorage on save
    llmEnhancerReuseYoutubeKey: boolean;                                 // Fall back to YouTube Gemini key if no dedicated key configured

    // === COMMAND PICKER ===
    /** User-configurable Pinned list — up to 5 favourite command IDs promoted
     *  to the top "Pinned" category in the picker. Empty array means use the
     *  static default (chat / search / quick-peek). Renamed from the legacy
     *  `pickerEssentialsCommandIds` (migrateOldSettings copies it forward). */
    pickerPinnedCommandIds: string[];
    /** Persisted set of category IDs the user has expanded in the picker.
     *  Defaults to ['pinned'] only — other categories collapsed.
     *  Updated on toggle so picker remembers preference across opens. */
    pickerExpandedCategoryIds: string[];

    // === SECRET STORAGE ===
    // SecretStorage API integration (Obsidian 1.11+)
    secretStorageMigrated: boolean;      // Whether keys have been migrated to SecretStorage

    // === AZURE AI FOUNDRY (Plan A — Azure providers) ===
    /** Azure-first mode is UX-ONLY (plan AD-6): when true, the settings UI promotes
     *  the Azure section and collapses the other providers. It does NOT route
     *  requests — actual routing stays driven by `cloudServiceType` + per-task
     *  provider selection. Vault-local; default off. */
    azureFirstMode: boolean;
    /** The non-Azure ("personal") provider the user was on before they enabled
     *  Azure-first (corporate) mode — restored on toggle-off so they return to
     *  e.g. direct Anthropic. Empty when not in / never entered Azure-first. */
    preAzureFirstProvider: string;
    /** Write-once migration input; cleared after the SecretStorage write. */
    azureApiKey: string;
    /** Soft indicator that a key lives in SecretStorage. */
    azureKeyStored: boolean;
    /** Max concurrent in-flight Azure requests (rate-limit pacing; default 4). */
    azureMaxConcurrentRequests: number;
    /** Max Azure requests started per rolling 60s (rate-limit pacing; default 60). */
    azureMaxRpm: number;
    /** One-time guard: bump stale low throttle defaults (2/10) to the post-quota-upgrade values (4/60) once, without clobbering user customisations. */
    azureThrottleDefaultsV2: boolean;
    /** One-time guard: bump the superseded Azure default model IDs to their current
     *  equivalents (gpt-5.3-chat→gpt-5.5, claude-opus-4-6→claude-opus-4-7) once. Exact-
     *  match only — never clobbers a custom deployment name. Defaults to FALSE so the
     *  guard can never persist ahead of the bump via the DEFAULT_SETTINGS merge (a
     *  default-true guard could get stuck true-without-bump if data.json is written
     *  out of band) — and so it self-heals any instance left in that state. */
    azureModelDefaultsV3: boolean;
    /** Per-deployment RPM overrides keyed by deployment NAME (Phase 2). Empty → every
     *  deployment uses azureMaxRpm. NEVER derived from TPM; the user enters their verified
     *  quotas (e.g. {"whisper":3,"gpt-4o-transcribe":10000}). Public-safe default: {}. */
    azurePerDeploymentRpm: Record<string, number>;
    /** Optional Azure fast/triage deployment names for high-volume tagging (Phase 3).
     *  Surface-matched: openai→azure-openai main, claude→azure-claude main. Empty (H4) →
     *  no fast-model routing (main model used; no regression). The user enters a tenant
     *  deployment name (e.g. { openai: 'gpt-5.4-nano' }); never assumed to exist. */
    azureFastModel: { openai?: string; claude?: string };
    /** Azure AI Foundry endpoint host (Claude) — e.g. https://<your-resource>.services.ai.azure.com */
    azureAIEndpoint: string;
    /** Azure OpenAI endpoint host (GPT/embeddings/Whisper) — e.g. https://<your-resource>.openai.azure.com */
    azureOpenAIEndpoint: string;
    /** Deployment name for audio transcription (default 'whisper'). */
    azureWhisperDeployment: string;
    /** GPT model id used by the Azure OpenAI surface. */
    azureGPTModel: string;
    /** model-based (default; model in body) vs deployment-based (deployment in URL). */
    azureRoutingMode: 'model-based' | 'deployment-based';
    /** Canonical-model-id → deployment-name mapping for deployment-based routing. */
    azureDeployments: { chat?: string; embeddings?: string };
    /** Legacy deployment-based paths (whisper + chat/embeddings) carry an api-version; override here if Azure changes it. */
    azureApiVersionOverride: { whisper?: string; chat?: string };
    /** Per-capability Azure routing (flexible Azure config). Stores ONLY the
     *  mode + (for azure) the deployment name SSOT. BYO provider/key/model live
     *  in the existing specialist settings. Consulted ONLY in Azure mode.
     *  See docs/plans/azure-capability-flexibility.md. */
    azureCapabilities: Partial<Record<AzureCapabilityId, AzureCapabilityChoice>>;
    /** Per-task model selection (concrete catalog ids; drives modelCatalog lookups). */
    taskModels: {
        tagging: string;
        summarization: string;
        audit: string;
        research: string;
        chat: string;
        mermaid: string;
        embeddings: string;
        transcription: string;
    };
}

// Main plugin folder - all subfolders are relative to this
export const DEFAULT_PLUGIN_FOLDER = 'AI-Organiser';

// Default persona IDs — single source of truth for fallback values
export const DEFAULT_SUMMARY_PERSONA_ID = 'brief';

function getDefaultTimezone(): string {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch {
        return 'UTC';
    }
}

export const DEFAULT_SETTINGS: AIOrganiserSettings = {
    serviceType: 'cloud',
    localEndpoint: 'http://localhost:11434/v1/chat/completions',
    localModel: 'mistral',
    cloudEndpoint: 'https://api.anthropic.com/v1/messages',
    cloudApiKey: '',
    cloudModel: 'latest-sonnet',
    cloudServiceType: 'claude',
    providerSettings: {},
    excludedFolders: [],
    language: 'default',
    interfaceLanguage: DEFAULT_LANGUAGE,
    replaceTags: true,
    enableTaxonomyGuardrail: true,
    autoAddNovelDisciplines: true,
    maxTags: 5,
    autoEnsureNoteStructure: true,
    debugMode: false,
    enableWebSummarization: true,
    summaryLength: 'standard',
    summaryLanguage: '',
    includeSummaryMetadata: true,
    defaultSummaryPersona: DEFAULT_SUMMARY_PERSONA_ID,
    enableStudyCompanion: false,
    saveTranscripts: 'file',
    transcriptFolder: 'Transcripts',
    summarizeTimeoutSeconds: 120,        // 2 minutes default, power users can increase
    multiSourceMaxDocumentChars: DEFAULT_MULTI_SOURCE_MAX_DOCUMENT_CHARS,
    multiSourceOversizedBehavior: 'full' as OversizedBehavior,
    minutesOutputFolder: 'Meetings',
    // F3 (R3 H4): folder under plugin root for Transcribe-audio output notes.
    transcriptOutputFolder: 'Transcripts',
    minutesDefaultTimezone: getDefaultTimezone(),
    minutesStyle: DEFAULT_MINUTES_STYLE,
    minutesObsidianTasksFormat: false,
    minutesGTDOverlay: false,
    enableSpeakerLabelling: false,
    audioDiarisationProvider: 'none',
    deepgramApiKey: '',
    maxDocumentChars: DEFAULT_MAX_DOCUMENT_CHARS,
    oversizedDocumentBehavior: 'ask' as OversizedBehavior,
    exportOutputFolder: 'Exports',
    exportFontFace: 'Noto Sans',
    exportFontSize: 14,
    exportColorScheme: 'navy-gold',
    exportPrimaryColor: '1A3A5C',
    exportAccentColor: 'F5C842',
    exportMinFontBody: 12,
    exportMinFontCaption: 10,
    exportMinFontTable: 11,
    flashcardFolder: 'Flashcards',
    flashcardProvider: 'main',
    flashcardModel: '',
    pluginFolder: DEFAULT_PLUGIN_FOLDER,
    outputRootFolder: '',                                  // Empty = use pluginFolder (backward compatible)
    configFolderPath: 'Config',
    lastSummarizeSource: 'note',

    // Chat Export Defaults
    chatExportFolder: 'Chats',
    aichatRefinementPasses: 1,
    aichatBrandToggleDefault: false,
    presentationGroundWebSearch: true,   // Automatic per user request; toggle gives privacy-conscious users an off switch
    presentationConsultantMode: false,   // Per-deck "Plan" pill default: false = new decks start "Straight to slides"; user picks "Storyline first" per deck (or flips this to default new decks to storyline)
    presentationStorylineGate: 'review', // When a deck's Plan = storyline, default to the storyline sign-off step (the consulting workflow)
    presentationModelRoles: { storyboardGenerator: null, independentCritic: null }, // null = "Main" for both roles
    presentationOutputFolder: 'Presentations',
    presentationBrandGuidelinesPath: '',
    // Brand fidelity (Plan B)
    brandFolderPath: '999_Brand',
    onBrandByDefault: false,
    // Default to the structured-IR engine (faithful PPTX). Falls back to legacy
    // HTML generation if IR generation fails, and to legacy PPTX export for
    // decks edited after generation (stale-IR guard) — so this is safe-by-default.
    presentationExportEngine: 'structured-ir',
    presLayout: { railCollapsed: false, railWidthPx: 360, filmstripCollapsed: false },

    // Chat Persistence & Projects Defaults
    chatRootFolder: 'AI Chat',
    enableChatPersistence: true,
    chatAutoCompaction: true,
    chatRetentionDays: 90,

    // Canvas Defaults
    canvasOutputFolder: 'Canvas',
    webReaderOutputFolder: 'Web Reader',
    canvasOpenAfterCreate: true,
    canvasEnableEdgeLabels: true,
    canvasUseLLMClustering: true,

    // Mermaid Chat Defaults
    mermaidChatIncludeNoteContext: true,
    mermaidChatIncludeBacklinks: false,
    mermaidChatIncludeRAG: false,
    mermaidChatRAGChunks: 3,
    mermaidChatStalenessNotice: false,
    mermaidChatStalenessGutter: false,
    mermaidChatGenerateAltText: false,
    mermaidChatExportTheme: 'default',
    mermaidChatExportScale: 2,
    
    // Semantic Search Defaults
    enableSemanticSearch: false,                        // User must opt-in
    embeddingProvider: 'openai',                        // Cloud-first default
    embeddingModel: 'text-embedding-3-small',           // OpenAI default model
    embeddingApiKey: '',                                // Will use cloudApiKey if empty and provider matches
    embeddingEndpoint: 'http://localhost:11434',       // For Ollama
    autoIndexNewNotes: true,                            // Auto-index when enabled
    useSharedExcludedFolders: true,                     // Share with tagging by default
    indexExcludedFolders: [],                           // Custom exclusions (when not shared)
    maxChunksPerNote: 10,                               // Reasonable limit
    chunkSize: 2000,                                    // ~500 tokens (char/4 approximation)
    chunkOverlap: 200,                                  // ~50 tokens overlap
    enableVaultChat: false,                             // Phase 2 feature
    ragContextChunks: 5,                                // Standard context window
    ragIncludeMetadata: true,                           // Include paths/headings
    relatedNotesCount: 15,
    
    // Bases Integration Defaults
    enableStructuredMetadata: true,                     // Enable by default
    includeModelInMetadata: true,                       // Track model usage
    autoDetectContentType: true,                        // Auto-classify content
    
    mobileProviderMode: 'auto',
    mobileFallbackProvider: 'claude',
    mobileFallbackModel: 'latest-haiku',
    mobileCustomEndpoint: '',
    mobileIndexingMode: 'read-only',
    mobileIndexSizeLimit: 50,
    
    // NotebookLM Integration Defaults
    notebooklmSelectionTag: 'notebooklm',
    notebooklmExportFolder: 'NotebookLM',
    notebooklmPostExportTagAction: 'keep',
    notebooklmExportFormat: 'text' as const,            // text = clean .txt (default)

    // Content defaults (apply to both formats)
    notebooklmIncludeFrontmatter: false,
    notebooklmIncludeTitle: true,

    // PDF-specific defaults (only used when exportFormat === 'pdf')
    notebooklmPdfPageSize: 'A4' as const,
    notebooklmPdfFontName: 'helvetica',
    notebooklmPdfFontSize: 11,

    // YouTube Defaults (Gemini-native processing)
    youtubeGeminiApiKey: '',                            // Empty = use main Gemini key if available
    youtubeGeminiModel: 'latest-flash',                  // Auto-tracks newest Flash tier

    // PDF Defaults (requires multimodal: Claude or Gemini)
    pdfProvider: 'auto',                                // Auto = use main provider if compatible, else prompt
    pdfApiKey: '',                                      // Empty = use main key if provider compatible
    pdfModel: '',                                       // Empty = use provider default

    // Audio Transcription Defaults (Whisper API)
    audioTranscriptionApiKey: '',                       // Empty = use main OpenAI/Groq key if available
    audioTranscriptionProvider: 'openai',              // OpenAI Whisper by default

    // Recording Defaults
    autoTranscribeRecordings: true,                    // Auto-transcribe under 25MB
    embedAudioInNote: true,                            // Embed audio link in note
    recordingQuality: 'speech' as const,               // Speech optimized (64kbps)
    postRecordingStorage: 'ask' as const,              // Ask user after transcription

    // Kindle Defaults
    kindleOutputFolder: 'Kindle',
    kindleAmazonRegion: 'com',
    kindleAutoTag: true,
    kindleHighlightStyle: 'blockquote' as const,
    kindleGroupByColor: false,
    kindleIncludeCoverImage: true,
    kindleSyncState: { importedHighlights: {} },

    // Research Assistant Defaults
    researchProvider: 'claude-web-search' as const,
    researchOutputFolder: 'Research',
    researchPreferredSites: '',
    researchExcludedSites: 'pinterest.com, quora.com',
    researchDefaultOutput: 'cursor' as const,
    researchIncludeCitations: true,
    // Phase 3: Usage guardrails
    enableResearchUsageGuardrails: true,
    researchMonthlyBudgetUsd: 10,
    researchWarnThresholdPercent: 80,
    researchBlockAtLimit: true,
    // Phase 3: Quality scoring
    enableResearchQualityScoring: true,
    // Phase 3: Academic mode
    researchCitationStyle: 'numeric' as const,
    // Phase 3: Vault pre-check
    enableResearchVaultPrecheck: true,
    researchVaultPrecheckMinSimilarity: 0.65,
    // Phase 3: Multi-perspective
    enableResearchPerspectiveQueries: true,
    researchPerspectivePreset: 'balanced' as const,
    researchCustomPerspectives: '',
    // Claude Web Search defaults
    researchClaudeMaxSearches: 5,
    researchClaudeUseDynamicFiltering: true,
    // Phase 3: Feature-flagged (Track B)
    enableResearchStreamingSynthesis: false,
    enableResearchZoteroIntegration: false,
    researchZoteroCollection: 'AI Organiser Research',

    // Smart Digitisation Defaults (Phase 3)
    digitiseDefaultMode: 'auto' as const,              // Auto-detect content type
    digitiseMaxDimension: 1536,                        // 1536px longest edge (good OCR quality)
    digitiseImageQuality: 0.85,                        // 85% JPEG quality

    // Sketch Pad Defaults (Phase 4)
    sketchOutputFolder: 'Sketches',
    sketchAutoDigitise: false,
    sketchDefaultPenColour: '#000000',
    sketchDefaultPenWidth: 3,

    // Media Compression Defaults (Phase 5)
    offerMediaCompression: 'large-files' as const,
    mediaCompressionThreshold: MEDIA_SIZE_WARN_BYTES,

    // Persona Schema Version
    personaSchemaVersion: 1,                             // Intentionally 1 (not CURRENT): existing users start here so migration fires on first load after upgrade

    // Reviewed Edits
    enableReviewedEdits: true,                          // Show diff before applying changes

    // LLM Audit Defaults
    enableLLMAudit: false,                              // Disabled by default (DD-5)
    auditProvider: 'main' as const,                     // Use main provider
    auditModel: '',                                     // Use provider default

    // Quick Peek Defaults
    quickPeekProvider: 'main' as const,                 // Use main provider
    quickPeekModel: '',                                 // Use provider default

    // Claude Thinking Mode Defaults
    claudeThinkingMode: 'adaptive' as const,            // Adaptive thinking for Opus 4.6

    // Feature toggles — empty map; isFeatureEnabled coalesces unset → registry.defaultOn
    // (fresh installs get the Lean set via the coalesce; migration seeds explicit flags).
    featureFlags: {},
    featuresIntroShown: false,

    // Newsletter Digest Defaults
    newsletterEnabled: false,
    newsletterSource: 'apps-script' as const,
    newsletterScriptUrl: '',
    newsletterOutputFolder: 'Newsletter Inbox',
    newsletterAutoTag: true,
    newsletterGmailLabel: 'Newsletters',
    newsletterAutoFetch: false,
    newsletterAutoFetchIntervalMins: 60,
    newsletterFetchLimit: 20,
    newsletterPreferredLanguage: 'en',
    newsletterDailyBrief: true,
    newsletterAudioPodcast: false,
    newsletterPodcastVoice: 'Charon',
    newsletterPodcastMaxMins: 5,
    newsletterBriefCutoffHour: 6,
    newsletterRetentionDays: 30,

    // Audio Narration Defaults
    audioNarrationProvider: 'gemini',
    audioNarrationVoice: 'Charon',
    audioNarrationOutputFolder: 'Narrations',
    audioNarrationEmbedInNote: true,
    audioNarrationCodeBlockMode: 'placeholder',
    audioNarrationTableMode: 'row-prose',
    audioNarrationImageMode: 'alt-text',
    audioNarrationLlmEnhancement: 'off',
    audioNarrationLlmProvider: 'gemini',
    llmEnhancerGeminiApiKey: '',
    llmEnhancerAnthropicApiKey: '',
    llmEnhancerReuseYoutubeKey: false,

    // Command picker — Pinned defaults to empty array (picker falls
    // back to static chat / search / quick-peek defaults).
    pickerPinnedCommandIds: [],
    // Only Pinned expanded by default; other categories collapsed.
    pickerExpandedCategoryIds: ['pinned'],

    // Secret Storage Defaults
    secretStorageMigrated: false,                       // Not migrated yet

    // Azure AI Foundry Defaults — ALL endpoints empty in the public store.
    // No corporate value ships in DEFAULT_SETTINGS (plan §2/§8).
    azureFirstMode: false,
    preAzureFirstProvider: '',
    azureApiKey: '',
    azureKeyStored: false,
    azureMaxConcurrentRequests: 4,
    azureMaxRpm: 60,
    azureThrottleDefaultsV2: true,
    azureModelDefaultsV3: false,
    azurePerDeploymentRpm: {},
    azureFastModel: {},
    azureAIEndpoint: '',
    azureOpenAIEndpoint: '',
    azureWhisperDeployment: 'whisper',
    azureGPTModel: 'gpt-5.5',
    azureRoutingMode: 'model-based',
    azureDeployments: {},
    azureApiVersionOverride: {},
    azureCapabilities: {},   // seeded from observable state by migrateOldSettings; empty → defaultModeFor at resolve time
    taskModels: {
        tagging: 'claude-sonnet-4-6',
        summarization: 'claude-sonnet-4-6',
        audit: 'claude-opus-4-6',
        research: 'claude-opus-4-6',
        chat: 'claude-sonnet-4-6',
        mermaid: 'claude-sonnet-4-6',
        embeddings: 'text-embedding-3-large',
        transcription: 'whisper',
    },
};

/**
 * Get the full path for a subfolder within the plugin folder
 */
export function getPluginSubfolderPath(settings: AIOrganiserSettings, subfolder: string): string {
    return `${settings.pluginFolder}/${subfolder}`;
}

function normalizeFolderSegment(value: string | undefined, fallback: string): string {
    const cleaned = (value || '')
        .trim()
        .replace(/\\/g, '/')
        .replace(/^\/+|\/+$/g, '');

    return cleaned || fallback;
}

function collapseDuplicatePrefix(fullPath: string, pluginFolder: string): string {
    const prefix = `${pluginFolder}/`;
    const doublePrefix = `${prefix}${pluginFolder}/`;

    let normalized = fullPath;
    while (normalized.startsWith(doublePrefix)) {
        normalized = `${prefix}${normalized.slice(doublePrefix.length)}`;
    }

    return normalized.replace(/\/+$/, '');
}

export function resolvePluginPath(settings: AIOrganiserSettings, folderValue: string | undefined, defaultSubfolder: string): string {
    const pluginFolder = normalizeFolderSegment(settings.pluginFolder, DEFAULT_PLUGIN_FOLDER);
    const pluginPrefix = `${pluginFolder}/`;
    let subfolder = normalizeFolderSegment(folderValue, defaultSubfolder);

    // If the value already includes the plugin folder, treat it as legacy full path
    if (subfolder.startsWith(pluginPrefix)) {
        return collapseDuplicatePrefix(subfolder, pluginFolder);
    }

    return collapseDuplicatePrefix(`${pluginFolder}/${subfolder}`, pluginFolder);
}

/**
 * Get the effective output root folder.
 * Returns outputRootFolder if set, otherwise falls back to pluginFolder.
 */
export function getEffectiveOutputRoot(settings: AIOrganiserSettings): string {
    let outputRoot = (settings.outputRootFolder || '').trim().replaceAll('\\', '/');
    while (outputRoot.startsWith('/')) outputRoot = outputRoot.slice(1);
    while (outputRoot.endsWith('/')) outputRoot = outputRoot.slice(0, -1);
    if (outputRoot) return outputRoot;
    return normalizeFolderSegment(settings.pluginFolder, DEFAULT_PLUGIN_FOLDER);
}

/**
 * Resolve a path under the output root folder (for generated content).
 * Handles legacy pluginFolder-prefixed values when outputRootFolder differs.
 */
export function resolveOutputPath(settings: AIOrganiserSettings, folderValue: string | undefined, defaultSubfolder: string): string {
    const outputRoot = getEffectiveOutputRoot(settings);
    const outputPrefix = `${outputRoot}/`;
    let subfolder = normalizeFolderSegment(folderValue, defaultSubfolder);

    // Handle legacy output-root prefix
    if (subfolder.startsWith(outputPrefix)) {
        return collapseDuplicatePrefix(subfolder, outputRoot);
    }

    // Handle legacy pluginFolder prefix when outputRoot differs
    const pluginFolder = normalizeFolderSegment(settings.pluginFolder, DEFAULT_PLUGIN_FOLDER);
    if (pluginFolder !== outputRoot && subfolder.startsWith(`${pluginFolder}/`)) {
        subfolder = subfolder.slice(`${pluginFolder}/`.length);
    }

    return collapseDuplicatePrefix(`${outputRoot}/${subfolder}`, outputRoot);
}

/**
 * Get a subfolder path under the output root (for folders without dedicated settings).
 */
export function getOutputSubfolderPath(settings: AIOrganiserSettings, subfolder: string): string {
    return `${getEffectiveOutputRoot(settings)}/${subfolder}`;
}

export function getConfigFolderFullPath(settings: AIOrganiserSettings): string {
    return resolvePluginPath(settings, settings.configFolderPath, 'Config');
}

export function getNotebookLMExportFullPath(settings: AIOrganiserSettings): string {
    return resolveOutputPath(settings, settings.notebooklmExportFolder, 'NotebookLM');
}

export function getDictionariesFolderFullPath(settings: AIOrganiserSettings): string {
    return `${getConfigFolderFullPath(settings)}/dictionaries`;
}

export function getMinutesOutputFullPath(settings: AIOrganiserSettings): string {
    return resolveOutputPath(settings, settings.minutesOutputFolder, 'Meetings');
}

/**
 * Path resolver for the Transcribe-audio command's output (plan F3, R3 H4).
 * Mirrors `getMinutesOutputFullPath` — composes the plugin's data folder
 * with the user-configured subfolder.
 */
export function getTranscriptOutputFullPath(settings: AIOrganiserSettings): string {
    return resolveOutputPath(settings, settings.transcriptOutputFolder, 'Transcripts');
}

export function getExportOutputFullPath(settings: AIOrganiserSettings): string {
    return resolveOutputPath(settings, settings.exportOutputFolder, 'Exports');
}

export function getFlashcardFullPath(settings: AIOrganiserSettings): string {
    return resolveOutputPath(settings, settings.flashcardFolder, 'Flashcards');
}

export function getAudioNarrationFullPath(settings: AIOrganiserSettings): string {
    return resolveOutputPath(settings, settings.audioNarrationOutputFolder, 'Narrations');
}

export function getChatExportFullPath(settings: AIOrganiserSettings): string {
    return resolveOutputPath(settings, settings.chatExportFolder, 'Chats');
}

export function getCanvasOutputFullPath(settings: AIOrganiserSettings): string {
    return resolveOutputPath(settings, settings.canvasOutputFolder, 'Canvas');
}

export function getWebReaderOutputFullPath(settings: AIOrganiserSettings): string {
    return resolveOutputPath(settings, settings.webReaderOutputFolder, 'Web Reader');
}

export function getKindleOutputFullPath(settings: AIOrganiserSettings): string {
    return resolveOutputPath(settings, settings.kindleOutputFolder, 'Kindle');
}

export function getNewsletterOutputFullPath(settings: AIOrganiserSettings): string {
    return resolveOutputPath(settings, settings.newsletterOutputFolder, 'Newsletter Inbox');
}

export function getTranscriptFullPath(settings: AIOrganiserSettings): string {
    return resolveOutputPath(settings, settings.transcriptFolder, 'Transcripts');
}

export function getSketchOutputFullPath(settings: AIOrganiserSettings): string {
    return resolveOutputPath(settings, settings.sketchOutputFolder, 'Sketches');
}

export function getResearchOutputFullPath(settings: AIOrganiserSettings): string {
    return resolveOutputPath(settings, settings.researchOutputFolder, 'Research');
}

/**
 * Get all plugin-managed folders that should be auto-excluded from tagging.
 * When output root equals plugin folder, just exclude pluginFolder (current behavior).
 * When split, exclude config root + each managed output subfolder individually.
 */
export function getPluginManagedFolders(settings: AIOrganiserSettings): string[] {
    const pluginFolder = normalizeFolderSegment(settings.pluginFolder, DEFAULT_PLUGIN_FOLDER);
    const outputRoot = getEffectiveOutputRoot(settings);

    if (outputRoot === pluginFolder) {
        return [pluginFolder]; // Same root — just exclude pluginFolder
    }

    // When split, exclude config root + each managed output subfolder
    return [
        pluginFolder,
        getTranscriptFullPath(settings),
        getMinutesOutputFullPath(settings),
        getExportOutputFullPath(settings),
        getFlashcardFullPath(settings),
        getChatExportFullPath(settings),
        getChatRootFullPath(settings),
        getCanvasOutputFullPath(settings),
        getWebReaderOutputFullPath(settings),
        getKindleOutputFullPath(settings),
        getNewsletterOutputFullPath(settings),
        getNotebookLMExportFullPath(settings),
        getSketchOutputFullPath(settings),
        getResearchOutputFullPath(settings),
        getOutputSubfolderPath(settings, DEFAULT_RECORDING_FOLDER),
    ];
}

/** Full absolute path to the chat root folder (conversations + projects). */
export function getChatRootFullPath(settings: AIOrganiserSettings): string {
    const root = (settings.chatRootFolder || 'AI Chat').trim();
    // chatRootFolder is relative to the effective output root, like other output folders
    return resolveOutputPath(settings, root, 'AI Chat');
}

/**
 * Pure function: migrates old settings to current schema.
 * Called from loadSettings() in main.ts.
 * All migration logic lives here for testability.
 */
export function migrateOldSettings(oldSettings: Record<string, unknown> | null): Record<string, unknown> | null {
    if (!oldSettings) return oldSettings;

    // Retire the Simplified-Chinese locale: English is the only interface
    // language now. Coerce any stored 'zh-cn' so the setting stays valid.
    if (oldSettings.interfaceLanguage === 'zh-cn') {
        oldSettings.interfaceLanguage = 'en';
    }

    // Migrate old Ollama settings to local
    if (oldSettings.serviceType === 'ollama') {
        oldSettings.serviceType = 'local';
        oldSettings.localEndpoint = oldSettings.ollamaEndpoint;
        oldSettings.localModel = oldSettings.ollamaModel;
        delete oldSettings.ollamaEndpoint;
        delete oldSettings.ollamaModel;
    }

    // Migrate old tag range settings to maxTags
    if (!oldSettings.maxTags) {
        oldSettings.maxTags = oldSettings.tagRangeGenerateMax ||
                              oldSettings.tagRangePredefinedMax ||
                              DEFAULT_SETTINGS.maxTags;
    }

    // Migrate old summary persona ID
    if (oldSettings.defaultSummaryPersona === 'student') {
        oldSettings.defaultSummaryPersona = 'brief';
    }

    // Retire the legacy HTML presentation engine: structured-IR is now the only
    // path, so coerce any stored 'html-legacy' choice (2026-06 retirement).
    if (oldSettings.presentationExportEngine === 'html-legacy') {
        oldSettings.presentationExportEngine = 'structured-ir';
    }

    // Consultant-quality storyline gate: coerce any out-of-range stored value to
    // the safe default ('review' = storyline sign-off first). Absent → DEFAULT_SETTINGS fills it.
    if (oldSettings.presentationStorylineGate !== undefined
        && oldSettings.presentationStorylineGate !== 'review'
        && oldSettings.presentationStorylineGate !== 'auto-build') {
        oldSettings.presentationStorylineGate = 'review';
    }

    // Per-role model selection (plan Cluster B): ensure the object + both keys exist
    // (default null = "Main"). Coerce a malformed stored value to the safe default.
    const roles = oldSettings.presentationModelRoles;
    if (!roles || typeof roles !== 'object') {
        oldSettings.presentationModelRoles = { storyboardGenerator: null, independentCritic: null };
    } else {
        const r = roles as Record<string, unknown>;
        if (typeof r.storyboardGenerator !== 'string') r.storyboardGenerator = null;
        if (typeof r.independentCritic !== 'string') r.independentCritic = null;
    }

    // Migrate summary length: brief|detailed|comprehensive → brief|standard|detailed
    // Check comprehensive FIRST to avoid double-migration (comprehensive→detailed→standard)
    if (oldSettings.summaryLength === 'comprehensive') {
        oldSettings.summaryLength = 'detailed';
    } else if (oldSettings.summaryLength === 'detailed') {
        oldSettings.summaryLength = 'standard';
    }

    // Migrate legacy sketch output folder: full path → subfolder only
    if (oldSettings.sketchOutputFolder === 'AI-Organiser/Sketches') {
        oldSettings.sketchOutputFolder = 'Sketches';
    }

    // Backfill the Slides side-rail layout slice for settings saved before it existed.
    const pl = oldSettings.presLayout;
    if (typeof pl !== 'object' || pl === null) {
        oldSettings.presLayout = { railCollapsed: false, railWidthPx: 360, filmstripCollapsed: false };
    }

    migrateDeprecatedGeminiIds(oldSettings);

    // Phase 2 TRA: Migrate minutesDefaultPersona + minutesDetailLevel → minutesStyle
    if (!oldSettings.minutesStyle && (oldSettings.minutesDefaultPersona || oldSettings.minutesDetailLevel)) {
        const persona = oldSettings.minutesDefaultPersona || 'standard';
        const detail = oldSettings.minutesDetailLevel || 'standard';

        if (persona === 'governance' || detail === 'detailed') {
            oldSettings.minutesStyle = 'detailed';
        } else if (detail === 'concise') {
            oldSettings.minutesStyle = 'smart-brevity';
        } else if (detail === 'template') {
            oldSettings.minutesStyle = 'guided';
        } else {
            // Covers 'standard' persona + 'standard' detail, and any custom persona
            oldSettings.minutesStyle = 'standard';
        }
        delete oldSettings.minutesDefaultPersona;
        delete oldSettings.minutesDetailLevel;
    }

    // Rename PDF-specific NotebookLM settings to format-agnostic names.
    // Guard: only copy when new key is absent — handles re-entrant migration and sync conflicts.
    if ('notebooklmPdfIncludeFrontmatter' in oldSettings && !('notebooklmIncludeFrontmatter' in oldSettings)) {
        oldSettings.notebooklmIncludeFrontmatter = oldSettings.notebooklmPdfIncludeFrontmatter;
        delete oldSettings.notebooklmPdfIncludeFrontmatter;
    }
    if ('notebooklmPdfIncludeTitle' in oldSettings && !('notebooklmIncludeTitle' in oldSettings)) {
        oldSettings.notebooklmIncludeTitle = oldSettings.notebooklmPdfIncludeTitle;
        delete oldSettings.notebooklmPdfIncludeTitle;
    }

    migrateAzureSettings(oldSettings);
    migrateBrandSettings(oldSettings);
    migrateFeatureFlags(oldSettings);
    migratePickerTaxonomy(oldSettings);

    return oldSettings;
}

/**
 * Feature-flag migration (FT-11) — ABSORB-before-DEFAULT order is load-bearing.
 *
 * (1) Absorb each legacy master switch (`enableSemanticSearch`→`semantic-search`,
 *     `newsletterEnabled`→`newsletter`) into `featureFlags[id]` when that flag is unset
 *     — so a user who had `newsletterEnabled:true` keeps the feature ON.
 * (2) Then seed the Lean defaults (`defaultOn`) for any STILL-unset non-core flags.
 *
 * If (2) ran first, `defaultFeatureFlags()` (newsletter=off) would pre-fill the flag and
 * the legacy `true` would be silently dropped (Gemini-R6-G1). An explicit saved flag
 * always wins over both. Idempotent + preserves saved flags; the legacy `enable*` fields
 * are left intact (back-compat read only — no longer the gating switch).
 */
function migrateFeatureFlags(s: Record<string, unknown>): void {
    const existing = (typeof s.featureFlags === 'object' && s.featureFlags !== null)
        ? (s.featureFlags as Record<string, unknown>)
        : {};
    const flags: Partial<Record<FeatureId, boolean>> = {};
    for (const [k, v] of Object.entries(existing)) {
        if (typeof v === 'boolean') flags[k as FeatureId] = v;
    }

    // (1) Absorb legacy masters BEFORE seeding defaults.
    for (const f of FEATURE_REGISTRY) {
        if (!f.absorbsLegacyFlag || f.id in flags) continue;
        const legacy = s[f.absorbsLegacyFlag as string];
        if (typeof legacy === 'boolean') flags[f.id] = legacy;
    }
    // (2) Seed Lean defaults for still-unset non-core flags.
    for (const f of FEATURE_REGISTRY) {
        if (f.core || f.id in flags) continue;
        flags[f.id] = f.defaultOn;
    }

    s.featureFlags = flags;
    if (typeof s.featuresIntroShown !== 'boolean') s.featuresIntroShown = false;
}

/**
 * Unified-feature-taxonomy migration (Cluster B). Two moves:
 *  1. Favourites setting renamed `pickerEssentialsCommandIds` → `pickerPinnedCommandIds`.
 *     Precedence: if the NEW key already holds an array it wins (idempotent re-run);
 *     else copy the old key's array forward. The old key is then removed.
 *  2. Persisted expanded category ids are remapped to the new stage taxonomy
 *     (`essentials`→`pinned`, `manage`→`maintain`; create/refine/find unchanged), then
 *     de-duplicated preserving first-seen order. Unrecognised ids are left untouched
 *     (they simply match no category and expand nothing — harmless).
 */
function migratePickerTaxonomy(s: Record<string, unknown>): void {
    // (1) favourites key rename
    if (!Array.isArray(s.pickerPinnedCommandIds) && Array.isArray(s.pickerEssentialsCommandIds)) {
        s.pickerPinnedCommandIds = s.pickerEssentialsCommandIds;
    }
    if ('pickerEssentialsCommandIds' in s) delete s.pickerEssentialsCommandIds;

    // (2) expanded-category id remap + dedup
    if (Array.isArray(s.pickerExpandedCategoryIds)) {
        const remap: Record<string, string> = { essentials: 'pinned', manage: 'maintain' };
        const seen = new Set<string>();
        const out: string[] = [];
        for (const raw of s.pickerExpandedCategoryIds) {
            if (typeof raw !== 'string') continue;
            const id = remap[raw] ?? raw;
            if (!seen.has(id)) { seen.add(id); out.push(id); }
        }
        s.pickerExpandedCategoryIds = out;
    }
}

/**
 * Plan B — Brand fidelity migration (sync, pure; plan §5a).
 *
 * The plugin standardizes on `brandFolderPath` + a fixed `brand-guidelines.md`
 * filename inside it. If the deprecated `presentationBrandGuidelinesPath` was set
 * (a full file path) and `brandFolderPath` is still unset/default, seed
 * `brandFolderPath` from the PARENT folder of that path. Pure string work only —
 * non-destructive (the deprecated field is left intact as a migration source).
 *
 * TODO(brand): one-time rename Notice in main.loadSettings — if the old file
 * wasn't named `brand-guidelines.md`, tell the user (once) to rename it inside
 * the brand folder. That is a runtime/async concern (Notice + vault check) and
 * does NOT belong in this pure function; leave the seam here as the trigger.
 */
function migrateBrandSettings(s: Record<string, unknown>): void {
    const oldPath = s.presentationBrandGuidelinesPath;
    if (typeof oldPath !== 'string' || oldPath.trim() === '') return;

    const current = s.brandFolderPath;
    const isUnset =
        typeof current !== 'string' ||
        current.trim() === '' ||
        current.trim() === DEFAULT_SETTINGS.brandFolderPath;
    if (!isUnset) return;

    // Parent folder = the path with the trailing filename segment dropped.
    const segments = oldPath.trim().split('/').filter(Boolean);
    if (segments.length <= 1) return; // bare filename — no parent folder to seed
    const parent = segments.slice(0, -1).join('/');
    if (parent) s.brandFolderPath = parent;
}

/**
 * Plan A — Azure providers migration (sync, pure; plan §9).
 *
 * - Rename the work-fork `workplaceMode` flag → `azureFirstMode` (non-destructive).
 * - Seed missing Azure connection-config + `taskModels` defaults so a settings
 *   object saved before these fields existed type-narrows cleanly.
 *
 * Intentionally does NOT force `cloudServiceType` or rewrite `embeddingProvider`
 * (the work fork did — that is corporate routing behaviour). Public Azure-first
 * mode is UX-only (plan AD-6); the user explicitly selects the Azure provider.
 *
 * Async secret-id migration (SecretStorage keychain) cannot run inside this pure
 * function — it lives in `main.ts` `migrateAzureSecretOnLoad()`, called from
 * `loadSettings()` after this pure pass.
 */
function migrateAzureSettings(s: Record<string, unknown>): void {
    // workplaceMode (work-fork) → azureFirstMode (public). Non-destructive rename.
    if (typeof s.workplaceMode === 'boolean' && s.azureFirstMode === undefined) {
        s.azureFirstMode = s.workplaceMode;
    }
    delete s.workplaceMode;

    if (typeof s.azureFirstMode !== 'boolean') s.azureFirstMode = DEFAULT_SETTINGS.azureFirstMode;
    if (typeof s.azureApiKey !== 'string') s.azureApiKey = DEFAULT_SETTINGS.azureApiKey;
    if (typeof s.azureKeyStored !== 'boolean') s.azureKeyStored = DEFAULT_SETTINGS.azureKeyStored;
    // Azure rate-limit pacing: coerce to finite ints in range, else default.
    const clampInt = (v: unknown, def: number, lo: number, hi: number): number => {
        const n = Math.floor(Number(v));
        return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
    };
    // One-time bump: the old conservative defaults (2 concurrent / 10 RPM) were
    // set for a low Azure quota. Post-quota-upgrade defaults are 4/60. Bump ONLY
    // when the user is still on the exact old defaults (never clobber a custom value).
    if (s.azureThrottleDefaultsV2 !== true) {
        if (Number(s.azureMaxConcurrentRequests) === 2) s.azureMaxConcurrentRequests = 4;
        if (Number(s.azureMaxRpm) === 10) s.azureMaxRpm = 60;
        s.azureThrottleDefaultsV2 = true;
    }
    // One-time bump of the superseded Azure default model IDs to their current
    // equivalents (the old low-tier gpt-5.3-chat / claude-opus-4-6 deployments are
    // 10 RPM; the standard current deployments are gpt-5.5 / claude-opus-4-7). Exact-
    // match only — a custom deployment name is never touched. The guard DEFAULTS TO
    // FALSE (unlike azureThrottleDefaultsV2) so it can never be persisted true-without-
    // bump through the DEFAULT_SETTINGS merge; the V3 version also re-fires once to
    // self-heal any instance the earlier default-true V2 guard left stuck. The legacy
    // azureModelDefaultsV2 key (if present on disk) is now ignored.
    if (s.azureModelDefaultsV3 !== true) {
        const bumpModel = (v: unknown): unknown => {
            if (v === 'gpt-5.3-chat') return 'gpt-5.5';
            if (v === 'claude-opus-4-6') return 'claude-opus-4-7';
            return v;
        };
        s.azureGPTModel = bumpModel(s.azureGPTModel);
        s.cloudModel = bumpModel(s.cloudModel);
        if (s.taskModels && typeof s.taskModels === 'object') {
            const tm = s.taskModels as Record<string, unknown>;
            for (const k of Object.keys(tm)) tm[k] = bumpModel(tm[k]);
        }
        s.azureModelDefaultsV3 = true;
    }
    s.azureMaxConcurrentRequests = clampInt(s.azureMaxConcurrentRequests, 4, 1, 10);
    s.azureMaxRpm = clampInt(s.azureMaxRpm, 60, 1, 600);
    // Per-deployment RPM map: keep only string→finite-positive-int entries (drop blanks/garbage).
    {
        const raw = s.azurePerDeploymentRpm;
        const clean: Record<string, number> = {};
        if (raw && typeof raw === 'object') {
            for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
                const name = String(k).trim();
                const n = Math.floor(Number(v));
                if (name && Number.isFinite(n) && n >= 1) clean[name] = n;
            }
        }
        s.azurePerDeploymentRpm = clean;
    }
    // Azure fast-model deployment names: optional trimmed strings per surface.
    {
        const raw = (s.azureFastModel ?? {}) as Record<string, unknown>;
        const fm: { openai?: string; claude?: string } = {};
        if (typeof raw.openai === 'string' && raw.openai.trim()) fm.openai = raw.openai.trim();
        if (typeof raw.claude === 'string' && raw.claude.trim()) fm.claude = raw.claude.trim();
        s.azureFastModel = fm;
    }
    if (typeof s.azureAIEndpoint !== 'string') s.azureAIEndpoint = DEFAULT_SETTINGS.azureAIEndpoint;
    if (typeof s.azureOpenAIEndpoint !== 'string') s.azureOpenAIEndpoint = DEFAULT_SETTINGS.azureOpenAIEndpoint;
    if (typeof s.azureWhisperDeployment !== 'string') s.azureWhisperDeployment = DEFAULT_SETTINGS.azureWhisperDeployment;
    if (typeof s.azureGPTModel !== 'string') s.azureGPTModel = DEFAULT_SETTINGS.azureGPTModel;
    if (s.azureRoutingMode !== 'model-based' && s.azureRoutingMode !== 'deployment-based') {
        s.azureRoutingMode = DEFAULT_SETTINGS.azureRoutingMode;
    }
    if (typeof s.azureDeployments !== 'object' || s.azureDeployments === null) {
        s.azureDeployments = { ...DEFAULT_SETTINGS.azureDeployments };
    }
    if (typeof s.azureApiVersionOverride !== 'object' || s.azureApiVersionOverride === null) {
        s.azureApiVersionOverride = { ...DEFAULT_SETTINGS.azureApiVersionOverride };
    }
    if (typeof s.taskModels !== 'object' || s.taskModels === null) {
        s.taskModels = { ...DEFAULT_SETTINGS.taskModels };
    }

    // Reconcile azureFirstMode ↔ provider: Azure-first ON must mean an Azure
    // provider, else isAzureMode stays false and mobile/specialists never route
    // to Azure (and the generic provider UI duplicates the Azure section). Auto-
    // heal a diverged state (e.g. user toggled Azure-first but provider = claude).
    if (s.azureFirstMode === true && typeof s.cloudServiceType === 'string'
        && !s.cloudServiceType.startsWith('azure')) {
        // Remember the personal provider so a later toggle-off restores it (corporate↔personal).
        if (!s.preAzureFirstProvider) s.preAzureFirstProvider = s.cloudServiceType;
        s.cloudServiceType = 'azure-claude';
        s.cloudEndpoint = '';
        const tm = s.taskModels as { chat?: string } | undefined;
        s.cloudModel = (tm && typeof tm.chat === 'string' && tm.chat) || 'claude-sonnet-4-6';
    }
    if (typeof s.preAzureFirstProvider !== 'string') s.preAzureFirstProvider = DEFAULT_SETTINGS.preAzureFirstProvider;

    // Stale hardcoded mobile fallback model (an old default) → the latest-* sentinel,
    // so normal-mode mobile uses the newest model instead of a pinned old one.
    if (s.mobileFallbackModel === 'gpt-5.2' || s.mobileFallbackModel === 'gpt-5.3-chat') {
        s.mobileFallbackModel = DEFAULT_SETTINGS.mobileFallbackModel;
    }

    // ── Per-capability Azure routing seeding (flexible Azure config, D6) ──
    // SYNC + non-secret only (keys are async/SecretStorage — cannot read here, H3).
    // Idempotent (only-if-absent — never clobber a user choice). Seeds to PRESERVE
    // each capability's prior REACHABLE behaviour (G2):
    //   transcription — was HARDCODED to azure whisper in azure mode (BYO unreachable) → azure.
    //   embeddings    — azure only when provider==='openai'; other providers used a BYO key → preserve byo.
    //   websearch     — tavily/brightdata worked regardless of main → preserve byo; else azure (claude surface).
    //   tts / youtube — no azure path historically → byo (delegate to existing narration/youtube config).
    if (typeof s.azureCapabilities !== 'object' || s.azureCapabilities === null) {
        s.azureCapabilities = {};
    }
    const isAzureUser =
        (typeof s.cloudServiceType === 'string' && s.cloudServiceType.startsWith('azure')) ||
        s.azureFirstMode === true;
    if (isAzureUser) {
        const caps = s.azureCapabilities as Record<string, { mode: 'azure' | 'byo' | 'off'; deployment?: string }>;
        const seed = (id: string, choice: { mode: 'azure' | 'byo' | 'off'; deployment?: string }): void => {
            if (!caps[id]) caps[id] = choice;
        };
        const whisperDep = typeof s.azureWhisperDeployment === 'string' ? s.azureWhisperDeployment : '';
        const embDep = (s.azureDeployments as { embeddings?: string } | undefined)?.embeddings;

        seed('transcription', { mode: 'azure', deployment: whisperDep });
        if (s.embeddingProvider === 'openai') seed('embeddings', { mode: 'azure', deployment: embDep ?? '' });
        else seed('embeddings', { mode: 'byo' });
        if (s.researchProvider === 'tavily' || s.researchProvider === 'brightdata-serp') seed('websearch', { mode: 'byo' });
        else seed('websearch', { mode: 'azure' });
        seed('tts', { mode: 'byo' });
        seed('youtube', { mode: 'byo' });
    }
}

/**
 * Replace deprecated / never-existed Gemini model IDs with the `latest-*`
 * sentinel (which now resolves to Google's auto-rotating `gemini-{tier}-latest`
 * alias). Keeps users on a working model instead of a stale pin.
 *
 * Do NOT migrate IDs that are actually valid on Google's API right now —
 * a previous version of this migration mistakenly rewrote valid preview
 * IDs to sentinels, and we don't want to repeat that.
 *
 * Maps:
 * - `gemini-3-flash`         → `latest-flash` (nonexistent; a prior commit
 *                                              wrongly dropped `-preview`
 *                                              assuming GA release)
 * - `gemini-3.1-pro`         → `latest-pro`   (same class of bad rename)
 * - `gemini-3-pro-preview`   → `latest-pro`   (discontinued March 9 2026)
 * - `gemini-2.0-flash`       → `latest-flash` (deprecated)
 * - `gemini-2.0-flash-lite`  → `latest-flash` (deprecated)
 *
 * KEEP unchanged (these are the correct IDs Google ships today):
 *   gemini-3.1-pro-preview, gemini-3-flash-preview,
 *   gemini-3.1-flash-lite-preview, gemini-2.5-{pro,flash,flash-lite}
 */
function migrateDeprecatedGeminiIds(s: Record<string, unknown>): void {
    const remap: Record<string, string> = {
        'gemini-3-flash': 'latest-flash',
        'gemini-3.1-pro': 'latest-pro',
        'gemini-3-pro-preview': 'latest-pro',
        'gemini-2.0-flash': 'latest-flash',
        'gemini-2.0-flash-lite': 'latest-flash',
    };
    const modelKeys = ['youtubeGeminiModel', 'pdfModel'] as const;
    for (const key of modelKeys) {
        const current = s[key];
        if (typeof current === 'string' && current in remap) {
            s[key] = remap[current];
        }
    }
}
