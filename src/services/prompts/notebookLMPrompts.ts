/**
 * NotebookLM Prompts
 *
 * Prompt builders for NotebookLM source pack operations.
 */

export function buildFolderNamePrompt(titles: string[], totalCount: number): string {
    return `<task>Generate a short folder name for a document export pack.</task>
<context>${totalCount} documents. Sample titles: ${titles.join(', ')}</context>
<requirements>
- 2-4 words, kebab-case (lowercase with hyphens)
- Descriptive of the content theme
- No dates, no special characters
- Return ONLY the folder name
</requirements>
<example>quarterly-sales-review</example>`;
}
