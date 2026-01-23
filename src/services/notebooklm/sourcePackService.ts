/**
 * Source Pack Service - Main Orchestrator
 *
 * Coordinates the PDF-based export workflow for NotebookLM.
 * This is a stub implementation - PDF export not yet implemented.
 */

import { App } from 'obsidian';
import {
    SourcePackConfig,
    ExportResult,
    SelectionResult,
    ExportPreview,
    ValidationWarnings
} from './types';
import { SelectionService } from './selectionService';

/**
 * Main service for NotebookLM source pack operations
 */
export class SourcePackService {
    private selectionService: SelectionService;

    constructor(private app: App, private config: SourcePackConfig) {
        this.selectionService = new SelectionService(app);
    }

    /**
     * Initialize service
     */
    async initialize(): Promise<void> {
        // Nothing to initialize for PDF-based export yet
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

        // Estimate size (rough: 50KB per note as PDF)
        const estimatedSizeBytes = selection.files.length * 50 * 1024;

        // Check NotebookLM limits
        const warnings: ValidationWarnings = {};

        if (selection.files.length > 45) {
            warnings.sourceCountWarning = `${selection.files.length} notes selected. NotebookLM limit is 50 sources per notebook.`;
        }

        if (estimatedSizeBytes > 180 * 1024 * 1024) {
            warnings.totalSizeWarning = `Estimated size exceeds 180MB. NotebookLM limit is 200MB.`;
        }

        return {
            selection,
            estimatedSizeBytes,
            warnings,
            config: this.config
        };
    }

    /**
     * Execute export operation
     * NOTE: PDF export not yet implemented - returns stub result
     */
    async executeExport(selection: SelectionResult): Promise<ExportResult> {
        // PDF export not yet implemented
        return {
            success: false,
            errorMessage: 'PDF export not yet implemented. This feature is coming soon.'
        };
    }
}
