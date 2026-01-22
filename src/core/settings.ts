import { LanguageCode } from '../services/types';
import { AdapterType } from '../services/adapters';
import { SupportedLanguage, DEFAULT_LANGUAGE } from '../i18n';

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
    // Flashcard Settings
    flashcardFolder: string;             // Subfolder for flashcard exports (under pluginFolder)
    // Plugin Folder Settings (unified structure)
    pluginFolder: string;                // Main plugin folder (contains Config, Transcripts, Flashcards)
    configFolderPath: string;            // Subfolder for config files (under pluginFolder)
    lastSummarizeSource: 'note' | 'url' | 'pdf' | 'youtube' | 'audio';
    
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

    // === OBSIDIAN BASES INTEGRATION ===
    enableStructuredMetadata: boolean;   // Use aio_* frontmatter properties for Bases
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
    // Selection
    notebooklmSelectionTag: string;      // Tag to mark notes for export (default: 'notebooklm')
    notebooklmExportFolder: string;      // Root folder for pack exports (under pluginFolder)
    
    // Export Configuration
    notebooklmExportMode: 'auto' | 'modular' | 'single';
    notebooklmMaxWordsPerModule: number; // Word budget per module (default: 120,000; max: 500,000)
    
    // Sanitisation Options
    notebooklmRemoveFrontmatter: boolean;
    notebooklmFlattenCallouts: boolean;
    notebooklmStripDataview: boolean;
    notebooklmStripDataviewJs: boolean;
    
    // Embed Handling
    notebooklmResolveEmbeds: 'none' | 'titleOnly' | 'excerpt';
    notebooklmEmbedMaxDepth: number;
    notebooklmEmbedMaxChars: number;
    
    // Link Context (optional feature)
    notebooklmIncludeLinkContext: boolean;
    notebooklmLinkContextMaxChars: number;
    notebooklmLinkContextDepth: number;
    
    // Image Handling
    notebooklmImageHandling: 'strip' | 'placeholder' | 'exportAssets';
    
    // Post-Export Actions
    notebooklmPostExportTagAction: 'keep' | 'clear' | 'archive';
}

// Main plugin folder - all subfolders are relative to this
export const DEFAULT_PLUGIN_FOLDER = 'AI-Organiser';

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
    flashcardFolder: 'Flashcards',
    pluginFolder: DEFAULT_PLUGIN_FOLDER,
    configFolderPath: 'Config',
    lastSummarizeSource: 'note',
    
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
    
    // NotebookLM Integration Defaults
    notebooklmSelectionTag: 'notebooklm',
    notebooklmExportFolder: 'NotebookLM',               // Under AI-Organiser/NotebookLM/
    notebooklmExportMode: 'auto',
    notebooklmMaxWordsPerModule: 120000,                // 120k words (safely under 500k limit)
    notebooklmRemoveFrontmatter: true,
    notebooklmFlattenCallouts: true,
    notebooklmStripDataview: true,
    notebooklmStripDataviewJs: true,
    notebooklmResolveEmbeds: 'none',                    // Default: omit embed content
    notebooklmEmbedMaxDepth: 2,
    notebooklmEmbedMaxChars: 2000,
    notebooklmIncludeLinkContext: false,
    notebooklmLinkContextMaxChars: 1000,
    notebooklmLinkContextDepth: 1,
    notebooklmImageHandling: 'strip',                   // Default: remove image noise
    notebooklmPostExportTagAction: 'keep',
};

/**
 * Get the full path for a subfolder within the plugin folder
 */
export function getPluginSubfolderPath(settings: AIOrganiserSettings, subfolder: string): string {
    return `${settings.pluginFolder}/${subfolder}`;
}

/**
 * Get all plugin-managed folders that should be auto-excluded from tagging
 */
export function getPluginManagedFolders(settings: AIOrganiserSettings): string[] {
    return [
        settings.pluginFolder, // Exclude the entire plugin folder
    ];
}
