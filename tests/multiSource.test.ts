/**
 * Multi-Source Summarization Tests
 * Tests mixed content scenarios not covered by sourceDetection.test.ts
 */

import { describe, it, expect } from 'vitest';
import { detectSourcesFromContent } from '../src/utils/sourceDetection';

describe('Multi-Source Mixed Content', () => {
    it('should handle mixed content with all source types', () => {
        const content = `
# Research Notes

## Sources to Process
- Article: https://blog.example.com/ai-research
- Video: https://youtube.com/watch?v=test12345ab
- Paper: [[papers/ml-paper.pdf]]
- Interview: [[recordings/interview.mp3]]

## References
https://docs.example.com/reference
        `;
        const sources = detectSourcesFromContent(content);

        expect(sources.urls.length).toBe(2); // blog + docs
        expect(sources.youtube.length).toBe(1);
        expect(sources.pdfs.length).toBe(1);
        expect(sources.audio.length).toBe(1);
    });
});
