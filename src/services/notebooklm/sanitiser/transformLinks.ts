/**
 * Transform WikiLinks to plain text with optional ID references
 * 
 * Converts [[Note Title]] to readable text and optionally adds ID references
 * for notes included in the pack.
 */

import { App, TFile } from 'obsidian';

export interface LinkTransformOptions {
    /** Map of file paths to short IDs (for notes in pack) */
    packNoteIds: Map<string, string>;
    /** Include ID references for pack notes */
    includeIdReferences: boolean;
}

export interface LinkTransformResult {
    /** Transformed content */
    content: string;
    /** Links found and their targets */
    links: Array<{ original: string; target: string; inPack: boolean }>;
}

/**
 * Transform WikiLinks in content
 * @param content Note content
 * @param sourceFile Source file (for link resolution)
 * @param app Obsidian App instance
 * @param options Transform options
 * @returns Transformed content and link metadata
 */
export function transformLinks(
    content: string,
    sourceFile: TFile,
    app: App,
    options: LinkTransformOptions
): LinkTransformResult {
    const links: Array<{ original: string; target: string; inPack: boolean }> = [];
    let result = content;

    // Match WikiLinks: [[Link]] or [[Link|Display]]
    const wikiLinkRegex = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
    const replacements: Array<{ original: string; replacement: string }> = [];

    let match;
    while ((match = wikiLinkRegex.exec(content)) !== null) {
        const linkPath = match[1].trim();
        const displayText = match[2] ? match[2].trim() : null;
        const original = match[0];

        // Resolve link
        const targetFile = app.metadataCache.getFirstLinkpathDest(linkPath, sourceFile.path);

        if (!targetFile) {
            // Link not found - use display text or link path
            const text = displayText || linkPath;
            replacements.push({ original, replacement: text });
            links.push({ original, target: linkPath, inPack: false });
            continue;
        }

        // Check if target is in pack
        const inPack = options.packNoteIds.has(targetFile.path);
        const noteTitle = displayText || targetFile.basename;

        links.push({ original, target: targetFile.path, inPack });

        // Build replacement
        let replacement = noteTitle;
        if (inPack && options.includeIdReferences) {
            const shortId = options.packNoteIds.get(targetFile.path);
            replacement = `${noteTitle} (see note id: ${shortId})`;
        }

        replacements.push({ original, replacement });
    }

    // Apply replacements
    for (const { original, replacement } of replacements) {
        result = result.replace(original, replacement);
    }

    return {
        content: result,
        links
    };
}

/**
 * Generate a link index section for a module
 * @param links Array of all links in the module
 * @param packNoteIds Map of file paths to short IDs
 * @returns Markdown link index section
 */
export function generateLinkIndex(
    links: Array<{ original: string; target: string; inPack: boolean }>,
    packNoteIds: Map<string, string>
): string {
    if (links.length === 0) return '';

    const lines: string[] = [
        '',
        '---',
        '### Link Index',
        ''
    ];

    // Group links by target
    const linkMap = new Map<string, boolean>();
    for (const link of links) {
        if (!linkMap.has(link.target)) {
            linkMap.set(link.target, link.inPack);
        }
    }

    // Sort by target name
    const sortedTargets = Array.from(linkMap.entries()).sort((a, b) => 
        a[0].localeCompare(b[0])
    );

    for (const [target, inPack] of sortedTargets) {
        if (inPack) {
            const shortId = packNoteIds.get(target);
            lines.push(`- ${target} → id: ${shortId}`);
        } else {
            lines.push(`- ${target} → (not included in pack)`);
        }
    }

    return lines.join('\n');
}

/**
 * Build map of pack note paths to short IDs
 * @param entries Pack entries with short IDs
 * @returns Map for quick lookups
 */
export function buildPackNoteIdMap(entries: Array<{ filePath: string; shortId: string }>): Map<string, string> {
    const map = new Map<string, string>();
    for (const entry of entries) {
        map.set(entry.filePath, entry.shortId);
    }
    return map;
}
