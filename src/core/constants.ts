/**
 * AI Organiser Constants
 * Centralizes constants used throughout the plugin
 */

/**
 * Frontmatter property names for AI Organiser metadata
 * Uses simple, user-friendly names for better readability in notes
 */
export const AIO_META = {
    /** 280-char summary hook for Bases preview */
    SUMMARY: 'summary',

    /** Processing status: 'processed' | 'pending' | 'error' */
    STATUS: 'status',

    /** Content type classification: 'note' | 'research' | 'meeting' | 'project' | 'reference' */
    TYPE: 'type',

    /** ISO timestamp of last AI processing */
    PROCESSED: 'processed',

    /** LLM model used (e.g., 'gpt-4o', 'claude-3-5-sonnet') */
    MODEL: 'model',

    /** Content source type: 'url' | 'pdf' | 'youtube' | 'audio' | 'note' */
    SOURCE: 'source',

    /** Original URL if web content */
    SOURCE_URL: 'source_url',

    /** Approximate word count */
    WORD_COUNT: 'word_count',

    /** Detected content language */
    LANGUAGE: 'language',

    /** Persona ID used for summarization (e.g., 'student', 'executive') */
    PERSONA: 'persona',
} as const;

/**
 * Maximum length for summary hook in frontmatter
 * Optimized for Obsidian Bases card preview
 */
export const SUMMARY_HOOK_MAX_LENGTH = 280;

/**
 * Default token limit for transcript chunking
 * Used by minutesService and textChunker
 */
export const CHUNK_TOKEN_LIMIT = 6000;

/**
 * Valid content type values
 */
export const CONTENT_TYPES = ['note', 'research', 'meeting', 'project', 'reference'] as const;
export type ContentType = typeof CONTENT_TYPES[number];

/**
 * Valid status values
 */
export const STATUS_VALUES = ['processed', 'pending', 'error'] as const;
export type StatusValue = typeof STATUS_VALUES[number];

/**
 * Valid source types
 */
export const SOURCE_TYPES = ['url', 'pdf', 'youtube', 'audio', 'note'] as const;
export type SourceType = typeof SOURCE_TYPES[number];

// Document format constants (single source of truth)
export const EXTRACTABLE_DOCUMENT_EXTENSIONS = ['docx', 'xlsx', 'pptx', 'txt', 'rtf'] as const;
export const ALL_DOCUMENT_EXTENSIONS = ['pdf', ...EXTRACTABLE_DOCUMENT_EXTENSIONS] as const;
export const DOCUMENT_EXTENSIONS_WITH_DOTS = ALL_DOCUMENT_EXTENSIONS.map(ext => `.${ext}`);
export type ExtractableDocumentExtension = typeof EXTRACTABLE_DOCUMENT_EXTENSIONS[number];

// Media extension constants (single source of truth)
export const IMAGE_EXTENSIONS: ReadonlyArray<string> = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'];
export const AUDIO_EXTENSIONS: ReadonlyArray<string> = ['.mp3', '.m4a', '.wav', '.webm', '.ogg', '.mp4', '.mpeg', '.mpga', '.oga'];
export const VIDEO_EXTENSIONS: ReadonlyArray<string> = ['.mp4', '.mov', '.avi'];

// Document extraction defaults
export const DEFAULT_MAX_DOCUMENT_CHARS = 50000;
export const DEFAULT_MULTI_SOURCE_MAX_DOCUMENT_CHARS = 100000;

// Content detection thresholds
export const MIN_TEXT_CONTENT_CHARS = 50;
export const SEARCH_TERM_SNIPPET_CHARS = 2000;

// Truncation choice types
export type TruncationChoice = 'truncate' | 'full' | 'skip';
export type OversizedBehavior = 'ask' | 'truncate' | 'full';

// Minutes detail level
export type MinutesDetailLevel = 'concise' | 'standard' | 'detailed';
export const DEFAULT_MINUTES_DETAIL_LEVEL: MinutesDetailLevel = 'standard';

// Integration strategy types
export type PlacementStrategy = 'cursor' | 'append' | 'callout' | 'merge';
export type FormatStrategy = 'prose' | 'bullets' | 'tasks' | 'table';
export type DetailStrategy = 'full' | 'concise' | 'summary';
export const DEFAULT_PLACEMENT_STRATEGY: PlacementStrategy = 'cursor';
export const DEFAULT_FORMAT_STRATEGY: FormatStrategy = 'prose';
export const DEFAULT_DETAIL_STRATEGY: DetailStrategy = 'full';
