import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DocumentHandlingController, DocumentItem, AddResult } from '../src/ui/controllers/DocumentHandlingController';
import type { App, TFile } from 'obsidian';
import { DocumentExtractionService } from '../src/services/documentExtractionService';
import type AIOrganiserPlugin from '../src/main';

// Mock Obsidian modules
vi.mock('obsidian', () => ({
    App: vi.fn(),
    TFile: vi.fn(),
    Modal: vi.fn(),
    Notice: vi.fn()
}));

describe('DocumentHandlingController', () => {
    let controller: DocumentHandlingController;
    let mockApp: any;
    let mockPlugin: any;
    let mockDocumentService: any;

    beforeEach(() => {
        // Setup mocks
        mockApp = {
            workspace: {
                getActiveFile: vi.fn().mockReturnValue(null)
            },
            vault: {
                getFiles: vi.fn().mockReturnValue([])
            }
        };

        mockPlugin = {
            settings: {
                maxDocumentChars: 50000,
                oversizedDocumentBehavior: 'ask'
            }
        };

        mockDocumentService = {
            extractText: vi.fn(),
            extractFromUrl: vi.fn()
        };

        controller = new DocumentHandlingController(
            mockApp as any,
            mockPlugin as any,
            mockDocumentService
        );
    });

    describe('addFromVault', () => {
        it('should add a valid document from vault', () => {
            const mockFile: any = {
                path: 'folder/doc.pdf',
                name: 'doc.pdf',
                extension: 'pdf'
            };

            const result = controller.addFromVault(mockFile);

            expect(result.added).toBe(true);
            expect(result.error).toBeUndefined();
            expect(controller.getCount()).toBe(1);
            const docs = controller.getDocuments();
            expect(docs[0].id).toBe('folder/doc.pdf');
            expect(docs[0].name).toBe('doc.pdf');
            expect(docs[0].path).toBe('folder/doc.pdf');
            expect(docs[0].isExternal).toBe(false);
        });

        it('should reject unsupported file types', () => {
            const mockFile: any = {
                path: 'folder/doc.unsupported',
                name: 'doc.unsupported',
                extension: 'unsupported'
            };

            const result = controller.addFromVault(mockFile);

            expect(result.added).toBe(false);
            expect(result.error).toContain('Unsupported file type');
            expect(controller.getCount()).toBe(0);
        });

        it('should detect duplicate by path', () => {
            const mockFile: any = {
                path: 'folder/doc.pdf',
                name: 'doc.pdf',
                extension: 'pdf'
            };

            const result1 = controller.addFromVault(mockFile);
            const result2 = controller.addFromVault(mockFile);

            expect(result1.added).toBe(true);
            expect(result2.added).toBe(false);
            expect(result2.duplicate).toBe(true);
            expect(controller.getCount()).toBe(1);
        });
    });

    describe('addFromUrl', () => {
        it('should add a valid HTTPS URL', () => {
            const url = 'https://example.com/doc.pdf';
            const result = controller.addFromUrl(url);

            expect(result.added).toBe(true);
            expect(result.error).toBeUndefined();
            expect(controller.getCount()).toBe(1);
            const docs = controller.getDocuments();
            expect(docs[0].isExternal).toBe(true);
            expect(docs[0].url).toBe(url);
            expect(docs[0].id).toBe('https://example.com/doc.pdf');
        });

        it('should reject non-HTTPS URLs', () => {
            const url = 'http://example.com/doc.pdf';
            const result = controller.addFromUrl(url);

            expect(result.added).toBe(false);
            expect(result.error).toContain('HTTPS');
            expect(controller.getCount()).toBe(0);
        });

        it('should normalize and detect duplicate URLs', () => {
            const url1 = 'https://Example.com/path/';
            const url2 = 'https://example.com/path';

            const result1 = controller.addFromUrl(url1);
            const result2 = controller.addFromUrl(url2);

            expect(result1.added).toBe(true);
            expect(result2.added).toBe(false);
            expect(result2.duplicate).toBe(true);
            expect(controller.getCount()).toBe(1);
        });

        it('should reject invalid URLs', () => {
            const url = 'not-a-url';
            const result = controller.addFromUrl(url);

            expect(result.added).toBe(false);
            expect(result.error).toContain('Invalid URL');
        });
    });

    describe('extractDocument', () => {
        it('should extract from vault file', async () => {
            const mockFile: any = {
                path: 'folder/doc.pdf',
                name: 'doc.pdf',
                extension: 'pdf'
            };

            controller.addFromVault(mockFile);

            mockDocumentService.extractText.mockResolvedValue({
                success: true,
                text: 'Extracted content here'
            });

            const result = await controller.extractDocument('folder/doc.pdf');

            expect(result.success).toBe(true);
            expect(mockDocumentService.extractText).toHaveBeenCalledWith(mockFile);

            const docs = controller.getDocuments();
            expect(docs[0].fullText).toBe('Extracted content here');
            expect(docs[0].extractedText).toBeDefined();
        });

        it('should extract from external URL', async () => {
            const url = 'https://example.com/doc.pdf';
            controller.addFromUrl(url);

            mockDocumentService.extractFromUrl.mockResolvedValue({
                success: true,
                text: 'URL content here'
            });

            const normalizedUrl = 'https://example.com/doc.pdf';
            const result = await controller.extractDocument(url);

            expect(result.success).toBe(true);
            expect(mockDocumentService.extractFromUrl).toHaveBeenCalledWith(url);

            const docs = controller.getDocuments();
            expect(docs[0].fullText).toBe('URL content here');
        });

        it('should handle extraction errors', async () => {
            const mockFile: any = {
                path: 'folder/doc.pdf',
                name: 'doc.pdf',
                extension: 'pdf'
            };

            controller.addFromVault(mockFile);

            mockDocumentService.extractText.mockResolvedValue({
                success: false,
                error: 'Extraction failed'
            });

            const result = await controller.extractDocument('folder/doc.pdf');

            expect(result.success).toBe(false);
            expect(result.error).toContain('Extraction failed');

            const docs = controller.getDocuments();
            expect(docs[0].error).toBeDefined();
        });
    });

    describe('truncation', () => {
        beforeEach(() => {
            mockPlugin.settings.maxDocumentChars = 100;
        });

        it('should apply truncation choice - truncate', async () => {
            const mockFile: any = {
                path: 'folder/doc.pdf',
                name: 'doc.pdf',
                extension: 'pdf'
            };

            controller.addFromVault(mockFile);

            const longText = 'a'.repeat(200);
            mockDocumentService.extractText.mockResolvedValue({
                success: true,
                text: longText
            });

            await controller.extractDocument('folder/doc.pdf');
            controller.setTruncationChoice('folder/doc.pdf', 'truncate');

            const docs = controller.getDocuments();
            expect(docs[0].extractedText).toHaveLength(100 + '\n\n[Truncated...]'.length);
            expect(docs[0].extractedText).toContain('[Truncated...]');
        });

        it('should apply truncation choice - full', async () => {
            const mockFile: any = {
                path: 'folder/doc.pdf',
                name: 'doc.pdf',
                extension: 'pdf'
            };

            controller.addFromVault(mockFile);

            const longText = 'a'.repeat(200);
            mockDocumentService.extractText.mockResolvedValue({
                success: true,
                text: longText
            });

            await controller.extractDocument('folder/doc.pdf');
            controller.setTruncationChoice('folder/doc.pdf', 'full');

            const docs = controller.getDocuments();
            expect(docs[0].extractedText).toBe(longText);
        });

        it('should apply truncation choice - skip', async () => {
            const mockFile: any = {
                path: 'folder/doc.pdf',
                name: 'doc.pdf',
                extension: 'pdf'
            };

            controller.addFromVault(mockFile);

            mockDocumentService.extractText.mockResolvedValue({
                success: true,
                text: 'content'
            });

            await controller.extractDocument('folder/doc.pdf');
            controller.setTruncationChoice('folder/doc.pdf', 'skip');

            const docs = controller.getDocuments();
            expect(docs[0].extractedText).toBe('');
            expect(docs[0].error).toContain('Excluded');
        });

        it('should identify oversized documents', async () => {
            const mockFile: any = {
                path: 'folder/doc.pdf',
                name: 'doc.pdf',
                extension: 'pdf'
            };

            controller.addFromVault(mockFile);

            const longText = 'a'.repeat(200);
            mockDocumentService.extractText.mockResolvedValue({
                success: true,
                text: longText
            });

            await controller.extractDocument('folder/doc.pdf');

            const oversized = controller.getOversizedDocuments();
            expect(oversized).toHaveLength(1);
            expect(oversized[0].charCount).toBe(200);
        });

        it('should apply truncation to all oversized documents', async () => {
            // Add two oversized documents
            const mockFile1: any = {
                path: 'folder/doc1.pdf',
                name: 'doc1.pdf',
                extension: 'pdf'
            };
            const mockFile2: any = {
                path: 'folder/doc2.pdf',
                name: 'doc2.pdf',
                extension: 'pdf'
            };

            controller.addFromVault(mockFile1);
            controller.addFromVault(mockFile2);

            const longText = 'a'.repeat(200);
            mockDocumentService.extractText.mockResolvedValue({
                success: true,
                text: longText
            });

            await controller.extractDocument('folder/doc1.pdf');
            await controller.extractDocument('folder/doc2.pdf');

            controller.applyTruncationToAll('skip');

            const docs = controller.getDocuments();
            expect(docs[0].truncationChoice).toBe('skip');
            expect(docs[1].truncationChoice).toBe('skip');
            expect(docs[0].extractedText).toBe('');
            expect(docs[1].extractedText).toBe('');
        });
    });

    describe('removeDocument', () => {
        it('should remove document by ID', () => {
            const mockFile: any = {
                path: 'folder/doc.pdf',
                name: 'doc.pdf',
                extension: 'pdf'
            };

            controller.addFromVault(mockFile);
            expect(controller.getCount()).toBe(1);

            const removed = controller.removeDocument('folder/doc.pdf');

            expect(removed).toBe(true);
            expect(controller.getCount()).toBe(0);
        });

        it('should return false for non-existent document', () => {
            const removed = controller.removeDocument('non-existent');

            expect(removed).toBe(false);
        });
    });

    describe('extractAll', () => {
        it('should extract all documents and return results', async () => {
            const mockFile1: any = {
                path: 'folder/doc1.pdf',
                name: 'doc1.pdf',
                extension: 'pdf'
            };
            const mockFile2: any = {
                path: 'folder/doc2.pdf',
                name: 'doc2.pdf',
                extension: 'pdf'
            };

            controller.addFromVault(mockFile1);
            controller.addFromVault(mockFile2);

            mockDocumentService.extractText.mockResolvedValue({
                success: true,
                text: 'content'
            });

            const result = await controller.extractAll();

            expect(result.documents).toHaveLength(2);
            expect(result.extractedContents.size).toBe(2);
            expect(result.errors).toHaveLength(0);
        });

        it('should collect errors from failed extractions', async () => {
            const mockFile1: any = {
                path: 'folder/doc1.pdf',
                name: 'doc1.pdf',
                extension: 'pdf'
            };
            const mockFile2: any = {
                path: 'folder/doc2.pdf',
                name: 'doc2.pdf',
                extension: 'pdf'
            };

            controller.addFromVault(mockFile1);
            controller.addFromVault(mockFile2);

            mockDocumentService.extractText
                .mockResolvedValueOnce({
                    success: true,
                    text: 'content'
                })
                .mockResolvedValueOnce({
                    success: false,
                    error: 'Failed to extract'
                });

            const result = await controller.extractAll();

            expect(result.extractedContents.size).toBe(1);
            expect(result.errors).toHaveLength(1);
            expect(result.errors[0]).toContain('Failed to extract');
        });
    });

    describe('getCombinedExtractedText', () => {
        it('should combine extracted text from all documents', async () => {
            const mockFile1: any = {
                path: 'folder/doc1.pdf',
                name: 'doc1.pdf',
                extension: 'pdf'
            };
            const mockFile2: any = {
                path: 'folder/doc2.pdf',
                name: 'doc2.pdf',
                extension: 'pdf'
            };

            controller.addFromVault(mockFile1);
            controller.addFromVault(mockFile2);

            mockDocumentService.extractText
                .mockResolvedValueOnce({
                    success: true,
                    text: 'content1'
                })
                .mockResolvedValueOnce({
                    success: true,
                    text: 'content2'
                });

            await controller.extractAll();

            const combined = controller.getCombinedExtractedText();

            expect(combined).toContain('### doc1.pdf');
            expect(combined).toContain('content1');
            expect(combined).toContain('### doc2.pdf');
            expect(combined).toContain('content2');
            expect(combined).toContain('---');
        });

        it('should exclude skipped documents', async () => {
            const mockFile: any = {
                path: 'folder/doc.pdf',
                name: 'doc.pdf',
                extension: 'pdf'
            };

            controller.addFromVault(mockFile);

            mockDocumentService.extractText.mockResolvedValue({
                success: true,
                text: 'content'
            });

            await controller.extractDocument('folder/doc.pdf');
            controller.setTruncationChoice('folder/doc.pdf', 'skip');

            const combined = controller.getCombinedExtractedText();

            expect(combined).toBe('');
        });
    });

    describe('clear', () => {
        it('should clear all documents and cache', async () => {
            const mockFile: any = {
                path: 'folder/doc.pdf',
                name: 'doc.pdf',
                extension: 'pdf'
            };

            controller.addFromVault(mockFile);

            mockDocumentService.extractText.mockResolvedValue({
                success: true,
                text: 'content'
            });

            await controller.extractDocument('folder/doc.pdf');

            expect(controller.getCount()).toBe(1);

            controller.clear();

            expect(controller.getCount()).toBe(0);
            expect(controller.getDocuments()).toHaveLength(0);
        });
    });

    describe('isAnyProcessing', () => {
        it('should return true when extraction is in progress', async () => {
            const mockFile: any = {
                path: 'folder/doc.pdf',
                name: 'doc.pdf',
                extension: 'pdf'
            };

            controller.addFromVault(mockFile);

            mockDocumentService.extractText.mockImplementation(() => {
                return new Promise((resolve) => {
                    setTimeout(() => {
                        resolve({
                            success: true,
                            text: 'content'
                        });
                    }, 100);
                });
            });

            const extractPromise = controller.extractDocument('folder/doc.pdf');

            // Check immediately while processing
            expect(controller.isAnyProcessing()).toBe(true);

            await extractPromise;

            expect(controller.isAnyProcessing()).toBe(false);
        });
    });

    describe('default truncation choice by setting', () => {
        it('should use truncate when oversizedDocumentBehavior is ask', () => {
            mockPlugin.settings.oversizedDocumentBehavior = 'ask';

            const mockFile: any = {
                path: 'folder/doc.pdf',
                name: 'doc.pdf',
                extension: 'pdf'
            };

            controller.addFromVault(mockFile);
            const docs = controller.getDocuments();

            expect(docs[0].truncationChoice).toBe('truncate');
        });

        it('should use truncate when oversizedDocumentBehavior is truncate', () => {
            mockPlugin.settings.oversizedDocumentBehavior = 'truncate';

            const mockFile: any = {
                path: 'folder/doc.pdf',
                name: 'doc.pdf',
                extension: 'pdf'
            };

            controller.addFromVault(mockFile);
            const docs = controller.getDocuments();

            expect(docs[0].truncationChoice).toBe('truncate');
        });

        it('should use full when oversizedDocumentBehavior is full', () => {
            mockPlugin.settings.oversizedDocumentBehavior = 'full';

            const mockFile: any = {
                path: 'folder/doc.pdf',
                name: 'doc.pdf',
                extension: 'pdf'
            };

            controller.addFromVault(mockFile);
            const docs = controller.getDocuments();

            expect(docs[0].truncationChoice).toBe('full');
        });
    });

    describe('already processing error', () => {
        it('should return error when document is already being processed', async () => {
            const mockFile: any = {
                path: 'folder/doc.pdf',
                name: 'doc.pdf',
                extension: 'pdf'
            };

            controller.addFromVault(mockFile);

            mockDocumentService.extractText.mockImplementation(() => {
                return new Promise((resolve) => {
                    setTimeout(() => {
                        resolve({ success: true, text: 'content' });
                    }, 100);
                });
            });

            // Start first extraction
            const firstPromise = controller.extractDocument('folder/doc.pdf');

            // Try to start another extraction immediately
            const secondResult = await controller.extractDocument('folder/doc.pdf');

            expect(secondResult.success).toBe(false);
            expect(secondResult.error).toContain('already being processed');

            await firstPromise;
        });
    });

    describe('setTruncationChoice errors', () => {
        it('should return error for non-existent document', () => {
            const result = controller.setTruncationChoice('nonexistent', 'truncate');

            expect(result.success).toBe(false);
            expect(result.error).toContain('not found');
        });
    });

    describe('extractDocument with no valid source', () => {
        it('should return error when document has no file or URL', async () => {
            // Manually add a document with no source (edge case)
            const mockFile: any = {
                path: 'folder/doc.pdf',
                name: 'doc.pdf',
                extension: 'pdf'
            };
            controller.addFromVault(mockFile);

            // Remove the file reference to simulate edge case
            const docs = (controller as any).documents;
            docs[0].file = undefined;
            docs[0].isExternal = false;

            const result = await controller.extractDocument('folder/doc.pdf');

            expect(result.success).toBe(false);
            expect(result.error).toContain('No valid source');
        });
    });
});

