import { LanguageCode } from '../types';
import { LanguageUtils } from '../../utils/languageUtils';
import { FolderContext } from '../../utils/folderContextUtils';

/**
 * Builds a taxonomy-based tagging prompt
 * Uses the 3-tier hierarchy: Theme -> Discipline -> Topics
 *
 * @param content - Content to analyze
 * @param taxonomyPrompt - Formatted taxonomy from ConfigurationService.getTaxonomyForPrompt()
 * @param maxTags - Maximum number of tags to return
 * @param language - Language for generated tags
 * @param folderContext - Optional folder context to constrain suggestions
 * @returns Formatted prompt string
 */
export function buildTaxonomyTagPrompt(
    content: string,
    taxonomyPrompt: string,
    maxTags: number = 5,
    language?: LanguageCode | 'default',
    folderContext?: FolderContext
): string {
    let langInstructions = '';

    // Prepare language instructions if needed
    if (language && language !== 'default') {
        const languageName = LanguageUtils.getLanguageDisplayName(language);
        langInstructions = `IMPORTANT: Generate all output in ${languageName} language.
Regardless of what language the content is in, all tags, title, and folder must be in ${languageName}.

`;
    }

    // Build folder scope constraint if provided
    let folderScopeInstructions = '';
    if (folderContext) {
        // Format subfolder list (limit to 20 for prompt size)
        let subfolderList = 'None';
        if (folderContext.subfolders.length > 0) {
            const displayedFolders = folderContext.subfolders.slice(0, 20);
            const suffix = folderContext.subfolders.length > 20 ? '...' : '';
            subfolderList = displayedFolders.join(', ') + suffix;
        }

        // Format tag list (limit to 30 for prompt size)
        let tagList = 'None';
        if (folderContext.existingTags.length > 0) {
            const displayedTags = folderContext.existingTags.slice(0, 30);
            const suffix = folderContext.existingTags.length > 30 ? '...' : '';
            tagList = displayedTags.join(', ') + suffix;
        }

        folderScopeInstructions = `
<folder_scope>
The user's vault is organized with the root folder: "${folderContext.rootPath}"
This folder contains ${folderContext.noteCount} notes.

Subfolders in this scope: ${subfolderList}

Existing tags used in this scope: ${tagList}

IMPORTANT CONSTRAINTS:
- Suggest a folder path that fits within "${folderContext.rootPath}" and its subfolders
- Prefer matching existing tags from this scope when appropriate
- New tags should be consistent with the organizational style of existing tags
- The suggested folder should be relative to or within "${folderContext.rootPath}"
</folder_scope>
`;
    }

    // Build folder rules and example based on whether folder context is provided
    let folderRules: string;
    let folderExample: string;

    if (folderContext) {
        // When folder scope is provided, constrain to that root
        folderRules = `Folder rules:
- IMPORTANT: The folder path MUST start with "${folderContext.rootPath}"
- Suggest a subfolder within this root that fits the content
- Use forward slashes for nested folders
- Use Title Case for folder names
- Example: "${folderContext.rootPath}/Subtopic" or "${folderContext.rootPath}/Category/Subtopic"`;

        folderExample = `{
  "tags": ["technology", "computer-science", "neural-networks", "backpropagation", "gradient-descent"],
  "title": "Understanding Neural Network Training",
  "folder": "${folderContext.rootPath}/Computer Science"
}`;
    } else {
        // Default behavior without folder scope
        folderRules = `Folder rules:
- Suggest a folder path using the Theme and Discipline
- Use forward slashes for nested folders (e.g., "Technology/Programming")
- Use Title Case for folder names
- Keep it to 1-3 levels deep`;

        folderExample = `{
  "tags": ["technology", "computer-science", "neural-networks", "backpropagation", "gradient-descent"],
  "title": "Understanding Neural Network Training",
  "folder": "Technology/Computer Science"
}`;
    }

    return `${langInstructions}${folderScopeInstructions}<task>
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
  "folder": "${folderContext ? folderContext.rootPath + '/Subtopic' : 'Theme/Discipline'}"
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

${folderRules}
</output_rules>

<output_format>
Example output:
${folderExample}

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

/**
 * Build a lightweight repair prompt for taxonomy guardrail.
 * Asks the LLM to pick the closest match from available options,
 * or respond "NOVEL" if no good match exists.
 *
 * ~200 tokens input. Only invoked when deterministic normalization fails.
 */
export function buildTaxonomyRepairPrompt(
    candidateTag: string,
    slotType: 'theme' | 'discipline',
    availableOptions: string[]
): string {
    return `<task>
The AI generated the ${slotType} tag "${candidateTag}" but it does not match any known ${slotType}.
Pick the CLOSEST match from the list below, or respond "NOVEL" if none are a reasonable match.
</task>

<available_options>
${availableOptions.join('\n')}
</available_options>

<output_format>
Respond with ONLY the exact name from the list above, or the word "NOVEL". No other text.
</output_format>`;
}
