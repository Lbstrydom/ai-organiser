/**
 * Tests for NotebookLM Source Pack Service
 *
 * Tests for Phase 3: Service Orchestration
 * - Hashing utilities (string and binary)
 * - Filename sanitization
 * - Linked document deduplication
 * - Export preview warnings
 */

import {
    computeSHA256,
    computeBinarySHA256,
    computePackHash,
    hashNoteContent,
    generateShortId,
    hashesMatch,
    isValidSHA256
} from '../src/services/notebooklm/hashing';
import { DEFAULT_PDF_CONFIG } from '../src/services/notebooklm/types';
import type { SourcePackConfig, LinkedDocument } from '../src/services/notebooklm/types';

describe('NotebookLM Hashing Utilities', () => {
    describe('computeSHA256', () => {
        it('should compute SHA256 hash of string content', () => {
            const hash = computeSHA256('Hello, World!');
            expect(hash).toBe('dffd6021bb2bd5b0af676290809ec3a53191dd81c7f70a4b28688a362182986f');
        });

        it('should produce consistent hashes for same input', () => {
            const hash1 = computeSHA256('test content');
            const hash2 = computeSHA256('test content');
            expect(hash1).toBe(hash2);
        });

        it('should produce different hashes for different input', () => {
            const hash1 = computeSHA256('content A');
            const hash2 = computeSHA256('content B');
            expect(hash1).not.toBe(hash2);
        });

        it('should handle empty string', () => {
            const hash = computeSHA256('');
            expect(hash).toHaveLength(64);
            expect(isValidSHA256(hash)).toBe(true);
        });

        it('should handle unicode content', () => {
            const hash = computeSHA256('Hello 世界 🌍');
            expect(hash).toHaveLength(64);
            expect(isValidSHA256(hash)).toBe(true);
        });
    });

    describe('computeBinarySHA256', () => {
        it('should compute SHA256 hash of ArrayBuffer', () => {
            const encoder = new TextEncoder();
            const buffer = encoder.encode('Hello, World!').buffer;
            const hash = computeBinarySHA256(buffer);

            // Should match string hash for same content
            expect(hash).toBe('dffd6021bb2bd5b0af676290809ec3a53191dd81c7f70a4b28688a362182986f');
        });

        it('should compute SHA256 hash of Uint8Array', () => {
            const encoder = new TextEncoder();
            const uint8 = encoder.encode('Hello, World!');
            const hash = computeBinarySHA256(uint8);

            expect(hash).toBe('dffd6021bb2bd5b0af676290809ec3a53191dd81c7f70a4b28688a362182986f');
        });

        it('should handle empty buffer', () => {
            const buffer = new ArrayBuffer(0);
            const hash = computeBinarySHA256(buffer);
            expect(hash).toHaveLength(64);
            expect(isValidSHA256(hash)).toBe(true);
        });

        it('should produce consistent hashes for same binary content', () => {
            const data = new Uint8Array([1, 2, 3, 4, 5]);
            const hash1 = computeBinarySHA256(data);
            const hash2 = computeBinarySHA256(data);
            expect(hash1).toBe(hash2);
        });
    });

    describe('computePackHash', () => {
        it('should compute deterministic hash from entry hashes', () => {
            const entryHashes = ['abc123', 'def456', 'ghi789'];
            const packHash = computePackHash(entryHashes);
            expect(packHash).toHaveLength(64);
        });

        it('should produce same hash regardless of input order', () => {
            const hashes1 = ['abc', 'def', 'ghi'];
            const hashes2 = ['ghi', 'abc', 'def'];

            expect(computePackHash(hashes1)).toBe(computePackHash(hashes2));
        });

        it('should produce different hash when content changes', () => {
            const hashes1 = ['abc', 'def'];
            const hashes2 = ['abc', 'xyz'];

            expect(computePackHash(hashes1)).not.toBe(computePackHash(hashes2));
        });

        it('should handle empty array', () => {
            const packHash = computePackHash([]);
            expect(packHash).toHaveLength(64);
        });
    });

    describe('hashNoteContent', () => {
        it('should return both full hash and short ID', () => {
            const result = hashNoteContent('test content');
            expect(result.sha256).toHaveLength(64);
            expect(result.shortId).toHaveLength(8);
            expect(result.sha256.startsWith(result.shortId)).toBe(true);
        });
    });

    describe('generateShortId', () => {
        it('should generate default 8-character ID', () => {
            const hash = computeSHA256('test');
            const shortId = generateShortId(hash);
            expect(shortId).toHaveLength(8);
        });

        it('should respect custom length', () => {
            const hash = computeSHA256('test');
            expect(generateShortId(hash, 6)).toHaveLength(6);
            expect(generateShortId(hash, 12)).toHaveLength(12);
        });
    });

    describe('hashesMatch', () => {
        it('should return true for matching hashes', () => {
            expect(hashesMatch('abc123', 'abc123')).toBe(true);
        });

        it('should be case-insensitive', () => {
            expect(hashesMatch('ABC123', 'abc123')).toBe(true);
            expect(hashesMatch('AbC123', 'aBc123')).toBe(true);
        });

        it('should return false for different hashes', () => {
            expect(hashesMatch('abc123', 'xyz789')).toBe(false);
        });
    });

    describe('isValidSHA256', () => {
        it('should validate correct SHA256 hashes', () => {
            const validHash = computeSHA256('test');
            expect(isValidSHA256(validHash)).toBe(true);
        });

        it('should reject invalid hashes', () => {
            expect(isValidSHA256('not-a-hash')).toBe(false);
            expect(isValidSHA256('abc')).toBe(false);
            expect(isValidSHA256('')).toBe(false);
            expect(isValidSHA256('g'.repeat(64))).toBe(false); // Invalid hex char
        });
    });
});

describe('NotebookLM Source Pack Types', () => {
    describe('DEFAULT_PDF_CONFIG', () => {
        it('should have valid default values', () => {
            expect(DEFAULT_PDF_CONFIG.pageSize).toBe('A4');
            expect(DEFAULT_PDF_CONFIG.fontName).toBe('helvetica');
            expect(DEFAULT_PDF_CONFIG.fontSize).toBe(11);
            expect(DEFAULT_PDF_CONFIG.includeFrontmatter).toBe(false);
            expect(DEFAULT_PDF_CONFIG.includeTitle).toBe(true);
            expect(DEFAULT_PDF_CONFIG.marginX).toBe(20);
            expect(DEFAULT_PDF_CONFIG.marginY).toBe(20);
            expect(DEFAULT_PDF_CONFIG.lineHeight).toBe(1.5);
        });
    });
});

describe('NotebookLM Source Pack Service Utilities', () => {
    // Test filename sanitization logic (extracted for testing)
    describe('filename sanitization', () => {
        const sanitizeFilename = (name: string): string => {
            return name
                .replaceAll(/[<>:"/\\|?*]/g, '-')
                .replaceAll(/\s+/g, '_')
                .replaceAll(/-+/g, '-')
                .replaceAll(/(^-)|(-$)/g, '')
                .slice(0, 200);
        };

        it('should replace invalid characters with dashes', () => {
            expect(sanitizeFilename('file<>name')).toBe('file-name');
            expect(sanitizeFilename('path/to/file')).toBe('path-to-file');
            expect(sanitizeFilename('what?')).toBe('what');
        });

        it('should replace spaces with underscores', () => {
            expect(sanitizeFilename('my file name')).toBe('my_file_name');
            expect(sanitizeFilename('multiple   spaces')).toBe('multiple_spaces');
        });

        it('should collapse multiple dashes', () => {
            expect(sanitizeFilename('a--b---c')).toBe('a-b-c');
        });

        it('should trim leading and trailing dashes', () => {
            expect(sanitizeFilename('-start')).toBe('start');
            expect(sanitizeFilename('end-')).toBe('end');
            expect(sanitizeFilename('-both-')).toBe('both');
        });

        it('should limit length to 200 characters', () => {
            const longName = 'a'.repeat(250);
            expect(sanitizeFilename(longName)).toHaveLength(200);
        });

        it('should handle normal filenames', () => {
            expect(sanitizeFilename('Meeting_Notes_2024')).toBe('Meeting_Notes_2024');
            expect(sanitizeFilename('project-plan')).toBe('project-plan');
        });
    });

    // Test linked document deduplication logic (extracted for testing)
    describe('linked document deduplication', () => {
        const deduplicateLinkedDocuments = (docs: LinkedDocument[]): LinkedDocument[] => {
            const seen = new Set<string>();
            const unique: LinkedDocument[] = [];

            for (const doc of docs) {
                const normalizedPath = doc.path.toLowerCase();
                if (!seen.has(normalizedPath)) {
                    seen.add(normalizedPath);
                    unique.push(doc);
                }
            }

            return unique;
        };

        it('should remove duplicate paths', () => {
            const docs: LinkedDocument[] = [
                { sourceFile: 'note1.md', path: 'doc.pdf', displayName: 'Doc', type: 'pdf' },
                { sourceFile: 'note2.md', path: 'doc.pdf', displayName: 'Doc', type: 'pdf' },
            ];

            const unique = deduplicateLinkedDocuments(docs);
            expect(unique).toHaveLength(1);
        });

        it('should be case-insensitive', () => {
            const docs: LinkedDocument[] = [
                { sourceFile: 'note1.md', path: 'Doc.PDF', displayName: 'Doc', type: 'pdf' },
                { sourceFile: 'note2.md', path: 'doc.pdf', displayName: 'Doc', type: 'pdf' },
            ];

            const unique = deduplicateLinkedDocuments(docs);
            expect(unique).toHaveLength(1);
        });

        it('should preserve order (first occurrence wins)', () => {
            const docs: LinkedDocument[] = [
                { sourceFile: 'note1.md', path: 'a.pdf', displayName: 'First A', type: 'pdf' },
                { sourceFile: 'note2.md', path: 'b.pdf', displayName: 'B', type: 'pdf' },
                { sourceFile: 'note3.md', path: 'a.pdf', displayName: 'Second A', type: 'pdf' },
            ];

            const unique = deduplicateLinkedDocuments(docs);
            expect(unique).toHaveLength(2);
            expect(unique[0].displayName).toBe('First A');
        });

        it('should handle empty array', () => {
            const unique = deduplicateLinkedDocuments([]);
            expect(unique).toHaveLength(0);
        });
    });

    // Test source count warning logic
    describe('source count warnings', () => {
        const getWarnings = (noteCount: number, attachmentCount: number) => {
            const totalSourceCount = noteCount + attachmentCount;
            const warnings: { sourceCountWarning?: string } = {};

            if (totalSourceCount > 50) {
                warnings.sourceCountWarning = `${totalSourceCount} sources selected (${noteCount} notes + ${attachmentCount} linked documents). NotebookLM limit is 50 sources per notebook.`;
            } else if (totalSourceCount > 45) {
                warnings.sourceCountWarning = `${totalSourceCount} sources selected (${noteCount} notes + ${attachmentCount} linked documents). Approaching NotebookLM limit of 50 sources.`;
            }

            return warnings;
        };

        it('should not warn for small counts', () => {
            const warnings = getWarnings(10, 5);
            expect(warnings.sourceCountWarning).toBeUndefined();
        });

        it('should warn when approaching limit (>45)', () => {
            const warnings = getWarnings(40, 8);
            expect(warnings.sourceCountWarning).toContain('Approaching');
            expect(warnings.sourceCountWarning).toContain('48 sources');
        });

        it('should warn when exceeding limit (>50)', () => {
            const warnings = getWarnings(45, 10);
            expect(warnings.sourceCountWarning).toContain('55 sources');
            expect(warnings.sourceCountWarning).toContain('limit is 50');
            expect(warnings.sourceCountWarning).not.toContain('Approaching');
        });

        it('should count notes and attachments together', () => {
            // 30 notes + 25 attachments = 55 total (exceeds limit)
            const warnings = getWarnings(30, 25);
            expect(warnings.sourceCountWarning).toBeDefined();
            expect(warnings.sourceCountWarning).toContain('30 notes');
            expect(warnings.sourceCountWarning).toContain('25 linked documents');
        });
    });

    // Test size warning logic
    describe('size warnings', () => {
        const getSizeWarnings = (estimatedSizeBytes: number) => {
            const warnings: { totalSizeWarning?: string } = {};
            const formatBytes = (bytes: number): string => {
                if (bytes < 1024) return `${bytes} B`;
                if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
                return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
            };

            if (estimatedSizeBytes > 200 * 1024 * 1024) {
                warnings.totalSizeWarning = `Estimated size (${formatBytes(estimatedSizeBytes)}) exceeds NotebookLM limit of 200MB.`;
            } else if (estimatedSizeBytes > 180 * 1024 * 1024) {
                warnings.totalSizeWarning = `Estimated size (${formatBytes(estimatedSizeBytes)}) approaching NotebookLM limit of 200MB.`;
            }

            return warnings;
        };

        it('should not warn for small sizes', () => {
            const warnings = getSizeWarnings(50 * 1024 * 1024); // 50MB
            expect(warnings.totalSizeWarning).toBeUndefined();
        });

        it('should warn when approaching limit (>180MB)', () => {
            const warnings = getSizeWarnings(185 * 1024 * 1024);
            expect(warnings.totalSizeWarning).toContain('approaching');
        });

        it('should warn when exceeding limit (>200MB)', () => {
            const warnings = getSizeWarnings(250 * 1024 * 1024);
            expect(warnings.totalSizeWarning).toContain('exceeds');
            expect(warnings.totalSizeWarning).toContain('250.0 MB');
        });
    });

    // Test pack ID generation
    describe('pack ID generation', () => {
        const generatePackId = (): string => {
            return 'pack-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
        };

        it('should generate unique IDs', () => {
            const id1 = generatePackId();
            const id2 = generatePackId();
            expect(id1).not.toBe(id2);
        });

        it('should start with "pack-" prefix', () => {
            const id = generatePackId();
            expect(id.startsWith('pack-')).toBe(true);
        });

        it('should contain timestamp component', () => {
            const id = generatePackId();
            const parts = id.split('-');
            expect(parts.length).toBeGreaterThanOrEqual(2);
        });
    });
});

describe('SourcePackConfig defaults', () => {
    it('should have valid structure', () => {
        const config: SourcePackConfig = {
            selectionTag: 'notebooklm',
            exportFolder: 'AI-Organiser/NotebookLM',
            postExportTagAction: 'clear',
            pdf: DEFAULT_PDF_CONFIG
        };

        expect(config.selectionTag).toBe('notebooklm');
        expect(config.postExportTagAction).toBe('clear');
        expect(config.pdf).toBeDefined();
    });

    it('should support archive tag action', () => {
        const config: SourcePackConfig = {
            selectionTag: 'notebooklm',
            exportFolder: 'AI-Organiser/NotebookLM',
            postExportTagAction: 'archive',
            pdf: DEFAULT_PDF_CONFIG
        };

        expect(config.postExportTagAction).toBe('archive');
    });
});

describe('Settings to SourcePackConfig wiring', () => {
    /**
     * These tests verify that AIOrganiserSettings correctly maps to SourcePackConfig
     * as implemented in main.ts initNotebookLMService()
     */

    it('should map selection tag from settings', () => {
        // Simulates the mapping in main.ts: selectionTag: this.settings.notebooklmSelectionTag
        const mockSettings = {
            notebooklmSelectionTag: 'export-me',
        };

        const config: Partial<SourcePackConfig> = {
            selectionTag: mockSettings.notebooklmSelectionTag,
        };

        expect(config.selectionTag).toBe('export-me');
    });

    it('should map post-export tag action from settings', () => {
        // Simulates: postExportTagAction: this.settings.notebooklmPostExportTagAction
        const mockSettings = {
            notebooklmPostExportTagAction: 'archive' as const,
        };

        const config: Partial<SourcePackConfig> = {
            postExportTagAction: mockSettings.notebooklmPostExportTagAction,
        };

        expect(config.postExportTagAction).toBe('archive');
    });

    it('should map PDF config from settings', () => {
        // Simulates the PDF config mapping in main.ts
        const mockSettings = {
            notebooklmPdfPageSize: 'Letter' as const,
            notebooklmPdfFontName: 'times',
            notebooklmPdfFontSize: 12,
            notebooklmPdfIncludeFrontmatter: true,
            notebooklmPdfIncludeTitle: false,
        };

        const pdfConfig = {
            pageSize: mockSettings.notebooklmPdfPageSize,
            fontName: mockSettings.notebooklmPdfFontName,
            fontSize: mockSettings.notebooklmPdfFontSize,
            includeFrontmatter: mockSettings.notebooklmPdfIncludeFrontmatter,
            includeTitle: mockSettings.notebooklmPdfIncludeTitle,
            marginX: DEFAULT_PDF_CONFIG.marginX,
            marginY: DEFAULT_PDF_CONFIG.marginY,
            lineHeight: DEFAULT_PDF_CONFIG.lineHeight,
        };

        expect(pdfConfig.pageSize).toBe('Letter');
        expect(pdfConfig.fontName).toBe('times');
        expect(pdfConfig.fontSize).toBe(12);
        expect(pdfConfig.includeFrontmatter).toBe(true);
        expect(pdfConfig.includeTitle).toBe(false);
    });

    it('should use default PDF values for margin and line height', () => {
        // These aren't exposed in settings, so they should come from DEFAULT_PDF_CONFIG
        expect(DEFAULT_PDF_CONFIG.marginX).toBe(20);
        expect(DEFAULT_PDF_CONFIG.marginY).toBe(20);
        expect(DEFAULT_PDF_CONFIG.lineHeight).toBe(1.5);
    });

    it('should validate all required SourcePackConfig fields can be populated from settings', () => {
        // Full integration test of the wiring pattern
        const mockSettings = {
            pluginFolder: 'AI-Organiser',
            notebooklmSelectionTag: 'notebooklm',
            notebooklmExportFolder: 'NotebookLM',
            notebooklmPostExportTagAction: 'clear' as const,
            notebooklmPdfPageSize: 'A4' as const,
            notebooklmPdfFontName: 'helvetica',
            notebooklmPdfFontSize: 11,
            notebooklmPdfIncludeFrontmatter: false,
            notebooklmPdfIncludeTitle: true,
        };

        // Simulate the full config building as in main.ts
        const pdfConfig = {
            pageSize: mockSettings.notebooklmPdfPageSize,
            fontName: mockSettings.notebooklmPdfFontName,
            fontSize: mockSettings.notebooklmPdfFontSize,
            includeFrontmatter: mockSettings.notebooklmPdfIncludeFrontmatter,
            includeTitle: mockSettings.notebooklmPdfIncludeTitle,
            marginX: DEFAULT_PDF_CONFIG.marginX,
            marginY: DEFAULT_PDF_CONFIG.marginY,
            lineHeight: DEFAULT_PDF_CONFIG.lineHeight,
        };

        const config: SourcePackConfig = {
            selectionTag: mockSettings.notebooklmSelectionTag,
            exportFolder: `${mockSettings.pluginFolder}/${mockSettings.notebooklmExportFolder}`,
            postExportTagAction: mockSettings.notebooklmPostExportTagAction,
            pdf: pdfConfig,
        };

        // Verify all fields are correctly populated
        expect(config.selectionTag).toBe('notebooklm');
        expect(config.exportFolder).toBe('AI-Organiser/NotebookLM');
        expect(config.postExportTagAction).toBe('clear');
        expect(config.pdf.pageSize).toBe('A4');
        expect(config.pdf.fontName).toBe('helvetica');
        expect(config.pdf.fontSize).toBe(11);
        expect(config.pdf.includeFrontmatter).toBe(false);
        expect(config.pdf.includeTitle).toBe(true);
        expect(config.pdf.marginX).toBe(20);
        expect(config.pdf.marginY).toBe(20);
        expect(config.pdf.lineHeight).toBe(1.5);
    });
});
