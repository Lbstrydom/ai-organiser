/**
 * Remove YAML frontmatter from note content
 */

/**
 * Remove frontmatter block from content
 * @param content Note content
 * @returns Content without frontmatter
 */
export function removeFrontmatter(content: string): string {
    // Match frontmatter pattern: ---\n...\n---
    const frontmatterRegex = /^---\n[\s\S]*?\n---\n?/;
    return content.replace(frontmatterRegex, '');
}
