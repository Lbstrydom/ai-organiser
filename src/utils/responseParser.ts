/**
 * Response Parser
 * Parses LLM responses, extracting JSON when present or falling back to plain text
 */

import { StructuredSummaryResponse } from '../services/prompts/structuredPrompts';

/**
 * Parse LLM response attempting to extract structured JSON
 * Falls back gracefully to plain text if JSON not found
 */
export function parseStructuredResponse(
    response: string
): StructuredSummaryResponse | null {
    if (!response || response.trim().length === 0) {
        return null;
    }
    
    // Try 1: Direct JSON parse
    try {
        const parsed = JSON.parse(response.trim());
        if (isValidStructuredResponse(parsed)) {
            return parsed;
        }
    } catch {
        // Not direct JSON, continue to other methods
    }
    
    // Try 2: Extract from markdown code fence
    const codeFenceMatch = response.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
    if (codeFenceMatch) {
        try {
            const parsed = JSON.parse(codeFenceMatch[1].trim());
            if (isValidStructuredResponse(parsed)) {
                return parsed;
            }
        } catch {
            // Invalid JSON in code fence
        }
    }
    
    // Try 3: Find JSON object in response
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
        try {
            const parsed = JSON.parse(jsonMatch[0]);
            if (isValidStructuredResponse(parsed)) {
                return parsed;
            }
        } catch {
            // Invalid JSON object
        }
    }
    
    // Try 4: Fallback - treat entire response as plain text body_content
    return createFallbackResponse(response);
}

/**
 * Validate that parsed JSON has required structure
 */
function isValidStructuredResponse(obj: any): obj is StructuredSummaryResponse {
    return (
        obj &&
        typeof obj === 'object' &&
        typeof obj.summary_hook === 'string' &&
        typeof obj.body_content === 'string' &&
        Array.isArray(obj.suggested_tags) &&
        typeof obj.content_type === 'string' &&
        ['note', 'research', 'meeting', 'project', 'reference'].includes(obj.content_type)
    );
}

/**
 * Create a fallback structured response from plain text
 */
function createFallbackResponse(text: string): StructuredSummaryResponse {
    // Extract first 280 chars as hook
    const hook = text.length <= 280 
        ? text 
        : text.substring(0, 277).trim() + '...';
    
    // Try to extract tags from text (look for common patterns)
    const tags: string[] = [];
    const tagMatches = text.match(/#[\w-]+/g);
    if (tagMatches) {
        tags.push(...tagMatches.slice(0, 5).map(t => t.substring(1)));
    }
    
    // Default to 'note' type if not specified
    let contentType: 'note' | 'research' | 'meeting' | 'project' | 'reference' = 'note';
    
    // Try to infer type from keywords
    const lowerText = text.toLowerCase();
    if (lowerText.includes('research') || lowerText.includes('study')) {
        contentType = 'research';
    } else if (lowerText.includes('meeting') || lowerText.includes('agenda')) {
        contentType = 'meeting';
    } else if (lowerText.includes('project') || lowerText.includes('roadmap')) {
        contentType = 'project';
    } else if (lowerText.includes('reference') || lowerText.includes('documentation')) {
        contentType = 'reference';
    }
    
    return {
        summary_hook: hook,
        body_content: text,
        suggested_tags: tags.length > 0 ? tags : ['summary'],
        content_type: contentType,
        detected_language: 'en'
    };
}

/**
 * Extract plain text from structured response (for backward compatibility)
 */
export function extractPlainText(response: StructuredSummaryResponse): string {
    return response.body_content;
}

/**
 * Validate and sanitize summary hook length
 */
export function sanitizeSummaryHook(hook: string, maxLength: number = 280): string {
    if (!hook || hook.length === 0) {
        return '';
    }
    
    if (hook.length <= maxLength) {
        return hook;
    }
    
    // Truncate at word boundary
    const truncated = hook.substring(0, maxLength - 3);
    const lastSpace = truncated.lastIndexOf(' ');
    
    if (lastSpace > maxLength * 0.7) {
        return truncated.substring(0, lastSpace) + '...';
    }
    
    return truncated + '...';
}
