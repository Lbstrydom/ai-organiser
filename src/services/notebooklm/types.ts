/**
 * NotebookLM Source Pack Data Contracts
 *
 * Type definitions for the NotebookLM integration feature.
 * This defines the configuration, manifest structure, and data contracts
 * for exporting Obsidian notes as PDF source packs for NotebookLM.
 */

/**
 * Configuration for PDF-based source pack generation
 */
export interface SourcePackConfig {
    /** Tag used to select notes for export */
    selectionTag: string;

    /** Export folder path */
    exportFolder: string;

    /** What to do with selection tags after export */
    postExportTagAction: 'clear' | 'archive';
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

    /** Total byte count of PDFs */
    totalBytes: number;
}

/**
 * Metadata for a single note in the pack
 */
export interface PackEntry {
    /** Vault-relative file path */
    filePath: string;

    /** Exported PDF filename */
    pdfName: string;

    /** Note title (from filename or frontmatter) */
    title: string;

    /** ISO datetime of last modification */
    mtime: string;

    /** Tags from frontmatter */
    tags: string[];

    /** PDF file size in bytes */
    sizeBytes: number;

    /** SHA256 hash of note content (for change detection) */
    sha256: string;
}

/**
 * Pack registry entry (tracks revisions across sessions)
 */
export interface PackRegistryEntry {
    /** Pack identifier */
    packId: string;

    /** Scope key (based on selection tag) */
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
export type ChangelogEntryType = 'added' | 'removed' | 'changed';

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
    };
}

/**
 * Selection result (notes selected for export)
 */
export interface SelectionResult {
    /** Array of TFile objects */
    files: any[]; // Use 'any' to avoid importing Obsidian types here

    /** Selection method used */
    selectionMethod: 'tag' | 'manual' | 'folder';

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
    /** Approaching/exceeding 50 source limit */
    sourceCountWarning?: string;

    /** Approaching/exceeding 200MB total size */
    totalSizeWarning?: string;
}

/**
 * Preview data for the export modal
 */
export interface ExportPreview {
    /** Selection result */
    selection: SelectionResult;

    /** Estimated total size */
    estimatedSizeBytes: number;

    /** Validation warnings */
    warnings: ValidationWarnings;

    /** Config to be used */
    config: SourcePackConfig;
}
