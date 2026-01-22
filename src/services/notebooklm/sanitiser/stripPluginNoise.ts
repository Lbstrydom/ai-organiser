/**
 * Strip plugin-specific noise from content
 * 
 * Removes markers and artifacts from plugins like:
 * - Templater: <%...%> markers
 * - Banners: cssclass banners
 * - Other plugin-specific syntax
 */

/**
 * Remove plugin noise from content
 * @param content Note content
 * @returns Cleaned content
 */
export function stripPluginNoise(content: string): string {
    let result = content;

    // Remove Templater commands: <%...%> or <%%...%%>
    result = result.replace(/<%[\s\S]*?%>/g, '');
    result = result.replace(/<%%-?[\s\S]*?-?%%>/g, '');

    // Remove empty HTML comments (sometimes left by plugins)
    result = result.replace(/<!--\s*-->/g, '');

    // Remove Tasks plugin syntax markers (global filter, etc.)
    result = result.replace(/```tasks[\s\S]*?```/g, '');

    // Remove excalidraw drawings
    result = result.replace(/```excalidraw[\s\S]*?```/g, '');

    // Remove mermaid diagrams (optional - could be kept)
    // Commented out by default as diagrams might be valuable
    // result = result.replace(/```mermaid[\s\S]*?```/g, '');

    // Remove inline Templater code
    result = result.replace(/<%\s*tp\.[^%]*%>/g, '');

    // Clean up multiple consecutive blank lines (caused by removals)
    result = result.replace(/\n{3,}/g, '\n\n');

    return result;
}

/**
 * Remove specific code block types
 * @param content Note content
 * @param blockTypes Array of code block types to remove (e.g., ['mermaid', 'excalidraw'])
 * @returns Cleaned content
 */
export function removeCodeBlocks(content: string, blockTypes: string[]): string {
    let result = content;

    for (const blockType of blockTypes) {
        const regex = new RegExp(`\`\`\`${blockType}[\\s\\S]*?\`\`\``, 'g');
        result = result.replace(regex, '');
    }

    return result;
}

/**
 * Remove HTML tags (optional aggressive cleaning)
 * @param content Note content
 * @param keepSemantic Keep semantic tags like <mark>, <u>, <strong>
 * @returns Cleaned content
 */
export function stripHtmlTags(content: string, keepSemantic: boolean = true): string {
    if (keepSemantic) {
        // Only remove div, span, script, style tags
        let result = content;
        result = result.replace(/<script[\s\S]*?<\/script>/gi, '');
        result = result.replace(/<style[\s\S]*?<\/style>/gi, '');
        result = result.replace(/<div[^>]*>/gi, '');
        result = result.replace(/<\/div>/gi, '');
        result = result.replace(/<span[^>]*>(.*?)<\/span>/gi, '$1');
        return result;
    } else {
        // Remove all HTML tags
        return content.replace(/<[^>]+>/g, '');
    }
}

/**
 * Clean up formatting artifacts
 * @param content Note content
 * @returns Cleaned content
 */
export function cleanupFormatting(content: string): string {
    let result = content;

    // Remove multiple consecutive blank lines
    result = result.replace(/\n{3,}/g, '\n\n');

    // Remove trailing whitespace from lines
    result = result.split('\n').map(line => line.trimEnd()).join('\n');

    // Ensure file ends with single newline
    result = result.trimEnd() + '\n';

    return result;
}
