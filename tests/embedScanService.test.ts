/**
 * Embed Scan Service Tests
 * Tests for vault embed/link scanning, reference counting, and orphan detection.
 *
 * MECE Coverage:
 * - normalizeEmbedPath: Alias stripping, anchor stripping, query stripping, combinations, edge cases
 * - classifyExtension: Image, PDF, audio, video, document, other — including case insensitivity
 * - formatFileSize: 0, bytes, KB, MB, GB thresholds
 * - getEmbedTypeIcon: One test per type
 * - hasEmbedTypeExtension: Matching and non-matching extensions
 * - isExternalUrl: HTTP, HTTPS, non-URL
 * - extractReferencesFromLine: All 4 regex patterns, combined, non-dedup behavior
 * - EMBED_TYPE_EXTENSIONS: Completeness and no-markdown assertion
 */

import {
    normalizeEmbedPath,
    classifyExtension,
    formatFileSize,
    getEmbedTypeIcon,
    hasEmbedTypeExtension,
    isExternalUrl,
    extractReferencesFromLine,
    EMBED_TYPE_EXTENSIONS,
    type EmbedTargetType,
} from '../src/services/embedScanService';

// ─── normalizeEmbedPath ──────────────────────────────────────────────────────

describe('normalizeEmbedPath', () => {
    it('should return trimmed path unchanged when no special chars', () => {
        expect(normalizeEmbedPath('folder/image.png')).toBe('folder/image.png');
    });

    it('should strip wiki-link alias (pipe)', () => {
        expect(normalizeEmbedPath('document.pdf|My Alias')).toBe('document.pdf');
    });

    it('should strip anchor (hash)', () => {
        expect(normalizeEmbedPath('document.pdf#page=2')).toBe('document.pdf');
        expect(normalizeEmbedPath('note.md#heading')).toBe('note.md');
    });

    it('should strip query params', () => {
        expect(normalizeEmbedPath('image.png?v=1')).toBe('image.png');
        expect(normalizeEmbedPath('file.pdf?token=abc&page=3')).toBe('file.pdf');
    });

    it('should strip alias before anchor (pipe appears before hash)', () => {
        expect(normalizeEmbedPath('file.pdf|alias#page=1')).toBe('file.pdf');
    });

    it('should strip anchor before query', () => {
        expect(normalizeEmbedPath('file.pdf#heading?v=2')).toBe('file.pdf');
    });

    it('should handle all three together', () => {
        expect(normalizeEmbedPath('file.pdf|alias#anchor?query')).toBe('file.pdf');
    });

    it('should handle whitespace around path', () => {
        expect(normalizeEmbedPath('  image.png  ')).toBe('image.png');
    });

    it('should return empty string for empty input', () => {
        expect(normalizeEmbedPath('')).toBe('');
        expect(normalizeEmbedPath('   ')).toBe('');
    });

    it('should preserve folder paths', () => {
        expect(normalizeEmbedPath('assets/images/photo.jpg|thumb')).toBe('assets/images/photo.jpg');
    });

    it('should handle hash at start (edge case)', () => {
        expect(normalizeEmbedPath('#heading-only')).toBe('');
    });

    it('should handle pipe at start', () => {
        expect(normalizeEmbedPath('|alias-only')).toBe('');
    });
});

// ─── classifyExtension ──────────────────────────────────────────────────────

describe('classifyExtension', () => {
    it('should classify common image extensions', () => {
        expect(classifyExtension('.png')).toBe('image');
        expect(classifyExtension('.jpg')).toBe('image');
        expect(classifyExtension('.jpeg')).toBe('image');
        expect(classifyExtension('.gif')).toBe('image');
        expect(classifyExtension('.webp')).toBe('image');
        expect(classifyExtension('.svg')).toBe('image');
        expect(classifyExtension('.bmp')).toBe('image');
        expect(classifyExtension('.heic')).toBe('image');
        expect(classifyExtension('.tiff')).toBe('image');
        expect(classifyExtension('.avif')).toBe('image');
    });

    it('should classify PDF', () => {
        expect(classifyExtension('.pdf')).toBe('pdf');
    });

    it('should classify audio extensions', () => {
        expect(classifyExtension('.mp3')).toBe('audio');
        expect(classifyExtension('.m4a')).toBe('audio');
        expect(classifyExtension('.wav')).toBe('audio');
        expect(classifyExtension('.ogg')).toBe('audio');
        expect(classifyExtension('.webm')).toBe('audio');
    });

    it('should classify video extensions', () => {
        expect(classifyExtension('.mov')).toBe('video');
        expect(classifyExtension('.avi')).toBe('video');
    });

    it('should classify document extensions', () => {
        expect(classifyExtension('.docx')).toBe('document');
        expect(classifyExtension('.xlsx')).toBe('document');
        expect(classifyExtension('.pptx')).toBe('document');
        expect(classifyExtension('.txt')).toBe('document');
        expect(classifyExtension('.rtf')).toBe('document');
    });

    it('should return "other" for unknown extensions', () => {
        expect(classifyExtension('.xyz')).toBe('other');
        expect(classifyExtension('.zip')).toBe('other');
        expect(classifyExtension('.json')).toBe('other');
        expect(classifyExtension('')).toBe('other');
    });

    it('should handle case insensitivity', () => {
        expect(classifyExtension('.PNG')).toBe('image');
        expect(classifyExtension('.PDF')).toBe('pdf');
        expect(classifyExtension('.MP3')).toBe('audio');
        expect(classifyExtension('.DOCX')).toBe('document');
    });

    it('should handle extension without leading dot for document types', () => {
        // Document extensions stored without dots in ALL_DOCUMENT_EXTENSIONS
        expect(classifyExtension('docx')).toBe('document');
        expect(classifyExtension('pdf')).toBe('document'); // 'pdf' is in ALL_DOCUMENT_EXTENSIONS
    });

    // Note: .mp4 is in both AUDIO and VIDEO arrays. AUDIO check comes first in classifyExtension.
    it('should classify .mp4 as audio (audio check precedes video)', () => {
        expect(classifyExtension('.mp4')).toBe('audio');
    });
});

// ─── formatFileSize ──────────────────────────────────────────────────────────

describe('formatFileSize', () => {
    it('should format 0 bytes', () => {
        expect(formatFileSize(0)).toBe('0 B');
    });

    it('should format bytes (< 1024)', () => {
        expect(formatFileSize(512)).toBe('512 B');
        expect(formatFileSize(1)).toBe('1 B');
        expect(formatFileSize(1023)).toBe('1023 B');
    });

    it('should format kilobytes', () => {
        expect(formatFileSize(1024)).toBe('1.0 KB');
        expect(formatFileSize(1536)).toBe('1.5 KB');
        expect(formatFileSize(102400)).toBe('100.0 KB');
    });

    it('should format megabytes', () => {
        expect(formatFileSize(1048576)).toBe('1.0 MB');
        expect(formatFileSize(5242880)).toBe('5.0 MB');
        expect(formatFileSize(1572864)).toBe('1.5 MB');
    });

    it('should format gigabytes', () => {
        expect(formatFileSize(1073741824)).toBe('1.0 GB');
        expect(formatFileSize(2147483648)).toBe('2.0 GB');
    });
});

// ─── getEmbedTypeIcon ────────────────────────────────────────────────────────

describe('getEmbedTypeIcon', () => {
    const expectedIcons: Record<EmbedTargetType, string> = {
        image: 'image',
        pdf: 'file-text',
        audio: 'music',
        video: 'video',
        document: 'file-spreadsheet',
        other: 'file',
    };

    for (const [type, icon] of Object.entries(expectedIcons)) {
        it(`should return "${icon}" for type "${type}"`, () => {
            expect(getEmbedTypeIcon(type as EmbedTargetType)).toBe(icon);
        });
    }
});

// ─── hasEmbedTypeExtension ───────────────────────────────────────────────────

describe('hasEmbedTypeExtension', () => {
    it('should match image extensions', () => {
        expect(hasEmbedTypeExtension('photo.png')).toBe(true);
        expect(hasEmbedTypeExtension('image.jpg')).toBe(true);
        expect(hasEmbedTypeExtension('anim.gif')).toBe(true);
    });

    it('should match PDF', () => {
        expect(hasEmbedTypeExtension('report.pdf')).toBe(true);
    });

    it('should match audio extensions', () => {
        expect(hasEmbedTypeExtension('track.mp3')).toBe(true);
        expect(hasEmbedTypeExtension('voice.m4a')).toBe(true);
    });

    it('should match video extensions', () => {
        expect(hasEmbedTypeExtension('clip.mov')).toBe(true);
    });

    it('should match document extensions', () => {
        expect(hasEmbedTypeExtension('data.xlsx')).toBe(true);
        expect(hasEmbedTypeExtension('report.docx')).toBe(true);
    });

    it('should NOT match markdown files', () => {
        expect(hasEmbedTypeExtension('note.md')).toBe(false);
    });

    it('should NOT match unknown extensions', () => {
        expect(hasEmbedTypeExtension('archive.zip')).toBe(false);
        expect(hasEmbedTypeExtension('data.json')).toBe(false);
        expect(hasEmbedTypeExtension('script.js')).toBe(false);
    });

    it('should handle case insensitivity', () => {
        expect(hasEmbedTypeExtension('PHOTO.PNG')).toBe(true);
        expect(hasEmbedTypeExtension('Report.PDF')).toBe(true);
    });

    it('should work with full paths', () => {
        expect(hasEmbedTypeExtension('assets/images/photo.png')).toBe(true);
        expect(hasEmbedTypeExtension('deep/nested/file.docx')).toBe(true);
    });
});

// ─── isExternalUrl ───────────────────────────────────────────────────────────

describe('isExternalUrl', () => {
    it('should return true for HTTP URLs', () => {
        expect(isExternalUrl('http://example.com/image.png')).toBe(true);
    });

    it('should return true for HTTPS URLs', () => {
        expect(isExternalUrl('https://example.com/doc.pdf')).toBe(true);
    });

    it('should return false for vault paths', () => {
        expect(isExternalUrl('folder/image.png')).toBe(false);
        expect(isExternalUrl('image.png')).toBe(false);
    });

    it('should return false for relative paths with dots', () => {
        expect(isExternalUrl('./assets/image.png')).toBe(false);
        expect(isExternalUrl('../images/photo.jpg')).toBe(false);
    });

    it('should return false for empty string', () => {
        expect(isExternalUrl('')).toBe(false);
    });
});

// ─── extractReferencesFromLine ───────────────────────────────────────────────

describe('extractReferencesFromLine', () => {
    describe('Wiki embeds (![[...]])', () => {
        it('should detect simple wiki embed', () => {
            const refs = extractReferencesFromLine('![[image.png]]', 1);
            expect(refs).toHaveLength(1);
            expect(refs[0]).toMatchObject({
                path: 'image.png',
                lineNumber: 1,
                isEmbedded: true,
            });
        });

        it('should detect wiki embed with alias', () => {
            const refs = extractReferencesFromLine('![[document.pdf|My Doc]]', 5);
            expect(refs).toHaveLength(1);
            expect(refs[0].path).toBe('document.pdf');
            expect(refs[0].isEmbedded).toBe(true);
        });

        it('should detect multiple wiki embeds on one line', () => {
            const refs = extractReferencesFromLine('![[a.png]] and ![[b.jpg]]', 3);
            expect(refs).toHaveLength(2);
            expect(refs[0].path).toBe('a.png');
            expect(refs[1].path).toBe('b.jpg');
        });
    });

    describe('Markdown embeds (![](...))', () => {
        it('should detect simple markdown embed', () => {
            const refs = extractReferencesFromLine('![alt](image.png)', 2);
            expect(refs).toHaveLength(1);
            expect(refs[0]).toMatchObject({
                path: 'image.png',
                lineNumber: 2,
                isEmbedded: true,
            });
        });

        it('should detect markdown embed with empty alt', () => {
            const refs = extractReferencesFromLine('![](photo.jpg)', 1);
            expect(refs).toHaveLength(1);
            expect(refs[0].path).toBe('photo.jpg');
        });
    });

    describe('Wiki links ([[...]])', () => {
        it('should detect simple wiki link', () => {
            const refs = extractReferencesFromLine('See [[report.pdf]] for details', 10);
            expect(refs).toHaveLength(1);
            expect(refs[0]).toMatchObject({
                path: 'report.pdf',
                lineNumber: 10,
                isEmbedded: false,
            });
        });

        it('should detect wiki link with display text', () => {
            const refs = extractReferencesFromLine('[[data.xlsx|Spreadsheet]]', 1);
            expect(refs).toHaveLength(1);
            expect(refs[0].path).toBe('data.xlsx');
            expect(refs[0].isEmbedded).toBe(false);
        });
    });

    describe('Markdown links ([](...))', () => {
        it('should detect markdown link (not embed)', () => {
            const refs = extractReferencesFromLine('[Download](report.pdf)', 7);
            expect(refs).toHaveLength(1);
            expect(refs[0]).toMatchObject({
                path: 'report.pdf',
                lineNumber: 7,
                isEmbedded: false,
            });
        });
    });

    describe('Mixed references', () => {
        it('should detect both embed and link on same line', () => {
            const refs = extractReferencesFromLine('![[image.png]] and [[doc.pdf]]', 1);
            expect(refs).toHaveLength(2);
            const embedded = refs.find(r => r.isEmbedded);
            const linked = refs.find(r => !r.isEmbedded);
            expect(embedded?.path).toBe('image.png');
            expect(linked?.path).toBe('doc.pdf');
        });

        it('should detect markdown embed followed by markdown link', () => {
            const refs = extractReferencesFromLine('![](img.png) and [link](file.pdf)', 1);
            expect(refs).toHaveLength(2);
            expect(refs.find(r => r.isEmbedded)?.path).toBe('img.png');
            expect(refs.find(r => !r.isEmbedded)?.path).toBe('file.pdf');
        });
    });

    describe('Non-dedup behavior', () => {
        it('should return duplicate references to same file', () => {
            const refs = extractReferencesFromLine('![[img.png]] text ![[img.png]]', 1);
            expect(refs).toHaveLength(2);
            expect(refs[0].path).toBe('img.png');
            expect(refs[1].path).toBe('img.png');
        });

        it('should return both embed and link to same file', () => {
            const refs = extractReferencesFromLine('![[file.pdf]] and [[file.pdf]]', 1);
            expect(refs).toHaveLength(2);
        });
    });

    describe('Edge cases', () => {
        it('should return empty array for plain text', () => {
            expect(extractReferencesFromLine('Just some plain text', 1)).toHaveLength(0);
        });

        it('should return empty array for empty line', () => {
            expect(extractReferencesFromLine('', 1)).toHaveLength(0);
        });

        it('should handle external URLs in markdown syntax', () => {
            const refs = extractReferencesFromLine('![](https://example.com/img.png)', 1);
            expect(refs).toHaveLength(1);
            expect(refs[0].path).toBe('https://example.com/img.png');
            // External URL filtering happens in scanNotes, not extractReferencesFromLine
        });

        it('should preserve line numbers correctly', () => {
            const refs = extractReferencesFromLine('![[test.png]]', 42);
            expect(refs[0].lineNumber).toBe(42);
        });

        it('should preserve original text', () => {
            const refs = extractReferencesFromLine('![[photo.jpg|thumbnail]]', 1);
            expect(refs[0].originalText).toBe('![[photo.jpg|thumbnail]]');
        });
    });
});

// ─── EMBED_TYPE_EXTENSIONS constant ──────────────────────────────────────────

describe('EMBED_TYPE_EXTENSIONS', () => {
    it('should include common image extensions', () => {
        expect(EMBED_TYPE_EXTENSIONS).toContain('.png');
        expect(EMBED_TYPE_EXTENSIONS).toContain('.jpg');
        expect(EMBED_TYPE_EXTENSIONS).toContain('.gif');
        expect(EMBED_TYPE_EXTENSIONS).toContain('.svg');
    });

    it('should include PDF', () => {
        expect(EMBED_TYPE_EXTENSIONS).toContain('.pdf');
    });

    it('should include audio extensions', () => {
        expect(EMBED_TYPE_EXTENSIONS).toContain('.mp3');
        expect(EMBED_TYPE_EXTENSIONS).toContain('.wav');
    });

    it('should include video extensions', () => {
        expect(EMBED_TYPE_EXTENSIONS).toContain('.mov');
    });

    it('should include document extensions', () => {
        expect(EMBED_TYPE_EXTENSIONS).toContain('.docx');
        expect(EMBED_TYPE_EXTENSIONS).toContain('.xlsx');
    });

    it('should NOT include .md', () => {
        expect(EMBED_TYPE_EXTENSIONS).not.toContain('.md');
    });

    it('should NOT include .js or .ts', () => {
        expect(EMBED_TYPE_EXTENSIONS).not.toContain('.js');
        expect(EMBED_TYPE_EXTENSIONS).not.toContain('.ts');
    });
});
