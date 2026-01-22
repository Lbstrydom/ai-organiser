/**
 * AI Organiser Constants
 * Centralizes constants used throughout the plugin
 */

/**
 * Frontmatter property namespace for AI Organiser metadata
 * All properties use the aio_ prefix to avoid conflicts with user properties
 */
export const AIO_META = {
    /** 280-char summary hook for Bases preview */
    SUMMARY: 'aio_summary',
    
    /** Processing status: 'processed' | 'pending' | 'error' */
    STATUS: 'aio_status',
    
    /** Content type classification: 'note' | 'research' | 'meeting' | 'project' | 'reference' */
    TYPE: 'aio_type',
    
    /** ISO timestamp of last AI processing */
    PROCESSED: 'aio_processed',
    
    /** LLM model used (e.g., 'gpt-4o', 'claude-3-5-sonnet') */
    MODEL: 'aio_model',
    
    /** Content source type: 'url' | 'pdf' | 'youtube' | 'audio' | 'note' */
    SOURCE: 'aio_source',
    
    /** Original URL if web content */
    SOURCE_URL: 'aio_source_url',
    
    /** Approximate word count */
    WORD_COUNT: 'aio_word_count',
    
    /** Detected content language */
    LANGUAGE: 'aio_language',
    
    /** Persona ID used for summarization (e.g., 'student', 'executive') */
    PERSONA: 'aio_persona',
} as const;

/**
 * Maximum length for summary hook in frontmatter
 * Optimized for Obsidian Bases card preview
 */
export const SUMMARY_HOOK_MAX_LENGTH = 280;

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
