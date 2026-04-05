/**
 * Embed Scan Service
 * Scans vault notes for embedded/linked files, builds reference maps, and detects possibly orphaned files.
 * 
 * Key design decisions:
 * - Does NOT reuse detectEmbeddedContent() directly because it deduplicates per note.
 *   Instead, we parse references ourselves to get accurate cross-note reference counts.
 * - Link normalization strips #anchors, ?queries, and |aliases before resolution.
 * - Orphan detection is labeled "possibly orphaned" — only markdown files are scanned,
 *   so canvas/json/plugin references are not checked.
 */

import { App, TFile, TFolder } from 'obsidian';
import {
    IMAGE_EXTENSIONS,
    AUDIO_EXTENSIONS,
    VIDEO_EXTENSIONS,
    ALL_DOCUMENT_EXTENSIONS,
} from '../core/constants';

// ─── Types ───────────────────────────────────────────────────────────────────

/** Classification of an embedded/linked target file */
export type EmbedTargetType = 'image' | 'pdf' | 'audio' | 'video' | 'document' | 'other';

/** A single reference from a source note to a target */
export interface EmbedReference {
    /** The markdown file containing the reference */
    sourceFile: TFile;
    /** 1-based line number of the reference */
    lineNumber: number;
    /** True if embed syntax (`![[]]` or `![]()`), false for link syntax */
    isEmbedded: boolean;
    /** The raw matched text in the source note */
    originalText: string;
}

/** An aggregated target file with all its incoming references */
export interface EmbedTarget {
    /** The resolved vault file, or null if unresolvable */
    file: TFile | null;
    /** The raw path/URL as written (normalized) */
    path: string;
    /** Classified file type */
    type: EmbedTargetType;
    /** File size in bytes (0 if unresolvable) */
    sizeBytes: number;
    /** All references pointing to this target across scanned notes */
    references: EmbedReference[];
}

/** Full scan result */
export interface EmbedScanResult {
    /** All referenced targets, sorted by size descending */
    targets: EmbedTarget[];
    /** Files that exist in vault with embed-type extensions but are not referenced by any scanned note */
    possiblyOrphaned: TFile[];
    /** Total notes scanned */
    notesScanned: number;
    /** Whether the scan was cancelled */
    cancelled: boolean;
}

/** Progress callback for vault-scale scans */
export interface ScanProgressCallback {
    (current: number, total: number, currentFile?: string): void;
}

/** Options for scan operations */
export interface EmbedScanOptions {
    /** Minimum file size in bytes to include in results (default: 0) */
    minSizeBytes?: number;
    /** Whether to include orphan detection — only meaningful for vault scope */
    includeOrphans?: boolean;
    /** AbortSignal for cancellation */
    signal?: AbortSignal;
    /** Progress callback */
    onProgress?: ScanProgressCallback;
}

// ─── Extension-based type classification ─────────────────────────────────────

/** All extensions considered "embed-type" files (non-markdown binary assets) */
export const EMBED_TYPE_EXTENSIONS: ReadonlyArray<string> = [
    ...IMAGE_EXTENSIONS,
    '.pdf',
    ...AUDIO_EXTENSIONS,
    ...VIDEO_EXTENSIONS,
    ...ALL_DOCUMENT_EXTENSIONS.filter(ext => ext !== 'pdf').map(ext => `.${ext}`),
];

/**
 * Classify a file extension into an EmbedTargetType.
 * Extension should include the leading dot (e.g., '.png').
 */
export function classifyExtension(ext: string): EmbedTargetType {
    const lower = ext.toLowerCase();
    if (IMAGE_EXTENSIONS.includes(lower)) return 'image';
    if (lower === '.pdf') return 'pdf';
    if (AUDIO_EXTENSIONS.includes(lower)) return 'audio';
    if (VIDEO_EXTENSIONS.includes(lower)) return 'video';
    // Document extensions are stored without dots in ALL_DOCUMENT_EXTENSIONS
    const withoutDot = lower.startsWith('.') ? lower.slice(1) : lower;
    if ((ALL_DOCUMENT_EXTENSIONS as readonly string[]).includes(withoutDot)) return 'document';
    return 'other';
}

// ─── Link normalization ──────────────────────────────────────────────────────

/**
 * Normalize a raw embed/link path by stripping anchors (#), query params (?), and aliases (|).
 * This ensures `file.pdf#page=2`, `note|alias`, and `image.png?v=1` all resolve correctly.
 */
export function normalizeEmbedPath(raw: string): string {
    let path = raw.trim();
    // Strip wiki-link alias: `file|alias` → `file`
    const pipeIdx = path.indexOf('|');
    if (pipeIdx !== -1) path = path.substring(0, pipeIdx);
    // Strip anchor: `file#heading` → `file`
    const hashIdx = path.indexOf('#');
    if (hashIdx !== -1) path = path.substring(0, hashIdx);
    // Strip query: `file?v=1` → `file`
    const queryIdx = path.indexOf('?');
    if (queryIdx !== -1) path = path.substring(0, queryIdx);
    return path.trim();
}

// ─── Regex patterns for reference detection ──────────────────────────────────

/** Matches `![alt](url)` — markdown embed */
const MARKDOWN_EMBED_RE = /!\[([^\]]*)\]\(([^)]+)\)/g;
/** Matches `![[file]]` or `![[file|alt]]` — wiki embed */
const WIKI_EMBED_RE = /!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;
/** Matches `[text](url)` but NOT preceded by `!` — markdown link */
const MARKDOWN_LINK_RE = /(?<!!)\[([^\]]+)\]\(([^)]+)\)/g;
/** Matches `[[file]]` or `[[file|display]]` but NOT preceded by `!` — wiki link */
const WIKI_LINK_RE = /(?<!!)\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;

export interface RawReference {
    path: string;
    lineNumber: number;
    isEmbedded: boolean;
    originalText: string;
}

/**
 * Extract all embed/link references from a single line of markdown.
 * Does NOT deduplicate — returns every occurrence.
 */
export function extractReferencesFromLine(line: string, lineNumber: number): RawReference[] {
    const refs: RawReference[] = [];

    for (const match of line.matchAll(MARKDOWN_EMBED_RE)) {
        refs.push({ path: match[2], lineNumber, isEmbedded: true, originalText: match[0] });
    }
    for (const match of line.matchAll(WIKI_EMBED_RE)) {
        refs.push({ path: match[1], lineNumber, isEmbedded: true, originalText: match[0] });
    }
    for (const match of line.matchAll(MARKDOWN_LINK_RE)) {
        // Exclude if preceded by `!` (already captured as embed)
        if (match.index !== undefined && match.index > 0 && line[match.index - 1] === '!') continue;
        refs.push({ path: match[2], lineNumber, isEmbedded: false, originalText: match[0] });
    }
    for (const match of line.matchAll(WIKI_LINK_RE)) {
        if (match.index !== undefined && match.index > 0 && line[match.index - 1] === '!') continue;
        refs.push({ path: match[1], lineNumber, isEmbedded: false, originalText: match[0] });
    }

    return refs;
}

/**
 * Check if a path points to an external URL
 */
export function isExternalUrl(path: string): boolean {
    return path.startsWith('http://') || path.startsWith('https://');
}

// ─── Core scanning logic ─────────────────────────────────────────────────────

/**
 * Scan a set of markdown files and build the full reference map with line numbers.
 * This is the main scan engine.
 */
export async function scanNotes(
    app: App,
    files: TFile[],
    options?: EmbedScanOptions
): Promise<EmbedScanResult> {
    const targetMap = new Map<string, EmbedTarget>();
    const minSize = options?.minSizeBytes ?? 0;
    let notesScanned = 0;

    for (let i = 0; i < files.length; i++) {
        if (options?.signal?.aborted) {
            return { targets: [], possiblyOrphaned: [], notesScanned, cancelled: true };
        }

        const sourceFile = files[i];
        options?.onProgress?.(i + 1, files.length, sourceFile.basename);

        let content: string;
        try {
            content = await app.vault.cachedRead(sourceFile);
        } catch {
            continue; // Skip unreadable files
        }

        const lines = content.split('\n');
        for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
            const rawRefs = extractReferencesFromLine(lines[lineIdx], lineIdx + 1);

            for (const raw of rawRefs) {
                // Skip external URLs — we only care about vault files
                if (isExternalUrl(raw.path)) continue;

                const normalized = normalizeEmbedPath(raw.path);
                if (!normalized) continue;

                // Resolve to a vault file
                const resolved = app.metadataCache.getFirstLinkpathDest(normalized, sourceFile.path);

                // Skip markdown files — we only care about binary/embed assets
                if (resolved && resolved.extension === 'md') continue;
                if (!resolved && !hasEmbedTypeExtension(normalized)) continue;

                const mapKey = resolved ? resolved.path : normalized.toLowerCase();

                let target = targetMap.get(mapKey);
                if (!target) {
                    const ext = resolved
                        ? `.${resolved.extension}`
                        : getExtensionFromPath(normalized);
                    target = {
                        file: resolved ?? null,
                        path: resolved?.path ?? normalized,
                        type: classifyExtension(ext),
                        sizeBytes: resolved?.stat?.size ?? 0,
                        references: []
                    };
                    targetMap.set(mapKey, target);
                }

                target.references.push({
                    sourceFile,
                    lineNumber: raw.lineNumber,
                    isEmbedded: raw.isEmbedded,
                    originalText: raw.originalText
                });
            }
        }

        notesScanned++;
    }

    // Filter by min size and sort by size descending
    let targets = Array.from(targetMap.values());
    if (minSize > 0) {
        targets = targets.filter(t => t.sizeBytes >= minSize);
    }
    targets.sort((a, b) => b.sizeBytes - a.sizeBytes);

    // Orphan detection (only if requested)
    let possiblyOrphaned: TFile[] = [];
    if (options?.includeOrphans) {
        const referencedPaths = new Set(
            Array.from(targetMap.values())
                .filter(t => t.file !== null)
                .map(t => t.file!.path)
        );
        possiblyOrphaned = findPossiblyOrphanedFiles(app, referencedPaths);
    }

    return { targets, possiblyOrphaned, notesScanned, cancelled: false };
}

// ─── Orphan detection ────────────────────────────────────────────────────────

/**
 * Find vault files with embed-type extensions that are NOT in the referenced set.
 * Only vault files in non-hidden folders are checked.
 * 
 * IMPORTANT: These are "possibly" orphaned — canvas/json/plugin files are not scanned.
 */
function findPossiblyOrphanedFiles(app: App, referencedPaths: Set<string>): TFile[] {
    const allFiles = app.vault.getFiles();
    return allFiles
        .filter(file => {
            // Must be an embed-type file
            if (!hasEmbedTypeExtension(file.name)) return false;
            // Must not be in a hidden/system folder
            if (file.path.startsWith('.')) return false;
            // Must not be already referenced
            return !referencedPaths.has(file.path);
        })
        .sort((a, b) => b.stat.size - a.stat.size);
}

/**
 * Check if a filename has an embed-type extension
 */
export function hasEmbedTypeExtension(filename: string): boolean {
    const lower = filename.toLowerCase();
    return EMBED_TYPE_EXTENSIONS.some(ext => lower.endsWith(ext));
}

/**
 * Extract extension from a path string (returns with leading dot)
 */
function getExtensionFromPath(path: string): string {
    const lastDot = path.lastIndexOf('.');
    if (lastDot === -1) return '';
    return path.substring(lastDot).toLowerCase();
}

// ─── Public helpers ──────────────────────────────────────────────────────────

/**
 * Format file size for display. Shared utility pattern.
 */
export function formatFileSize(bytes: number): string {
    if (bytes === 0) return '0 B';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * Get a Lucide icon name for an embed target type.
 */
export function getEmbedTypeIcon(type: EmbedTargetType): string {
    switch (type) {
        case 'image': return 'image';
        case 'pdf': return 'file-text';
        case 'audio': return 'music';
        case 'video': return 'video';
        case 'document': return 'file-spreadsheet';
        case 'other': return 'file';
    }
}

/**
 * Get all markdown files in a folder (recursive).
 */
export function getMarkdownFilesInFolder(app: App, folder: TFolder): TFile[] {
    const files: TFile[] = [];
    for (const child of folder.children) {
        if (child instanceof TFile && child.extension === 'md') {
            files.push(child);
        } else if (child instanceof TFolder) {
            files.push(...getMarkdownFilesInFolder(app, child));
        }
    }
    return files;
}
