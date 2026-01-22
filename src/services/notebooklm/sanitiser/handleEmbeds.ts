/**
 * Handle Obsidian embeds/transclusions
 * 
 * Embeds like ![[Note]] or ![[Note#Heading]] can be:
 * - Omitted (none)
 * - Replaced with title reference (titleOnly)
 * - Replaced with excerpt (excerpt)
 * 
 * Includes cycle detection and depth limiting.
 */

import { App, TFile } from 'obsidian';

export interface EmbedResolveOptions {
    /** Resolution mode */
    mode: 'none' | 'titleOnly' | 'excerpt';
    /** Maximum recursion depth */
    maxDepth: number;
    /** Maximum characters per embed */
    maxCharsPerEmbed: number;
    /** Total character budget for all embeds */
    maxTotalEmbedChars: number;
}

export interface EmbedResolveResult {
    /** Resolved content */
    content: string;
    /** Warnings generated during resolution */
    warnings: string[];
    /** Total characters used */
    charsUsed: number;
}

/**
 * Resolve embeds in note content
 * @param content Note content
 * @param sourceFile Source file (for relative path resolution)
 * @param app Obsidian App instance
 * @param options Embed resolution options
 * @returns Resolved content and warnings
 */
export async function handleEmbeds(
    content: string,
    sourceFile: TFile,
    app: App,
    options: EmbedResolveOptions
): Promise<EmbedResolveResult> {
    if (options.mode === 'none') {
        // Strip all embeds
        const strippedContent = content.replace(/!\[\[([^\]]+)\]\]/g, '');
        return {
            content: strippedContent,
            warnings: [],
            charsUsed: 0
        };
    }

    const warnings: string[] = [];
    const visited = new Set<string>();
    let totalCharsUsed = 0;

    // Track source file as visited to prevent circular refs
    visited.add(sourceFile.path);

    // Process embeds
    let result = content;
    const embedRegex = /!\[\[([^\]]+)\]\]/g;
    let match;
    const replacements: Array<{ original: string; replacement: string }> = [];

    while ((match = embedRegex.exec(content)) !== null) {
        const embedText = match[1];
        const original = match[0];

        // Parse embed reference
        const { filePath, heading } = parseEmbedReference(embedText, sourceFile, app);

        if (!filePath) {
            warnings.push(`Embed not found: ${embedText}`);
            replacements.push({ original, replacement: `[Embed not found: ${embedText}]` });
            continue;
        }

        // Check if already visited (cycle detection)
        if (visited.has(filePath)) {
            warnings.push(`Circular reference detected: ${embedText}`);
            replacements.push({ original, replacement: `[Circular reference: ${embedText}]` });
            continue;
        }

        // Resolve embed
        const resolved = await resolveEmbed(
            filePath,
            heading,
            app,
            visited,
            1,
            options,
            warnings,
            totalCharsUsed
        );

        // Check budget
        if (totalCharsUsed + resolved.length > options.maxTotalEmbedChars) {
            warnings.push(`Embed budget exceeded, truncating: ${embedText}`);
            const remaining = options.maxTotalEmbedChars - totalCharsUsed;
            replacements.push({ 
                original, 
                replacement: resolved.substring(0, remaining) + '...' 
            });
            totalCharsUsed = options.maxTotalEmbedChars;
            break; // Stop processing further embeds
        }

        replacements.push({ original, replacement: resolved });
        totalCharsUsed += resolved.length;
    }

    // Apply replacements
    for (const { original, replacement } of replacements) {
        result = result.replace(original, replacement);
    }

    return {
        content: result,
        warnings,
        charsUsed: totalCharsUsed
    };
}

/**
 * Parse embed reference to extract file path and heading
 */
function parseEmbedReference(
    embedText: string,
    sourceFile: TFile,
    app: App
): { filePath: string | null; heading: string | null } {
    // Split by # for heading references
    const parts = embedText.split('#');
    const linkPath = parts[0].trim();
    const heading = parts.length > 1 ? parts[1].trim() : null;

    // Resolve link path to file
    const file = app.metadataCache.getFirstLinkpathDest(linkPath, sourceFile.path);

    return {
        filePath: file?.path || null,
        heading
    };
}

/**
 * Resolve a single embed
 */
async function resolveEmbed(
    filePath: string,
    heading: string | null,
    app: App,
    visited: Set<string>,
    currentDepth: number,
    options: EmbedResolveOptions,
    warnings: string[],
    currentCharsUsed: number
): Promise<string> {
    // Check depth limit
    if (currentDepth > options.maxDepth) {
        warnings.push(`Embed depth exceeded: ${filePath}`);
        return `[Embed depth exceeded: ${filePath}]`;
    }

    // Get file
    const file = app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) {
        return `[File not found: ${filePath}]`;
    }

    // Mark as visited
    visited.add(filePath);

    try {
        // Read content
        let content = await app.vault.read(file);

        // If heading specified, extract that section
        if (heading) {
            const extracted = extractHeadingSection(content, heading);
            if (!extracted) {
                return `[Heading not found: ${heading} in ${file.basename}]`;
            }
            content = extracted;
        }

        // Remove frontmatter
        content = content.replace(/^---\n[\s\S]*?\n---\n?/, '');

        // Handle mode
        if (options.mode === 'titleOnly') {
            return `[See: ${file.basename}${heading ? ' → ' + heading : ''}]`;
        }

        // Excerpt mode: truncate to maxCharsPerEmbed
        if (content.length > options.maxCharsPerEmbed) {
            content = content.substring(0, options.maxCharsPerEmbed) + '...';
            warnings.push(`Embed truncated: ${file.basename}`);
        }

        // Recursively handle nested embeds (increment depth)
        if (content.includes('![[')) {
            const nestedResult = await handleEmbeds(content, file, app, {
                ...options,
                maxTotalEmbedChars: options.maxTotalEmbedChars - currentCharsUsed
            });
            content = nestedResult.content;
            warnings.push(...nestedResult.warnings);
        }

        return content;

    } finally {
        // Unmark visited for other paths
        visited.delete(filePath);
    }
}

/**
 * Extract content under a specific heading
 */
function extractHeadingSection(content: string, heading: string): string | null {
    const lines = content.split('\n');
    const headingRegex = new RegExp(`^#+\\s+${heading}\\s*$`, 'i');
    
    let startIdx = -1;
    let headingLevel = 0;

    // Find heading
    for (let i = 0; i < lines.length; i++) {
        const match = lines[i].match(/^(#+)\s+(.+)$/);
        if (match && match[2].trim().toLowerCase() === heading.toLowerCase()) {
            startIdx = i;
            headingLevel = match[1].length;
            break;
        }
    }

    if (startIdx === -1) return null;

    // Extract until next heading of same or higher level
    const sectionLines: string[] = [];
    for (let i = startIdx + 1; i < lines.length; i++) {
        const match = lines[i].match(/^(#+)\s+/);
        if (match && match[1].length <= headingLevel) {
            break; // Next section
        }
        sectionLines.push(lines[i]);
    }

    return sectionLines.join('\n').trim();
}
