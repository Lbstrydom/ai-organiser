import type { PlacementStrategy, FormatStrategy, DetailStrategy } from '../../core/constants';

/**
 * Get placement-specific instructions for integration prompts.
 */
export function getPlacementInstructions(placement: PlacementStrategy): string {
    switch (placement) {
        case 'cursor':
            return `Process the pending content into a well-structured section ready for insertion.
- Do NOT reference or include the main note content
- Create a self-contained block that can be dropped into any position
- Use appropriate headings if the content covers multiple topics`;
        case 'append':
            return `Organise the pending content as new section(s) with clear headings.
- Do NOT modify or reference existing note content
- Create well-titled sections for distinct topics
- Each section should be self-contained`;
        case 'callout':
            return `Rewrite the existing note, inserting the pending content as CALLOUT BLOCKS next to relevant sections.
- Use Obsidian callout syntax: > [!info] Title
- Place each callout after the most relevant paragraph or section
- Do NOT modify existing text — only insert callouts between sections`;
        case 'merge':
            return `Rewrite the existing note, integrating pending content INTO relevant sections by topic.
- Merge new information where it logically belongs
- Create new sections only for entirely new topics
- Remove redundancy — don't repeat existing information
- Maintain coherent narrative and logical flow`;
    }
}

/**
 * Get format-specific instructions for integration prompts.
 */
export function getFormatInstructions(format: FormatStrategy): string {
    switch (format) {
        case 'prose':
            return `Write in standard prose paragraphs.`;
        case 'bullets':
            return `Format as bullet-point lists organised under headings. Use sub-bullets for details.`;
        case 'tasks':
            return `Format as action items using Obsidian checkbox syntax: - [ ] Task description. Group related tasks under headings.`;
        case 'table':
            return `Format as markdown tables with columns appropriate to the content. Add a heading above each table.`;
    }
}

/**
 * Get detail-level instructions for integration prompts.
 */
export function getDetailInstructions(detail: DetailStrategy): string {
    switch (detail) {
        case 'full':
            return `Include all relevant new information, details, and examples.`;
        case 'concise':
            return `Include only key points and essential insights. Tighten prose, omit supporting examples.`;
        case 'summary':
            return `Distil the pending content to its core insights before integrating. Discard verbose explanations and secondary details.`;
    }
}

/**
 * Build prompt for extracting content from a PDF using multimodal vision.
 * This is different from summarization - we want the full content extracted,
 * not a summary. The extracted content will be integrated into notes.
 *
 * @param pdfName Display name of the PDF for context
 * @param language Output language (optional)
 * @returns Extraction prompt for the LLM
 */
export function buildPdfExtractionPrompt(pdfName: string, language?: string): string {
    const langInstruction = language ? `\n\nRespond in ${language}.` : '';

    return `<task>
Extract and describe all content from this PDF document.
</task>

<document_name>${pdfName}</document_name>

<requirements>
- Extract ALL text content, preserving the logical structure and hierarchy
- Describe any diagrams, charts, graphs, or images in detail
- For tables, reproduce the data in markdown table format
- For figures/diagrams, explain what they show and any data points visible
- Include headings, section titles, and maintain the document's organization
- Preserve important formatting like lists, numbered items, and emphasis
- If there are citations or references, include them
- Do NOT summarize or condense - extract the FULL content
</requirements>

<output_format>
Provide the extracted content in clean markdown format:
- Use appropriate heading levels (##, ###) matching the document structure
- Render tables in markdown format
- Use prose to describe visual elements you cannot directly transcribe
- Separate major sections with blank lines for readability
</output_format>${langInstruction}`;
}
