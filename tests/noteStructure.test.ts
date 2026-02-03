/**
 * Tests for noteStructure utilities: extractSourcesFromPending, getReferencesContent
 */

import { extractSourcesFromPending, getReferencesContent } from '../src/utils/noteStructure';

describe('extractSourcesFromPending', () => {
    it('should extract a web source with title, date, and URL', () => {
        const pending = `### Source: My Article (2026-01-15)
> From: https://example.com/article

Some content here.`;

        const sources = extractSourcesFromPending(pending);
        expect(sources).toHaveLength(1);
        expect(sources[0]).toEqual({
            type: 'web',
            title: 'My Article',
            link: 'https://example.com/article',
            date: '2026-01-15',
            isInternal: false
        });
    });

    it('should detect YouTube source type', () => {
        const pending = `### Source: Tech Talk (2026-02-01)
> From: https://www.youtube.com/watch?v=abc123

Video notes.`;

        const sources = extractSourcesFromPending(pending);
        expect(sources).toHaveLength(1);
        expect(sources[0].type).toBe('youtube');
    });

    it('should detect youtu.be short links as YouTube', () => {
        const pending = `### Source: Short Video (2026-02-01)
> From: https://youtu.be/abc123

Notes.`;

        const sources = extractSourcesFromPending(pending);
        expect(sources[0].type).toBe('youtube');
    });

    it('should detect PDF source type', () => {
        const pending = `### Source: Research Paper (2026-01-20)
> From: https://example.com/paper.pdf

Summary.`;

        const sources = extractSourcesFromPending(pending);
        expect(sources[0].type).toBe('pdf');
    });

    it('should detect audio source types', () => {
        const pending = `### Source: Podcast Episode (2026-01-10)
> From: https://example.com/episode.mp3

Transcript.`;

        const sources = extractSourcesFromPending(pending);
        expect(sources[0].type).toBe('audio');
    });

    it('should detect document source types', () => {
        const pending = `### Source: Report (2026-01-05)
> From: https://example.com/report.docx

Content.`;

        const sources = extractSourcesFromPending(pending);
        expect(sources[0].type).toBe('document');
    });

    it('should detect internal wikilink as note type and strip brackets', () => {
        const pending = `### Source: My Note (2026-01-01)
> From: [[My Note]]

Internal reference.`;

        const sources = extractSourcesFromPending(pending);
        expect(sources).toHaveLength(1);
        expect(sources[0]).toEqual({
            type: 'note',
            title: 'My Note',
            link: 'My Note',
            date: '2026-01-01',
            isInternal: true
        });
    });

    it('should skip blocks without > From: line', () => {
        const pending = `### Source: No Link (2026-01-01)

Just some content without a from line.

### Source: Has Link (2026-01-02)
> From: https://example.com

With link.`;

        const sources = extractSourcesFromPending(pending);
        expect(sources).toHaveLength(1);
        expect(sources[0].title).toBe('Has Link');
    });

    it('should handle source without date', () => {
        const pending = `### Source: Undated Article
> From: https://example.com

Content.`;

        const sources = extractSourcesFromPending(pending);
        expect(sources).toHaveLength(1);
        expect(sources[0].title).toBe('Undated Article');
        expect(sources[0].date).toBeUndefined();
    });

    it('should extract multiple sources', () => {
        const pending = `### Source: First (2026-01-01)
> From: https://example.com/first

First content.

### Source: Second (2026-01-02)
> From: https://example.com/second

Second content.

### Source: Third (2026-01-03)
> From: [[Internal Note]]

Third content.`;

        const sources = extractSourcesFromPending(pending);
        expect(sources).toHaveLength(3);
        expect(sources[0].title).toBe('First');
        expect(sources[1].title).toBe('Second');
        expect(sources[2].title).toBe('Third');
        expect(sources[2].isInternal).toBe(true);
    });

    it('should return empty array for empty input', () => {
        expect(extractSourcesFromPending('')).toEqual([]);
    });

    it('should return empty array for content without source headings', () => {
        const pending = `Some random content
without any source headings.`;

        expect(extractSourcesFromPending(pending)).toEqual([]);
    });

    it('should detect video source types', () => {
        const pending = `### Source: Meeting Recording (2026-01-15)
> From: https://example.com/recording.mp4

Recording.`;

        const sources = extractSourcesFromPending(pending);
        expect(sources[0].type).toBe('video');
    });

    // Unstructured content tests (raw URLs, embeds)
    it('should extract raw URLs from unstructured pending content', () => {
        const pending = `https://www.decanter.com/some-article/
https://www.youtube.com/watch?v=abc123
Some text describing the content.`;

        const sources = extractSourcesFromPending(pending);
        expect(sources).toHaveLength(2);
        expect(sources[0].type).toBe('web');
        expect(sources[0].link).toBe('https://www.decanter.com/some-article/');
        expect(sources[1].type).toBe('youtube');
    });

    it('should extract wikilink embeds from unstructured content', () => {
        const pending = `![[My Document.pdf]]
![[Recording.wav]]
Some notes about this content.`;

        const sources = extractSourcesFromPending(pending);
        expect(sources).toHaveLength(2);
        expect(sources[0].type).toBe('pdf');
        expect(sources[0].link).toBe('My Document.pdf');
        expect(sources[0].isInternal).toBe(true);
        expect(sources[1].type).toBe('audio');
    });

    it('should handle mixed structured and unstructured content', () => {
        const pending = `### Source: Article (2026-01-01)
> From: https://example.com/article

Content here.

https://www.youtube.com/watch?v=xyz
![[Report.pdf]]`;

        const sources = extractSourcesFromPending(pending);
        expect(sources).toHaveLength(3);
        expect(sources[0].type).toBe('web');
        expect(sources[0].title).toBe('Article');
        expect(sources[1].type).toBe('youtube');
        expect(sources[2].type).toBe('pdf');
        expect(sources[2].isInternal).toBe(true);
    });

    it('should deduplicate URLs across structured and unstructured', () => {
        const pending = `### Source: My Site (2026-01-01)
> From: https://example.com

https://example.com
More content.`;

        const sources = extractSourcesFromPending(pending);
        expect(sources).toHaveLength(1);
        expect(sources[0].title).toBe('My Site');
    });

    it('should generate readable titles from URL paths', () => {
        const pending = `https://www.decanter.com/decanter-world-wine-awards/how-we-judge-wine-521278/`;

        const sources = extractSourcesFromPending(pending);
        expect(sources).toHaveLength(1);
        expect(sources[0].title).toContain('decanter.com');
        expect(sources[0].title).not.toBe('decanter.com'); // Should be more than just hostname
    });

    it('should strip trailing punctuation from raw URLs', () => {
        const pending = `Check out https://example.com/page, it's great.
Also see https://other.com/article.`;

        const sources = extractSourcesFromPending(pending);
        expect(sources).toHaveLength(2);
        expect(sources[0].link).toBe('https://example.com/page');
        expect(sources[1].link).toBe('https://other.com/article');
    });

    it('should handle real-world mixed pending content', () => {
        const pending = `![[Leading Wine Competitions.wav]]

https://www.decanter.com/decanter-world-wine-awards/how-we-judge-wine-521278/
https://www.thewinecellargroup.com/blogs/news/award-winning-wines
https://www.youtube.com/watch?v=5rqxefwTOHw&t=5
![[JUDGING-PROCESS_01.pdf]]
The Decanter World Wine Awards is the world's largest wine competition.`;

        const sources = extractSourcesFromPending(pending);
        expect(sources.length).toBeGreaterThanOrEqual(5);

        const types = sources.map(s => s.type);
        expect(types).toContain('audio');
        expect(types).toContain('web');
        expect(types).toContain('youtube');
        expect(types).toContain('pdf');
    });
});

describe('getReferencesContent', () => {
    function createMockEditor(lines: string[]) {
        return {
            lineCount: vi.fn().mockReturnValue(lines.length),
            getLine: vi.fn((i: number) => lines[i] || '')
        } as any;
    }

    it('should return references section content when present', () => {
        const lines = [
            '# My Note',
            '',
            'Some content.',
            '',
            '## References',
            '- [Link](https://example.com)',
            '- [[Internal Note]]',
            '',
            '## Pending Integration'
        ];

        const editor = createMockEditor(lines);
        const content = getReferencesContent(editor);
        expect(content).toContain('https://example.com');
        expect(content).toContain('[[Internal Note]]');
    });

    it('should return empty string when no references section exists', () => {
        const lines = [
            '# My Note',
            '',
            'Some content.',
        ];

        const editor = createMockEditor(lines);
        const content = getReferencesContent(editor);
        expect(content).toBe('');
    });
});
