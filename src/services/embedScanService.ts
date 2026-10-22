/**
 * Embed Scan Service
 * Scans vault notes for embedded/linked files, builds reference maps, and detects possibly orphaned files.
 * 
 * Key design decisions:
 * - Does NOT reuse detectEmbeddedContent() directly because it deduplicates per note.
 *   Instead, we parse references ourselves to get accurate cross-note reference counts.
 * - Link normalization strips #anchors, ?queries, and |aliases before resolution.
 * - References come from markdown notes AND canvas `file` nodes (JSON Canvas 1.0). Other formats
 *   (plugin JSON, other plugins' files) are not scanned, so orphan detection stays labeled
 *   "possibly orphaned" and the trash confirmation says so.
 * - A canvas that cannot be parsed, or a note that cannot be read, is a coverage failure: it is
 *   reported and blocks trashing anything it might reference.
 */

import { App, TFile, TFolder } from 'obsidian';
import { Result, ok, err } from '../core/result';
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
    /** Where the reference lives. Absent means a markdown note. */
    kind?: 'markdown' | 'canvas';
    /** Canvas node id when `kind` is `canvas` */
    nodeId?: string;
}

/** A reference as it was scanned, kept so a later check can re-resolve it against current paths. */
export interface StoredOccurrence {
    referrerPath: string;
    kind: 'markdown' | 'canvas';
    /** The normalised link text (markdown) or the canvas node's file path */
    linktext: string;
    lineNumber: number;
}

/** A referrer that could not be read, so its references are unknown. */
export interface CoverageFailure {
    path: string;
    kind: 'canvas-unreadable' | 'markdown-unreadable';
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
    /** True when some link to this file could also match another file with the same name */
    ambiguous?: boolean;
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
    /** Canvas files scanned for `file` nodes */
    canvasesScanned?: number;
    /** Referrers that could not be read; any entry blocks trashing */
    coverageFailures?: CoverageFailure[];
    /** Paths of files that some link could not tell apart from another file of the same name */
    ambiguousPaths?: string[];
    /** `Date.now()` when the scan began; later vault changes make the result out of date */
    scanStartedAt?: number;
    /** Every non-markdown reference found, for re-resolution at trash confirmation */
    occurrences?: StoredOccurrence[];
    /** Every note and canvas that was actually read, with its modified time then. A later check
     *  treats any referrer NOT listed here (or changed since) as unscanned and reads it again. */
    scannedReferrers?: { path: string; mtime: number }[];
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

// ─── Canvas references (JSON Canvas 1.0) ─────────────────────────────────────

/** A `file` node of a canvas. */
export interface CanvasFileRef {
    nodeId: string;
    file: string;
    subpath?: string;
}

/**
 * Parse the `file` nodes out of a canvas. Pure. Anything that is not a JSON object is
 * `canvas-unreadable`; a missing or non-array `nodes` field simply means no nodes.
 */
export function parseCanvasFileRefs(text: string): Result<CanvasFileRef[]> {
    let data: unknown;
    try {
        data = JSON.parse(text);
    } catch {
        return err('canvas-unreadable');
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return err('canvas-unreadable');
    const nodes = (data as { nodes?: unknown }).nodes;
    if (nodes === undefined) return ok([]);
    if (!Array.isArray(nodes)) return err('canvas-unreadable');
    const refs: CanvasFileRef[] = [];
    for (const node of nodes) {
        if (!node || typeof node !== 'object') continue;
        const n = node as { id?: unknown; type?: unknown; file?: unknown; subpath?: unknown };
        if (n.type !== 'file' || typeof n.file !== 'string' || n.file === '') continue;
        refs.push({
            nodeId: typeof n.id === 'string' ? n.id : '',
            file: n.file,
            subpath: typeof n.subpath === 'string' ? n.subpath : undefined,
        });
    }
    return ok(refs);
}

/** The text of every `text` node of a canvas (these can contain `![[file]]` links like any note). */
export function parseCanvasTextNodes(text: string): string[] {
    let data: unknown;
    try {
        data = JSON.parse(text);
    } catch {
        return [];
    }
    const nodes = data && typeof data === 'object' ? (data as { nodes?: unknown }).nodes : undefined;
    if (!Array.isArray(nodes)) return [];
    const out: string[] = [];
    for (const node of nodes) {
        if (!node || typeof node !== 'object') continue;
        const n = node as { type?: unknown; text?: unknown; id?: unknown };
        if (n.type === 'text' && typeof n.text === 'string') out.push(n.text);
    }
    return out;
}

/** True when the path has a non-markdown extension (a link to a note has none or `.md`). */
function pointsAtNonMarkdown(normalized: string): boolean {
    const ext = getExtensionFromPath(normalized);
    return ext !== '' && ext !== '.md';
}

/**
 * Collect the candidate attachment references in one referrer's text. Pure: no vault access.
 * Markdown yields one occurrence per link or embed that points at a non-markdown path;
 * a canvas yields one per `file` node. An unparseable canvas is a coverage failure.
 */
export function collectOccurrences(
    referrerPath: string,
    extension: string,
    text: string,
): { occurrences: StoredOccurrence[]; embedded: Map<StoredOccurrence, RawReference>; failure?: CoverageFailure } {
    const occurrences: StoredOccurrence[] = [];
    const embedded = new Map<StoredOccurrence, RawReference>();
    if (extension === 'canvas') {
        const parsed = parseCanvasFileRefs(text);
        if (!parsed.ok) return { occurrences, embedded, failure: { path: referrerPath, kind: 'canvas-unreadable' } };
        for (const ref of parsed.value) {
            const occ: StoredOccurrence = { referrerPath, kind: 'canvas', linktext: ref.file, lineNumber: 0 };
            occurrences.push(occ);
            embedded.set(occ, { path: ref.file, lineNumber: 0, isEmbedded: true, originalText: ref.nodeId });
        }
        // Text nodes hold Markdown: a link or embed in one references the file just like in a note.
        for (const nodeText of parseCanvasTextNodes(text)) {
            for (const raw of nodeText.split('\n').flatMap((line) => extractReferencesFromLine(line, 0))) {
                if (isExternalUrl(raw.path)) continue;
                const normalized = normalizeEmbedPath(raw.path);
                if (!normalized || !pointsAtNonMarkdown(normalized)) continue;
                const occ: StoredOccurrence = { referrerPath, kind: 'canvas', linktext: normalized, lineNumber: 0 };
                occurrences.push(occ);
                embedded.set(occ, { path: normalized, lineNumber: 0, isEmbedded: raw.isEmbedded, originalText: 'text node' });
            }
        }
        return { occurrences, embedded };
    }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
        for (const raw of extractReferencesFromLine(lines[i], i + 1)) {
            if (isExternalUrl(raw.path)) continue;
            const normalized = normalizeEmbedPath(raw.path);
            if (!normalized || !pointsAtNonMarkdown(normalized)) continue;
            const occ: StoredOccurrence = { referrerPath, kind: 'markdown', linktext: normalized, lineNumber: raw.lineNumber };
            occurrences.push(occ);
            embedded.set(occ, raw);
        }
    }
    return { occurrences, embedded };
}

/**
 * Index of vault files by lower-case file name, used to tell whether a link could match more
 * than one file. A link matches a file when it equals the path, or is a trailing part of it.
 */
export function buildCandidateIndex(paths: Iterable<string>): (linktext: string) => string[] {
    const byName = new Map<string, string[]>();
    for (const path of paths) {
        const name = path.split('/').pop()!.toLowerCase();
        const list = byName.get(name);
        if (list) list.push(path);
        else byName.set(name, [path]);
    }
    return (linktext: string) => {
        const lower = linktext.replaceAll('\\', '/').replace(/^\/+/, '').toLowerCase();
        const name = lower.split('/').pop()!;
        const sameName = byName.get(name) ?? [];
        if (!lower.includes('/')) return [...sameName];
        return sameName.filter((p) => {
            const pl = p.toLowerCase();
            return pl === lower || pl.endsWith('/' + lower);
        });
    };
}

// ─── Core scanning logic ─────────────────────────────────────────────────────

/**
 * Scan a set of notes and canvases and build the full reference map with line numbers.
 * Markdown files and `.canvas` files may be mixed in `files`. This is the main scan engine.
 */
export async function scanNotes(
    app: App,
    files: TFile[],
    options?: EmbedScanOptions
): Promise<EmbedScanResult> {
    const targetMap = new Map<string, EmbedTarget>();
    const minSize = options?.minSizeBytes ?? 0;
    const scanStartedAt = Date.now();
    const occurrences: StoredOccurrence[] = [];
    const coverageFailures: CoverageFailure[] = [];
    const ambiguous = new Set<string>();
    const scannedReferrers: { path: string; mtime: number }[] = [];
    const candidatesFor = buildCandidateIndex(app.vault.getFiles().map((f) => f.path));
    let notesScanned = 0;
    let canvasesScanned = 0;

    for (let i = 0; i < files.length; i++) {
        if (options?.signal?.aborted) {
            return { targets: [], possiblyOrphaned: [], notesScanned, cancelled: true, scanStartedAt };
        }

        const sourceFile = files[i];
        options?.onProgress?.(i + 1, files.length, sourceFile.basename);
        const isCanvas = sourceFile.extension === 'canvas';

        let content: string;
        // The modified time must describe the revision that was read, so take it before the read and
        // keep it only if it is unchanged afterwards (otherwise record "unknown" so it is read again).
        const mtimeBeforeRead = sourceFile.stat.mtime;
        try {
            content = await app.vault.cachedRead(sourceFile);
        } catch {
            coverageFailures.push({ path: sourceFile.path, kind: isCanvas ? 'canvas-unreadable' : 'markdown-unreadable' });
            continue;
        }

        const collected = collectOccurrences(sourceFile.path, isCanvas ? 'canvas' : 'md', content);
        if (collected.failure) {
            coverageFailures.push(collected.failure);
            continue;
        }
        scannedReferrers.push({
            path: sourceFile.path,
            mtime: sourceFile.stat.mtime === mtimeBeforeRead ? mtimeBeforeRead : -1,
        });

        for (const occ of collected.occurrences) {
            const raw = collected.embedded.get(occ)!;
            const normalized = occ.linktext;

            // Resolve to a vault file. A canvas node holds a vault-relative path.
            let resolved: TFile | null;
            if (isCanvas) {
                const direct = app.vault.getAbstractFileByPath(normalized);
                resolved = direct instanceof TFile ? direct : app.metadataCache.getFirstLinkpathDest(normalized, sourceFile.path);
            } else {
                resolved = app.metadataCache.getFirstLinkpathDest(normalized, sourceFile.path);
            }

            // Skip markdown files — we only care about binary/embed assets
            if (resolved && resolved.extension === 'md') continue;
            if (!resolved && !hasEmbedTypeExtension(normalized)) continue;

            occurrences.push(occ);

            const candidates = candidatesFor(normalized);
            const isAmbiguous = !isCanvas && candidates.length > 1;
            if (isAmbiguous) for (const c of candidates) ambiguous.add(c);

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
                originalText: isCanvas ? `canvas node ${raw.originalText}` : raw.originalText,
                kind: isCanvas ? 'canvas' : 'markdown',
                nodeId: isCanvas ? raw.originalText : undefined,
            });
        }

        if (isCanvas) canvasesScanned++;
        else notesScanned++;
    }

    for (const target of targetMap.values()) {
        if (target.file && ambiguous.has(target.file.path)) target.ambiguous = true;
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

    return {
        targets,
        possiblyOrphaned,
        notesScanned,
        cancelled: false,
        canvasesScanned,
        coverageFailures,
        ambiguousPaths: [...ambiguous],
        scanStartedAt,
        occurrences,
        scannedReferrers,
    };
}

// ─── Orphan detection ────────────────────────────────────────────────────────

/**
 * Find vault files with embed-type extensions that are NOT in the referenced set.
 * Only vault files in non-hidden folders are checked.
 * 
 * IMPORTANT: These are "possibly" orphaned — json/plugin files are not scanned.
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
 * Get all canvas files in a folder (recursive).
 */
export function getCanvasFilesInFolder(folder: TFolder): TFile[] {
    const files: TFile[] = [];
    for (const child of folder.children) {
        if (child instanceof TFile && child.extension === 'canvas') {
            files.push(child);
        } else if (child instanceof TFolder) {
            files.push(...getCanvasFilesInFolder(child));
        }
    }
    return files;
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
