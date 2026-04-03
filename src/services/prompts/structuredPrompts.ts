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

    /** Optional narrative companion content (Study persona dual-output) */
    companion_content?: string;
}

export interface StructuredSummaryOptions {
    length?: 'brief' | 'standard' | 'detailed';
    language?: string;
    personaPrompt?: string;
    userContext?: string;
    /** When true, request a narrative companion section alongside the structured summary */
    includeCompanion?: boolean;
}

/**
 * Build a structured summary prompt that requests JSON output
 */
export function buildStructuredSummaryPrompt(options: StructuredSummaryOptions = {}): string {
    const length = options.length || 'standard';
    const language = options.language ? getLanguageNameForPrompt(options.language) : 'English';
    const personaPrompt = options.personaPrompt || '';
    const userContext = options.userContext || '';
    
    // Length-specific instructions
    const lengthInstructions: Record<string, string> = {
        brief: 'Use Smart Brevity format. Structure body_content as: ### The Lede (1-2 sentences: the single most important takeaway), ### Why It Matters (2-3 bullets on significance/stakes), ### Go Deeper (key details as bold-topic bullets), ### The Bottom Line (1 sentence conclusion or action). Active voice, no filler, bold key terms.',
        standard: 'Create a comprehensive summary covering key concepts, arguments, and conclusions (4-6 paragraphs).',
        detailed: 'Create an extensive summary with detailed explanations, examples, and all significant points (6+ paragraphs).'
    };
    
    const lengthInstruction = lengthInstructions[length];
    
    const includeCompanion = options.includeCompanion === true;

    // Companion JSON field and instructions — only injected when requested (no prompt bloat)
    const companionJsonField = includeCompanion
        ? ',\n  "companion_content": "A narrative explanation written as if teaching a friend..."'
        : '';
    const companionInstructions = includeCompanion
        ? `\n- companion_content (optional): a narrative "Explain Like a Friend" companion — restate the material in conversational prose, using analogies and examples. This goes into a separate companion note. Include only when a useful narrative can be added; omit the field entirely otherwise.`
        : '';

    // Soften "exact structure" when companion is included, since companion_content is optional
    const structureNote = includeCompanion
        ? 'You MUST return valid JSON matching this structure (companion_content is optional; no additional text before or after):'
        : 'You MUST return valid JSON with this exact structure (no additional text before or after):';

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
${structureNote}

{
  "summary_hook": "A concise 280-character preview...",
  "body_content": "## Main heading\\n\\nFull formatted summary with markdown...",
  "suggested_tags": ["tag1", "tag2", "tag3"],
  "content_type": "research",
  "detected_language": "en"${companionJsonField}
}

CRITICAL:
- summary_hook must be 280 characters or less
- body_content should use markdown formatting (headers, lists, emphasis)
- body_content must NOT start with a link to the source URL - jump straight into the summary content
- Do NOT include any reference to the source URL in body_content (it's stored separately in metadata)
- suggested_tags: array of 3-7 relevant tags
- content_type: exactly one of: note, research, meeting, project, reference${companionInstructions}
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
