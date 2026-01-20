import { LanguageCode } from '../types';
import { LanguageUtils } from '../../utils/languageUtils';
import { AIOrganiserSettings } from '../../core/settings';

let pluginSettings: AIOrganiserSettings | undefined;

export function setSettings(settings: AIOrganiserSettings): void {
    pluginSettings = settings;
}

/**
 * Builds a taxonomy-based tagging prompt
 * Uses the 3-tier hierarchy: Theme -> Discipline -> Topics
 *
 * @param content - Content to analyze
 * @param taxonomyPrompt - Formatted taxonomy from ConfigurationService.getTaxonomyForPrompt()
 * @param maxTags - Maximum number of tags to return
 * @param language - Language for generated tags
 * @returns Formatted prompt string
 */
export function buildTaxonomyTagPrompt(
    content: string,
    taxonomyPrompt: string,
    maxTags: number = 5,
    language?: LanguageCode | 'default'
): string {
    let langInstructions = '';

    // Prepare language instructions if needed
    if (language && language !== 'default') {
        const languageName = LanguageUtils.getLanguageDisplayName(language);
        langInstructions = `IMPORTANT: Generate all output in ${languageName} language.
Regardless of what language the content is in, all tags, title, and folder must be in ${languageName}.

`;
    }

    return `${langInstructions}<task>
You are a knowledge organizer. Analyze the document and:
1. Assign tags using a structured 3-level taxonomy
2. Suggest a descriptive title for the note
3. Suggest an appropriate folder path for organizing this note
</task>

<taxonomy_structure>
The tagging system uses THREE levels:

1. **THEME** (Required, exactly 1)
   - Select from the available themes below
   - This is the broadest category that best fits the content
   - If content is abstract (e.g., math, logic), map it to the industry/domain it serves

2. **DISCIPLINE** (Required, exactly 1)
   - Select from the available disciplines below, OR generate an appropriate one
   - This is the academic/professional field the content belongs to
   - Must be different from the Theme
   - Use kebab-case (e.g., "data-science" not "Data Science")

3. **TOPICS** (Required, 2-${Math.max(2, maxTags - 2)} tags)
   - Generate specific tags for the actual content
   - These should be concrete concepts, techniques, or subjects from the document
   - Use kebab-case format
</taxonomy_structure>

${taxonomyPrompt}

<document_content>
${content}
</document_content>

<output_rules>
Return your response in exactly this JSON format:
{
  "tags": ["theme", "discipline", "topic1", "topic2"],
  "title": "Suggested Note Title",
  "folder": "Theme/Discipline"
}

Tag rules:
- First tag MUST be the Theme (from available themes)
- Second tag MUST be the Discipline
- Remaining tags are specific Topics from the content
- Use kebab-case for all tags (lowercase with hyphens)
- Do NOT include the # symbol
- Maximum ${maxTags} tags total

Title rules:
- Create a clear, descriptive title that captures the main subject
- Use Title Case (capitalize important words)
- Keep it concise (3-8 words)
- Do not include special characters except hyphens and colons

Folder rules:
- Suggest a folder path using the Theme and Discipline
- Use forward slashes for nested folders (e.g., "Technology/Programming")
- Use Title Case for folder names
- Keep it to 1-3 levels deep
</output_rules>

<output_format>
Example output:
{
  "tags": ["technology", "computer-science", "neural-networks", "backpropagation", "gradient-descent"],
  "title": "Understanding Neural Network Training",
  "folder": "Technology/Computer Science"
}

Return ONLY the JSON object, no additional text or explanation.
</output_format>`;
}

/**
 * Legacy function for backward compatibility
 * Now redirects to taxonomy-based prompt
 */
export function buildTagPrompt(
    content: string,
    candidateTags: string[],
    _mode: unknown,
    maxTags: number = 5,
    language?: LanguageCode | 'default'
): string {
    // Convert candidate tags to a simple taxonomy format for backward compatibility
    const themeList = candidateTags.length > 0
        ? candidateTags.join(', ')
        : 'Technology, Strategy, Business, Science, Personal-Development';

    const taxonomyPrompt = `<available_themes>
${themeList}
</available_themes>

<available_disciplines>
Use your judgment to select an appropriate discipline based on the content.
Common disciplines include: computer-science, mathematics, marketing, economics, psychology, design, project-management, data-science
</available_disciplines>`;

    return buildTaxonomyTagPrompt(content, taxonomyPrompt, maxTags, language);
}
