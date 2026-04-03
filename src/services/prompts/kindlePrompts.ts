/**
 * Kindle Prompts
 *
 * LLM prompts for Kindle highlight enhancement:
 * - Book summary hook generation (280 chars for Bases metadata)
 * - Highlight theme grouping (JSON output for future UI)
 */

import type { KindleBook, KindleHighlight } from '../kindle/kindleTypes';

/**
 * Build a prompt to generate a 280-character book summary hook
 * from Kindle highlights. Used for Bases metadata integration.
 */
export function buildBookSummaryPrompt(
    book: KindleBook,
    highlights: KindleHighlight[],
    language: string
): string {
    const highlightTexts = highlights
        .filter(h => h.text)
        .slice(0, 30) // Cap to avoid token overflow
        .map((h, i) => `[${i + 1}] ${h.text}`)
        .join('\n');

    return `<task>
Write a single concise summary sentence (max 280 characters) for this book based on the reader's highlights.
The summary should capture the book's core themes as revealed by what the reader chose to highlight.
</task>

<book>
Title: ${book.title}
Author: ${book.author}
Total highlights: ${book.highlightCount}
</book>

<highlights>
${highlightTexts}
</highlights>

<requirements>
- Write in ${language}
- Maximum 280 characters (hard limit)
- One or two sentences, no more
- Focus on themes the reader found important (based on highlights)
- Do NOT start with "This book" or "The author" — start with the core idea
- Do NOT use markdown formatting
- Do NOT add quotes or attribution
</requirements>

<output_format>
Return ONLY the summary text, nothing else. No JSON, no labels, no explanation.
Example: "Atomic habits compound through small daily improvements. The key insight is that 1% better each day creates remarkable long-term results through identity-based behaviour change."
</output_format>`;
}

/**
 * Build a prompt to group highlights into thematic clusters.
 * Returns JSON with theme labels and highlight indexes.
 */
export function buildHighlightThemePrompt(
    book: KindleBook,
    highlights: KindleHighlight[],
    language: string
): string {
    const filtered = highlights.filter(h => h.text);
    const capped = filtered.slice(0, 50);
    const highlightTexts = capped
        .map((h, i) => `[${i}] ${h.text}`)
        .join('\n');

    const capNote = filtered.length > 50
        ? `\nNote: Showing ${capped.length} of ${book.highlightCount} highlights.\n`
        : '';

    return `<task>
Group these book highlights from "${book.title}" into thematic clusters.
</task>

<highlights>
${highlightTexts}
</highlights>${capNote}

<requirements>
- Identify 3-7 themes from the highlights
- Assign each highlight index to exactly one theme
- Use ${language} for theme labels
- Keep theme labels concise (1-4 words)
- Every highlight must appear in exactly one theme
</requirements>

<output_format>
Return JSON only: {"themes": [{"name": "Theme Label", "highlightIndexes": [0, 2, 5]}]}
</output_format>`;
}
