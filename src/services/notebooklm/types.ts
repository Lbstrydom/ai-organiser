/**
 * NotebookLM Source Pack Data Contracts
 *
 * Type definitions for the NotebookLM integration feature.
 */

/**
 * Export format: 'text' produces a clean .txt file per note (default);
 * 'pdf' uses the legacy jsPDF path (strips code/math/mermaid blocks).
 */
export type ExportFormat = 'text' | 'pdf';

/** Whether creating a brand-new pack or incrementally updating an existing one */
export type ExportMode = 'new' | 'update';

/**
 * Configuration for source pack generation
 */
export interface SourcePackConfig {
    /** Tag used to select notes for export */
    selectionTag: string;

    /** Export folder path */
    exportFolder: string;

    /** What to do with selection tags after export */
    postExportTagAction: 'keep' | 'clear' | 'archive';

    /** Export format: 'text' (default) or 'pdf' (legacy) */
    exportFormat: ExportFormat;

    /** PDF generation configuration (only used when exportFormat === 'pdf') */
    pdf: PdfConfig;
}

/**
 * PDF generation configuration
 */
export interface PdfConfig {
    /** Page size (A4, Letter, Legal) */
    pageSize: 'A4' | 'Letter' | 'Legal';

    /** Font name (must be supported by jsPDF) */
    fontName: string;

    /** Base font size in points */
    fontSize: number;

    /** Include frontmatter in exported content */
    includeFrontmatter: boolean;

    /** Include note title as H1 at top */
    includeTitle: boolean;

    /** Left/right page margin in mm */
    marginX: number;

    /** Top/bottom page margin in mm */
    marginY: number;

    /** Line height multiplier */
    lineHeight: number;
}

/**
 * Default PDF configuration
 */
export const DEFAULT_PDF_CONFIG: PdfConfig = {
    pageSize: 'A4',
    fontName: 'helvetica',
    fontSize: 11,
    includeFrontmatter: false,
    includeTitle: true,
    marginX: 20,
    marginY: 20,
    lineHeight: 1.5
};

/**
 * PDF generator interface
 */
export interface IPdfGenerator {
    generate(title: string, markdown: string, config: PdfConfig): Promise<ArrayBuffer>;
}

/**
 * Manifest sidecar file — metadata about the pack (not for NotebookLM upload)
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

    /** Total byte count of all exported files */
    totalBytes: number;
}

/**
 * Metadata for a single note or sidecar in the pack
 */
export interface PackEntry {
    /** Entry type: note-text, note-pdf (generated from note) or attachment (linked doc) */
    type: 'note-text' | 'note-pdf' | 'attachment';

    /** Vault-relative file path */
    filePath: string;

    /**
     * Exported output filename within the pack folder.
     * Renamed from legacy `pdfName`; reads both on load via normalizePackEntry().
     */
    outputName: string;

    /** Note title (from filename or frontmatter) */
    title: string;

    /** ISO datetime of last modification */
    mtime: string;

    /** Tags from frontmatter */
    tags: string[];

    /** File size in bytes */
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

    /**
     * Hash of export config subset that affects rendering.
     * Empty string triggers full re-export when reading legacy entries.
     */
    configHash: string;
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
    files: import('obsidian').TFile[];

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

    /** Warnings (per-note failures that didn't abort the export) */
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

    /** Linked documents detected in selected notes */
    linkedDocuments: LinkedDocument[];

    /** Validation warnings */
    warnings: ValidationWarnings;

    /** Config to be used */
    config: SourcePackConfig;

    /** Whether a previous pack exists for this scope (enables Update Pack UX) */
    hasPreviousPack: boolean;

    /** Whether export config changed since last pack (disables Update Pack) */
    configChanged: boolean;
}

export interface LinkedDocument {
    sourceFile: string;
    path: string;
    displayName: string;
    type: 'document' | 'pdf';
    /** Resolved file size in bytes (0 if unknown) */
    sizeBytes?: number;
}

/**
 * Unified snapshot entry for incremental export diffing.
 * Covers both notes and sidecar documents.
 */
export interface SnapshotEntry {
    kind: 'note' | 'sidecar';
    /** Vault-relative path for notes; normalized URL/path for sidecars */
    sourceKey: string;
    contentHash: string;
    outputName: string;
}
