/**
 * Structured Prompts
 * Prompts that request structured JSON responses from LLMs
 */

import { getLanguageNameForPrompt } from '../languages';

/**
 * Structured summary response format
 */
export interface StructuredSummaryResponse {
    /** 280-character summary hook for Bases preview */
    summary_hook: string;
    
    /** Full formatted summary for note body */
    body_content: string;
    
    /** 3-7 relevant tags */
    suggested_tags: string[];
    
    /** Content type classification */
    content_type: 'note' | 'research' | 'meeting' | 'project' | 'reference';
    
    /** Detected language (optional) */
    detected_language?: string;
}

export interface StructuredSummaryOptions {
    length?: 'brief' | 'detailed' | 'comprehensive';
    language?: string;
    personaPrompt?: string;
    userContext?: string;
}

/**
 * Build a structured summary prompt that requests JSON output
 */
export function buildStructuredSummaryPrompt(options: StructuredSummaryOptions = {}): string {
    const length = options.length || 'detailed';
    const language = options.language ? getLanguageNameForPrompt(options.language) : 'English';
    const personaPrompt = options.personaPrompt || '';
    const userContext = options.userContext || '';
    
    // Length-specific instructions
    const lengthInstructions: Record<string, string> = {
        brief: 'Create a concise summary focusing on the main points (2-3 paragraphs).',
        detailed: 'Create a comprehensive summary covering key concepts, arguments, and conclusions (4-6 paragraphs).',
        comprehensive: 'Create an extensive summary with detailed explanations, examples, and all significant points (6+ paragraphs).'
    };
    
    const lengthInstruction = lengthInstructions[length];
    
    return `<task>
You are a professional note-taker creating structured summaries. You must return your response as valid JSON.
</task>

${personaPrompt ? `<persona>\n${personaPrompt}\n</persona>\n` : ''}
${userContext ? `<user_context>\n${userContext}\n</user_context>\n` : ''}

<instructions>
1. Read and analyze the provided content carefully
2. ${lengthInstruction}
3. Create a 280-character summary hook (concise overview for quick preview)
4. Identify 3-7 relevant tags for categorization
5. Classify the content type as one of: note, research, meeting, project, reference
6. Write everything in ${language}
7. Format as markdown with proper headings and structure
</instructions>

<output_format>
You MUST return valid JSON with this exact structure (no additional text before or after):

{
  "summary_hook": "A concise 280-character preview...",
  "body_content": "## Main heading\\n\\nFull formatted summary with markdown...",
  "suggested_tags": ["tag1", "tag2", "tag3"],
  "content_type": "research",
  "detected_language": "en"
}

CRITICAL:
- summary_hook must be 280 characters or less
- body_content should use markdown formatting (headers, lists, emphasis)
- suggested_tags: array of 3-7 relevant tags
- content_type: exactly one of: note, research, meeting, project, reference
- Return ONLY the JSON object, no explanations or wrapper text
</output_format>

<content>
{{CONTENT}}
</content>`;
}

/**
 * Insert content into the structured summary prompt
 */
export function insertContentIntoStructuredPrompt(
    promptTemplate: string,
    content: string
): string {
    return promptTemplate.replace('{{CONTENT}}', content);
}
