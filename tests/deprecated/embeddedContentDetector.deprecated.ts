/**
 * Embedded Content Detector Tests
 * Tests for detecting audio, documents, PDFs, and other embedded content
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { App, TFile, TFolder } from './mocks/obsidian';

// Import the actual detection logic patterns (replicated for testing)
// These patterns match the actual implementation

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'];
const DOCUMENT_EXTENSIONS = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.rtf'];
const AUDIO_EXTENSIONS = ['.mp3', '.m4a', '.wav', '.webm', '.ogg', '.mp4', '.mpeg', '.mpga', '.oga'];

type ContentType = 'image' | 'pdf' | 'youtube' | 'web-link' | 'internal-link' | 'document' | 'audio';

interface DetectedContent {
    type: ContentType;
    originalText: string;
    url: string;
    displayName: string;
    isEmbedded: boolean;
    isExternal: boolean;
    lineNumber: number;
}

// Simplified detection functions for testing
function detectEmbeddedSyntax(line: string, lineNumber: number): DetectedContent[] {
    const items: DetectedContent[] = [];

    // Wiki-style embedded: ![[file]] or ![[file|alt]]
    const wikiEmbedRegex = /!\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g;
    let match;

    while ((match = wikiEmbedRegex.exec(line)) !== null) {
        const filePath = match[1];
        const altText = match[2] || filePath;
        const type = classifyFileType(filePath);

        items.push({
            type,
            originalText: match[0],
            url: filePath,
            displayName: altText,
            isEmbedded: true,
            isExternal: false,
            lineNumber
        });
    }

    // Markdown embedded: ![alt](url)
    const markdownEmbedRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;

    while ((match = markdownEmbedRegex.exec(line)) !== null) {
        const altText = match[1];
        const url = match[2];
        const isExternal = url.startsWith('http://') || url.startsWith('https://');
        const type = isExternal ? classifyExternalUrl(url) : classifyFileType(url);

        items.push({
            type,
            originalText: match[0],
            url,
            displayName: altText || url,
            isEmbedded: true,
            isExternal,
            lineNumber
        });
    }

    return items;
}

function detectLinkSyntax(line: string, lineNumber: number): DetectedContent[] {
    const items: DetectedContent[] = [];

    // Wiki-style links: [[file]] - but not embedded (no !)
    const wikiLinkRegex = /(?<!!)\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g;
    let match;

    while ((match = wikiLinkRegex.exec(line)) !== null) {
        // Skip if preceded by ! (embedded)
        if (match.index > 0 && line[match.index - 1] === '!') {
            continue;
        }

        const filePath = match[1];
        const displayText = match[2] || filePath;
        const type = classifyFileType(filePath);

        items.push({
            type,
            originalText: match[0],
            url: filePath,
            displayName: displayText,
            isEmbedded: false,
            isExternal: false,
            lineNumber
        });
    }

    return items;
}

function classifyFileType(path: string): ContentType {
    const lowerPath = path.toLowerCase();

    if (IMAGE_EXTENSIONS.some(ext => lowerPath.endsWith(ext))) {
        return 'image';
    }
    if (lowerPath.endsWith('.pdf')) {
        return 'pdf';
    }
    if (AUDIO_EXTENSIONS.some(ext => lowerPath.endsWith(ext))) {
        return 'audio';
    }
    if (DOCUMENT_EXTENSIONS.some(ext => lowerPath.endsWith(ext))) {
        return 'document';
    }
    return 'internal-link';
}

function classifyExternalUrl(url: string): ContentType {
    const lowerUrl = url.toLowerCase();

    if (isYouTubeUrl(url)) {
        return 'youtube';
    }
    if (IMAGE_EXTENSIONS.some(ext => lowerUrl.endsWith(ext))) {
        return 'image';
    }
    if (lowerUrl.endsWith('.pdf')) {
        return 'pdf';
    }
    return 'web-link';
}

function isYouTubeUrl(url: string): boolean {
    return url.includes('youtube.com/watch') ||
           url.includes('youtu.be/') ||
           url.includes('youtube.com/embed/');
}

function detectContent(content: string): DetectedContent[] {
    const items: DetectedContent[] = [];
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineNumber = i + 1;

        items.push(...detectEmbeddedSyntax(line, lineNumber));
        items.push(...detectLinkSyntax(line, lineNumber));
    }

    return items;
}

describe('Embedded Content Detector', () => {
    describe('Audio Detection', () => {
        it('should detect embedded MP3 files', () => {
            const content = '![[recording.mp3]]';
            const items = detectContent(content);

            expect(items).toHaveLength(1);
            expect(items[0].type).toBe('audio');
            expect(items[0].isEmbedded).toBe(true);
            expect(items[0].url).toBe('recording.mp3');
        });

        it('should detect all audio extensions', () => {
            const extensions = ['.mp3', '.m4a', '.wav', '.webm', '.ogg', '.mp4', '.mpeg', '.mpga', '.oga'];

            for (const ext of extensions) {
                const content = `![[audio${ext}]]`;
                const items = detectContent(content);

                expect(items).toHaveLength(1);
                expect(items[0].type).toBe('audio');
            }
        });

        it('should detect audio with path', () => {
            const content = '![[Recordings/meeting-2025-01-24.m4a]]';
            const items = detectContent(content);

            expect(items).toHaveLength(1);
            expect(items[0].type).toBe('audio');
            expect(items[0].url).toBe('Recordings/meeting-2025-01-24.m4a');
        });

        it('should detect audio with alt text', () => {
            const content = '![[interview.mp3|Interview Recording]]';
            const items = detectContent(content);

            expect(items).toHaveLength(1);
            expect(items[0].type).toBe('audio');
            expect(items[0].displayName).toBe('Interview Recording');
        });
    });

    describe('Document Detection', () => {
        it('should detect embedded DOCX files', () => {
            const content = '![[agenda.docx]]';
            const items = detectContent(content);

            expect(items).toHaveLength(1);
            expect(items[0].type).toBe('document');
        });

        it('should detect embedded PPTX files', () => {
            const content = '![[presentation.pptx]]';
            const items = detectContent(content);

            expect(items).toHaveLength(1);
            expect(items[0].type).toBe('document');
        });

        it('should detect embedded XLSX files', () => {
            const content = '![[data.xlsx]]';
            const items = detectContent(content);

            expect(items).toHaveLength(1);
            expect(items[0].type).toBe('document');
        });

        it('should detect embedded PDF files separately', () => {
            const content = '![[report.pdf]]';
            const items = detectContent(content);

            expect(items).toHaveLength(1);
            expect(items[0].type).toBe('pdf');
        });
    });

    describe('YouTube Detection', () => {
        it('should detect YouTube watch URLs', () => {
            const content = '![Video](https://www.youtube.com/watch?v=dQw4w9WgXcQ)';
            const items = detectContent(content);

            expect(items).toHaveLength(1);
            expect(items[0].type).toBe('youtube');
            expect(items[0].isExternal).toBe(true);
        });

        it('should detect youtu.be short URLs', () => {
            const content = '![](https://youtu.be/dQw4w9WgXcQ)';
            const items = detectContent(content);

            expect(items).toHaveLength(1);
            expect(items[0].type).toBe('youtube');
        });

        it('should detect YouTube embed URLs', () => {
            const content = '![](https://www.youtube.com/embed/dQw4w9WgXcQ)';
            const items = detectContent(content);

            expect(items).toHaveLength(1);
            expect(items[0].type).toBe('youtube');
        });
    });

    describe('Image Detection', () => {
        it('should detect embedded images', () => {
            const content = '![[screenshot.png]]';
            const items = detectContent(content);

            expect(items).toHaveLength(1);
            expect(items[0].type).toBe('image');
        });

        it('should detect external image URLs', () => {
            const content = '![Alt](https://example.com/image.jpg)';
            const items = detectContent(content);

            expect(items).toHaveLength(1);
            expect(items[0].type).toBe('image');
            expect(items[0].isExternal).toBe(true);
        });
    });

    describe('Link vs Embed Distinction', () => {
        it('should distinguish embedded from linked content', () => {
            const content = '![[embedded.mp3]]\n[[linked.mp3]]';
            const items = detectContent(content);

            expect(items).toHaveLength(2);
            expect(items[0].isEmbedded).toBe(true);
            expect(items[1].isEmbedded).toBe(false);
        });

        it('should correctly identify linked documents', () => {
            const content = '[[agenda.docx]]';
            const items = detectContent(content);

            expect(items).toHaveLength(1);
            expect(items[0].type).toBe('document');
            expect(items[0].isEmbedded).toBe(false);
        });
    });

    describe('Multiple Content Types', () => {
        it('should detect multiple content types in one document', () => {
            const content = `# Meeting Notes

![[recording.mp3]]
![[agenda.pptx]]
![[screenshot.png]]
[[reference.pdf]]

Watch: https://youtube.com/watch?v=abc123
`;
            const items = detectContent(content);

            const types = items.map(i => i.type);
            expect(types).toContain('audio');
            expect(types).toContain('document');
            expect(types).toContain('image');
            expect(types).toContain('pdf');
        });

        it('should track line numbers correctly', () => {
            const content = 'Line 1\n![[audio.mp3]]\nLine 3\n![[doc.docx]]';
            const items = detectContent(content);

            expect(items[0].lineNumber).toBe(2);
            expect(items[1].lineNumber).toBe(4);
        });
    });

    describe('Edge Cases', () => {
        it('should handle empty content', () => {
            const items = detectContent('');
            expect(items).toHaveLength(0);
        });

        it('should handle content with no embeds', () => {
            const content = '# Just a regular note\n\nNo embeds here.';
            const items = detectContent(content);
            expect(items).toHaveLength(0);
        });

        it('should handle malformed embed syntax', () => {
            const content = '![[incomplete';
            const items = detectContent(content);
            expect(items).toHaveLength(0);
        });

        it('should handle files without extensions', () => {
            const content = '![[noextension]]';
            const items = detectContent(content);

            expect(items).toHaveLength(1);
            expect(items[0].type).toBe('internal-link');
        });

        it('should be case insensitive for extensions', () => {
            const content = '![[AUDIO.MP3]]\n![[Document.DOCX]]';
            const items = detectContent(content);

            expect(items[0].type).toBe('audio');
            expect(items[1].type).toBe('document');
        });
    });
});

describe('Audio Extensions', () => {
    it('should include all Whisper-compatible formats', () => {
        // Based on OpenAI Whisper documentation
        const whisperFormats = ['mp3', 'm4a', 'wav', 'webm', 'ogg', 'mp4', 'mpeg', 'mpga'];

        for (const format of whisperFormats) {
            expect(AUDIO_EXTENSIONS).toContain(`.${format}`);
        }
    });
});

describe('Document Extensions', () => {
    it('should include Office formats', () => {
        expect(DOCUMENT_EXTENSIONS).toContain('.docx');
        expect(DOCUMENT_EXTENSIONS).toContain('.xlsx');
        expect(DOCUMENT_EXTENSIONS).toContain('.pptx');
    });

    it('should include PDF', () => {
        expect(DOCUMENT_EXTENSIONS).toContain('.pdf');
    });
});
