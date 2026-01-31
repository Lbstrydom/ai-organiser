/**
 * Source Pack Service - Main Orchestrator
 *
 * Coordinates the PDF-based export workflow for NotebookLM.
 * Generates PDFs from markdown notes and copies linked documents as sidecar files.
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
    PackStats
} from './types';
import { SelectionService } from './selectionService';
import { WriterService } from './writer';
import { RegistryService } from './registry';
import { computeSHA256, computeBinarySHA256 } from './hashing';
import { MarkdownPdfGenerator } from './pdf/MarkdownPdfGenerator';
import { detectEmbeddedContent } from '../../utils/embeddedContentDetector';
import { extractTagsFromCache } from '../../utils/tagUtils';

/** Sleep utility for async yielding to keep UI responsive */
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** Number of items to process before yielding to UI */
const YIELD_BATCH_SIZE = 5;

/** Yield duration in milliseconds */
const YIELD_DURATION_MS = 20;

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

    /**
     * Initialize service (load registry)
     */
    async initialize(): Promise<void> {
        await this.registryService.loadRegistry();
    }

    /**
     * Update configuration
     */
    updateConfig(config: SourcePackConfig): void {
        this.config = config;
    }

    /**
     * Get preview data for export modal
     */
    async getExportPreview(selectionTag?: string): Promise<ExportPreview> {
        const tag = selectionTag || this.config.selectionTag;
        const selection = await this.selectionService.getSelectedNotes(tag);

        const linkedDocuments: LinkedDocument[] = [];
        for (const file of selection.files) {
            try {
                const content = await this.app.vault.read(file);
                const detected = detectEmbeddedContent(this.app, content, file);
                for (const item of detected.items) {
                    if (item.type === 'document' || item.type === 'pdf') {
                        linkedDocuments.push({
                            sourceFile: file.path,
                            path: item.url,
                            displayName: item.displayName,
                            type: item.type
                        });
                    }
                }
            } catch {
                // Ignore read/detection errors for preview
            }
        }

        // Deduplicate linked documents by path
        const uniqueLinkedDocs = this.deduplicateLinkedDocuments(linkedDocuments);

        // Total source count = notes + unique linked documents
        const totalSourceCount = selection.files.length + uniqueLinkedDocs.length;

        // Estimate size (rough: 50KB per note as PDF, actual size for linked docs)
        const estimatedNotesSize = selection.files.length * 50 * 1024;
        const estimatedAttachmentsSize = await this.estimateAttachmentsSize(uniqueLinkedDocs);
        const estimatedSizeBytes = estimatedNotesSize + estimatedAttachmentsSize;

        // Check NotebookLM limits (notes + attachments count toward 50-source limit)
        const warnings: ValidationWarnings = {};

        if (totalSourceCount > 50) {
            warnings.sourceCountWarning = `${totalSourceCount} sources selected (${selection.files.length} notes + ${uniqueLinkedDocs.length} linked documents). NotebookLM limit is 50 sources per notebook.`;
        } else if (totalSourceCount > 45) {
            warnings.sourceCountWarning = `${totalSourceCount} sources selected (${selection.files.length} notes + ${uniqueLinkedDocs.length} linked documents). Approaching NotebookLM limit of 50 sources.`;
        }

        if (estimatedSizeBytes > 200 * 1024 * 1024) {
            warnings.totalSizeWarning = `Estimated size (${this.formatBytes(estimatedSizeBytes)}) exceeds NotebookLM limit of 200MB.`;
        } else if (estimatedSizeBytes > 180 * 1024 * 1024) {
            warnings.totalSizeWarning = `Estimated size (${this.formatBytes(estimatedSizeBytes)}) approaching NotebookLM limit of 200MB.`;
        }

        return {
            selection,
            estimatedSizeBytes,
            linkedDocuments: uniqueLinkedDocs,
            warnings,
            config: this.config
        };
    }

    /**
     * Execute export operation
     * Generates PDFs from notes and copies linked documents as sidecar files
     */
    async executeExport(
        selection: SelectionResult,
        onProgress?: (current: number, total: number, message: string) => void
    ): Promise<ExportResult> {
        const warnings: string[] = [];
        const entries: PackEntry[] = [];
        let totalBytes = 0;
        let processedCount = 0;

        try {
            // Generate pack ID and determine folder path
            const packId = this.generatePackId();
            const timestamp = new Date().toISOString().replaceAll(/[:.]/g, '-').slice(0, 19);
            const packFolderPath = `${this.config.exportFolder}/${timestamp}`;

            // Ensure pack folder exists
            await this.writerService.ensureFolder(this.config.exportFolder);
            await this.writerService.ensureFolder(packFolderPath);

            // Collect linked documents from all notes
            const allLinkedDocs: LinkedDocument[] = [];
            for (const file of selection.files) {
                try {
                    const content = await this.app.vault.read(file);
                    const detected = detectEmbeddedContent(this.app, content, file);
                    for (const item of detected.items) {
                        if (item.type === 'document' || item.type === 'pdf') {
                            allLinkedDocs.push({
                                sourceFile: file.path,
                                path: item.url,
                                displayName: item.displayName,
                                type: item.type
                            });
                        }
                    }
                } catch {
                    // Continue on detection errors
                }
            }
            const uniqueLinkedDocs = this.deduplicateLinkedDocuments(allLinkedDocs);

            const totalItems = selection.files.length + uniqueLinkedDocs.length;

            // Process notes - generate PDFs
            for (const file of selection.files) {
                processedCount++;

                onProgress?.(processedCount, totalItems, `Generating PDF: ${file.basename}`);

                try {
                    const content = await this.app.vault.read(file);
                    const contentHash = computeSHA256(content);

                    // Generate PDF
                    const pdfBuffer = await this.pdfGenerator.generate(
                        file.basename,
                        content,
                        this.config.pdf
                    );

                    // Generate safe filename
                    const safeName = this.sanitizeFilename(file.basename);
                    const pdfName = `${safeName}.pdf`;
                    const pdfPath = `${packFolderPath}/${pdfName}`;

                    // Write PDF to vault
                    await this.app.vault.createBinary(pdfPath, pdfBuffer);

                    // Get file metadata
                    const cache = this.app.metadataCache.getFileCache(file);
                    const tags = extractTagsFromCache(cache).map((t: string) => t.replace(/^#/, ''));

                    entries.push({
                        type: 'note-pdf',
                        filePath: file.path,
                        pdfName,
                        title: file.basename,
                        mtime: new Date(file.stat.mtime).toISOString(),
                        tags,
                        sizeBytes: pdfBuffer.byteLength,
                        sha256: contentHash
                    });

                    totalBytes += pdfBuffer.byteLength;
                } catch (error) {
                    warnings.push(`Failed to process note "${file.basename}": ${error instanceof Error ? error.message : String(error)}`);
                }

                // Yield to UI every YIELD_BATCH_SIZE items
                if (processedCount % YIELD_BATCH_SIZE === 0) {
                    await sleep(YIELD_DURATION_MS);
                }
            }

            // Process linked documents - copy as sidecar files
            for (const linkedDoc of uniqueLinkedDocs) {
                processedCount++;

                onProgress?.(processedCount, totalItems, `Copying attachment: ${linkedDoc.displayName}`);

                try {
                    const attachmentEntry = await this.copyLinkedDocument(linkedDoc, packFolderPath);
                    if (attachmentEntry) {
                        entries.push(attachmentEntry);
                        totalBytes += attachmentEntry.sizeBytes;
                    }
                } catch (error) {
                    warnings.push(`Failed to copy attachment "${linkedDoc.displayName}": ${error instanceof Error ? error.message : String(error)}`);
                }

                // Yield to UI every YIELD_BATCH_SIZE items
                if (processedCount % YIELD_BATCH_SIZE === 0) {
                    await sleep(YIELD_DURATION_MS);
                }
            }

            // Build manifest
            const stats: PackStats = {
                noteCount: entries.filter(e => e.type === 'note-pdf').length,
                totalBytes
            };

            const manifest: PackManifest = {
                packId,
                revision: 1, // Will be updated by registry
                generatedAt: new Date().toISOString(),
                stats,
                config: this.config,
                entries
            };

            // Update registry (determines actual revision number)
            const scopeKey = `tag:${selection.scopeValue}`;
            const registryEntry = await this.registryService.updateEntry(scopeKey, manifest, packFolderPath);
            manifest.revision = registryEntry.revision;

            // Write manifest and README
            onProgress?.(totalItems, totalItems, 'Writing manifest...');
            await this.writerService.writeManifest(packFolderPath, manifest);
            await this.writerService.writeReadme(packFolderPath, manifest);

            // Apply post-export tag action
            onProgress?.(totalItems, totalItems, 'Updating tags...');
            if (this.config.postExportTagAction === 'clear') {
                await this.selectionService.clearSelection(selection.files as TFile[]);
            } else if (this.config.postExportTagAction === 'archive') {
                await this.selectionService.archiveSelection(
                    selection.files as TFile[],
                    packId,
                    manifest.revision
                );
            }

            return {
                success: true,
                packFolderPath,
                packId,
                revision: manifest.revision,
                stats,
                warnings: warnings.length > 0 ? warnings : undefined
            };
        } catch (error) {
            return {
                success: false,
                errorMessage: error instanceof Error ? error.message : String(error),
                warnings: warnings.length > 0 ? warnings : undefined
            };
        }
    }

    /**
     * Copy a linked document to the pack folder as a sidecar file
     */
    private async copyLinkedDocument(
        linkedDoc: LinkedDocument,
        packFolderPath: string
    ): Promise<PackEntry | null> {
        // Resolve the file in the vault
        const file = this.app.vault.getAbstractFileByPath(linkedDoc.path);
        if (!file || !(file instanceof TFile)) {
            // Try to find by link resolution
            const resolved = this.app.metadataCache.getFirstLinkpathDest(linkedDoc.path, '');
            if (!resolved || !(resolved instanceof TFile)) {
                return null;
            }
            return this.copyVaultFile(resolved, packFolderPath);
        }

        return this.copyVaultFile(file, packFolderPath);
    }

    /**
     * Copy a vault file to the pack folder
     */
    private async copyVaultFile(
        file: TFile,
        packFolderPath: string
    ): Promise<PackEntry> {
        const content = await this.app.vault.readBinary(file);
        const contentHash = computeBinarySHA256(content);

        // Generate safe filename
        const safeName = this.sanitizeFilename(file.basename);
        const extension = file.extension;
        const outputName = `${safeName}.${extension}`;
        const outputPath = `${packFolderPath}/${outputName}`;

        // Write to pack folder
        await this.app.vault.createBinary(outputPath, content);

        return {
            type: 'attachment',
            filePath: file.path,
            pdfName: outputName, // Using pdfName field for attachment filename
            title: file.basename,
            mtime: new Date(file.stat.mtime).toISOString(),
            tags: [],
            sizeBytes: content.byteLength,
            sha256: contentHash
        };
    }

    /**
     * Deduplicate linked documents by path
     */
    private deduplicateLinkedDocuments(docs: LinkedDocument[]): LinkedDocument[] {
        const seen = new Set<string>();
        const unique: LinkedDocument[] = [];

        for (const doc of docs) {
            const normalizedPath = doc.path.toLowerCase();
            if (!seen.has(normalizedPath)) {
                seen.add(normalizedPath);
                unique.push(doc);
            }
        }

        return unique;
    }

    /**
     * Estimate total size of attachments
     */
    private async estimateAttachmentsSize(linkedDocs: LinkedDocument[]): Promise<number> {
        let totalSize = 0;

        for (const doc of linkedDocs) {
            try {
                const file = this.app.vault.getAbstractFileByPath(doc.path);
                if (file && file instanceof TFile) {
                    totalSize += file.stat.size;
                } else {
                    // Try link resolution
                    const resolved = this.app.metadataCache.getFirstLinkpathDest(doc.path, '');
                    if (resolved && resolved instanceof TFile) {
                        totalSize += resolved.stat.size;
                    }
                }
            } catch {
                // Ignore errors, use 0 for unknown files
            }
        }

        return totalSize;
    }

    /**
     * Generate a unique pack ID
     */
    private generatePackId(): string {
        return 'pack-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    }

    /**
     * Sanitize filename for PDF output
     */
    private sanitizeFilename(name: string): string {
        return name
            .replaceAll(/[<>:"/\\|?*]/g, '-') // Replace invalid chars
            .replaceAll(/\s+/g, '_') // Replace spaces with underscores
            .replaceAll(/-+/g, '-') // Collapse multiple dashes
            .replaceAll(/(^-)|(-$)/g, '') // Trim leading/trailing dashes
            .slice(0, 200); // Limit length
    }

    /**
     * Format bytes to human-readable string
     */
    private formatBytes(bytes: number): string {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }
}
