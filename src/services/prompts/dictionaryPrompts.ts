/**
 * Dictionary Prompts
 * Prompts for term extraction from documents using LLM
 */

export interface DocumentForExtraction {
    name: string;
    content: string;
}

/**
 * Build a prompt for extracting terminology from documents
 * Returns a prompt that asks LLM to identify key terms and categorize them
 */
export function buildTermExtractionPrompt(
    documents: DocumentForExtraction[],
    existingTerms: string[] = [],
    language: string = 'English'
): string {
    const existingTermsSection = existingTerms.length > 0
        ? `\n<existing_terms>${existingTerms.join(', ')}</existing_terms>`
        : '';

    const documentSections = documents
        .map(doc => `<document name="${doc.name}">\n${doc.content}\n</document>`)
        .join('\n\n');

    return `<task>Extract key terminology and people names from the provided documents</task>

<requirements>
- Identify all important terms, concepts, and people mentioned in the documents
- Categorize each term: person | acronym | term | project | organization
- Ignore common words and generic terms
- Return as space-separated tags with optional category suffix
- Format: "term-category" (e.g., "john-smith-person", "API-acronym")
- Language: ${language}
${existingTermsSection}
</requirements>

<documents>
${documentSections}
</documents>

<output_format>
Return a space-separated list of extracted terms with categories. Examples:
john-smith-person api-acronym project-phoenix-project sprint-velocity-term

Do not include explanations, just the extracted terms.
</output_format>`;
}

/**
 * Build a prompt for validating dictionary entries
 */
export function buildDictionaryValidationPrompt(
    entries: Array<{ term: string; definition?: string }>,
    language: string = 'English'
): string {
    const entryList = entries
        .map(e => `- ${e.term}${e.definition ? ` - ${e.definition}` : ''}`)
        .join('\n');

    return `<task>Validate and enhance dictionary entries</task>

<requirements>
- Review each term for accuracy and clarity
- Flag any ambiguous or incorrectly categorized terms
- Suggest definitions for entries without them
- Language: ${language}
</requirements>

<entries>
${entryList}
</entries>

<output_format>
Return validation results as JSON:
{
  "valid_entries": ["term1", "term2"],
  "issues": [{"term": "term", "issue": "description"}],
  "suggestions": [{"term": "term", "definition": "suggested definition"}]
}
</output_format>`;
}

/**
 * Build a prompt for extracting specific categories of terms
 */
export function buildCategoryExtractionPrompt(
    content: string,
    category: 'person' | 'acronym' | 'term' | 'project' | 'organization',
    language: string = 'English'
): string {
    const categoryDescription: Record<string, string> = {
        person: 'people names and roles',
        acronym: 'abbreviations and acronyms',
        term: 'important concepts and terminology',
        project: 'project names and initiatives',
        organization: 'company, department, and organization names'
    };

    return `<task>Extract ${categoryDescription[category]} from the provided content</task>

<requirements>
- Find all mentions of ${categoryDescription[category]}
- Return only the most important ones
- Language: ${language}
</requirements>

<content>
${content}
</content>

<output_format>
Return space-separated terms. Example:
term1 term2 term3

Do not include explanations, just the terms.
</output_format>`;
}
