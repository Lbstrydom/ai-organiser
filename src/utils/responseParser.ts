/**
 * Response Parser
 * Parses LLM responses, extracting JSON when present or falling back to plain text
 */

import { StructuredSummaryResponse } from '../services/prompts/structuredPrompts';
import { SUMMARY_HOOK_MAX_LENGTH } from '../core/constants';

// ── Generic JSON extraction (used by canvas boards, structured responses, etc.) ──

/** Attempt direct JSON.parse on trimmed text. Returns parsed value or null. */
export function tryParseJson(text: string): unknown {
    try {
        return JSON.parse(text.trim());
    } catch {
        return null;
    }
}

/** Extract JSON from a markdown code fence (```json ... ```). */
export function tryParseJsonFromFence(text: string): unknown {
    const regex = /```(?:json)?\s*\n([\s\S]*?)\n```/gi;
    const match = regex.exec(text);
    if (!match) return null;
    return tryParseJson(match[1]);
}

/** Find the first JSON object ({...}) embedded in surrounding text. */
export function tryParseJsonFromObject(text: string): unknown {
    const regex = /\{[\s\S]*\}/g;
    const match = regex.exec(text);
    if (!match) return null;
    return tryParseJson(match[0]);
}

/** Try all three JSON extraction strategies in order. Returns parsed value or null. */
export function tryExtractJson(text: string): unknown {
    if (!text?.trim()) return null;
    return tryParseJson(text) ?? tryParseJsonFromFence(text) ?? tryParseJsonFromObject(text);
}

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
 * Also sanitizes body_content and summary_hook
 */
function isValidStructuredResponse(obj: any): obj is StructuredSummaryResponse {
    const VALID_CONTENT_TYPES = ['note', 'research', 'meeting', 'project', 'reference'];

    // Only require the two essential string fields
    const hasRequiredFields = (
        obj &&
        typeof obj === 'object' &&
        typeof obj.summary_hook === 'string' &&
        typeof obj.body_content === 'string'
    );

    if (!hasRequiredFields) return false;

    // Coerce missing/invalid optional fields to safe defaults instead of rejecting
    if (!Array.isArray(obj.suggested_tags)) {
        obj.suggested_tags = [];
    }
    if (typeof obj.content_type !== 'string' || !VALID_CONTENT_TYPES.includes(obj.content_type)) {
        obj.content_type = 'note';
    }

    // Sanitize content
    obj.summary_hook = sanitizeSummaryHookContent(obj.summary_hook);
    obj.body_content = sanitizeBodyContent(obj.body_content);

    return true;
}

/**
 * Sanitize summary hook by removing headings, links, and other markdown that shouldn't be there
 */
function sanitizeSummaryHookContent(hook: string): string {
    if (!hook) return hook;

    let sanitized = hook;

    // Remove any ## heading markers and their content that follows
    // e.g., "Summary text. ## Heading Title" -> "Summary text."
    sanitized = sanitized.replaceAll(/\s*##\s+[^\n]+/g, '');

    // Remove markdown links [text](url) - replace with just the text
    sanitized = sanitized.replaceAll(/\[([^\]]*)\]\([^)]+\)/g, '$1');

    // Remove bare URLs
    sanitized = sanitized.replaceAll(/https?:\/\/[^\s]+/g, '');

    // Clean up extra whitespace and punctuation issues
    sanitized = sanitized.replaceAll(/\s{2,}/g, ' ').trim();

    // Ensure it ends cleanly (not with dangling punctuation)
    sanitized = sanitized.replaceAll(/[,\s]+$/g, '').trim();

    // Truncate to SUMMARY_HOOK_MAX_LENGTH chars if needed (reserve 3 for ellipsis)
    if (sanitized.length > SUMMARY_HOOK_MAX_LENGTH) {
        sanitized = sanitized.substring(0, SUMMARY_HOOK_MAX_LENGTH - 3).trim() + '...';
    }

    return sanitized;
}

/**
 * Sanitize body content by removing leading source links
 * Some LLMs add the source URL as a link at the start despite instructions not to
 */
function sanitizeBodyContent(content: string): string {
    if (!content) return content;

    // Pattern: Leading markdown link followed by heading or newline
    // e.g., "[Title](https://example.com) ## Heading" or "[Title](url)\n## Heading"
    const leadingLinkPattern = /^\s*\[[^\]]*\]\(https?:\/\/[^)]+\)\s*/;

    // Remove leading link if present
    let sanitized = content.replace(leadingLinkPattern, '');

    // Also handle case where link is on its own line at the start
    sanitized = sanitized.replace(/^\s*\[[^\]]*\]\(https?:\/\/[^)]+\)\s*\n+/, '');

    return sanitized.trim();
}

/**
 * Create a fallback structured response from plain text
 */
function createFallbackResponse(text: string): StructuredSummaryResponse {
    // Extract first SUMMARY_HOOK_MAX_LENGTH chars as hook (reserve 3 for ellipsis)
    const hook = text.length <= SUMMARY_HOOK_MAX_LENGTH 
        ? text 
        : text.substring(0, SUMMARY_HOOK_MAX_LENGTH - 3).trim() + '...';
    
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
export function sanitizeSummaryHook(hook: string, maxLength: number = SUMMARY_HOOK_MAX_LENGTH): string {
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
