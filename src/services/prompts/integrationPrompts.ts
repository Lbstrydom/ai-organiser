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
