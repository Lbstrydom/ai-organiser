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
