import { TAG_PREDEFINED_RANGE, TAG_GENERATE_RANGE } from '../../utils/constants';
import { LanguageCode } from '../types';
import { languageNames, getLanguageName } from '../languageUtils';
import { LanguageUtils } from '../../utils/languageUtils';
import { SYSTEM_PROMPT } from '../../utils/constants';
import { TaggingMode } from './types';

// Re-export TaggingMode for backward compatibility
export { TaggingMode };

import { AITaggerSettings } from '../../core/settings';

let pluginSettings: AITaggerSettings | undefined;

export function setSettings(settings: AITaggerSettings): void {
    pluginSettings = settings;
}

/**
 * Builds a prompt for tag analysis based on the specified mode
 * @param content - Content to analyze
 * @param candidateTags - Array of candidate tags
 * @param mode - Tagging mode
 * @param maxTags - Maximum number of tags to return
 * @param language - Language for generated tags
 * @returns Formatted prompt string
 */
export function buildTagPrompt(
    content: string, 
    candidateTags: string[], 
    mode: TaggingMode,
    maxTags: number = 5,
    language?: LanguageCode | 'default'
): string {
    let prompt = '';
    let langInstructions = '';

    // Prepare language instructions if needed
    if (language && language !== 'default') {
        const languageName = LanguageUtils.getLanguageDisplayName(language);

        switch (mode) {
            case TaggingMode.Hybrid:
                langInstructions = `IMPORTANT: Generate all new tags in ${languageName} language only.
When generating new tags (not selecting from predefined ones), they must be in ${languageName} only.

`;
                break;

            case TaggingMode.GenerateNew:
                langInstructions = `IMPORTANT: Generate all tags in ${languageName} language only.
Regardless of what language the content is in, all tags must be in ${languageName} only.
First understand the content, then if needed translate concepts to ${languageName}, then generate tags in ${languageName}.

`;
                break;

            default:
                langInstructions = '';
        }
    }

    // Add nested tags instructions if enabled (skip in Custom mode)
    if (pluginSettings?.enableNestedTags && mode !== TaggingMode.Custom) {
        const nestedInstructions = `
<nested_tags_requirements>
Generate tags in hierarchical/nested format using forward slashes (/) when appropriate.
Use nested tags to show relationships from general to specific concepts.

Structure: parent/child or parent/child/grandchild (max ${pluginSettings.nestedTagsMaxDepth} levels)

Examples of good nested tags:
- technology/artificial-intelligence/machine-learning
- science/biology/genetics
- programming/languages/python
- business/marketing/social-media
- art/painting/impressionism

When to use nested tags:
1. When there's a clear categorical hierarchy (category/subcategory)
2. When the concept has a broader parent topic
3. When it helps organize knowledge by domain

When NOT to use nested tags:
1. Don't force nesting if concepts are independent
2. Don't create unnecessary hierarchies
3. Flat tags are fine for standalone concepts

Generate a mix of nested and flat tags based on content relevance.
</nested_tags_requirements>

`;
        prompt += nestedInstructions;
    }

    switch (mode) {
        case TaggingMode.PredefinedTags:
            prompt += `<task>
Analyze the document content and select up to ${maxTags} most relevant tags from the available tag list.
</task>

<available_tags>
${candidateTags.join(', ')}
</available_tags>

<document_content>
${content}
</document_content>

<requirements>
- Select ONLY from the available tags listed above
- Do NOT modify existing tags or create new ones
- Do NOT include the # symbol
- Choose the most relevant and specific tags that match the content
- Return up to ${maxTags} tags maximum
</requirements>

<output_format>
Return the selected tags as a comma-separated list in kebab-case format.

Example: machine-learning, data-science, neural-networks

Do NOT include explanations, just the comma-separated tag list.
</output_format>`;
            break;

        case TaggingMode.Hybrid:
            prompt += `${langInstructions}<task>
Analyze the document content and provide relevant tags using a two-part approach:
1. Select existing tags from the available tag list that match the content (up to ${Math.ceil(maxTags/2)} tags)
2. Generate new tags for concepts not covered by existing tags (up to ${Math.ceil(maxTags/2)} tags)
</task>

<available_tags>
${candidateTags.join(', ')}
</available_tags>

<document_content>
${content}
</document_content>

<tag_requirements>
- Use kebab-case formatting (lowercase with hyphens): "machine-learning" not "Machine Learning"
- Keep tags concise (1-3 words maximum)
- Be specific and descriptive
- Match existing tags exactly when selecting from available tags
- Generate new tags only for important concepts not covered by existing tags
- Do NOT include the # symbol
- Do NOT prefix tags with field names or "tag:"
</tag_requirements>

<output_format>
Return ONLY a valid JSON object with this exact structure:
{
  "matchedExistingTags": ["existing-tag-1", "existing-tag-2"],
  "suggestedTags": ["new-tag-1", "new-tag-2"]
}

Example of CORRECT output:
{
  "matchedExistingTags": ["medical-research", "healthcare"],
  "suggestedTags": ["clinical-trials", "patient-outcomes"]
}

Example of WRONG output (DO NOT DO THIS):
{
  "matchedExistingTags": ["tag:matchedExistingTags-medical-research"],
  "suggestedTags": ["suggestedTags-healthcare"]
}
</output_format>`;
            break;

        case TaggingMode.GenerateNew:
            prompt += `${langInstructions}<task>
Analyze the document content and generate up to ${maxTags} relevant tags that best describe the key topics, themes, and concepts.
</task>

<document_content>
${content}
</document_content>

<tag_requirements>
- Use kebab-case formatting (lowercase with hyphens): "machine-learning" not "Machine Learning" or "machine_learning"
- Keep tags concise (1-3 words maximum)
- Be specific and descriptive
- Focus on main topics, key concepts, and important themes
- Avoid overly generic tags unless highly relevant
- Do NOT include the # symbol
- Do NOT prefix tags with "tag:" or any other prefix
</tag_requirements>

<output_format>
Return the tags as a comma-separated list.

Example: machine-learning, deep-learning, neural-networks, python, data-preprocessing

Do NOT include explanations or additional text, just the comma-separated tag list.
</output_format>`;
            break;

        case TaggingMode.Custom:
            // NUCLEAR MODIFICATION: Force 3-Tier Corporate Taxonomy
            // This replaces the standard Custom logic to remove "conciseness" constraints.

            // 1. Define the mandatory theme list (Fallback to hardcoded if file is empty)
            const themeList = candidateTags && candidateTags.length > 0
                ? candidateTags.join(', ')
                : 'Technology, Strategy, Operations, Leadership, Wartsila, Thrive, AI, Innovation, Creativity, Communication, Influence, Coaching, Programming, DevOps, AISystems';

            prompt += `${langInstructions}
<task>
You are a specialized Corporate Taxonomist.
Your ONLY goal is to classify this content into a strict 3-Level Hierarchy.
</task>

<rules>
*** LEVEL 1: THEME (Mandatory) ***
- You MUST begin with exactly ONE tag from the 'Available Themes' list below.
- RULE: If the note is abstract (e.g., math, logic), you MUST map it to the industry it serves (e.g., Set Theory -> 'Technology').

*** LEVEL 2: DISCIPLINE (General Subject) ***
- You MUST generate exactly ONE tag for the broader academic or professional field.
- Examples: 'mathematics', 'computer-science', 'project-management', 'contract-law'.
- This tag must be distinct from the Theme.

*** LEVEL 3: SPECIFIC TOPICS ***
- Generate 2-4 specific tags for the actual content.
- Use kebab-case (e.g., 'set-theory', 'logic-gates').
</rules>

<available_themes>
${themeList}
</available_themes>

<document_content>
${content}
</document_content>

<output_format>
Return ONLY a single comma-separated list.
DO NOT use labels like "Theme:". Just the values.

Target Structure: [Theme], [Discipline], [Topic1], [Topic2], [Topic3]

Example Output:
Technology, mathematics, set-theory, boolean-logic
</output_format>`;

            break;

        default:
            throw new Error(`Unsupported tagging mode: ${mode}`);
    }

    return prompt;
}
