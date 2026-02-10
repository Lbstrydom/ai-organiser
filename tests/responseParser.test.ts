/**
 * Response Parser Tests
 * Tests for JSON extraction, 4-tier fallback logic, and content sanitization
 *
 * These tests verify the parsing logic that handles various LLM response formats
 */

import { parseStructuredResponse, sanitizeSummaryHook, extractPlainText, tryParseJson, tryParseJsonFromFence, tryParseJsonFromObject, tryExtractJson, splitCompanionContent } from '../src/utils/responseParser';
import { SUMMARY_HOOK_MAX_LENGTH } from '../src/core/constants';
import { STUDY_COMPANION_DELIMITER } from '../src/services/prompts/summaryPrompts';

describe('Response Parser - parseStructuredResponse', () => {

    describe('Tier 1: Direct JSON Parse', () => {
        it('should parse valid direct JSON', () => {
            const response = JSON.stringify({
                summary_hook: 'A brief summary',
                body_content: 'Full content here',
                suggested_tags: ['tag1', 'tag2'],
                content_type: 'note',
                detected_language: 'en'
            });

            const result = parseStructuredResponse(response);

            expect(result).not.toBeNull();
            expect(result?.summary_hook).toBe('A brief summary');
            expect(result?.body_content).toBe('Full content here');
            expect(result?.suggested_tags).toEqual(['tag1', 'tag2']);
            expect(result?.content_type).toBe('note');
        });

        it('should parse JSON with extra whitespace', () => {
            const response = `
            {
                "summary_hook": "Summary",
                "body_content": "Content",
                "suggested_tags": [],
                "content_type": "note",
                "detected_language": "en"
            }
            `;

            const result = parseStructuredResponse(response);

            expect(result).not.toBeNull();
            expect(result?.summary_hook).toBe('Summary');
        });

        it('should reject invalid content_type', () => {
            const response = JSON.stringify({
                summary_hook: 'Summary',
                body_content: 'Content',
                suggested_tags: [],
                content_type: 'invalid_type', // Not in allowed list
                detected_language: 'en'
            });

            // Should fall through to fallback since content_type is invalid
            const result = parseStructuredResponse(response);
            // Fallback will infer type from content
            expect(result?.content_type).toBe('note');
        });
    });

    describe('Tier 2: Markdown Code Fence Extraction', () => {
        it('should extract JSON from ```json code fence', () => {
            const response = `Here's the structured response:

\`\`\`json
{
    "summary_hook": "Code fence summary",
    "body_content": "Code fence content",
    "suggested_tags": ["extracted"],
    "content_type": "research",
    "detected_language": "en"
}
\`\`\`

Additional commentary here.`;

            const result = parseStructuredResponse(response);

            expect(result).not.toBeNull();
            expect(result?.summary_hook).toBe('Code fence summary');
            expect(result?.content_type).toBe('research');
        });

        it('should extract JSON from ``` code fence (no language tag)', () => {
            const response = `Response:

\`\`\`
{
    "summary_hook": "No lang tag",
    "body_content": "Content",
    "suggested_tags": [],
    "content_type": "meeting",
    "detected_language": "en"
}
\`\`\``;

            const result = parseStructuredResponse(response);

            expect(result).not.toBeNull();
            expect(result?.content_type).toBe('meeting');
        });
    });

    describe('Tier 3: JSON Object Search', () => {
        it('should find JSON object embedded in text', () => {
            const response = `I'll provide the summary in JSON format:

{"summary_hook":"Embedded JSON","body_content":"Found in text","suggested_tags":["found"],"content_type":"project","detected_language":"en"}

Hope this helps!`;

            const result = parseStructuredResponse(response);

            expect(result).not.toBeNull();
            expect(result?.summary_hook).toBe('Embedded JSON');
            expect(result?.content_type).toBe('project');
        });

        it('should handle JSON with newlines embedded in text', () => {
            const response = `Result: {
                "summary_hook": "Multi-line",
                "body_content": "Content here",
                "suggested_tags": [],
                "content_type": "reference",
                "detected_language": "en"
            } That's all.`;

            const result = parseStructuredResponse(response);

            expect(result).not.toBeNull();
            expect(result?.content_type).toBe('reference');
        });
    });

    describe('Tier 4: Fallback to Plain Text', () => {
        it('should create fallback from plain text', () => {
            const response = 'This is just plain text without any JSON structure.';

            const result = parseStructuredResponse(response);

            expect(result).not.toBeNull();
            expect(result?.body_content).toBe(response);
            expect(result?.summary_hook).toBe(response);
            expect(result?.content_type).toBe('note');
            expect(result?.suggested_tags).toContain('summary');
        });

        it('should extract hashtags as suggested_tags', () => {
            const response = 'This note is about #programming and #testing with #vitest framework.';

            const result = parseStructuredResponse(response);

            expect(result?.suggested_tags).toContain('programming');
            expect(result?.suggested_tags).toContain('testing');
            expect(result?.suggested_tags).toContain('vitest');
        });

        it('should limit extracted tags to 5', () => {
            const response = '#tag1 #tag2 #tag3 #tag4 #tag5 #tag6 #tag7 content here';

            const result = parseStructuredResponse(response);

            expect(result?.suggested_tags.length).toBeLessThanOrEqual(5);
        });

        it('should truncate long text for summary_hook', () => {
            const longText = 'A'.repeat(300);

            const result = parseStructuredResponse(longText);

            expect(result?.summary_hook.length).toBeLessThanOrEqual(SUMMARY_HOOK_MAX_LENGTH);
            expect(result?.summary_hook).toContain('...');
        });

        it('should infer content_type from keywords', () => {
            expect(parseStructuredResponse('This is research about AI')?.content_type).toBe('research');
            expect(parseStructuredResponse('Meeting notes from today')?.content_type).toBe('meeting');
            expect(parseStructuredResponse('Project roadmap for Q1')?.content_type).toBe('project');
            expect(parseStructuredResponse('Reference documentation')?.content_type).toBe('reference');
            expect(parseStructuredResponse('Just some general notes')?.content_type).toBe('note');
        });
    });

    describe('Edge Cases', () => {
        it('should return null for empty string', () => {
            expect(parseStructuredResponse('')).toBeNull();
        });

        it('should return null for whitespace-only string', () => {
            expect(parseStructuredResponse('   \n\t  ')).toBeNull();
        });

        it('should handle malformed JSON gracefully', () => {
            const response = '{ "summary_hook": "broken JSON';

            const result = parseStructuredResponse(response);

            // Should fallback to plain text
            expect(result).not.toBeNull();
            expect(result?.body_content).toContain('broken JSON');
        });

        it('should handle JSON missing required fields', () => {
            const response = JSON.stringify({
                summary_hook: 'Only partial',
                // Missing body_content, suggested_tags, content_type
            });

            const result = parseStructuredResponse(response);

            // Should fallback since validation fails (no body_content)
            expect(result).not.toBeNull();
            expect(result?.content_type).toBe('note'); // Fallback default
        });

        it('should coerce unknown content_type to note instead of rejecting', () => {
            const response = JSON.stringify({
                summary_hook: 'A summary',
                body_content: '## Real markdown content\n\nWith paragraphs.',
                suggested_tags: ['ai'],
                content_type: 'article' // Not in allowed list
            });

            const result = parseStructuredResponse(response);

            // Should extract body_content, NOT insert raw JSON
            expect(result).not.toBeNull();
            expect(result?.body_content).toContain('## Real markdown content');
            expect(result?.body_content).not.toContain('"summary_hook"');
            expect(result?.content_type).toBe('note'); // Coerced to default
        });

        it('should coerce missing suggested_tags to empty array', () => {
            const response = JSON.stringify({
                summary_hook: 'A summary',
                body_content: 'Content here',
                content_type: 'research'
                // No suggested_tags
            });

            const result = parseStructuredResponse(response);

            expect(result).not.toBeNull();
            expect(result?.body_content).toBe('Content here');
            expect(result?.suggested_tags).toEqual([]);
            expect(result?.content_type).toBe('research');
        });

        it('should never insert raw JSON as body_content when JSON has summary_hook and body_content', () => {
            // Regression test: LLM returns valid JSON but with unexpected content_type
            const response = JSON.stringify({
                summary_hook: 'Master AI specs',
                body_content: '## The Deep Dive\n\nDetailed analysis of spec writing.',
                suggested_tags: 'not-an-array', // Wrong type
                content_type: 'tutorial', // Not in allowed list
                detected_language: 'en'
            });

            const result = parseStructuredResponse(response);

            expect(result).not.toBeNull();
            // Must extract markdown body, not insert raw JSON
            expect(result?.body_content).toContain('## The Deep Dive');
            expect(result?.body_content).not.toContain('"summary_hook"');
            expect(result?.body_content).not.toContain('"body_content"');
            expect(result?.suggested_tags).toEqual([]); // Coerced
            expect(result?.content_type).toBe('note'); // Coerced
        });
    });
});

describe('Response Parser - Summary Hook Sanitization', () => {

    describe('sanitizeSummaryHook', () => {
        it('should return short hooks unchanged', () => {
            const hook = 'A short summary hook.';
            expect(sanitizeSummaryHook(hook)).toBe(hook);
        });

        it('should truncate at word boundary for long hooks', () => {
            const hook = 'This is a very long summary hook that needs to be truncated because it exceeds the maximum allowed length of ' + SUMMARY_HOOK_MAX_LENGTH + ' characters and we want to cut it at a word boundary rather than in the middle of a word which would look ugly and unprofessional in the UI display area.';

            const result = sanitizeSummaryHook(hook, 100);

            expect(result.length).toBeLessThanOrEqual(100);
            expect(result.endsWith('...')).toBe(true);
            expect(result).not.toMatch(/\s\.\.\.$/); // Should not have space before ...
        });

        it('should handle empty string', () => {
            expect(sanitizeSummaryHook('')).toBe('');
        });

        it('should handle string exactly at max length', () => {
            const hook = 'A'.repeat(SUMMARY_HOOK_MAX_LENGTH);
            expect(sanitizeSummaryHook(hook)).toBe(hook);
        });

        it('should handle string one char over max length', () => {
            const hook = 'A'.repeat(SUMMARY_HOOK_MAX_LENGTH + 1);
            const result = sanitizeSummaryHook(hook);
            expect(result.length).toBeLessThanOrEqual(SUMMARY_HOOK_MAX_LENGTH);
            expect(result).toContain('...');
        });

        it('should use custom max length', () => {
            const hook = 'This is a test summary that exceeds fifty characters.';
            const result = sanitizeSummaryHook(hook, 50);
            expect(result.length).toBeLessThanOrEqual(50);
        });
    });

    describe('Internal sanitizeSummaryHookContent (tested via parseStructuredResponse)', () => {
        it('should remove ## headings from summary_hook', () => {
            const response = JSON.stringify({
                summary_hook: 'Summary text. ## Heading Title More text',
                body_content: 'Content',
                suggested_tags: [],
                content_type: 'note',
                detected_language: 'en'
            });

            const result = parseStructuredResponse(response);

            expect(result?.summary_hook).not.toContain('##');
            expect(result?.summary_hook).not.toContain('Heading Title');
        });

        it('should remove markdown links from summary_hook', () => {
            const response = JSON.stringify({
                summary_hook: 'Check out [this link](https://example.com) for more.',
                body_content: 'Content',
                suggested_tags: [],
                content_type: 'note',
                detected_language: 'en'
            });

            const result = parseStructuredResponse(response);

            expect(result?.summary_hook).toBe('Check out this link for more.');
            expect(result?.summary_hook).not.toContain('[');
            expect(result?.summary_hook).not.toContain('https://');
        });

        it('should remove bare URLs from summary_hook', () => {
            const response = JSON.stringify({
                summary_hook: 'Visit https://example.com/page for details.',
                body_content: 'Content',
                suggested_tags: [],
                content_type: 'note',
                detected_language: 'en'
            });

            const result = parseStructuredResponse(response);

            expect(result?.summary_hook).not.toContain('https://');
        });

        it('should clean up extra whitespace', () => {
            const response = JSON.stringify({
                summary_hook: 'Text with   multiple   spaces.',
                body_content: 'Content',
                suggested_tags: [],
                content_type: 'note',
                detected_language: 'en'
            });

            const result = parseStructuredResponse(response);

            expect(result?.summary_hook).toBe('Text with multiple spaces.');
        });

        it('should remove trailing punctuation issues', () => {
            const response = JSON.stringify({
                summary_hook: 'Summary text, ',
                body_content: 'Content',
                suggested_tags: [],
                content_type: 'note',
                detected_language: 'en'
            });

            const result = parseStructuredResponse(response);

            expect(result?.summary_hook).toBe('Summary text');
        });
    });

    describe('Internal sanitizeBodyContent (tested via parseStructuredResponse)', () => {
        it('should remove leading markdown link', () => {
            const response = JSON.stringify({
                summary_hook: 'Summary',
                body_content: '[Source](https://example.com) ## Main Content\n\nBody text here.',
                suggested_tags: [],
                content_type: 'note',
                detected_language: 'en'
            });

            const result = parseStructuredResponse(response);

            expect(result?.body_content).not.toMatch(/^\[Source\]/);
            expect(result?.body_content).toContain('## Main Content');
        });

        it('should remove link on its own line at start', () => {
            const response = JSON.stringify({
                summary_hook: 'Summary',
                body_content: '[Article Title](https://example.com/article)\n\n## Heading\n\nContent.',
                suggested_tags: [],
                content_type: 'note',
                detected_language: 'en'
            });

            const result = parseStructuredResponse(response);

            expect(result?.body_content).toMatch(/^## Heading/);
        });

        it('should preserve internal links', () => {
            const response = JSON.stringify({
                summary_hook: 'Summary',
                body_content: '## Content\n\nSee [this page](https://example.com) for details.',
                suggested_tags: [],
                content_type: 'note',
                detected_language: 'en'
            });

            const result = parseStructuredResponse(response);

            expect(result?.body_content).toContain('[this page](https://example.com)');
        });
    });
});

describe('Response Parser - extractPlainText', () => {
    it('should extract body_content from structured response', () => {
        const response = {
            summary_hook: 'Hook',
            body_content: 'The main content here',
            suggested_tags: ['tag'],
            content_type: 'note' as const,
            detected_language: 'en'
        };

        expect(extractPlainText(response)).toBe('The main content here');
    });
});

describe('Response Parser - Content Type Validation', () => {
    const validTypes = ['note', 'research', 'meeting', 'project', 'reference'];

    it.each(validTypes)('should accept content_type "%s"', (type) => {
        const response = JSON.stringify({
            summary_hook: 'Summary',
            body_content: 'Content',
            suggested_tags: [],
            content_type: type,
            detected_language: 'en'
        });

        const result = parseStructuredResponse(response);

        expect(result?.content_type).toBe(type);
    });

    it('should reject unknown content_type and fallback', () => {
        const response = JSON.stringify({
            summary_hook: 'Summary',
            body_content: 'Content',
            suggested_tags: [],
            content_type: 'blog_post', // Invalid
            detected_language: 'en'
        });

        const result = parseStructuredResponse(response);

        // Falls back to inference from content
        expect(validTypes).toContain(result?.content_type);
    });
});

describe('Response Parser - Real-world LLM Response Patterns', () => {
    it('should handle Claude-style verbose response', () => {
        const response = `I'll analyze this content and provide a structured summary.

\`\`\`json
{
    "summary_hook": "Key findings from the quarterly report",
    "body_content": "## Overview\\n\\nThe report shows significant growth.",
    "suggested_tags": ["quarterly-report", "analysis"],
    "content_type": "research",
    "detected_language": "en"
}
\`\`\`

Let me know if you need any clarification!`;

        const result = parseStructuredResponse(response);

        expect(result?.summary_hook).toBe('Key findings from the quarterly report');
        expect(result?.content_type).toBe('research');
    });

    it('should handle GPT-style compact response', () => {
        const response = '{"summary_hook":"Quick summary","body_content":"Content here","suggested_tags":["gpt"],"content_type":"note","detected_language":"en"}';

        const result = parseStructuredResponse(response);

        expect(result?.summary_hook).toBe('Quick summary');
    });

    it('should handle response with preamble text', () => {
        const response = `Based on my analysis, here is the structured output:

{
    "summary_hook": "Analysis results",
    "body_content": "Detailed analysis...",
    "suggested_tags": ["analysis"],
    "content_type": "research",
    "detected_language": "en"
}`;

        const result = parseStructuredResponse(response);

        expect(result?.summary_hook).toBe('Analysis results');
    });
});

describe('Response Parser - Generic JSON Extraction', () => {
    describe('tryParseJson', () => {
        it('should parse valid JSON', () => {
            expect(tryParseJson('{"key": "value"}')).toEqual({ key: 'value' });
        });

        it('should parse JSON with surrounding whitespace', () => {
            expect(tryParseJson('  {"a": 1}  ')).toEqual({ a: 1 });
        });

        it('should return null for invalid JSON', () => {
            expect(tryParseJson('not json')).toBeNull();
        });

        it('should return null for empty string', () => {
            expect(tryParseJson('')).toBeNull();
        });

        it('should parse arrays', () => {
            expect(tryParseJson('[1, 2, 3]')).toEqual([1, 2, 3]);
        });
    });

    describe('tryParseJsonFromFence', () => {
        it('should extract JSON from ```json fence', () => {
            const text = 'Here is the result:\n```json\n{"labels": [1]}\n```\nDone.';
            expect(tryParseJsonFromFence(text)).toEqual({ labels: [1] });
        });

        it('should extract JSON from ``` fence without language tag', () => {
            const text = '```\n{"key": "val"}\n```';
            expect(tryParseJsonFromFence(text)).toEqual({ key: 'val' });
        });

        it('should return null when no fence present', () => {
            expect(tryParseJsonFromFence('just plain text')).toBeNull();
        });

        it('should return null when fence contains invalid JSON', () => {
            expect(tryParseJsonFromFence('```json\nnot json\n```')).toBeNull();
        });
    });

    describe('tryParseJsonFromObject', () => {
        it('should find JSON object in surrounding text', () => {
            const text = 'Result: {"a": 1} end';
            expect(tryParseJsonFromObject(text)).toEqual({ a: 1 });
        });

        it('should return null when no braces present', () => {
            expect(tryParseJsonFromObject('no json here')).toBeNull();
        });

        it('should return null when braces contain invalid JSON', () => {
            expect(tryParseJsonFromObject('prefix {broken json} suffix')).toBeNull();
        });
    });

    describe('tryExtractJson', () => {
        it('should try direct parse first', () => {
            expect(tryExtractJson('{"direct": true}')).toEqual({ direct: true });
        });

        it('should fall back to code fence', () => {
            const text = 'prefix\n```json\n{"fenced": true}\n```\nsuffix';
            expect(tryExtractJson(text)).toEqual({ fenced: true });
        });

        it('should fall back to object search', () => {
            const text = 'The result is {"embedded": true} here';
            expect(tryExtractJson(text)).toEqual({ embedded: true });
        });

        it('should return null for empty/whitespace input', () => {
            expect(tryExtractJson('')).toBeNull();
            expect(tryExtractJson('   ')).toBeNull();
        });

        it('should return null when nothing works', () => {
            expect(tryExtractJson('completely plain text')).toBeNull();
        });
    });
});

describe('Response Parser - companion_content in structured JSON', () => {
    it('should pass through companion_content when present and valid', () => {
        const response = JSON.stringify({
            summary_hook: 'Hook',
            body_content: '## Summary\n\nMain content.',
            suggested_tags: ['ai'],
            content_type: 'research',
            companion_content: 'Think of it like cooking a recipe...',
        });

        const result = parseStructuredResponse(response);

        expect(result).not.toBeNull();
        expect(result?.companion_content).toBe('Think of it like cooking a recipe...');
        expect(result?.body_content).toContain('## Summary');
    });

    it('should parse normally when companion_content is absent', () => {
        const response = JSON.stringify({
            summary_hook: 'Hook',
            body_content: 'Content',
            suggested_tags: ['tag'],
            content_type: 'note',
        });

        const result = parseStructuredResponse(response);

        expect(result).not.toBeNull();
        expect(result?.companion_content).toBeUndefined();
        expect(result?.body_content).toBe('Content');
    });

    it('should strip companion_content when it is not a string', () => {
        const response = JSON.stringify({
            summary_hook: 'Hook',
            body_content: 'Content',
            suggested_tags: [],
            content_type: 'note',
            companion_content: 42,
        });

        const result = parseStructuredResponse(response);

        expect(result).not.toBeNull();
        expect(result?.companion_content).toBeUndefined();
    });

    it('should pass through companion_content from code fence JSON', () => {
        const response = `Here is the result:

\`\`\`json
{
    "summary_hook": "Fenced hook",
    "body_content": "Fenced body",
    "suggested_tags": ["test"],
    "content_type": "note",
    "companion_content": "Imagine you're explaining to a friend..."
}
\`\`\``;

        const result = parseStructuredResponse(response);

        expect(result?.companion_content).toBe("Imagine you're explaining to a friend...");
    });

    it('should pass through empty string companion_content', () => {
        const response = JSON.stringify({
            summary_hook: 'Hook',
            body_content: 'Content',
            suggested_tags: [],
            content_type: 'note',
            companion_content: '',
        });

        const result = parseStructuredResponse(response);

        // Empty string is a valid string — passed through
        expect(result?.companion_content).toBe('');
    });
});

describe('Response Parser - splitCompanionContent', () => {
    it('should return summary only when no delimiter present', () => {
        const text = '## Summary\n\nMain content here.';
        const result = splitCompanionContent(text);

        expect(result.summary).toBe(text);
        expect(result.companion).toBeUndefined();
    });

    it('should split on delimiter into summary and companion', () => {
        const main = '## Summary\n\nKey points about the topic.';
        const companion = '## Explain Like a Friend\n\nThink of it like building blocks...';
        const text = `${main}\n${STUDY_COMPANION_DELIMITER}\n${companion}`;

        const result = splitCompanionContent(text);

        expect(result.summary).toBe(main);
        expect(result.companion).toBe(companion);
    });

    it('should return undefined companion when delimiter is at the end with no content after', () => {
        const text = `## Summary\n\nContent.\n${STUDY_COMPANION_DELIMITER}\n`;

        const result = splitCompanionContent(text);

        expect(result.summary).toBe('## Summary\n\nContent.');
        expect(result.companion).toBeUndefined();
    });

    it('should handle delimiter with extra whitespace around it', () => {
        const text = `Main summary text.\n\n${STUDY_COMPANION_DELIMITER}\n\nCompanion text here.`;

        const result = splitCompanionContent(text);

        expect(result.summary).toBe('Main summary text.');
        expect(result.companion).toBe('Companion text here.');
    });

    it('should handle empty string input', () => {
        const result = splitCompanionContent('');
        expect(result.summary).toBe('');
        expect(result.companion).toBeUndefined();
    });

    it('should only split on first occurrence of delimiter', () => {
        const text = `Part 1\n${STUDY_COMPANION_DELIMITER}\nPart 2\n${STUDY_COMPANION_DELIMITER}\nPart 3`;

        const result = splitCompanionContent(text);

        expect(result.summary).toBe('Part 1');
        expect(result.companion).toContain('Part 2');
        expect(result.companion).toContain('Part 3');
    });
});
