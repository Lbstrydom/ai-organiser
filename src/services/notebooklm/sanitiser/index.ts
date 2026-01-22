/**
 * Sanitiser Pipeline Orchestrator
 * 
 * Coordinates all sanitisation transforms in the correct order:
 * 1. Remove frontmatter
 * 2. Strip Dataview blocks
 * 3. Flatten callouts
 * 4. Handle embeds/transclusions
 * 5. Transform links
 * 6. Process images
 * 7. Strip plugin noise
 * 8. Clean up formatting
 */

import { App, TFile } from 'obsidian';
import { SourcePackConfig, SanitisedNote } from '../types';
import { hashNoteContent } from '../hashing';
import { removeFrontmatter } from './removeFrontmatter';
import { stripDataview, stripDataviewJs, stripAllDataview } from './stripDataview';
import { flattenCallouts } from './flattenCallouts';
import { handleEmbeds, EmbedResolveOptions } from './handleEmbeds';
import { transformLinks, LinkTransformOptions, buildPackNoteIdMap } from './transformLinks';
import { stripImages, ImageHandlingMode } from './stripImages';
import { stripPluginNoise, cleanupFormatting } from './stripPluginNoise';

/**
 * Sanitise a single note according to config
 * @param file TFile to sanitise
 * @param app Obsidian App instance
 * @param config Source pack configuration
 * @param packNoteIds Map of pack note paths to short IDs (for link transforms)
 * @returns Sanitised note with metadata
 */
export async function sanitiseNote(
    file: TFile,
    app: App,
    config: SourcePackConfig,
    packNoteIds: Map<string, string> = new Map()
): Promise<SanitisedNote> {
    const warnings: string[] = [];
    
    // Read original content
    let content = await app.vault.read(file);

    // 1. Remove frontmatter
    if (config.removeFrontmatter) {
        content = removeFrontmatter(content);
    }

    // 2. Strip Dataview blocks
    if (config.stripDataview && config.stripDataviewJs) {
        content = stripAllDataview(content);
    } else if (config.stripDataview) {
        content = stripDataview(content);
    } else if (config.stripDataviewJs) {
        content = stripDataviewJs(content);
    }

    // 3. Flatten callouts
    if (config.flattenCallouts) {
        content = flattenCallouts(content);
    }

    // 4. Handle embeds/transclusions
    if (config.resolveEmbeds !== 'none') {
        const embedOptions: EmbedResolveOptions = {
            mode: config.resolveEmbeds,
            maxDepth: config.embedMaxDepth,
            maxCharsPerEmbed: config.embedMaxChars,
            maxTotalEmbedChars: config.embedMaxChars * 10 // Budget for all embeds
        };

        const embedResult = await handleEmbeds(content, file, app, embedOptions);
        content = embedResult.content;
        warnings.push(...embedResult.warnings);
    } else {
        // Strip embeds entirely
        content = content.replace(/!\[\[([^\]]+)\]\]/g, '');
    }

    // 5. Transform WikiLinks
    const linkOptions: LinkTransformOptions = {
        packNoteIds,
        includeIdReferences: true
    };
    const linkResult = transformLinks(content, file, app, linkOptions);
    content = linkResult.content;

    // 6. Process images
    const imageResult = stripImages(content, config.imageHandling as ImageHandlingMode);
    content = imageResult.content;

    // 7. Strip plugin noise
    content = stripPluginNoise(content);

    // 8. Clean up formatting
    content = cleanupFormatting(content);

    // Compute hash and metrics
    const { sha256, shortId } = hashNoteContent(content);
    const wordCount = countWords(content);
    const byteCount = Buffer.byteLength(content, 'utf8');

    return {
        filePath: file.path,
        title: file.basename,
        content,
        wordCount,
        byteCount,
        sha256,
        shortId,
        warnings
    };
}

/**
 * Sanitise multiple notes in batch
 * @param files Array of TFiles to sanitise
 * @param app Obsidian App instance
 * @param config Source pack configuration
 * @param progressCallback Optional callback for progress updates
 * @returns Array of sanitised notes
 */
export async function sanitiseNotes(
    files: TFile[],
    app: App,
    config: SourcePackConfig,
    progressCallback?: (current: number, total: number) => void
): Promise<SanitisedNote[]> {
    const results: SanitisedNote[] = [];

    // First pass: sanitise all notes to get short IDs
    const firstPassResults: SanitisedNote[] = [];
    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        progressCallback?.(i + 1, files.length);

        const sanitised = await sanitiseNote(file, app, config);
        firstPassResults.push(sanitised);
    }

    // Build ID map for link resolution
    const packNoteIds = buildPackNoteIdMap(
        firstPassResults.map(r => ({ filePath: r.filePath, shortId: r.shortId }))
    );

    // Second pass: re-sanitise with proper link IDs
    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const sanitised = await sanitiseNote(file, app, config, packNoteIds);
        results.push(sanitised);
    }

    return results;
}

/**
 * Count words in text
 * @param text Text to count
 * @returns Word count
 */
function countWords(text: string): number {
    // Remove code blocks
    const withoutCode = text.replace(/```[\s\S]*?```/g, '');
    
    // Split by whitespace and filter empty
    const words = withoutCode.trim().split(/\s+/).filter(w => w.length > 0);
    
    return words.length;
}

/**
 * Preview sanitisation (without full processing)
 * Used for quick estimates in the export modal
 * @param file File to preview
 * @param app Obsidian App instance
 * @returns Estimated word count after sanitisation
 */
export async function previewSanitisation(file: TFile, app: App): Promise<number> {
    let content = await app.vault.read(file);
    
    // Quick sanitisation for estimate
    content = removeFrontmatter(content);
    content = stripAllDataview(content);
    content = content.replace(/!\[\[([^\]]+)\]\]/g, ''); // Strip embeds
    content = stripPluginNoise(content);
    
    return countWords(content);
}
