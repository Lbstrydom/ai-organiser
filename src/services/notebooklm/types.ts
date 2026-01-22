/**
 * NotebookLM Source Pack Data Contracts
 * 
 * Type definitions for the NotebookLM integration feature.
 * This defines the configuration, manifest structure, and data contracts
 * for exporting Obsidian notes as NotebookLM-ready source packs.
 */

/**
 * Configuration for source pack generation and sanitisation
 */
export interface SourcePackConfig {
    /** Export mode: auto (smart), modular (split by word budget), or single file */
    exportMode: 'auto' | 'modular' | 'single';
    
    /** Maximum words per module file (default: 120,000; NotebookLM max: 500,000) */
    maxWordsPerModule: number;

    // Sanitisation toggles
    /** Remove YAML frontmatter from notes */
    removeFrontmatter: boolean;
    
    /** Flatten callout blocks to plain text */
    flattenCallouts: boolean;
    
    /** Remove dataview code blocks */
    stripDataview: boolean;
    
    /** Remove dataviewjs code blocks */
    stripDataviewJs: boolean;

    // Embed handling
    /** How to resolve note embeds/transclusions */
    resolveEmbeds: 'none' | 'titleOnly' | 'excerpt';
    
    /** Maximum recursion depth for embed resolution */
    embedMaxDepth: number;
    
    /** Maximum characters per resolved embed */
    embedMaxChars: number;

    // Link context (optional feature)
    /** Include context snippets for outgoing links */
    includeLinkContext: boolean;
    
    /** Max characters of context per link */
    linkContextMaxChars: number;
    
    /** Depth for link context resolution */
    linkContextDepth: number;

    // Image handling
    /** How to handle image references */
    imageHandling: 'strip' | 'placeholder' | 'exportAssets';

    // Post-export actions
    /** What to do with selection tags after export */
    postExportTagAction: 'keep' | 'clear' | 'archive';
}

/**
 * Manifest sidecar file - metadata about the pack (not for NotebookLM upload)
 */
export interface PackManifest {
    /** Unique pack identifier (UUID) */
    packId: string;
    
    /** Revision number (increments on content changes) */
    revision: number;
    
    /** ISO datetime of generation */
    generatedAt: string;
    
    /** Scope definition */
    scope: {
        type: 'folder' | 'tag' | 'query' | 'mixed';
        value: string;
    };
    
    /** Aggregated statistics */
    stats: PackStats;
    
    /** Configuration used for this pack */
    config: SourcePackConfig;
    
    /** Array of included notes with metadata */
    entries: PackEntry[];
}

/**
 * Statistics for a source pack
 */
export interface PackStats {
    /** Number of notes included */
    noteCount: number;
    
    /** Number of module files generated */
    moduleCount: number;
    
    /** Total word count across all notes */
    totalWords: number;
    
    /** Total byte count */
    totalBytes: number;
}

/**
 * Metadata for a single note in the pack
 */
export interface PackEntry {
    /** Vault-relative file path */
    filePath: string;
    
    /** Note title (from filename or frontmatter) */
    title: string;
    
    /** ISO datetime of last modification */
    mtime: string;
    
    /** Tags from frontmatter */
    tags: string[];
    
    /** Word count after sanitisation */
    wordCount: number;
    
    /** Byte count after sanitisation */
    byteCount: number;
    
    /** SHA256 hash of sanitised content */
    sha256: string;
    
    /** Short ID (first 6-8 chars of hash) for stable anchors */
    shortId: string;
}

/**
 * Pack registry entry (tracks revisions across sessions)
 */
export interface PackRegistryEntry {
    /** Pack identifier */
    packId: string;
    
    /** Scope key (folder path, tag name, etc.) */
    scopeKey: string;
    
    /** Current revision number */
    revision: number;
    
    /** Hash of pack content (for change detection) */
    packHash: string;
    
    /** ISO datetime of last export */
    lastExportedAt: string;
    
    /** Path to pack folder */
    packFolderPath: string;
}

/**
 * Pack registry (persisted to disk)
 */
export interface PackRegistry {
    /** Registry format version */
    version: number;
    
    /** Map of scopeKey -> PackRegistryEntry */
    packs: Record<string, PackRegistryEntry>;
}

/**
 * Changelog entry types
 */
export type ChangelogEntryType = 'added' | 'removed' | 'changed' | 'warning';

/**
 * Single entry in the changelog
 */
export interface ChangelogEntry {
    type: ChangelogEntryType;
    filePath: string;
    title: string;
    details?: string;
}

/**
 * Generated changelog for a pack revision
 */
export interface Changelog {
    /** Old revision number */
    fromRevision: number;
    
    /** New revision number */
    toRevision: number;
    
    /** ISO datetime of changelog generation */
    generatedAt: string;
    
    /** Array of changes */
    entries: ChangelogEntry[];
    
    /** Summary counts */
    summary: {
        added: number;
        removed: number;
        changed: number;
        warnings: number;
    };
}

/**
 * Module content structure (for internal use before writing)
 */
export interface ModuleContent {
    /** Module number (1-indexed) */
    moduleNumber: number;
    
    /** Module filename */
    fileName: string;
    
    /** Array of sanitised note contents with anchors */
    noteContents: string[];
    
    /** Total word count in this module */
    wordCount: number;
    
    /** Total byte count in this module */
    byteCount: number;
    
    /** Entries included in this module */
    entries: PackEntry[];
}

/**
 * Sanitisation result for a single note
 */
export interface SanitisedNote {
    /** Original file path */
    filePath: string;
    
    /** Note title */
    title: string;
    
    /** Sanitised content (markdown) */
    content: string;
    
    /** Word count */
    wordCount: number;
    
    /** Byte count */
    byteCount: number;
    
    /** SHA256 hash */
    sha256: string;
    
    /** Short ID */
    shortId: string;
    
    /** Warnings generated during sanitisation */
    warnings: string[];
}

/**
 * Selection result (notes selected for export)
 */
export interface SelectionResult {
    /** Array of TFile objects */
    files: any[]; // Use 'any' to avoid importing Obsidian types here
    
    /** Total word count estimate (before sanitisation) */
    estimatedWords: number;
    
    /** Selection method used */
    selectionMethod: 'tag' | 'manual' | 'folder' | 'query';
    
    /** Scope value (tag name, folder path, etc.) */
    scopeValue: string;
}

/**
 * Export operation result
 */
export interface ExportResult {
    /** Success status */
    success: boolean;
    
    /** Pack folder path (if successful) */
    packFolderPath?: string;
    
    /** Pack ID */
    packId?: string;
    
    /** Revision number */
    revision?: number;
    
    /** Statistics */
    stats?: PackStats;
    
    /** Error message (if failed) */
    errorMessage?: string;
    
    /** Warnings */
    warnings?: string[];
}

/**
 * Validation warnings for NotebookLM limits
 */
export interface ValidationWarnings {
    /** Approaching/exceeding 50 module limit */
    moduleCountWarning?: string;
    
    /** Approaching/exceeding 500k word limit per module */
    moduleWordLimitWarning?: string;
    
    /** Approaching/exceeding 200MB per module */
    moduleSizeLimitWarning?: string;
    
    /** Total pack size warning */
    totalSizeWarning?: string;
}

/**
 * Preview data for the export modal
 */
export interface ExportPreview {
    /** Selection result */
    selection: SelectionResult;
    
    /** Estimated module count */
    estimatedModuleCount: number;
    
    /** Validation warnings */
    warnings: ValidationWarnings;
    
    /** Config to be used */
    config: SourcePackConfig;
}
