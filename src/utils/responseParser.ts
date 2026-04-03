/**
 * Response Parser
 * Parses LLM responses, extracting JSON when present or falling back to plain text
 */

import { StructuredSummaryResponse } from '../services/prompts/structuredPrompts';
import { STUDY_COMPANION_DELIMITER } from '../services/prompts/summaryPrompts';
import { SUMMARY_HOOK_MAX_LENGTH } from '../core/constants';
import { truncateAtBoundary } from '../services/tokenLimits';

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

/** Try JSON extraction strategies in order: direct → fence → object → repair newlines. */
export function tryExtractJson(text: string): unknown {
    if (!text?.trim()) return null;
    const result = tryParseJson(text) ?? tryParseJsonFromFence(text) ?? tryParseJsonFromObject(text);
    if (result !== null) return result;
    // Repair literal newlines/tabs inside JSON strings (common LLM failure) and retry
    const repaired = repairJsonStrings(text);
    if (repaired === text) return null;
    return tryParseJson(repaired) ?? tryParseJsonFromFence(repaired) ?? tryParseJsonFromObject(repaired);
}

/**
 * Repair literal newlines, tabs, and carriage returns inside JSON string values.
 * LLMs commonly output JSON with unescaped newlines in multi-line strings like
 * body_content, which is invalid JSON. This walks the text character-by-character,
 * tracking string context, and escapes only the characters inside strings.
 */
export function repairJsonStrings(text: string): string {
    let result = '';
    let inString = false;
    let escape = false;
    for (const ch of text) {
        if (escape) { result += ch; escape = false; continue; }
        if (ch === '\\' && inString) { result += ch; escape = true; continue; }
        if (ch === '"') { inString = !inString; result += ch; continue; }
        if (inString) {
            if (ch === '\n') { result += String.raw`\n`; continue; }
            if (ch === '\r') { result += String.raw`\r`; continue; }
            if (ch === '\t') { result += String.raw`\t`; continue; }
        }
        result += ch;
    }
    return result;
}

// ── Structured response parsing helpers ──

function tryParseStructured(text: string): StructuredSummaryResponse | null {
    try {
        const parsed = JSON.parse(text);
        return isValidStructuredResponse(parsed) ? parsed : null;
    } catch { return null; }
}

function tryParseStructuredFromFence(text: string): StructuredSummaryResponse | null {
    // Non-greedy match — works when body_content has no inner code fences
    const m = /```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```/.exec(text);
    if (!m) return null;
    return tryParseStructured(m[1].trim());
}

/** Greedy fence: matches from opening ``` to the LAST closing ```. 
 *  Handles body_content that contains inner code fences. */
function tryParseStructuredFromFenceGreedy(text: string): StructuredSummaryResponse | null {
    const m = /```(?:json)?\s*\r?\n([\s\S]*)\r?\n```/.exec(text);
    if (!m) return null;
    return tryParseStructured(m[1].trim());
}

function tryParseStructuredFromObject(text: string): StructuredSummaryResponse | null {
    const m = /\{[\s\S]*\}/.exec(text);
    if (!m) return null;
    return tryParseStructured(m[0]);
}

function tryParseStructuredRepaired(text: string): StructuredSummaryResponse | null {
    const repaired = repairJsonStrings(text);
    if (repaired === text) return null;
    return tryParseStructured(repaired.trim())
        ?? tryParseStructuredFromFence(repaired)
        ?? tryParseStructuredFromFenceGreedy(repaired)
        ?? tryParseStructuredFromObject(repaired);
}

/**
 * Last-resort field extraction: pull body_content from malformed JSON
 * by walking the string value character-by-character.
 * Works even when JSON.parse fails due to unescaped quotes or other issues.
 */
function tryExtractStructuredFields(text: string): StructuredSummaryResponse | null {
    const bodyContent = extractJsonStringValue(text, 'body_content');
    const summaryHook = extractJsonStringValue(text, 'summary_hook');
    if (!bodyContent || !summaryHook) return null;

    // Try to get optional fields
    let suggestedTags: string[] = [];
    const tagsMatch = /"suggested_tags"\s*:\s*\[([^\]]*)\]/.exec(text);
    if (tagsMatch) {
        suggestedTags = tagsMatch[1]
            .split(',')
            .map(t => t.trim().replace(/^"|"$/g, ''))
            .filter(t => t.length > 0);
    }

    let contentType: string = 'note';
    const typeMatch = /"content_type"\s*:\s*"([^"]+)"/.exec(text);
    if (typeMatch) contentType = typeMatch[1];

    const result = {
        summary_hook: summaryHook,
        body_content: bodyContent,
        suggested_tags: suggestedTags,
        content_type: contentType as any,
    };

    return isValidStructuredResponse(result) ? result : null;
}

/**
 * Extract a JSON string value by walking char-by-char from the key.
 * Handles escaped characters (\" \n \t etc.) correctly.
 */
function extractJsonStringValue(text: string, key: string): string | null {
    const keyPattern = new RegExp(`"${key}"\\s*:\\s*"`);
    const keyMatch = keyPattern.exec(text);
    if (!keyMatch) return null;

    const valueStart = keyMatch.index + keyMatch[0].length;
    let result = '';
    let escape = false;

    for (let i = valueStart; i < text.length; i++) {
        const ch = text[i];
        if (escape) {
            // Handle JSON escape sequences
            switch (ch) {
                case 'n': result += '\n'; break;
                case 'r': result += '\r'; break;
                case 't': result += '\t'; break;
                case '"': result += '"'; break;
                case '\\': result += '\\'; break;
                case '/': result += '/'; break;
                default: result += ch; break;
            }
            escape = false;
            continue;
        }
        if (ch === '\\') { escape = true; continue; }
        if (ch === '"') {
            // End of string value
            return result;
        }
        // Accept literal newlines (common LLM error) — convert to actual newlines
        result += ch;
    }
    return null; // Unterminated string
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
    
    // Try strategies in order:
    // 1. Direct JSON.parse
    // 2. Non-greedy fence extraction
    // 3. Greedy fence extraction (handles inner code fences)
    // 4. Object extraction {…}
    // 5. Repair literal newlines + retry all above
    // 6. Field-level extraction (handles broken JSON)
    // 7. Fallback to plain text
    return tryParseStructured(response.trim())
        ?? tryParseStructuredFromFence(response)
        ?? tryParseStructuredFromFenceGreedy(response)
        ?? tryParseStructuredFromObject(response)
        ?? tryParseStructuredRepaired(response)
        ?? tryExtractStructuredFields(response)
        ?? createFallbackResponse(response);
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

    // Pass through companion_content if present and valid; strip if wrong type
    if ('companion_content' in obj && typeof obj.companion_content !== 'string') {
        delete obj.companion_content;
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
 * Split a traditional (non-JSON) LLM response into main summary and optional companion content.
 * The companion section, if present, follows the STUDY_COMPANION_DELIMITER on its own line.
 * Returns { summary, companion } where companion is undefined when not present.
 *
 * Empty strings return `{ summary: '' }` (no companion). The falsy guard is defensive
 * only — callers should always pass a string.
 */
export function splitCompanionContent(text: string): { summary: string; companion?: string } {
    if (!text) return { summary: '' };

    const idx = text.indexOf(STUDY_COMPANION_DELIMITER);
    if (idx === -1) return { summary: text };

    const summary = text.substring(0, idx).trimEnd();
    const companion = text.substring(idx + STUDY_COMPANION_DELIMITER.length).trim();

    return {
        summary,
        companion: companion.length > 0 ? companion : undefined,
    };
}

/**
 * Validate and sanitize summary hook length.
 * Delegates to truncateAtBoundary for consistent boundary-aware truncation.
 */
export function sanitizeSummaryHook(hook: string, maxLength: number = SUMMARY_HOOK_MAX_LENGTH): string {
    if (!hook?.trim()) return '';
    // Run content sanitization first (strip markdown, URLs, etc.)
    const cleaned = sanitizeSummaryHookContent(hook);
    if (cleaned.length <= maxLength) return cleaned;
    return truncateAtBoundary(cleaned, maxLength, '...');
}
