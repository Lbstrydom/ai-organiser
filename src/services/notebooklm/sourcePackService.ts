/**
 * Source Pack Service — Main Orchestrator
 *
 * Coordinates text/PDF export for NotebookLM source packs.
 * Generates .txt or .pdf files from markdown notes and copies linked documents as sidecars.
 */

import { App, TFile } from 'obsidian';
import {
    SourcePackConfig,
    ExportResult,
    SelectionResult,
    ExportPreview,
    ValidationWarnings,
    LinkedDocument,
    PackManifest,
    PackEntry,
    PackStats,
} from './types';
import { ok, err } from '../../core/result';
import type { Result } from '../../core/result';
import { SelectionService } from './selectionService';
import { WriterService } from './writer';
import { RegistryService } from './registry';
import { computeSHA256, computeBinarySHA256 } from './hashing';
import { MarkdownPdfGenerator } from './pdf/MarkdownPdfGenerator';
import { preprocessNoteForNotebookLM, PREPROCESSOR_VERSION } from './textPreprocessor';
import { formatBytes, resolveOutputName } from './notebooklmUtils';
import { detectEmbeddedContent } from '../../utils/embeddedContentDetector';
import { extractTagsFromCache } from '../../utils/tagUtils';
import { logger } from '../../utils/logger';

/** Sleep utility for async yielding to keep UI responsive */
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** Number of items to process before yielding to UI */
const YIELD_BATCH_SIZE = 5;

/** Yield duration in milliseconds */
const YIELD_DURATION_MS = 20;

/** Estimated bytes per note for size preview (format-dependent) */
const ESTIMATED_TEXT_NOTE_BYTES = 5 * 1024;   // 5 KB text
const ESTIMATED_PDF_NOTE_BYTES = 50 * 1024;   // 50 KB PDF

/**
 * Main service for NotebookLM source pack operations
 */
export class SourcePackService {
    private readonly selectionService: SelectionService;
    private readonly writerService: WriterService;
    private readonly registryService: RegistryService;
    private readonly pdfGenerator: MarkdownPdfGenerator;

    constructor(private app: App, private config: SourcePackConfig) {
        this.selectionService = new SelectionService(app);
        this.writerService = new WriterService(app);
        this.registryService = new RegistryService(app);
        this.pdfGenerator = new MarkdownPdfGenerator();
    }

    async initialize(): Promise<void> {
        await this.registryService.loadRegistry();
    }

    updateConfig(config: SourcePackConfig): void {
        this.config = config;
    }

    getSelectionCount(): number {
        return this.selectionService.getSelectionCount();
    }

    /**
     * Get preview data for the export modal.
     * Detects linked documents once and includes them in the result to avoid
     * redundant scanning in executeExport (B8).
     */
    async getExportPreview(selectionTag?: string): Promise<ExportPreview> {
        const tag = selectionTag ?? this.config.selectionTag;
        const selection = await this.selectionService.getSelectedNotes(tag);

        const linkedDocuments = await this.collectLinkedDocuments(selection.files);

        const totalSourceCount = selection.files.length + linkedDocuments.length;
        const estimatedNoteSize = this.config.exportFormat === 'text'
            ? ESTIMATED_TEXT_NOTE_BYTES
            : ESTIMATED_PDF_NOTE_BYTES;

        const estimatedSizeBytes =
            selection.files.length * estimatedNoteSize +
            this.estimateAttachmentsSize(linkedDocuments);

        const warnings: ValidationWarnings = {};
        if (totalSourceCount > 50) {
            warnings.sourceCountWarning =
                `${totalSourceCount} sources selected (${selection.files.length} notes + ${linkedDocuments.length} linked documents). NotebookLM limit is 50 sources per notebook.`;
        } else if (totalSourceCount > 45) {
            warnings.sourceCountWarning =
                `${totalSourceCount} sources selected (${selection.files.length} notes + ${linkedDocuments.length} linked documents). Approaching NotebookLM limit of 50 sources.`;
        }

        if (estimatedSizeBytes > 200 * 1024 * 1024) {
            warnings.totalSizeWarning = `Estimated size (${formatBytes(estimatedSizeBytes)}) exceeds NotebookLM limit of 200 MB.`;
        } else if (estimatedSizeBytes > 180 * 1024 * 1024) {
            warnings.totalSizeWarning = `Estimated size (${formatBytes(estimatedSizeBytes)}) approaching NotebookLM limit of 200 MB.`;
        }

        const scopeKey = `tag:${tag}`;
        const hasPreviousPack = this.registryService.hasBeenExported(scopeKey);
        const configChanged = hasPreviousPack
            ? this.registryService.getEntry(scopeKey)?.configHash !== computeConfigHash(this.config)
            : false;

        return {
            selection,
            estimatedSizeBytes,
            linkedDocuments,
            warnings,
            config: this.config,
            hasPreviousPack,
            configChanged,
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Full export
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Execute a full (new-pack) export.
     *
     * @param selection   - Notes to export
     * @param onProgress  - Progress callback
     * @param folderName  - Optional pack folder name (defaults to timestamp)
     * @param linkedDocs  - Pre-collected linked documents (skips re-scan when provided)
     * @param signal      - AbortSignal for cancellation
     */
    async executeExport(
        selection: SelectionResult,
        onProgress?: (current: number, total: number, message: string) => void,
        folderName?: string,
        linkedDocs?: LinkedDocument[],
        signal?: AbortSignal
    ): Promise<ExportResult> {
        const warnings: string[] = [];
        const entries: PackEntry[] = [];
        let totalBytes = 0;

        // Temp folder for transactional write
        const tmpFolderPath = `${this.config.exportFolder}/__tmp-${Date.now()}`;

        try {
            const packId = this.generatePackId();
            const name = folderName
                ?? new Date().toISOString().replaceAll(/[:.]/g, '-').slice(0, 19);

            // Collision-safe final folder name
            let packFolderPath = `${this.config.exportFolder}/${name}`;
            let counter = 2;
            while (this.app.vault.getAbstractFileByPath(packFolderPath) && counter <= 999) {
                packFolderPath = `${this.config.exportFolder}/${name}-${counter}`;
                counter++;
            }

            // Ensure export root exists, create temp folder
            await this.writerService.ensureFolder(this.config.exportFolder);
            await this.writerService.ensureFolder(tmpFolderPath);

            // Collect linked docs (use pre-scanned result if available)
            const uniqueLinkedDocs = linkedDocs ?? await this.collectLinkedDocuments(selection.files);
            const totalItems = selection.files.length + uniqueLinkedDocs.length;
            const used = new Set<string>(); // filename collision set

            let processedCount = 0;

            // Process notes
            for (const file of selection.files) {
                if (signal?.aborted) {
                    await this.cleanupTemp(tmpFolderPath);
                    return { success: false, errorMessage: 'Export cancelled' };
                }

                processedCount++;
                onProgress?.(processedCount, totalItems, `Processing: ${file.basename}`);

                const result = await this.processNote(file, tmpFolderPath, used);
                if (result.ok) {
                    entries.push(result.value);
                    totalBytes += result.value.sizeBytes;
                } else {
                    warnings.push(`Failed to process note "${file.basename}": ${result.error}`);
                }

                if (processedCount % YIELD_BATCH_SIZE === 0) await sleep(YIELD_DURATION_MS);
            }

            // Process linked documents
            for (const linkedDoc of uniqueLinkedDocs) {
                if (signal?.aborted) {
                    await this.cleanupTemp(tmpFolderPath);
                    return { success: false, errorMessage: 'Export cancelled' };
                }

                processedCount++;
                onProgress?.(processedCount, totalItems, `Copying attachment: ${linkedDoc.displayName}`);

                const result = await this.processLinkedDoc(linkedDoc, tmpFolderPath, used);
                if (result.ok) {
                    entries.push(result.value);
                    totalBytes += result.value.sizeBytes;
                } else {
                    warnings.push(`Failed to copy attachment "${linkedDoc.displayName}": ${result.error}`);
                }

                if (processedCount % YIELD_BATCH_SIZE === 0) await sleep(YIELD_DURATION_MS);
            }

            // Build manifest
            const stats: PackStats = {
                noteCount: entries.filter(e => e.type === 'note-text' || e.type === 'note-pdf').length,
                totalBytes,
            };
            const manifest: PackManifest = {
                packId,
                revision: 1,
                generatedAt: new Date().toISOString(),
                stats,
                config: this.config,
                entries,
            };

            // Write manifest + README to temp folder
            onProgress?.(totalItems, totalItems, 'Writing manifest...');
            await this.writerService.writeManifest(tmpFolderPath, manifest);
            await this.writerService.writeReadme(tmpFolderPath, manifest);

            // Atomic rename: temp → final pack folder
            await this.renameTempToFinal(tmpFolderPath, packFolderPath);

            // Update registry (determines actual revision)
            const cfgHash = computeConfigHash(this.config);
            const scopeKey = `tag:${selection.scopeValue}`;
            const registryEntry = await this.registryService.updateEntry(
                scopeKey, manifest, packFolderPath, cfgHash
            );
            manifest.revision = registryEntry.revision;

            // Apply post-export tag action
            onProgress?.(totalItems, totalItems, 'Updating tags...');
            if (this.config.postExportTagAction === 'clear') {
                await this.selectionService.clearSelection(selection.files);
            } else if (this.config.postExportTagAction === 'archive') {
                await this.selectionService.archiveSelection(
                    selection.files, packId, manifest.revision
                );
            }

            return {
                success: true,
                packFolderPath,
                packId,
                revision: manifest.revision,
                stats,
                warnings: warnings.length > 0 ? warnings : undefined,
            };
        } catch (error) {
            await this.cleanupTemp(tmpFolderPath);
            return {
                success: false,
                errorMessage: error instanceof Error ? error.message : String(error),
                warnings: warnings.length > 0 ? warnings : undefined,
            };
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Incremental export ("Update Pack")
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Execute an incremental export, re-generating only changed notes and sidecars.
     * Falls back to a full export if no previous manifest exists or config changed.
     */
    async executeIncrementalExport(
        selection: SelectionResult,
        onProgress?: (current: number, total: number, message: string) => void,
        folderName?: string,
        linkedDocs?: LinkedDocument[],
        signal?: AbortSignal
    ): Promise<ExportResult> {
        const scopeKey = `tag:${selection.scopeValue}`;
        const previous = await this.registryService.getPreviousManifest(scopeKey);
        const currentConfigHash = computeConfigHash(this.config);
        const registryEntry = this.registryService.getEntry(scopeKey);

        // Config changed or no previous manifest → fall back to full export
        if (!previous || registryEntry?.configHash !== currentConfigHash) {
            logger.debug('Export', 'Incremental export falling back to full (config changed or no previous pack)');
            return this.executeExport(selection, onProgress, folderName, linkedDocs, signal);
        }

        const uniqueLinkedDocs = linkedDocs ?? await this.collectLinkedDocuments(selection.files);
        const previousByPath = new Map(previous.entries.map(e => [e.filePath, e]));
        const currentPaths = new Set(selection.files.map(f => f.path));

        // Categorise notes
        const toRegenerate: TFile[] = [];
        const toCopy: TFile[] = [];

        for (const file of selection.files) {
            try {
                const content = await this.app.vault.read(file);
                const hash = await computeSHA256(content);
                const prev = previousByPath.get(file.path);
                (prev && prev.sha256 === hash ? toCopy : toRegenerate).push(file);
            } catch {
                toRegenerate.push(file); // safe: re-generate on read error
            }
            if (signal?.aborted) return { success: false, errorMessage: 'Export cancelled' };
        }

        // Deleted notes: in previous manifest but not in current scope
        const toDelete = previous.entries.filter(e => !currentPaths.has(e.filePath));

        const totalItems = toRegenerate.length + toCopy.length + uniqueLinkedDocs.length;
        const tmpFolderPath = `${this.config.exportFolder}/__tmp-${Date.now()}`;

        try {
            const packId = this.generatePackId();
            const name = folderName
                ?? new Date().toISOString().replaceAll(/[:.]/g, '-').slice(0, 19);

            let packFolderPath = `${this.config.exportFolder}/${name}`;
            let counter = 2;
            while (this.app.vault.getAbstractFileByPath(packFolderPath) && counter <= 999) {
                packFolderPath = `${this.config.exportFolder}/${name}-${counter}`;
                counter++;
            }

            await this.writerService.ensureFolder(this.config.exportFolder);
            await this.writerService.ensureFolder(tmpFolderPath);

            const entries: PackEntry[] = [];
            let totalBytes = 0;
            const warnings: string[] = [];
            const used = new Set<string>();
            let processedCount = 0;

            // Re-generate changed notes
            for (const file of toRegenerate) {
                if (signal?.aborted) {
                    await this.cleanupTemp(tmpFolderPath);
                    return { success: false, errorMessage: 'Export cancelled' };
                }
                processedCount++;
                onProgress?.(processedCount, totalItems, `Processing: ${file.basename}`);

                const result = await this.processNote(file, tmpFolderPath, used);
                if (result.ok) {
                    entries.push(result.value);
                    totalBytes += result.value.sizeBytes;
                } else {
                    warnings.push(`Failed to process "${file.basename}": ${result.error}`);
                }
                if (processedCount % YIELD_BATCH_SIZE === 0) await sleep(YIELD_DURATION_MS);
            }

            // Copy unchanged notes from previous pack folder
            for (const file of toCopy) {
                if (signal?.aborted) {
                    await this.cleanupTemp(tmpFolderPath);
                    return { success: false, errorMessage: 'Export cancelled' };
                }
                processedCount++;
                onProgress?.(processedCount, totalItems, `Copying unchanged: ${file.basename}`);

                const prevEntry = previousByPath.get(file.path);
                if (prevEntry) {
                    try {
                        const srcPath = `${registryEntry.packFolderPath}/${prevEntry.outputName}`;
                        const srcFile = this.app.vault.getAbstractFileByPath(srcPath);
                        if (srcFile instanceof TFile) {
                            const data = await this.app.vault.readBinary(srcFile);
                            const outName = resolveOutputName(
                                prevEntry.outputName.replace(/\.[^.]+$/, ''), // strip ext
                                prevEntry.outputName.split('.').pop() ?? 'txt',
                                used
                            );
                            await this.app.vault.createBinary(`${tmpFolderPath}/${outName}`, data);
                            entries.push({ ...prevEntry, outputName: outName });
                            totalBytes += prevEntry.sizeBytes;
                        } else {
                            // Source file gone — re-generate
                            const result = await this.processNote(file, tmpFolderPath, used);
                            if (result.ok) { entries.push(result.value); totalBytes += result.value.sizeBytes; }
                        }
                    } catch {
                        const result = await this.processNote(file, tmpFolderPath, used);
                        if (result.ok) { entries.push(result.value); totalBytes += result.value.sizeBytes; }
                    }
                }
                if (processedCount % YIELD_BATCH_SIZE === 0) await sleep(YIELD_DURATION_MS);
            }

            // Process sidecars (always re-detect; sidecars don't benefit from copy-if-unchanged
            // because their vault files may have changed independently)
            for (const linkedDoc of uniqueLinkedDocs) {
                if (signal?.aborted) {
                    await this.cleanupTemp(tmpFolderPath);
                    return { success: false, errorMessage: 'Export cancelled' };
                }
                processedCount++;
                onProgress?.(processedCount, totalItems, `Copying attachment: ${linkedDoc.displayName}`);

                const result = await this.processLinkedDoc(linkedDoc, tmpFolderPath, used);
                if (result.ok) { entries.push(result.value); totalBytes += result.value.sizeBytes; }
                else warnings.push(`Failed to copy attachment "${linkedDoc.displayName}": ${result.error}`);

                if (processedCount % YIELD_BATCH_SIZE === 0) await sleep(YIELD_DURATION_MS);
            }

            if (toDelete.length > 0) {
                logger.debug('Export', `Incremental: ${toDelete.length} entries removed from scope (not copied)`);
            }

            const stats: PackStats = {
                noteCount: entries.filter(e => e.type === 'note-text' || e.type === 'note-pdf').length,
                totalBytes,
            };
            const manifest: PackManifest = {
                packId,
                revision: previous.revision + 1,
                generatedAt: new Date().toISOString(),
                stats,
                config: this.config,
                entries,
            };

            onProgress?.(totalItems, totalItems, 'Writing manifest...');
            await this.writerService.writeManifest(tmpFolderPath, manifest);
            await this.writerService.writeReadme(tmpFolderPath, manifest);

            // Atomic rename
            await this.renameTempToFinal(tmpFolderPath, packFolderPath);

            await this.registryService.updateEntry(scopeKey, manifest, packFolderPath, currentConfigHash);

            onProgress?.(totalItems, totalItems, 'Updating tags...');
            if (this.config.postExportTagAction === 'clear') {
                await this.selectionService.clearSelection(selection.files);
            } else if (this.config.postExportTagAction === 'archive') {
                await this.selectionService.archiveSelection(
                    selection.files, packId, manifest.revision
                );
            }

            return {
                success: true,
                packFolderPath,
                packId,
                revision: manifest.revision,
                stats,
                warnings: warnings.length > 0 ? warnings : undefined,
            };
        } catch (error) {
            await this.cleanupTemp(tmpFolderPath);
            return {
                success: false,
                errorMessage: error instanceof Error ? error.message : String(error),
            };
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Private helpers
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Process a single note — generate text (.txt) or PDF (.pdf) and write to the pack folder.
     * Returns a Result<PackEntry> so callers can accumulate warnings without throwing.
     */
    private async processNote(
        file: TFile,
        packFolderPath: string,
        used: Set<string>
    ): Promise<Result<PackEntry>> {
        try {
            const content = await this.app.vault.read(file);
            const contentHash = await computeSHA256(content);
            const cache = this.app.metadataCache.getFileCache(file);
            const tags = extractTagsFromCache(cache).map((t: string) => t.replace(/^#/, ''));

            if (this.config.exportFormat === 'text') {
                // Text export via preprocessor
                const textResult = this.generateTextFile(file.basename, content);
                if (!textResult.ok) return err(textResult.error);

                const outputName = resolveOutputName(file.basename, 'txt', used);
                await this.app.vault.createBinary(`${packFolderPath}/${outputName}`, textResult.value);

                return ok({
                    type: 'note-text',
                    filePath: file.path,
                    outputName,
                    title: file.basename,
                    mtime: new Date(file.stat.mtime).toISOString(),
                    tags,
                    sizeBytes: textResult.value.byteLength,
                    sha256: contentHash,
                });
            } else {
                // PDF export (legacy path)
                const pdfBuffer = await this.pdfGenerator.generate(
                    file.basename, content, this.config.pdf
                );
                const outputName = resolveOutputName(file.basename, 'pdf', used);
                await this.app.vault.createBinary(`${packFolderPath}/${outputName}`, pdfBuffer);

                return ok({
                    type: 'note-pdf',
                    filePath: file.path,
                    outputName,
                    title: file.basename,
                    mtime: new Date(file.stat.mtime).toISOString(),
                    tags,
                    sizeBytes: pdfBuffer.byteLength,
                    sha256: contentHash,
                });
            }
        } catch (error) {
            return err(error instanceof Error ? error.message : String(error));
        }
    }

    /**
     * Copy a linked document to the pack folder as a sidecar file.
     * Returns a Result<PackEntry>.
     */
    private async processLinkedDoc(
        linkedDoc: LinkedDocument,
        packFolderPath: string,
        used: Set<string>
    ): Promise<Result<PackEntry>> {
        try {
            // Try direct path first, then link resolution
            let file: TFile | null = null;
            const direct = this.app.vault.getAbstractFileByPath(linkedDoc.path);
            if (direct instanceof TFile) {
                file = direct;
            } else {
                const resolved = this.app.metadataCache.getFirstLinkpathDest(linkedDoc.path, '');
                if (resolved instanceof TFile) file = resolved;
            }

            if (!file) return err(`File not found in vault: ${linkedDoc.path}`);

            const data = await this.app.vault.readBinary(file);
            const contentHash = await computeBinarySHA256(data);
            const outputName = resolveOutputName(file.basename, file.extension, used);
            await this.app.vault.createBinary(`${packFolderPath}/${outputName}`, data);

            return ok({
                type: 'attachment',
                filePath: file.path,
                outputName,
                title: file.basename,
                mtime: new Date(file.stat.mtime).toISOString(),
                tags: [],
                sizeBytes: data.byteLength,
                sha256: contentHash,
            });
        } catch (error) {
            return err(error instanceof Error ? error.message : String(error));
        }
    }

    /**
     * Generate a UTF-8 encoded text file from note content.
     * Applies the line-state preprocessor to strip/preserve content per rules.
     */
    private generateTextFile(
        title: string,
        content: string
    ): Result<ArrayBuffer> {
        try {
            const processed = preprocessNoteForNotebookLM(content, {
                includeFrontmatter: this.config.pdf.includeFrontmatter,
                includeTitle: this.config.pdf.includeTitle,
                title,
            });
            const encoded = new TextEncoder().encode(processed);
            return ok(encoded.buffer);
        } catch (error) {
            return err(error instanceof Error ? error.message : String(error));
        }
    }

    /**
     * Collect and deduplicate linked documents from all selected notes.
     * Also resolves file sizes for display in the modal.
     */
    private async collectLinkedDocuments(files: TFile[]): Promise<LinkedDocument[]> {
        const all: LinkedDocument[] = [];
        for (const file of files) {
            try {
                const content = await this.app.vault.read(file);
                const detected = detectEmbeddedContent(this.app, content, file);
                for (const item of detected.items) {
                    if (item.type === 'document' || item.type === 'pdf') {
                        all.push({
                            sourceFile: file.path,
                            path: item.url,
                            displayName: item.displayName,
                            type: item.type,
                        });
                    }
                }
            } catch {
                // Ignore read/detection errors
            }
        }
        return this.deduplicateLinkedDocuments(all);
    }

    private deduplicateLinkedDocuments(docs: LinkedDocument[]): LinkedDocument[] {
        const seen = new Set<string>();
        return docs.filter(doc => {
            const key = doc.path.toLowerCase();
            if (seen.has(key)) return false;
            seen.add(key);
            // Resolve file size
            try {
                const file = this.app.vault.getAbstractFileByPath(doc.path)
                    ?? this.app.metadataCache.getFirstLinkpathDest(doc.path, '');
                if (file instanceof TFile) doc.sizeBytes = file.stat.size;
            } catch { /* ignore */ }
            return true;
        });
    }

    private estimateAttachmentsSize(linkedDocs: LinkedDocument[]): number {
        let total = 0;
        for (const doc of linkedDocs) {
            if (doc.sizeBytes != null) {
                total += doc.sizeBytes;
                continue;
            }
            try {
                const file = this.app.vault.getAbstractFileByPath(doc.path)
                    ?? this.app.metadataCache.getFirstLinkpathDest(doc.path, '');
                if (file instanceof TFile) total += file.stat.size;
            } catch { /* ignore */ }
        }
        return total;
    }

    /**
     * Rename temp folder to its final path via vault adapter.
     * Falls back to file-by-file copy+delete if adapter rename is unavailable.
     */
    private async renameTempToFinal(tmpPath: string, finalPath: string): Promise<void> {
        const adapter = this.app.vault.adapter as {
            rename?: (from: string, to: string) => Promise<void>;
        };
        if (typeof adapter.rename === 'function') {
            await adapter.rename(tmpPath, finalPath);
        } else {
            // Fallback: create final folder, move files one-by-one, delete temp
            await this.writerService.ensureFolder(finalPath);
            const tmpFolder = this.app.vault.getAbstractFileByPath(tmpPath);
            if (tmpFolder && 'children' in tmpFolder) {
                for (const child of (tmpFolder as import('obsidian').TFolder).children) {
                    if (child instanceof TFile) {
                        const data = await this.app.vault.readBinary(child);
                        await this.app.vault.createBinary(`${finalPath}/${child.name}`, data);
                        await this.app.fileManager.trashFile(child);
                    }
                }
            }
            await this.cleanupTemp(tmpPath);
        }
    }

    /** Delete the temp folder, swallowing errors */
    private async cleanupTemp(tmpPath: string): Promise<void> {
        try {
            const adapter = this.app.vault.adapter as {
                rmdir?: (path: string, recursive: boolean) => Promise<void>;
            };
            if (typeof adapter.rmdir === 'function') {
                await adapter.rmdir(tmpPath, true);
                return;
            }
            // Fallback: delete each file individually
            const folder = this.app.vault.getAbstractFileByPath(tmpPath);
            if (folder && 'children' in folder) {
                for (const child of (folder as import('obsidian').TFolder).children) {
                    if (child instanceof TFile) {
                        await this.app.fileManager.trashFile(child);
                    }
                }
            }
        } catch (error) {
            logger.warn('Export', 'Failed to clean up temp folder:', error);
        }
    }

    private generatePackId(): string {
        return 'pack-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Config hash (module-level, pure)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute a deterministic hash of the config fields that affect export rendering.
 * If this hash differs from the stored registry entry, a full re-export is required.
 *
 * Synchronous — uses a simple but stable string fingerprint (not cryptographic).
 */
export function computeConfigHash(config: SourcePackConfig): string {
    const relevant = {
        format: config.exportFormat,
        frontmatter: config.pdf.includeFrontmatter,
        title: config.pdf.includeTitle,
        preprocessorVersion: PREPROCESSOR_VERSION,
    };
    // Simple deterministic fingerprint — no Web Crypto needed for this non-security use
    return JSON.stringify(relevant);
}
