/**
 * Strip Dataview code blocks from note content
 */

/**
 * Remove dataview query blocks
 * @param content Note content
 * @returns Content without dataview blocks
 */
export function stripDataview(content: string): string {
    // Match ```dataview ... ``` blocks
    const dataviewRegex = /```dataview\n[\s\S]*?```/g;
    return content.replace(dataviewRegex, '');
}

/**
 * Remove dataviewjs code blocks
 * @param content Note content
 * @returns Content without dataviewjs blocks
 */
export function stripDataviewJs(content: string): string {
    // Match ```dataviewjs ... ``` blocks
    const dataviewJsRegex = /```dataviewjs\n[\s\S]*?```/g;
    return content.replace(dataviewJsRegex, '');
}

/**
 * Remove both dataview and dataviewjs blocks
 * @param content Note content
 * @returns Content without dataview blocks
 */
export function stripAllDataview(content: string): string {
    let result = stripDataview(content);
    result = stripDataviewJs(result);
    return result;
}
