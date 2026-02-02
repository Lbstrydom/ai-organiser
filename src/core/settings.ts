import { LanguageCode } from '../services/types';
import { AdapterType } from '../services/adapters';
import { SupportedLanguage, DEFAULT_LANGUAGE } from '../i18n';
import { DEFAULT_MAX_DOCUMENT_CHARS, DEFAULT_MULTI_SOURCE_MAX_DOCUMENT_CHARS, OversizedBehavior, MinutesDetailLevel, DEFAULT_MINUTES_DETAIL_LEVEL } from './constants';

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
    maxTags: number;                     // Maximum number of tags to generate
    autoEnsureNoteStructure: boolean;    // Ensure References/Pending Integration sections after commands
    debugMode: boolean;
    // Web Summarization Settings
    enableWebSummarization: boolean;
    summaryLength: 'brief' | 'detailed' | 'comprehensive';
    summaryLanguage: string;
    includeSummaryMetadata: boolean;
    defaultSummaryPersona: string;       // Default persona ID for summarization
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
    minutesDefaultPersona: string;       // Default minutes persona ID
    minutesObsidianTasksFormat: boolean; // Add actions as Obsidian Tasks
    minutesDetailLevel: MinutesDetailLevel; // Minutes output detail: concise, standard, detailed
    maxDocumentChars: number;            // Minutes: max document size before truncation
    oversizedDocumentBehavior: 'truncate' | 'full' | 'ask'; // Minutes: oversized behavior
    // Export Settings (DOCX/PPTX)
    exportOutputFolder: string;          // Folder for exported documents
    // Flashcard Settings
    flashcardFolder: string;             // Subfolder for flashcard exports (under pluginFolder)
    // Plugin Folder Settings (unified structure)
    pluginFolder: string;                // Main plugin folder (contains Config, Transcripts, Flashcards)
    configFolderPath: string;            // Subfolder for config files (under pluginFolder)
    lastSummarizeSource: 'note' | 'url' | 'pdf' | 'youtube' | 'audio';

    // === CHAT EXPORT SETTINGS ===
    chatExportFolder: string;           // Subfolder under pluginFolder for chat exports

    // === CANVAS SETTINGS ===
    canvasOutputFolder: string;         // Subfolder under pluginFolder
    canvasOpenAfterCreate: boolean;     // Open canvas file after creation
    canvasEnableEdgeLabels: boolean;    // Use LLM for edge labels (Investigation Board)
    canvasUseLLMClustering: boolean;    // Use LLM for cluster grouping (Cluster Board)
    
    // === SEMANTIC SEARCH SETTINGS ===
    enableSemanticSearch: boolean;       // Master toggle for semantic search features
    
    // Embedding Provider Configuration
    // Note: Claude does not offer embedding APIs, so it's not a valid embedding provider
    embeddingProvider: 'openai' | 'gemini' | 'ollama' | 'openrouter' | 'cohere' | 'voyage';
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

    // === SECRET STORAGE ===
    // SecretStorage API integration (Obsidian 1.11+)
    secretStorageMigrated: boolean;      // Whether keys have been migrated to SecretStorage
}

// Main plugin folder - all subfolders are relative to this
export const DEFAULT_PLUGIN_FOLDER = 'AI-Organiser';

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
    cloudEndpoint: 'https://api.openai.com/v1/chat/completions',
    cloudApiKey: '',
    cloudModel: 'gpt-5.2',
    cloudServiceType: 'openai',
    providerSettings: {},
    excludedFolders: [],
    language: 'default',
    interfaceLanguage: DEFAULT_LANGUAGE,
    replaceTags: true,
    maxTags: 5,
    autoEnsureNoteStructure: true,
    debugMode: false,
    enableWebSummarization: true,
    summaryLength: 'detailed',
    summaryLanguage: '',
    includeSummaryMetadata: true,
    defaultSummaryPersona: 'student',
    saveTranscripts: 'file',
    transcriptFolder: 'Transcripts',
    summarizeTimeoutSeconds: 120,        // 2 minutes default, power users can increase
    multiSourceMaxDocumentChars: DEFAULT_MULTI_SOURCE_MAX_DOCUMENT_CHARS,
    multiSourceOversizedBehavior: 'full' as OversizedBehavior,
    minutesOutputFolder: 'Meetings',
    minutesDefaultTimezone: getDefaultTimezone(),
    minutesDefaultPersona: 'corporate-minutes',
    minutesObsidianTasksFormat: false,
    minutesDetailLevel: DEFAULT_MINUTES_DETAIL_LEVEL,
    maxDocumentChars: DEFAULT_MAX_DOCUMENT_CHARS,
    oversizedDocumentBehavior: 'ask' as OversizedBehavior,
    exportOutputFolder: 'Exports',
    flashcardFolder: 'Flashcards',
    pluginFolder: DEFAULT_PLUGIN_FOLDER,
    configFolderPath: 'Config',
    lastSummarizeSource: 'note',

    // Chat Export Defaults
    chatExportFolder: 'Chats',

    // Canvas Defaults
    canvasOutputFolder: 'Canvas',
    canvasOpenAfterCreate: true,
    canvasEnableEdgeLabels: true,
    canvasUseLLMClustering: true,
    
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
    mobileFallbackProvider: 'openai',
    mobileFallbackModel: 'gpt-5.2',
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
    youtubeGeminiModel: 'gemini-3-flash-preview',       // Gemini 3 Flash (successor to 2.0, deprecated March 2026)

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

export function getConfigFolderFullPath(settings: AIOrganiserSettings): string {
    return resolvePluginPath(settings, settings.configFolderPath, 'Config');
}

export function getNotebookLMExportFullPath(settings: AIOrganiserSettings): string {
    return resolvePluginPath(settings, settings.notebooklmExportFolder, 'NotebookLM');
}

export function getDictionariesFolderFullPath(settings: AIOrganiserSettings): string {
    return `${getConfigFolderFullPath(settings)}/dictionaries`;
}

export function getMinutesOutputFullPath(settings: AIOrganiserSettings): string {
    return resolvePluginPath(settings, settings.minutesOutputFolder, 'Meetings');
}

export function getExportOutputFullPath(settings: AIOrganiserSettings): string {
    return resolvePluginPath(settings, settings.exportOutputFolder, 'Exports');
}

export function getFlashcardFullPath(settings: AIOrganiserSettings): string {
    return resolvePluginPath(settings, settings.flashcardFolder, 'Flashcards');
}

export function getChatExportFullPath(settings: AIOrganiserSettings): string {
    return resolvePluginPath(settings, settings.chatExportFolder, 'Chats');
}

export function getCanvasOutputFullPath(settings: AIOrganiserSettings): string {
    return resolvePluginPath(settings, settings.canvasOutputFolder, 'Canvas');
}

export function getTranscriptFullPath(settings: AIOrganiserSettings): string {
    return resolvePluginPath(settings, settings.transcriptFolder, 'Transcripts');
}

/**
 * Get all plugin-managed folders that should be auto-excluded from tagging
 */
export function getPluginManagedFolders(settings: AIOrganiserSettings): string[] {
    return [
        settings.pluginFolder, // Exclude the entire plugin folder
    ];
}
