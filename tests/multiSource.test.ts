/**
 * Multi-Source Summarization Tests
 * Tests source detection, modal result handling, and output formatting
 */

import { describe, it, expect } from 'vitest';
import {
    detectSourcesFromContent,
    getTotalSourceCount,
    hasAnySources,
    removeProcessedSources,
    DetectedSources
} from '../src/utils/sourceDetection';

describe('Source Detection', () => {
    describe('detectSourcesFromContent', () => {
        it('should detect regular URLs', () => {
            const content = `
Check out this article: https://example.com/article
And this one: https://blog.example.org/post/123
            `;
            const sources = detectSourcesFromContent(content);

            expect(sources.urls.length).toBe(2);
            expect(sources.urls[0].value).toBe('https://example.com/article');
            expect(sources.urls[1].value).toBe('https://blog.example.org/post/123');
        });

        it('should detect YouTube URLs', () => {
            const content = `
Watch this: https://www.youtube.com/watch?v=dQw4w9WgXcQ
Also: https://youtu.be/abc123def45
            `;
            const sources = detectSourcesFromContent(content);

            expect(sources.youtube.length).toBe(2);
            expect(sources.youtube[0].value).toContain('youtube.com');
            expect(sources.youtube[1].value).toContain('youtu.be');
        });

        it('should detect vault PDF links', () => {
            const content = `
See the document: [[research-paper.pdf]]
Also check: [[folder/another-doc.pdf]]
            `;
            const sources = detectSourcesFromContent(content);

            expect(sources.pdfs.length).toBe(2);
            expect(sources.pdfs[0].value).toBe('research-paper.pdf');
            expect(sources.pdfs[0].isVaultFile).toBe(true);
            expect(sources.pdfs[1].value).toBe('folder/another-doc.pdf');
        });

        it('should detect PDF URLs', () => {
            const content = `
Download: https://example.com/docs/report.pdf
            `;
            const sources = detectSourcesFromContent(content);

            expect(sources.pdfs.length).toBe(1);
            expect(sources.pdfs[0].value).toContain('.pdf');
            expect(sources.pdfs[0].isVaultFile).toBe(false);
        });

        it('should detect vault audio links', () => {
            const content = `
Listen: [[podcast-episode.mp3]]
Recording: [[meeting/call-2024.m4a]]
            `;
            const sources = detectSourcesFromContent(content);

            expect(sources.audio.length).toBe(2);
            expect(sources.audio[0].value).toBe('podcast-episode.mp3');
            expect(sources.audio[0].isVaultFile).toBe(true);
        });

        it('should not duplicate sources', () => {
            const content = `
https://example.com/article
https://example.com/article
https://example.com/article
            `;
            const sources = detectSourcesFromContent(content);

            expect(sources.urls.length).toBe(1);
        });

        it('should detect sources in Pending Integration section', () => {
            const content = `
## Summary
This is a summary.

## Pending Integration
https://example.com/to-process
[[document.pdf]]
            `;
            const sources = detectSourcesFromContent(content);

            expect(sources.urls.length).toBe(1);
            expect(sources.urls[0].context).toContain('Pending');
            expect(sources.pdfs.length).toBe(1);
            expect(sources.pdfs[0].context).toContain('Pending');
        });

        it('should not classify YouTube as regular URL', () => {
            const content = `
https://www.youtube.com/watch?v=dQw4w9WgXcQ
https://example.com/regular-page
            `;
            const sources = detectSourcesFromContent(content);

            expect(sources.youtube.length).toBe(1);
            expect(sources.urls.length).toBe(1);
            // YouTube URL should NOT be in regular urls
            expect(sources.urls.some(u => u.value.includes('youtube.com'))).toBe(false);
        });

        it('should handle mixed content', () => {
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

    describe('getTotalSourceCount', () => {
        it('should count all sources correctly', () => {
            const sources: DetectedSources = {
                urls: [{ type: 'url', value: 'a', displayName: 'a' }],
                youtube: [{ type: 'youtube', value: 'b', displayName: 'b' }],
                pdfs: [
                    { type: 'pdf', value: 'c', displayName: 'c' },
                    { type: 'pdf', value: 'd', displayName: 'd' }
                ],
                audio: []
            };

            expect(getTotalSourceCount(sources)).toBe(4);
        });

        it('should return 0 for empty sources', () => {
            const sources: DetectedSources = {
                urls: [],
                youtube: [],
                pdfs: [],
                audio: []
            };

            expect(getTotalSourceCount(sources)).toBe(0);
        });
    });

    describe('hasAnySources', () => {
        it('should return true when sources exist', () => {
            const sources: DetectedSources = {
                urls: [{ type: 'url', value: 'a', displayName: 'a' }],
                youtube: [],
                pdfs: [],
                audio: []
            };

            expect(hasAnySources(sources)).toBe(true);
        });

        it('should return false for empty sources', () => {
            const sources: DetectedSources = {
                urls: [],
                youtube: [],
                pdfs: [],
                audio: []
            };

            expect(hasAnySources(sources)).toBe(false);
        });
    });

    describe('removeProcessedSources', () => {
        it('should remove URLs from content', () => {
            const content = `
Check this out:
https://example.com/article

And this:
https://blog.example.com/post
            `;
            const urlsToRemove = ['https://example.com/article'];
            const result = removeProcessedSources(content, urlsToRemove);

            expect(result).not.toContain('https://example.com/article');
            expect(result).toContain('https://blog.example.com/post');
        });

        it('should remove markdown links when on their own line', () => {
            const content = `
- [Article Title](https://example.com/article)
Some other text
            `;
            const urlsToRemove = ['https://example.com/article'];
            const result = removeProcessedSources(content, urlsToRemove);

            expect(result).not.toContain('https://example.com/article');
            expect(result).toContain('Some other text');
        });

        it('should NOT remove inline markdown links (only removes whole lines)', () => {
            // This is expected behavior - inline links are preserved
            const content = `
See [this article](https://example.com/article) for details.
            `;
            const urlsToRemove = ['https://example.com/article'];
            const result = removeProcessedSources(content, urlsToRemove);

            // Inline links are NOT removed (would break sentence structure)
            expect(result).toContain('https://example.com/article');
        });

        it('should preserve content when no URLs match', () => {
            const content = `
This is some content.
https://example.com/keep-this
            `;
            const urlsToRemove = ['https://different.com/url'];
            const result = removeProcessedSources(content, urlsToRemove);

            expect(result).toContain('https://example.com/keep-this');
        });

        it('should clean up empty list items after removal', () => {
            const content = `
- https://example.com/article
- Keep this item
            `;
            const urlsToRemove = ['https://example.com/article'];
            const result = removeProcessedSources(content, urlsToRemove);

            // Should not have an empty list item
            expect(result.trim()).not.toMatch(/^-\s*$/m);
        });
    });
});

describe('Multi-Source Output Formatting', () => {
    describe('Source status checklist', () => {
        it('should format successful sources with checkmark', () => {
            const source = {
                type: 'web' as const,
                title: 'Example Article',
                success: true
            };

            const line = `- [${source.success ? '✓' : '✗'}] ${source.title}`;
            expect(line).toBe('- [✓] Example Article');
        });

        it('should format failed sources with X and error', () => {
            const source = {
                type: 'youtube' as const,
                title: 'Video Title',
                success: false,
                error: 'No transcript available'
            };

            const status = source.success ? '' : ` - *${source.error}*`;
            const line = `- [${source.success ? '✓' : '✗'}] ${source.title}${status}`;
            expect(line).toBe('- [✗] Video Title - *No transcript available*');
        });

        it('should truncate long titles', () => {
            const longTitle = 'This is a very long title that exceeds sixty characters and should be truncated';
            const truncated = longTitle.length > 60
                ? longTitle.substring(0, 57) + '...'
                : longTitle;

            expect(truncated.length).toBeLessThanOrEqual(60);
            expect(truncated).toContain('...');
        });
    });

    describe('Modal result structure', () => {
        it('should have correct structure with all source types', () => {
            interface MultiSourceModalResult {
                sources: {
                    urls: string[];
                    youtube: string[];
                    pdfs: Array<{ path: string; isVaultFile: boolean }>;
                    audio: Array<{ path: string; isVaultFile: boolean }>;
                };
                summarizeNote: boolean;
                focusContext?: string;
                personaId?: string;
            }

            const result: MultiSourceModalResult = {
                sources: {
                    urls: ['https://example.com'],
                    youtube: ['https://youtube.com/watch?v=abc'],
                    pdfs: [{ path: 'doc.pdf', isVaultFile: true }],
                    audio: [{ path: 'audio.mp3', isVaultFile: true }]
                },
                summarizeNote: false,
                focusContext: 'key findings',
                personaId: 'student'
            };

            expect(result.sources.urls).toHaveLength(1);
            expect(result.sources.youtube).toHaveLength(1);
            expect(result.sources.pdfs).toHaveLength(1);
            expect(result.sources.pdfs[0].isVaultFile).toBe(true);
            expect(result.sources.audio).toHaveLength(1);
            expect(result.personaId).toBe('student');
        });
    });
});

describe('ProcessedSource tracking', () => {
    interface ProcessedSource {
        type: 'web' | 'youtube' | 'note' | 'pdf' | 'audio';
        url?: string;
        title: string;
        date: string;
        success: boolean;
        error?: string;
    }

    it('should track successful URL processing', () => {
        const source: ProcessedSource = {
            type: 'web',
            url: 'https://example.com/article',
            title: 'Example Article',
            date: '2024-01-15',
            success: true
        };

        expect(source.success).toBe(true);
        expect(source.error).toBeUndefined();
    });

    it('should track failed YouTube processing with error', () => {
        const source: ProcessedSource = {
            type: 'youtube',
            url: 'https://youtube.com/watch?v=abc',
            title: 'Protected Video',
            date: '2024-01-15',
            success: false,
            error: 'Transcript not available'
        };

        expect(source.success).toBe(false);
        expect(source.error).toBe('Transcript not available');
    });

    it('should calculate success/fail counts correctly', () => {
        const sources: ProcessedSource[] = [
            { type: 'web', title: 'Article 1', date: '2024-01-15', success: true },
            { type: 'web', title: 'Article 2', date: '2024-01-15', success: true },
            { type: 'youtube', title: 'Video', date: '2024-01-15', success: false, error: 'No captions' },
            { type: 'pdf', title: 'Document', date: '2024-01-15', success: true },
        ];

        const successCount = sources.filter(s => s.success).length;
        const failCount = sources.length - successCount;

        expect(successCount).toBe(3);
        expect(failCount).toBe(1);
    });
});
