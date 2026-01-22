/**
 * Source Pack Service - Main Orchestrator
 * 
 * Coordinates the entire export workflow:
 * 1. Selection
 * 2. Sanitisation
 * 3. Chunking
 * 4. Writing
 * 5. Registry management
 */

import { App, TFile } from 'obsidian';
import { v4 as uuidv4 } from 'uuid';
import {
    SourcePackConfig,
    ExportResult,
    PackManifest,
    SelectionResult,
    ExportPreview,
    ValidationWarnings,
    PackStats
} from './types';
import { SelectionService } from './selectionService';
import { sanitiseNotes } from './sanitiser';
import { 
    chunkNotesIntoModules, 
    estimateModuleCount,
    autoSelectExportMode,
    validateExportParameters 
} from './chunking';
import { WriterService } from './writer';
import { RegistryService } from './registry';
import { computePackHash } from './hashing';

/**
 * Main service for NotebookLM source pack operations
 */
export class SourcePackService {
    private selectionService: SelectionService;
    private writerService: WriterService;
    private registryService: RegistryService;

    constructor(private app: App, private config: SourcePackConfig) {
        this.selectionService = new SelectionService(app);
        this.writerService = new WriterService(app);
        this.registryService = new RegistryService(app);
    }

    /**
     * Initialize service (load registry)
     */
    async initialize(): Promise<void> {
        await this.registryService.loadRegistry();
    }

    /**
     * Generate preview for export modal
     * @param selection Selection result
     * @returns Export preview with warnings
     */
    async generatePreview(selection: SelectionResult): Promise<ExportPreview> {
        const totalWords = selection.estimatedWords;
        const noteCount = selection.files.length;

        // Determine export mode
        let exportMode = this.config.exportMode;
        if (exportMode === 'auto') {
            exportMode = autoSelectExportMode(
                noteCount,
                totalWords,
                this.config.maxWordsPerModule
            );
        }

        // Estimate module count
        const estimatedModuleCount = exportMode === 'single' 
            ? 1 
            : estimateModuleCount(
                selection.files.map(() => ({ wordCount: totalWords / noteCount })),
                this.config.maxWordsPerModule
            );

        // Validate parameters
        const warningMessages = validateExportParameters(
            noteCount,
            totalWords,
            this.config.maxWordsPerModule
        );

        const warnings: ValidationWarnings = {};
        for (const warning of warningMessages) {
            if (warning.includes('Module count')) {
                warnings.moduleCountWarning = warning;
            } else if (warning.includes('Word budget')) {
                warnings.moduleWordLimitWarning = warning;
            } else if (warning.includes('size')) {
                warnings.moduleSizeLimitWarning = warning;
            }
        }

        return {
            selection,
            estimatedModuleCount,
            warnings,
            config: { ...this.config, exportMode }
        };
    }

    /**
     * Export source pack
     * @param selection Selection result
     * @param progressCallback Optional progress callback
     * @returns Export result
     */
    async exportSourcePack(
        selection: SelectionResult,
        progressCallback?: (stage: string, progress: number) => void
    ): Promise<ExportResult> {
        try {
            progressCallback?.('Sanitising notes', 0.1);

            // Step 1: Sanitise all notes
            const sanitisedNotes = await sanitiseNotes(
                selection.files,
                this.app,
                this.config,
                (current, total) => {
                    const progress = 0.1 + (current / total) * 0.4;
                    progressCallback?.('Sanitising notes', progress);
                }
            );

            progressCallback?.('Chunking into modules', 0.5);

            // Step 2: Determine export mode
            let exportMode = this.config.exportMode;
            if (exportMode === 'auto') {
                const totalWords = sanitisedNotes.reduce((sum, n) => sum + n.wordCount, 0);
                exportMode = autoSelectExportMode(
                    sanitisedNotes.length,
                    totalWords,
                    this.config.maxWordsPerModule
                );
            }

            // Step 3: Chunk into modules
            const modules = exportMode === 'single'
                ? chunkNotesIntoModules(sanitisedNotes, Number.MAX_SAFE_INTEGER) // Single module
                : chunkNotesIntoModules(sanitisedNotes, this.config.maxWordsPerModule);

            progressCallback?.('Preparing manifest', 0.6);

            // Step 4: Build manifest
            const scopeKey = this.buildScopeKey(selection);
            const packId = uuidv4();
            
            const stats: PackStats = {
                noteCount: sanitisedNotes.length,
                moduleCount: modules.length,
                totalWords: sanitisedNotes.reduce((sum, n) => sum + n.wordCount, 0),
                totalBytes: sanitisedNotes.reduce((sum, n) => sum + n.byteCount, 0)
            };

            const allEntries = modules.flatMap(m => m.entries);
            const packHash = computePackHash(allEntries.map(e => e.sha256));
            const revision = this.registryService.getNextRevision(scopeKey, packHash);

            // Map selection method to scope type (manual maps to mixed)
            const scopeType = selection.selectionMethod === 'manual'
                ? 'mixed' as const
                : selection.selectionMethod;

            const manifest: PackManifest = {
                packId,
                revision,
                generatedAt: new Date().toISOString(),
                scope: {
                    type: scopeType,
                    value: selection.scopeValue
                },
                stats,
                config: this.config,
                entries: allEntries
            };

            progressCallback?.('Writing files', 0.7);

            // Step 5: Determine pack folder path
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T')[0];
            const packFolderName = `Pack_${scopeKey.replace(/[^a-zA-Z0-9-]/g, '_')}_v${String(revision).padStart(3, '0')}_${timestamp}`;
            const packFolderPath = `${this.getExportRootFolder()}/${packFolderName}`;

            // Step 6: Generate changelog (if not first export)
            const previousManifest = await this.registryService.getPreviousManifest(scopeKey);
            const changelog = this.writerService.generateChangelog(previousManifest, manifest);

            // Step 7: Write pack files
            await this.writerService.writeSourcePack(
                packFolderPath,
                modules,
                manifest,
                changelog
            );

            progressCallback?.('Updating registry', 0.9);

            // Step 8: Update registry
            await this.registryService.updateEntry(scopeKey, manifest, packFolderPath);

            progressCallback?.('Complete', 1.0);

            // Step 9: Handle post-export tag action
            if (this.config.postExportTagAction === 'clear') {
                await this.selectionService.clearSelection(selection.files);
            } else if (this.config.postExportTagAction === 'archive') {
                await this.selectionService.archiveSelection(
                    selection.files,
                    packId,
                    revision
                );
            }

            return {
                success: true,
                packFolderPath,
                packId,
                revision,
                stats,
                warnings: sanitisedNotes.flatMap(n => n.warnings)
            };

        } catch (error) {
            console.error('NotebookLM export failed:', error);
            return {
                success: false,
                errorMessage: (error as Error).message || 'Unknown error during export'
            };
        }
    }

    /**
     * Get selection by tag
     */
    async getSelectionByTag(tag?: string): Promise<SelectionResult> {
        return await this.selectionService.selectByTag(tag);
    }

    /**
     * Get selection by folder
     */
    async getSelectionByFolder(folderPath: string, recursive: boolean = true): Promise<SelectionResult> {
        return await this.selectionService.selectByFolder(folderPath, recursive);
    }

    /**
     * Toggle selection on current note
     */
    async toggleSelection(file: TFile): Promise<boolean> {
        return await this.selectionService.toggleSelection(file);
    }

    /**
     * Clear selection tags
     */
    async clearSelectionTags(files: TFile[]): Promise<void> {
        await this.selectionService.clearSelection(files);
    }

    /**
     * Build scope key for registry
     */
    private buildScopeKey(selection: SelectionResult): string {
        const type = selection.selectionMethod;
        const value = selection.scopeValue.replace(/[^a-zA-Z0-9-]/g, '_');
        return `${type}:${value}`;
    }

    /**
     * Get export root folder path
     */
    private getExportRootFolder(): string {
        // This will be injected from plugin settings
        // For now, return a default
        return 'AI-Organiser/NotebookLM';
    }

    /**
     * Update configuration
     */
    updateConfig(config: Partial<SourcePackConfig>): void {
        this.config = { ...this.config, ...config };
    }
}
