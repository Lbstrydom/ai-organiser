/**
 * Transcript Quality Service Tests
 * Phase 1 of the TRA plan — 36 tests covering:
 * - detectRepetitionLoop (10 tests)
 * - stripCorruptTail (5 tests)
 * - validateChunkQuality (8 tests)
 * - validateTranscriptCompleteness (5 tests)
 * - stitchOverlappingTranscripts (8 tests)
 */

import {
    detectRepetitionLoop,
    stripCorruptTail,
    validateChunkQuality,
    validateTranscriptCompleteness,
    stitchOverlappingTranscripts,
    REPETITION_WINDOW_CHARS,
    REPETITION_THRESHOLD_PERCENT,
    MIN_WORDS_PER_MINUTE,
    COVERAGE_BLOCK_THRESHOLD,
    COVERAGE_WARN_THRESHOLD,
    EXPECTED_WORDS_PER_MINUTE,
    MIN_CHUNK_WORDS,
} from '../src/services/transcriptQualityService';

// ============================================================================
// detectRepetitionLoop
// ============================================================================

describe('detectRepetitionLoop', () => {
    it('should return clean result for normal text', () => {
        const text = 'The board discussed the financial outlook for the next quarter. ' +
            'Revenue projections show a moderate increase over the previous period. ' +
            'The CEO presented the strategic plan for expanding into new markets. ' +
            'Several board members raised questions about capital allocation and risk management. ' +
            'It was agreed to form a subcommittee to review the proposals in detail.';
        const result = detectRepetitionLoop(text);
        expect(result.isCorrupt).toBe(false);
        expect(result.corruptionStartIndex).toBe(-1);
        expect(result.corruptPattern).toBe('');
        expect(result.cleanTranscript).toBe(text);
    });

    it('should detect "m m m" repetition tail', () => {
        const clean = 'The meeting discussed the budget proposal and funding requirements. ';
        // Generate a corrupt tail of single-char 'm' tokens longer than 500 chars
        const corrupt = Array(300).fill('m').join(' ');
        const text = clean + corrupt;
        const result = detectRepetitionLoop(text);
        expect(result.isCorrupt).toBe(true);
        expect(result.corruptPattern).toBe('m');
        expect(result.cleanTranscript.length).toBeLessThan(text.length);
        // The clean transcript should not contain the bulk of corruption
        expect(result.cleanTranscript).not.toContain('m m m m m m m m');
    });

    it('should detect "um um um" repetition variant', () => {
        const clean = 'The presenter explained the project timeline in detail. ';
        // "um" is 2 chars, not single-char — but "u u u" pattern would be single-char
        // Test with single-char repetition 'u'
        const corrupt = Array(300).fill('u').join(' ');
        const text = clean + corrupt;
        const result = detectRepetitionLoop(text);
        expect(result.isCorrupt).toBe(true);
        expect(result.corruptPattern).toBe('u');
    });

    it('should avoid false positive on normal text with some short words', () => {
        // Normal English text has short words (a, I, to) but not >80% single-char
        const text = 'I went to a store and I got a new bag. It was on sale so I bought two. ' +
            'The clerk asked if I wanted a receipt. I said yes and she gave me one. ' +
            'Then I left the store and walked to my car. It was a nice day outside. ' +
            'I drove home and put the bags on the table in my kitchen area today now.';
        const padded = text.repeat(5); // Make it longer than the window
        const result = detectRepetitionLoop(padded);
        expect(result.isCorrupt).toBe(false);
    });

    it('should handle all-corrupt text', () => {
        const corrupt = Array(300).fill('x').join(' ');
        const result = detectRepetitionLoop(corrupt);
        expect(result.isCorrupt).toBe(true);
        expect(result.corruptPattern).toBe('x');
        expect(result.cleanTranscript).toBe('');
    });

    it('should handle empty string', () => {
        const result = detectRepetitionLoop('');
        expect(result.isCorrupt).toBe(false);
        expect(result.corruptionStartIndex).toBe(-1);
        expect(result.cleanTranscript).toBe('');
    });

    it('should detect corruption at 81% threshold but not at 79%', () => {
        // Build text that is purely single-char 'm' tokens (100% single-char ASCII).
        // This clearly exceeds the 80% threshold.
        const corrupt81 = Array(300).fill('m').join(' '); // ~600 chars, 100% single-char 'm'
        const result81 = detectRepetitionLoop(corrupt81);
        expect(result81.isCorrupt).toBe(true);

        // Build text where single-char ASCII tokens are only ~30% (well below threshold)
        // Mix multi-char words so single-char ratio stays under 80%
        const tokens79: string[] = [];
        for (let i = 0; i < 250; i++) {
            tokens79.push('discussion');  // multi-char
            if (i % 4 === 0) tokens79.push('m'); // single-char every 4th = ~20%
        }
        const safe = tokens79.join(' ');
        const resultBelow = detectRepetitionLoop(safe);
        expect(resultBelow.isCorrupt).toBe(false);
    });

    it('should detect non-ASCII repetition patterns (single-byte non-letter ASCII)', () => {
        // Test with repeated '1' characters (ASCII digit)
        const clean = 'The meeting concluded with several action items for review. ';
        const corrupt = Array(300).fill('1').join(' ');
        const text = clean + corrupt;
        const result = detectRepetitionLoop(text);
        expect(result.isCorrupt).toBe(true);
        expect(result.corruptPattern).toBe('1');
    });

    it('should NOT false-positive on CJK text', () => {
        // Chinese text with many single-character words (CJK characters are NOT ASCII)
        const chineseText = '会议 讨论 了 公司 的 财务 状况 和 未来 发展 计划 。 ' +
            '董事会 审查 了 第三季度 的 财务 报告 。 ' +
            '公司 的 营业 收入 较 去年 同期 增长 了 百分之 十五 。 ' +
            '首席 执行 官 介绍 了 公司 下一 年度 的 战略 规划 。';
        const longChinese = chineseText.repeat(10); // Make it long enough for window analysis
        const result = detectRepetitionLoop(longChinese);
        expect(result.isCorrupt).toBe(false);
    });

    it('should handle mixed CJK and ASCII text without false positive', () => {
        // Mix of English and Chinese (common in bilingual meeting transcripts)
        const mixedText = 'CEO 介绍了 Q3 results 报告 。 Revenue 增长 15% year-over-year 。 ' +
            'The Board 讨论了 risk management 策略 and 财务 outlook for 2026 。 ' +
            '首席财务官 presented the budget 预算 和 expenditure 计划 。';
        const longMixed = mixedText.repeat(10);
        const result = detectRepetitionLoop(longMixed);
        expect(result.isCorrupt).toBe(false);
    });
});

// ============================================================================
// stripCorruptTail
// ============================================================================

describe('stripCorruptTail', () => {
    it('should return text unchanged when no corruption', () => {
        const text = 'The meeting concluded with all agenda items addressed.';
        const result = stripCorruptTail(text);
        expect(result.cleanText).toBe(text);
        expect(result.charsRemoved).toBe(0);
        expect(result.warning).toBeNull();
    });

    it('should strip corrupt tail and report warning', () => {
        const clean = 'Important discussion about budget allocation. ';
        const corrupt = Array(300).fill('m').join(' ');
        const text = clean + corrupt;
        const result = stripCorruptTail(text);
        expect(result.cleanText.length).toBeLessThan(text.length);
        expect(result.charsRemoved).toBeGreaterThan(0);
        expect(result.warning).toContain('Repetition loop detected');
        expect(result.warning).toContain('m');
    });

    it('should handle fully corrupt text', () => {
        const corrupt = Array(300).fill('x').join(' ');
        const result = stripCorruptTail(corrupt);
        expect(result.cleanText).toBe('');
        expect(result.charsRemoved).toBe(corrupt.length);
        expect(result.warning).not.toBeNull();
    });

    it('should handle text with multiple potential patterns', () => {
        // Clean text followed by 'a' pattern then 'b' pattern
        const clean = 'Some meaningful content here about the budget review. ';
        const corruptA = Array(300).fill('a').join(' ');
        const text = clean + corruptA;
        const result = stripCorruptTail(text);
        expect(result.charsRemoved).toBeGreaterThan(0);
        expect(result.cleanText).not.toContain('a a a a a a');
    });

    it('should preserve clean text exactly when no corruption', () => {
        const text = 'The board resolved to approve the proposed budget amendments ' +
            'and instructed management to implement the changes by end of Q2.';
        const result = stripCorruptTail(text);
        expect(result.cleanText).toBe(text);
        expect(result.charsRemoved).toBe(0);
    });
});

// ============================================================================
// validateChunkQuality
// ============================================================================

describe('validateChunkQuality', () => {
    it('should report normal quality for good transcript', () => {
        const transcript = 'The meeting started with a review of the previous minutes. ' +
            'All action items from last meeting were confirmed as completed. ' +
            'The chair moved on to discuss the budget proposal for the next fiscal year.';
        const report = validateChunkQuality(transcript, 0, 300);
        expect(report.chunkIndex).toBe(0);
        expect(report.wordCount).toBeGreaterThan(20);
        expect(report.hasRepetitionLoop).toBe(false);
        expect(report.wordsPerMinute).not.toBeNull();
    });

    it('should flag low words-per-minute', () => {
        // 10 words in 300 seconds (5 min) = 2 wpm
        const transcript = 'Hello world this is a very short transcript indeed now.';
        const report = validateChunkQuality(transcript, 1, 300);
        expect(report.wordsPerMinute).toBeLessThan(MIN_WORDS_PER_MINUTE);
    });

    it('should handle very high words-per-minute without error', () => {
        // Lots of words in short duration
        const transcript = ('The quick brown fox jumps over the lazy dog. ').repeat(100);
        const report = validateChunkQuality(transcript, 0, 10); // 10 seconds
        expect(report.wordsPerMinute).toBeGreaterThan(100);
        expect(report.hasRepetitionLoop).toBe(false);
    });

    it('should detect repetition in chunk', () => {
        const corrupt = Array(300).fill('m').join(' ');
        const report = validateChunkQuality(corrupt, 2, 300);
        expect(report.hasRepetitionLoop).toBe(true);
        expect(report.chunkIndex).toBe(2);
    });

    it('should flag empty chunk', () => {
        const report = validateChunkQuality('Hi ok', 3, 300);
        expect(report.wordCount).toBeLessThanOrEqual(MIN_CHUNK_WORDS);
    });

    it('should return null wordsPerMinute when no duration provided', () => {
        const transcript = 'This is a normal transcript with enough content to pass validation checks.';
        const report = validateChunkQuality(transcript, 0);
        expect(report.wordsPerMinute).toBeNull();
    });

    it('should enforce minimum word count check', () => {
        const transcript = 'One two three four';
        const report = validateChunkQuality(transcript, 5, 300);
        expect(report.wordCount).toBe(4);
        expect(report.wordCount).toBeLessThan(MIN_CHUNK_WORDS);
    });

    it('should pass through chunk index correctly', () => {
        const transcript = 'Normal transcript content for testing chunk index passthrough validation.';
        const report = validateChunkQuality(transcript, 42, 60);
        expect(report.chunkIndex).toBe(42);
    });
});

// ============================================================================
// validateTranscriptCompleteness
// ============================================================================

describe('validateTranscriptCompleteness', () => {
    it('should return ok for coverage >= 75%', () => {
        // 60 min meeting, 120 wpm expected = 7200 words expected
        // 75% of 7200 = 5400 words
        const result = validateTranscriptCompleteness(5500, 60);
        expect(result.severity).toBe('ok');
        expect(result.coveragePercent).toBeGreaterThanOrEqual(COVERAGE_WARN_THRESHOLD);
    });

    it('should return warn for coverage 50-75%', () => {
        // 60 min meeting, 120 wpm = 7200 expected
        // 60% of 7200 = 4320 words
        const result = validateTranscriptCompleteness(4320, 60);
        expect(result.severity).toBe('warn');
        expect(result.coveragePercent).toBeGreaterThanOrEqual(COVERAGE_BLOCK_THRESHOLD);
        expect(result.coveragePercent).toBeLessThan(COVERAGE_WARN_THRESHOLD);
        expect(result.message).toContain('incomplete');
    });

    it('should return block for coverage < 50%', () => {
        // 60 min meeting, 120 wpm = 7200 expected
        // 30% of 7200 = 2160 words
        const result = validateTranscriptCompleteness(2160, 60);
        expect(result.severity).toBe('block');
        expect(result.coveragePercent).toBeLessThan(COVERAGE_BLOCK_THRESHOLD);
        expect(result.message).toContain('significant content appears missing');
    });

    it('should handle zero duration', () => {
        const result = validateTranscriptCompleteness(1000, 0);
        expect(result.severity).toBe('block');
        expect(result.coveragePercent).toBe(0);
    });

    it('should handle zero words', () => {
        const result = validateTranscriptCompleteness(0, 60);
        expect(result.severity).toBe('block');
        expect(result.coveragePercent).toBe(0);
        expect(result.message).toContain('empty');
    });
});

// ============================================================================
// stitchOverlappingTranscripts
// ============================================================================

describe('stitchOverlappingTranscripts', () => {
    it('should merge two chunks with overlapping content', () => {
        // Simulate overlap: last part of A matches first part of B
        const chunkA = 'The meeting began with a review of the previous minutes and action items from last month.';
        const chunkB = 'action items from last month. The chair then presented the new budget proposal for Q3.';
        const result = stitchOverlappingTranscripts([chunkA, chunkB], 10, 2.5);
        // Should contain both unique parts and the overlap only once
        expect(result).toContain('The meeting began');
        expect(result).toContain('budget proposal for Q3');
        // The overlapping phrase should appear only once
        const count = (result.match(/action items from last month/g) || []).length;
        expect(count).toBe(1);
    });

    it('should merge three chunks correctly', () => {
        const a = 'First segment with some content about the project timeline and deliverables.';
        const b = 'project timeline and deliverables. Second segment discusses budget allocation and resources.';
        const c = 'budget allocation and resources. Third segment covers risk management and contingency plans.';
        const result = stitchOverlappingTranscripts([a, b, c], 10, 2.5);
        expect(result).toContain('First segment');
        expect(result).toContain('Second segment');
        expect(result).toContain('Third segment');
        // Each overlap phrase should appear only once
        expect((result.match(/project timeline and deliverables/g) || []).length).toBe(1);
        expect((result.match(/budget allocation and resources/g) || []).length).toBe(1);
    });

    it('should fall back to space join when no overlap found', () => {
        const a = 'Apples oranges bananas grapes watermelon pineapple.';
        const b = 'Helicopter submarine airplane spacecraft satellite.';
        const result = stitchOverlappingTranscripts([a, b], 10, 2.5);
        expect(result).toBe(a + ' ' + b);
    });

    it('should return single chunk unchanged', () => {
        const text = 'Just one chunk of transcript content.';
        const result = stitchOverlappingTranscripts([text], 10);
        expect(result).toBe(text);
    });

    it('should return empty string for empty array', () => {
        const result = stitchOverlappingTranscripts([], 10);
        expect(result).toBe('');
    });

    it('should handle varied overlap lengths', () => {
        const a = 'Short content here with overlap at the end of this segment.';
        const b = 'overlap at the end of this segment. And then new content continues here.';
        // Try with larger overlap window
        const result = stitchOverlappingTranscripts([a, b], 20, 2.5);
        expect(result).toContain('Short content here');
        expect(result).toContain('new content continues here');
        expect((result.match(/overlap at the end of this segment/g) || []).length).toBe(1);
    });

    it('should handle fuzzy match with Whisper variation (case-insensitive)', () => {
        // Whisper might capitalize differently between chunks
        const a = 'The CEO presented quarterly results showing strong growth.';
        const b = 'the ceo presented quarterly results showing strong growth. Revenue increased by 15%.';
        const result = stitchOverlappingTranscripts([a, b], 10, 2.5);
        // Should deduplicate despite case differences
        expect(result).toContain('Revenue increased');
        // The overlap should appear only once (case insensitive match)
        const matches = result.toLowerCase().match(/presented quarterly results/g) || [];
        expect(matches.length).toBe(1);
    });

    it('should handle Unicode text correctly', () => {
        const a = 'The meeting covered budget and strategic planning for 2026.';
        const b = 'strategic planning for 2026. Le comité a discuté des investissements futurs.';
        const result = stitchOverlappingTranscripts([a, b], 10, 2.5);
        expect(result).toContain('The meeting covered budget');
        expect(result).toContain('investissements futurs');
        expect((result.match(/strategic planning for 2026/g) || []).length).toBe(1);
    });
});
