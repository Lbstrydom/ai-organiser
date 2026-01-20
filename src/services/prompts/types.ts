/**
 * Prompt-related type definitions
 */

// TaggingMode is deprecated - the plugin now uses a unified taxonomy-based approach
// Keeping for backward compatibility with any existing code that references it
export enum TaggingMode {
    /**
     * @deprecated Use taxonomy-based tagging instead
     */
    PredefinedTags = 'predefined',

    /**
     * @deprecated Use taxonomy-based tagging instead
     */
    GenerateNew = 'generate',

    /**
     * @deprecated Use taxonomy-based tagging instead
     */
    Hybrid = 'hybrid',

    /**
     * @deprecated Use taxonomy-based tagging instead
     */
    Custom = 'custom'
}
