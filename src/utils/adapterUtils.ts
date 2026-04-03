import type { ContentPart } from '../services/adapters/types';

/**
 * Extract text from ContentPart array
 * For text-only providers, extracts and concatenates all text parts
 * @param content - String or ContentPart array
 * @returns Concatenated text content
 */
export function extractTextFromParts(content: string | ContentPart[]): string {
    if (typeof content === 'string') return content;
    
    return content
        .filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text')
        .map(p => p.text)
        .join('\n');
}
