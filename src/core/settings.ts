import { LanguageCode } from '../services/types';
import { AdapterType } from '../services/adapters';
import { SupportedLanguage, DEFAULT_LANGUAGE } from '../i18n';
import { DEFAULT_MAX_DOCUMENT_CHARS, DEFAULT_MULTI_SOURCE_MAX_DOCUMENT_CHARS, OversizedBehavior, MinutesStyle, DEFAULT_MINUTES_STYLE, MEDIA_SIZE_WARN_BYTES, DEFAULT_RECORDING_FOLDER } from './constants';
import type { KindleSyncState } from '../services/kindle/kindleTypes';

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
    minutesDefaultTimezone: string;      // Default timezone for meetings
    minutesStyle: MinutesStyle;          // Minutes output style (Phase 2 TRA)
    minutesObsidianTasksFormat: boolean; // Add actions as Obsidian Tasks
    minutesGTDOverlay: boolean;              // GTD-style action classification overlay
    enableSpeakerLabelling: boolean;          // LLM speaker-labelling pre-pass (Phase 4 TRA)
    audioDiarisationProvider: 'none' | 'assemblyai' | 'deepgram'; // Diarisation provider placeholder (Phase 4c TRA)
    maxDocumentChars: number;            // Minutes: max document size before truncation
    oversizedDocumentBehavior: 'truncate' | 'full' | 'ask'; // Minutes: oversized behavior
    // Export Settings (DOCX/PPTX)
    exportOutputFolder: string;          // Folder for exported documents
    exportFontFace: string;              // Font family for PPTX/DOCX exports
    exportFontSize: number;              // Body font size in points (10–18)
    exportColorScheme: string;           // Preset name or 'custom'
    exportPrimaryColor: string;          // Hex (no #) — used when exportColorScheme = 'custom'
    exportAccentColor: string;           // Hex (no #) — used when exportColorScheme = 'custom'
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
    aichatDefaultModel: string;          // Default model for AI Chat
    aichatRefinementPasses: 1 | 2;       // Number of refinement passes in presentation build
    aichatBrandToggleDefault: boolean;   // Whether brand toggle is on by default
    presentationOutputFolder: string;    // Subfolder under pluginFolder for presentation exports (HTML/PPTX)
    presentationBrandGuidelinesPath: string; // Vault path to brand guidelines file

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
    // PDF-based export for rich content preservation
    notebooklmSelectionTag: string;      // Tag to mark notes for export (default: 'notebooklm')
    notebooklmExportFolder: string;      // Root folder for pack exports (under pluginFolder)
    notebooklmPostExportTagAction: 'clear' | 'archive';  // No 'keep' - tags should be cleared after PDF export

    // PDF Generation Settings
    notebooklmPdfPageSize: 'A4' | 'Letter' | 'Legal';
    notebooklmPdfFontName: string;
    notebooklmPdfFontSize: number;
    notebooklmPdfIncludeFrontmatter: boolean;
    notebooklmPdfIncludeTitle: boolean;

    // === YOUTUBE SETTINGS ===
    // Gemini-native YouTube processing (more reliable than transcript scraping)
    youtubeGeminiApiKey: string;         // Dedicated Gemini key for YouTube (uses main key if provider is Gemini)
    youtubeGeminiModel: string;          // Gemini model for YouTube (default: gemini-3-flash-preview)

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

    // === SECRET STORAGE ===
    // SecretStorage API integration (Obsidian 1.11+)
    secretStorageMigrated: boolean;      // Whether keys have been migrated to SecretStorage
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
    cloudModel: 'claude-sonnet-4-6',
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
    minutesDefaultTimezone: getDefaultTimezone(),
    minutesStyle: DEFAULT_MINUTES_STYLE,
    minutesObsidianTasksFormat: false,
    minutesGTDOverlay: false,
    enableSpeakerLabelling: false,
    audioDiarisationProvider: 'none',
    maxDocumentChars: DEFAULT_MAX_DOCUMENT_CHARS,
    oversizedDocumentBehavior: 'ask' as OversizedBehavior,
    exportOutputFolder: 'Exports',
    exportFontFace: 'Noto Sans',
    exportFontSize: 14,
    exportColorScheme: 'navy-gold',
    exportPrimaryColor: '1A3A5C',
    exportAccentColor: 'F5C842',
    flashcardFolder: 'Flashcards',
    flashcardProvider: 'main',
    flashcardModel: '',
    pluginFolder: DEFAULT_PLUGIN_FOLDER,
    outputRootFolder: '',                                  // Empty = use pluginFolder (backward compatible)
    configFolderPath: 'Config',
    lastSummarizeSource: 'note',

    // Chat Export Defaults
    chatExportFolder: 'Chats',
    aichatDefaultModel: 'claude-sonnet-4-6',
    aichatRefinementPasses: 1,
    aichatBrandToggleDefault: false,
    presentationOutputFolder: 'Presentations',
    presentationBrandGuidelinesPath: '',

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
    mobileFallbackModel: 'claude-haiku-4-5-20251001',
    mobileCustomEndpoint: '',
    mobileIndexingMode: 'read-only',
    mobileIndexSizeLimit: 50,
    
    // NotebookLM Integration Defaults (PDF-based export)
    notebooklmSelectionTag: 'notebooklm',
    notebooklmExportFolder: 'NotebookLM',               // Under AI-Organiser/NotebookLM/
    notebooklmPostExportTagAction: 'clear',             // Clear tags after export (no reason to keep for PDF)

    // PDF Generation Defaults
    notebooklmPdfPageSize: 'A4',
    notebooklmPdfFontName: 'helvetica',
    notebooklmPdfFontSize: 11,
    notebooklmPdfIncludeFrontmatter: false,
    notebooklmPdfIncludeTitle: true,

    // YouTube Defaults (Gemini-native processing)
    youtubeGeminiApiKey: '',                            // Empty = use main Gemini key if available
    youtubeGeminiModel: 'gemini-3-flash-preview',       // Gemini 3 Flash

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

    // Secret Storage Defaults
    secretStorageMigrated: false,                       // Not migrated yet
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

export function getExportOutputFullPath(settings: AIOrganiserSettings): string {
    return resolveOutputPath(settings, settings.exportOutputFolder, 'Exports');
}

export function getFlashcardFullPath(settings: AIOrganiserSettings): string {
    return resolveOutputPath(settings, settings.flashcardFolder, 'Flashcards');
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
export function migrateOldSettings(oldSettings: Record<string, any> | null): Record<string, any> | null {
    if (!oldSettings) return oldSettings;

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

    // Migrate deprecated Gemini 3 Pro Preview → Gemini 3.1 Pro Preview (discontinued March 9, 2026)
    if (oldSettings.youtubeGeminiModel === 'gemini-3-pro-preview') {
        oldSettings.youtubeGeminiModel = 'gemini-3.1-pro-preview';
    }
    if (oldSettings.pdfModel === 'gemini-3-pro-preview') {
        oldSettings.pdfModel = 'gemini-3.1-pro-preview';
    }

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

    return oldSettings;
}
