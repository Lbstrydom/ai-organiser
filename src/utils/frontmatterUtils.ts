/**
 * Frontmatter Utilities
 * Handles reading and writing AI Organiser metadata in note frontmatter
 */

import { App, TFile } from 'obsidian';
import * as yaml from 'js-yaml';
import { AIO_META, SUMMARY_HOOK_MAX_LENGTH, ContentType, StatusValue, SourceType } from '../core/constants';

/**
 * AI Organiser metadata structure
 */
export interface AIOMetadata {
    [AIO_META.SUMMARY]?: string;
    [AIO_META.STATUS]?: StatusValue;
    [AIO_META.TYPE]?: ContentType;
    [AIO_META.PROCESSED]?: string;
    [AIO_META.MODEL]?: string;
    [AIO_META.SOURCE]?: SourceType;
    [AIO_META.SOURCE_URL]?: string;
    [AIO_META.WORD_COUNT]?: number;
    [AIO_META.LANGUAGE]?: string;
    [AIO_META.PERSONA]?: string;
}

/**
 * Update AI Organiser metadata in a note's frontmatter
 * Preserves all existing frontmatter properties
 */
export async function updateAIOMetadata(
    app: App,
    file: TFile,
    metadata: Partial<AIOMetadata>
): Promise<boolean> {
    try {
        const content = await app.vault.read(file);
        const cache = app.metadataCache.getFileCache(file);
        const frontmatterPosition = cache?.frontmatterPosition;
        
        let frontmatter: any = {};
        let contentAfterFrontmatter = content;
        
        // Extract existing frontmatter if present
        if (frontmatterPosition) {
            const frontmatterText = content.substring(
                frontmatterPosition.start.offset + 4, // Skip '---\n'
                frontmatterPosition.end.offset - 4    // Skip '\n---'
            );
            
            try {
                frontmatter = yaml.load(frontmatterText) || {};
            } catch (yamlError) {
                console.error('[AI Organiser] YAML parse error:', yamlError);
                return false;
            }
            
            contentAfterFrontmatter = content.substring(frontmatterPosition.end.offset);
        }
        
        // Merge new AIO metadata with existing frontmatter
        const updatedFrontmatter = {
            ...frontmatter,
            ...metadata
        };
        
        // Generate new frontmatter YAML
        const newFrontmatterYAML = yaml.dump(updatedFrontmatter, {
            lineWidth: -1, // No line wrapping
            noRefs: true   // No YAML references
        }).trim();
        
        // Build new content
        const newContent = `---\n${newFrontmatterYAML}\n---${contentAfterFrontmatter}`;
        
        // Write back to file
        await app.vault.modify(file, newContent);
        return true;
    } catch (error) {
        console.error('[AI Organiser] Error updating AIO metadata:', error);
        return false;
    }
}

/**
 * Read AI Organiser metadata from a note's frontmatter
 */
export function getAIOMetadata(app: App, file: TFile): AIOMetadata | null {
    const cache = app.metadataCache.getFileCache(file);
    const frontmatter = cache?.frontmatter;
    
    if (!frontmatter) {
        return null;
    }
    
    const metadata: AIOMetadata = {};
    
    // Extract all AIO properties
    for (const [key, value] of Object.entries(AIO_META)) {
        const propName = value;
        if (propName in frontmatter) {
            (metadata as any)[propName] = frontmatter[propName];
        }
    }
    
    return Object.keys(metadata).length > 0 ? metadata : null;
}

/**
 * Create a 280-character summary hook from full summary
 * Truncates at sentence boundary when possible
 */
export function createSummaryHook(fullSummary: string): string {
    if (!fullSummary || fullSummary.length === 0) {
        return '';
    }
    
    // Remove markdown formatting for cleaner preview
    let cleaned = fullSummary
        .replace(/#{1,6}\s/g, '') // Remove headers
        .replace(/\*\*([^*]+)\*\*/g, '$1') // Remove bold
        .replace(/\*([^*]+)\*/g, '$1') // Remove italic
        .replace(/`([^`]+)`/g, '$1') // Remove inline code
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // Convert links to text
        .trim();
    
    if (cleaned.length <= SUMMARY_HOOK_MAX_LENGTH) {
        return cleaned;
    }
    
    // Try to truncate at sentence boundary
    const maxLength = SUMMARY_HOOK_MAX_LENGTH - 3; // Reserve space for '...'
    const sentences = cleaned.match(/[^.!?]+[.!?]+/g) || [];
    
    let hook = '';
    for (const sentence of sentences) {
        if ((hook + sentence).length <= maxLength) {
            hook += sentence;
        } else {
            break;
        }
    }
    
    // If no complete sentence fits, truncate at word boundary
    if (hook.length === 0) {
        const words = cleaned.substring(0, maxLength).split(' ');
        words.pop(); // Remove last partial word
        hook = words.join(' ');
    }
    
    return hook.trim() + '...';
}

/**
 * Check if a note has been processed by AI Organiser
 */
export function isAIOProcessed(app: App, file: TFile): boolean {
    const metadata = getAIOMetadata(app, file);
    return metadata !== null && metadata[AIO_META.STATUS] === 'processed';
}

/**
 * Get all notes with a specific status
 */
export function getNotesWithStatus(
    app: App,
    status: StatusValue,
    folder?: string
): TFile[] {
    const files = app.vault.getMarkdownFiles();
    
    return files.filter(file => {
        // Filter by folder if specified
        if (folder && !file.path.startsWith(folder)) {
            return false;
        }
        
        const metadata = getAIOMetadata(app, file);
        return metadata && metadata[AIO_META.STATUS] === status;
    });
}

/**
 * Count words in text content
 */
export function countWords(text: string): number {
    if (!text || text.trim().length === 0) {
        return 0;
    }
    
    // Remove frontmatter
    const withoutFrontmatter = text.replace(/^---[\s\S]*?---\n?/, '');
    
    // Remove code blocks
    const withoutCode = withoutFrontmatter.replace(/```[\s\S]*?```/g, '');
    
    // Count words
    const words = withoutCode.trim().split(/\s+/);
    return words.filter(w => w.length > 0).length;
}

/**
 * Detect language from text content (simple heuristic)
 */
export function detectLanguage(text: string): string {
    if (!text || text.length < 50) {
        return 'unknown';
    }
    
    // Very basic detection - count character ranges
    const cjkRegex = /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff]/g;
    const cjkMatches = text.match(cjkRegex);
    const cjkRatio = cjkMatches ? cjkMatches.length / text.length : 0;
    
    if (cjkRatio > 0.3) {
        return 'zh'; // Likely Chinese/Japanese
    }
    
    // Default to English for Latin script
    return 'en';
}
