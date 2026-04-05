/**
 * Prompt-related type definitions
 */

// TaggingMode is maintained for backward compatibility with legacy tagging paths.
// The plugin primarily uses a unified taxonomy-based approach, but legacy modes
// remain active fallbacks for users without a configured taxonomy.
export enum TaggingMode {
    PredefinedTags = 'predefined',
    GenerateNew = 'generate',
    Hybrid = 'hybrid',
    Custom = 'custom'
}
