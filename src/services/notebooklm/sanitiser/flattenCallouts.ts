/**
 * Flatten Obsidian callouts to plain text
 * 
 * Callouts are multi-line blocks that start with > [!TYPE] and continue with >
 * We flatten them to improve NotebookLM readability.
 */

/**
 * Flatten callout blocks to plain text
 * @param content Note content
 * @returns Content with flattened callouts
 */
export function flattenCallouts(content: string): string {
    const lines = content.split('\n');
    const result: string[] = [];
    let inCallout = false;
    let calloutType = '';

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        
        // Check for callout start: > [!TYPE] Title
        const calloutStartMatch = line.match(/^>\s*\[!(\w+)\](.*)$/);
        
        if (calloutStartMatch) {
            // Start of callout
            inCallout = true;
            calloutType = calloutStartMatch[1];
            const title = calloutStartMatch[2].trim();
            
            // Convert to plain text header
            if (title) {
                result.push(`**${calloutType}**: ${title}`);
            } else {
                result.push(`**${calloutType}**`);
            }
            continue;
        }
        
        // Check for callout continuation: > content
        if (inCallout && line.startsWith('>')) {
            // Remove > prefix and add content
            const content = line.substring(1).trim();
            if (content) {
                result.push(content);
            }
            continue;
        }
        
        // End of callout (line doesn't start with >)
        if (inCallout && !line.startsWith('>')) {
            inCallout = false;
            calloutType = '';
        }
        
        // Regular line
        result.push(line);
    }
    
    return result.join('\n');
}

/**
 * Alternative flattening that preserves callout structure with indentation
 * @param content Note content
 * @returns Content with indented callouts
 */
export function flattenCalloutsWithIndent(content: string): string {
    const lines = content.split('\n');
    const result: string[] = [];
    let inCallout = false;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        
        // Check for callout start
        const calloutStartMatch = line.match(/^>\s*\[!(\w+)\](.*)$/);
        
        if (calloutStartMatch) {
            inCallout = true;
            const calloutType = calloutStartMatch[1];
            const title = calloutStartMatch[2].trim();
            
            if (title) {
                result.push(`[${calloutType.toUpperCase()}]: ${title}`);
            } else {
                result.push(`[${calloutType.toUpperCase()}]`);
            }
            continue;
        }
        
        // Check for callout continuation
        if (inCallout && line.startsWith('>')) {
            const content = line.substring(1).trim();
            if (content) {
                result.push(`  ${content}`); // Indent content
            }
            continue;
        }
        
        // End of callout
        if (inCallout && !line.startsWith('>')) {
            inCallout = false;
        }
        
        result.push(line);
    }
    
    return result.join('\n');
}
