/**
 * Digitisation Prompts — Vision LLM prompts for Smart Digitisation (Phase 3)
 */
import type { DigitiseMode } from '../visionService';

/**
 * Build digitisation prompt for vision LLM
 * @param mode - Digitisation mode (auto, handwriting, diagram, whiteboard, mixed)
 * @param language - Output language
 * @returns XML-structured prompt optimized for vision LLMs
 */
export function buildDigitisePrompt(mode: DigitiseMode, language: string): string {
    const modeHint = getModeHint(mode);
    
    return `<task>
You are a Digitisation Engine. Convert the image into structured, editable content.
${modeHint ? `\n<context>${modeHint}</context>\n` : ''}
</task>

<requirements>
- Extract ALL visible text as Markdown (headings, bullets, numbered lists as appropriate)
- Convert any diagrams, flowcharts, or visual structures into Mermaid.js code
- If text appears inside diagram elements, include it in both the extracted text AND the Mermaid diagram
- Preserve the logical reading order (top-to-bottom, left-to-right)
- Mark illegible or uncertain items in an Uncertainties section
- Output language: ${language}
</requirements>

<output_format>
## Extracted Text

[Markdown content here]

## Diagram

\`\`\`mermaid
[Mermaid code here — ONLY if a diagram/flowchart/structure is present]
\`\`\`

## Uncertainties

- [List any illegible or ambiguous items — ONLY if applicable]
</output_format>

<examples>
## Example 1: Handwritten Notes
**Input**: Photo of handwritten meeting notes
**Output**:
## Extracted Text

# Meeting Notes - Q1 Planning

## Action Items
- Review budget proposal by Friday
- Schedule follow-up with marketing team
- Draft project timeline for new feature

## Key Decisions
- Approved 15% budget increase
- Delayed product launch to March

## Diagram

[None - purely text-based notes]

## Uncertainties

- One abbreviation unclear (possibly "ASAP" or "ABAP")

---

## Example 2: Whiteboard Diagram
**Input**: Whiteboard photo with flowchart
**Output**:
## Extracted Text

System Architecture Overview

**Components:**
- User Interface
- API Gateway
- Database
- Cache Layer

## Diagram

\`\`\`mermaid
graph TD
    UI[User Interface] --> API[API Gateway]
    API --> Cache{Cache Hit?}
    Cache -->|Yes| Return[Return Data]
    Cache -->|No| DB[(Database)]
    DB --> Cache
\`\`\`

## Uncertainties

- Arrow between Cache and Database might indicate bidirectional flow
</examples>`;
}

/**
 * Get mode-specific hint for prompt context
 */
function getModeHint(mode: DigitiseMode): string | null {
    switch (mode) {
        case 'handwriting':
            return 'The image contains handwritten text. Focus on accurate character recognition, including cursive and varied handwriting styles.';
        
        case 'diagram':
            return 'The image is primarily a diagram or flowchart. Prioritize structural accuracy in Mermaid output. Common diagram types include: flowcharts, system architecture diagrams, UML diagrams, mind maps, and organizational charts.';
        
        case 'whiteboard':
            return 'This is a whiteboard photo. Expect mixed handwriting, diagrams, and annotations. Handle potential glare, shadows, and uneven lighting. Text may be written at angles or in different sizes.';
        
        case 'mixed':
            return 'This contains both handwritten text and diagrams. Separate them into appropriate sections. Preserve spatial relationships where text annotates diagram elements.';
        
        case 'auto':
        default:
            return null; // No hint — let VLM determine content type
    }
}