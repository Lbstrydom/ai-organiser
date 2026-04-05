/**
 * Migration Service
 * Migrates existing notes to Obsidian Bases-compatible metadata format
 */

import { App, TFile, TFolder } from 'obsidian';
import { AIO_META, ContentType } from '../core/constants';
import { 
    updateAIOMetadata, 
    createSummaryHook, 
    getAIOMetadata,
    countWords,
    detectLanguage 
} from '../utils/frontmatterUtils';
import type AIOrganiserPlugin from '../main';
import { logger } from '../utils/logger';

export interface MigrationOptions {
    /** Whether to overwrite existing AI Organiser metadata properties */
    overwriteExisting: boolean;
    
    /** Whether to extract summaries from note body */
    extractSummary: boolean;
    
    /** Folders to exclude from migration */
    excludedFolders: string[];
}

export interface MigrationResult {
    success: boolean;
    processed: number;
    updated: number;
    skipped: number;
    errors: number;
    errorMessages: string[];
}

export interface MigrationScope {
    total: number;
    needsMigration: number;
    alreadyMigrated: number;
    files: TFile[];
}

/**
 * Migration Service for upgrading notes to Bases format
 */
export class MigrationService {
    private app: App;
    private plugin: AIOrganiserPlugin;
    
    constructor(app: App, plugin: AIOrganiserPlugin) {
        this.app = app;
        this.plugin = plugin;
    }
    
    /**
     * Analyze migration scope - count notes needing migration
     */
    public analyzeMigrationScope(folder?: TFolder): MigrationScope {
        const files = folder 
            ? this.getMarkdownFilesInFolder(folder)
            : this.app.vault.getMarkdownFiles();
        
        let needsMigration = 0;
        let alreadyMigrated = 0;
        
        for (const file of files) {
            const metadata = getAIOMetadata(this.app, file);
            if (metadata && metadata[AIO_META.STATUS]) {
                alreadyMigrated++;
            } else {
                needsMigration++;
            }
        }
        
        return {
            total: files.length,
            needsMigration,
            alreadyMigrated,
            files
        };
    }
    
    /**
     * Migrate a single note to Bases format
     */
    public async migrateNote(
        file: TFile,
        options: MigrationOptions
    ): Promise<boolean> {
        try {
            // Check if already migrated and should skip
            const existingMetadata = getAIOMetadata(this.app, file);
            if (existingMetadata && existingMetadata[AIO_META.STATUS] && !options.overwriteExisting) {
                return false; // Skip - already migrated
            }
            
            // Read note content
            const content = await this.app.vault.read(file);
            const cache = this.app.metadataCache.getFileCache(file);
            const frontmatter = cache?.frontmatter;
            
            // Extract or determine metadata
            const metadata: Record<string, unknown> = {};
            
            // Extract summary from note body if requested
            if (options.extractSummary) {
                const summary = this.extractSummaryFromContent(content);
                if (summary) {
                    metadata[AIO_META.SUMMARY] = createSummaryHook(summary);
                }
            }
            
            // Set status based on existing tags or processing
            metadata[AIO_META.STATUS] = this.determineStatus(file, frontmatter);
            
            // Auto-detect content type if enabled
            if (this.plugin.settings.autoDetectContentType) {
                metadata[AIO_META.TYPE] = this.detectContentType(content, frontmatter);
            }
            
            // Set processed timestamp for already-processed notes
            if (metadata[AIO_META.STATUS] === 'processed') {
                metadata[AIO_META.PROCESSED] = file.stat.mtime 
                    ? new Date(file.stat.mtime).toISOString()
                    : new Date().toISOString();
            }
            
            // Add word count
            metadata[AIO_META.WORD_COUNT] = countWords(content);
            
            // Detect language
            const detectedLang = detectLanguage(content);
            if (detectedLang !== 'unknown') {
                metadata[AIO_META.LANGUAGE] = detectedLang;
            }
            
            // Update frontmatter
            const success = await updateAIOMetadata(this.app, file, metadata);
            return success;
            
        } catch (error) {
            logger.error('Migration', `Error migrating ${file.path}:`, error);
            return false;
        }
    }
    
    /**
     * Migrate all notes in a folder
     */
    public async migrateFolder(
        folder: TFolder,
        options: MigrationOptions,
        progressCallback?: (current: number, total: number, fileName: string) => void
    ): Promise<MigrationResult> {
        const files = this.getMarkdownFilesInFolder(folder);
        return this.migrateFiles(files, options, progressCallback);
    }
    
    /**
     * Migrate entire vault
     */
    public async migrateVault(
        options: MigrationOptions,
        progressCallback?: (current: number, total: number, fileName: string) => void
    ): Promise<MigrationResult> {
        const files = this.app.vault.getMarkdownFiles();
        
        // Filter out excluded folders
        const filteredFiles = files.filter(file => {
            return !options.excludedFolders.some(excluded => 
                file.path.startsWith(excluded)
            );
        });
        
        return this.migrateFiles(filteredFiles, options, progressCallback);
    }
    
    /**
     * Migrate a list of files
     */
    private async migrateFiles(
        files: TFile[],
        options: MigrationOptions,
        progressCallback?: (current: number, total: number, fileName: string) => void
    ): Promise<MigrationResult> {
        const result: MigrationResult = {
            success: true,
            processed: 0,
            updated: 0,
            skipped: 0,
            errors: 0,
            errorMessages: []
        };
        
        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            
            if (progressCallback) {
                progressCallback(i + 1, files.length, file.basename);
            }
            
            try {
                const migrated = await this.migrateNote(file, options);
                
                result.processed++;
                if (migrated) {
                    result.updated++;
                } else {
                    result.skipped++;
                }
                
            } catch (error) {
                result.errors++;
                const errorMsg = `${file.basename}: ${error instanceof Error ? error.message : 'Unknown error'}`;
                result.errorMessages.push(errorMsg);
            }
        }
        
        result.success = result.errors === 0;
        return result;
    }
    
    /**
     * Extract summary from note content
     * Looks for common summary patterns in the note body
     */
    private extractSummaryFromContent(content: string): string | null {
        // Remove frontmatter
        const withoutFrontmatter = content.replace(/^---[\s\S]*?---\n?/, '');
        
        // Look for summary section
        const summaryMatch = withoutFrontmatter.match(/##\s*Summary[\s\S]*?\n\n([\s\S]*?)(?=\n##|$)/i);
        if (summaryMatch && summaryMatch[1]) {
            return summaryMatch[1].trim();
        }
        
        // Look for TL;DR section
        const tldrMatch = withoutFrontmatter.match(/##\s*TL;?DR[\s\S]*?\n\n([\s\S]*?)(?=\n##|$)/i);
        if (tldrMatch && tldrMatch[1]) {
            return tldrMatch[1].trim();
        }
        
        // Use first paragraph if no summary found
        const firstParagraph = withoutFrontmatter.trim().split('\n\n')[0];
        if (firstParagraph && firstParagraph.length > 50 && firstParagraph.length < 1000) {
            return firstParagraph;
        }
        
        return null;
    }
    
    /**
     * Determine status based on existing tags or note state
     */
    private determineStatus(file: TFile, frontmatter: Record<string, unknown> | undefined): 'processed' | 'pending' | 'error' {
        // If note has tags, consider it processed
        if (frontmatter?.tags && Array.isArray(frontmatter.tags) && frontmatter.tags.length > 0) {
            return 'processed';
        }
        
        // Otherwise, pending
        return 'pending';
    }
    
    /**
     * Detect content type from note content and metadata
     */
    private detectContentType(content: string, frontmatter: Record<string, unknown> | undefined): ContentType {
        const lowerContent = content.toLowerCase();

        // Check frontmatter type if exists
        if (frontmatter?.type && typeof frontmatter.type === 'string') {
            const type = frontmatter.type.toLowerCase();
            if (type === 'research' || type === 'meeting' || type === 'project' || type === 'reference') {
                return type as ContentType;
            }
        }
        
        // Detect from content patterns
        if (lowerContent.includes('research') || lowerContent.includes('study') || lowerContent.includes('paper')) {
            return 'research';
        }
        
        if (lowerContent.includes('meeting') || lowerContent.includes('agenda') || lowerContent.includes('attendees')) {
            return 'meeting';
        }
        
        if (lowerContent.includes('project') || lowerContent.includes('roadmap') || lowerContent.includes('milestone')) {
            return 'project';
        }
        
        if (lowerContent.includes('reference') || lowerContent.includes('documentation') || lowerContent.includes('api')) {
            return 'reference';
        }
        
        // Default to note
        return 'note';
    }
    
    /**
     * Get all markdown files in a folder (recursive)
     */
    private getMarkdownFilesInFolder(folder: TFolder): TFile[] {
        const files: TFile[] = [];
        
        for (const child of folder.children) {
            if (child instanceof TFile && child.extension === 'md') {
                files.push(child);
            } else if (child instanceof TFolder) {
                files.push(...this.getMarkdownFilesInFolder(child));
            }
        }
        
        return files;
    }
}
