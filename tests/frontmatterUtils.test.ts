/**
 * Frontmatter Utilities Tests
 * Tests for summary hook creation, word counting, and language detection
 *
 * MECE Coverage:
 * - createSummaryHook: Empty, short, exact boundary, long with sentences, long without sentences
 * - countWords: Empty, with frontmatter, with code blocks, normal text
 * - detectLanguage: English, Chinese, mixed, short text
 */

import { createSummaryHook, countWords, detectLanguage } from '../src/utils/frontmatterUtils';
import { SUMMARY_HOOK_MAX_LENGTH } from '../src/core/constants';

describe('Frontmatter Utils - createSummaryHook', () => {

    describe('Empty and Short Input', () => {
        it('should return empty string for empty input', () => {
            expect(createSummaryHook('')).toBe('');
        });

        it('should return empty string for null-like input', () => {
            // @ts-expect-error - testing runtime behavior
            expect(createSummaryHook(null)).toBe('');
            // @ts-expect-error - testing runtime behavior
            expect(createSummaryHook(undefined)).toBe('');
        });

        it('should return short text unchanged', () => {
            const text = 'This is a short summary.';
            expect(createSummaryHook(text)).toBe(text);
        });

        it('should return text at exactly max length unchanged', () => {
            const text = 'A'.repeat(SUMMARY_HOOK_MAX_LENGTH);
            expect(createSummaryHook(text)).toBe(text);
        });
    });

    describe('Markdown Removal', () => {
        it('should remove header markers', () => {
            expect(createSummaryHook('## Header text')).toBe('Header text');
            expect(createSummaryHook('### Another header')).toBe('Another header');
            expect(createSummaryHook('###### Deep header')).toBe('Deep header');
        });

        it('should remove bold formatting', () => {
            expect(createSummaryHook('This is **bold** text')).toBe('This is bold text');
        });

        it('should remove italic formatting', () => {
            expect(createSummaryHook('This is *italic* text')).toBe('This is italic text');
        });

        it('should remove inline code', () => {
            expect(createSummaryHook('Use `console.log()` for debugging')).toBe('Use console.log() for debugging');
        });

        it('should convert markdown links to text', () => {
            expect(createSummaryHook('Check [this link](https://example.com) out'))
                .toBe('Check this link out');
        });

        it('should handle multiple markdown elements', () => {
            const input = '## **Bold Header** with `code` and [link](url)';
            expect(createSummaryHook(input)).toBe('Bold Header with code and link');
        });
    });

    describe('Sentence Boundary Truncation', () => {
        it('should truncate at sentence boundary when possible', () => {
            // Text must exceed 280 chars to trigger truncation
            const sentences = 'First sentence here. Second sentence here. Third sentence continues. ' +
                'Fourth sentence added. Fifth sentence written. Sixth sentence included. ' +
                'Seventh sentence present. Eighth sentence follows. Ninth sentence appears. ' +
                'Tenth sentence is here to ensure we exceed the maximum length of 280 characters.';
            const result = createSummaryHook(sentences);

            // Should end with ... and respect sentence boundary
            expect(result.endsWith('...')).toBe(true);
            expect(result.length).toBeLessThanOrEqual(SUMMARY_HOOK_MAX_LENGTH);
        });

        it('should include complete sentences that fit', () => {
            // Create text with sentences that fit
            const shortSentences = 'Short one. Another short. Third one.';
            const result = createSummaryHook(shortSentences);

            expect(result).toBe(shortSentences);
        });

        it('should handle question marks as sentence boundaries', () => {
            const text = 'Is this working? Yes it is. More text here.';
            expect(createSummaryHook(text)).toBe(text);
        });

        it('should handle exclamation marks as sentence boundaries', () => {
            const text = 'Amazing! This works. Great stuff.';
            expect(createSummaryHook(text)).toBe(text);
        });
    });

    describe('Word Boundary Truncation', () => {
        it('should truncate at word boundary when no sentence fits', () => {
            // Single very long sentence with no periods (must exceed 280 chars)
            const longSentence = 'This is a very long sentence without any periods that goes on and on and on and on and keeps going without stopping and continues for quite a while until it exceeds the maximum length allowed for the summary hook which is two hundred and eighty characters and this keeps going further to ensure we exceed that limit';
            const result = createSummaryHook(longSentence);

            expect(result.endsWith('...')).toBe(true);
            expect(result.length).toBeLessThanOrEqual(SUMMARY_HOOK_MAX_LENGTH);
            // Should end with complete word + space + ... OR complete word + ...
            // The implementation adds ... after removing the last (possibly partial) word
            // So result should end with a complete word followed by ...
            expect(result).toMatch(/\w+\.\.\.$/);
        });

        it('should handle text with no spaces', () => {
            const noSpaces = 'A'.repeat(300);
            const result = createSummaryHook(noSpaces);

            expect(result.endsWith('...')).toBe(true);
            expect(result.length).toBeLessThanOrEqual(SUMMARY_HOOK_MAX_LENGTH);
        });
    });

    describe('Edge Cases', () => {
        it('should trim whitespace', () => {
            expect(createSummaryHook('  spaced text  ')).toBe('spaced text');
        });

        it('should handle only whitespace', () => {
            expect(createSummaryHook('   \n\t   ')).toBe('');
        });

        it('should handle mixed newlines', () => {
            const text = 'Line one\nLine two\r\nLine three';
            const result = createSummaryHook(text);
            expect(result).toContain('Line one');
        });
    });
});

describe('Frontmatter Utils - countWords', () => {

    describe('Empty Input', () => {
        it('should return 0 for empty string', () => {
            expect(countWords('')).toBe(0);
        });

        it('should return 0 for whitespace only', () => {
            expect(countWords('   \n\t   ')).toBe(0);
        });

        it('should return 0 for null-like input', () => {
            // @ts-expect-error - testing runtime behavior
            expect(countWords(null)).toBe(0);
            // @ts-expect-error - testing runtime behavior
            expect(countWords(undefined)).toBe(0);
        });
    });

    describe('Basic Word Counting', () => {
        it('should count simple words', () => {
            expect(countWords('one two three')).toBe(3);
        });

        it('should handle multiple spaces', () => {
            expect(countWords('one   two    three')).toBe(3);
        });

        it('should handle newlines as word separators', () => {
            expect(countWords('one\ntwo\nthree')).toBe(3);
        });

        it('should handle tabs as word separators', () => {
            expect(countWords('one\ttwo\tthree')).toBe(3);
        });
    });

    describe('Frontmatter Removal', () => {
        it('should exclude frontmatter from word count', () => {
            const textWithFrontmatter = `---
title: Test Note
tags: [test, note]
---
These are five actual words.`;

            expect(countWords(textWithFrontmatter)).toBe(5);
        });

        it('should handle empty frontmatter', () => {
            const text = `---
---
Four words after frontmatter`;

            expect(countWords(text)).toBe(4);
        });

        it('should handle content with no frontmatter', () => {
            expect(countWords('Just regular text')).toBe(3);
        });
    });

    describe('Code Block Removal', () => {
        it('should exclude code blocks from word count', () => {
            const textWithCode = `Some text before.

\`\`\`javascript
const code = 'should not count';
function test() { return true; }
\`\`\`

Text after code.`;

            // "Some text before" (3) + "Text after code" (3) = 6
            expect(countWords(textWithCode)).toBe(6);
        });

        it('should handle multiple code blocks', () => {
            const text = `Word1

\`\`\`
block one
\`\`\`

Word2

\`\`\`python
block two
\`\`\`

Word3`;

            expect(countWords(text)).toBe(3);
        });

        it('should handle code blocks with no content', () => {
            const text = `Before

\`\`\`
\`\`\`

After`;
            expect(countWords(text)).toBe(2);
        });
    });

    describe('Mixed Content', () => {
        it('should handle frontmatter and code blocks together', () => {
            const text = `---
title: Test
---

Introduction text here.

\`\`\`
code block
\`\`\`

Conclusion words.`;

            // "Introduction text here" (3) + "Conclusion words" (2) = 5
            expect(countWords(text)).toBe(5);
        });

        it('should count real-world note content', () => {
            const realNote = `---
title: Meeting Notes
date: 2024-01-15
tags: [meeting, project]
---

# Meeting Summary

Today we discussed the project timeline. The deadline is next month.

\`\`\`
Action items:
- Review docs
- Update code
\`\`\`

## Next Steps

Schedule follow-up meeting.`;

            // Should count only prose, not frontmatter or code
            const count = countWords(realNote);
            expect(count).toBeGreaterThan(10);
            expect(count).toBeLessThan(25);
        });
    });
});

describe('Frontmatter Utils - detectLanguage', () => {

    describe('English Detection', () => {
        it('should detect English text', () => {
            const englishText = 'This is a sample English text that should be detected as English. It contains only Latin characters and common English words.';
            expect(detectLanguage(englishText)).toBe('en');
        });

        it('should detect English with numbers and punctuation', () => {
            const text = 'In 2024, the project increased by 50%! Amazing results.';
            expect(detectLanguage(text)).toBe('en');
        });
    });

    describe('CJK Detection', () => {
        it('should detect Chinese text', () => {
            // Text must exceed 50 characters total for detection (this is 60+ chars)
            const chineseText = '这是一段中文文本，用于测试语言检测功能。这个函数应该能够识别中文内容。我们需要更多字符来超过五十个字符的阈值，这样才能正确检测。';
            expect(chineseText.length).toBeGreaterThan(50);
            expect(detectLanguage(chineseText)).toBe('zh');
        });

        it('should detect Japanese text (contains CJK)', () => {
            // Text must exceed 50 characters total for detection (this is 60+ chars)
            const japaneseText = 'これは日本語のテキストです。言語検出機能をテストしています。さらにテキストを追加して五十文字を超えるようにします。';
            expect(japaneseText.length).toBeGreaterThan(50);
            expect(detectLanguage(japaneseText)).toBe('zh'); // Returns 'zh' for all CJK
        });

        it('should detect heavily CJK mixed content', () => {
            // Over 50 chars with >30% CJK ratio (this is 60+ chars)
            const mixedHeavyCJK = '这是中文内容 English 这是更多中文 还有中文 这是继续中文 更多的中文内容在这里 继续添加更多的中文文字';
            expect(mixedHeavyCJK.length).toBeGreaterThan(50);
            expect(detectLanguage(mixedHeavyCJK)).toBe('zh');
        });
    });

    describe('Edge Cases', () => {
        it('should return unknown for short text', () => {
            expect(detectLanguage('Hi')).toBe('unknown');
            expect(detectLanguage('Short')).toBe('unknown');
        });

        it('should return unknown for text under 50 chars', () => {
            const shortText = 'This is just under fifty characters long';
            expect(detectLanguage(shortText)).toBe('unknown');
        });

        it('should handle empty string', () => {
            expect(detectLanguage('')).toBe('unknown');
        });

        it('should handle text with mostly English and some CJK', () => {
            const mostlyEnglish = 'This is a long English text with just one Chinese character 中 in the middle of it all.';
            expect(detectLanguage(mostlyEnglish)).toBe('en');
        });

        it('should handle special characters and emojis', () => {
            const withEmoji = 'This is a test with emoji 🎉 and special chars @#$% but still English';
            expect(detectLanguage(withEmoji)).toBe('en');
        });
    });

    describe('Threshold Behavior', () => {
        it('should detect minority CJK content as English', () => {
            // About 25% CJK - below threshold, should be English
            const borderline = 'English text here. 中文 More English text continues here.';
            const result = detectLanguage(borderline);
            expect(result).toBe('en');
        });
    });
});
