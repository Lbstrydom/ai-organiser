import { App, TFile } from 'obsidian';
import { DocumentExtractionService } from '../../services/documentExtractionService';
import type AIOrganiserPlugin from '../../main';
import { TruncationChoice, DEFAULT_MAX_DOCUMENT_CHARS, ALL_DOCUMENT_EXTENSIONS } from '../../core/constants';
import { detectEmbeddedDocuments } from '../../utils/embeddedContentDetector';

export interface DocumentItem {
    readonly id: string;
    name: string;
    path?: string;
    isExternal: boolean;
    url?: string;
    file?: TFile;
    truncationChoice: TruncationChoice;
    charCount: number;
    fullText?: string;
    extractedText?: string;
    isProcessing: boolean;
    error?: string;
}

export interface AddResult {
    added: boolean;
    duplicate?: boolean;
    error?: string;
}

export interface DocumentHandlingResult {
    documents: DocumentItem[];
    extractedContents: Map<string, string>;
    errors: string[];
}

/**
 * Controller for document handling in Minutes and Multi-Source modals
 * Manages document state, extraction, truncation, and caching
 * Follows no-stubs policy: all public methods are fully implemented
 */
export class DocumentHandlingController {
    private app: App;
    private plugin: AIOrganiserPlugin;
    private documentService: DocumentExtractionService;
    private documents: DocumentItem[] = [];
    private contentCache: Map<string, string> = new Map();

    constructor(
        app: App,
        plugin: AIOrganiserPlugin,
        documentService: DocumentExtractionService
    ) {
        this.app = app;
        this.plugin = plugin;
        this.documentService = documentService;
    }

    /**
     * Compute stable ID from document properties
     * - Vault files: full path (e.g., "Folder/Sub/file.docx")
     * - External URLs: normalized URL (lowercase host, no trailing slash)
     */
    static getDocumentId(item: Pick<DocumentItem, 'isExternal' | 'path' | 'url'>): string {
        if (item.isExternal && item.url) {
            return DocumentHandlingController.normalizeUrl(item.url);
        }
        return item.path || '';
    }

    /**
     * Normalize URL for deduplication and ID generation
     * - Lowercase hostname
     * - Remove trailing slash
     * - Preserve path and query
     */
    private static normalizeUrl(url: string): string {
        try {
            const parsed = new URL(url);
            const normalized = `${parsed.protocol}//${parsed.hostname.toLowerCase()}${parsed.pathname.replace(/\/$/, '')}${parsed.search}`;
            return normalized;
        } catch {
            return url.toLowerCase();
        }
    }

    /**
     * Get maximum document character limit from settings
     */
    getMaxChars(): number {
        return this.plugin.settings.maxDocumentChars || DEFAULT_MAX_DOCUMENT_CHARS;
    }

    /**
     * Get default truncation choice based on settings
     * When 'ask', defaults to 'truncate' (safe option) - user can change via UI
     */
    private getDefaultTruncationChoice(): TruncationChoice {
        const behavior = this.plugin.settings.oversizedDocumentBehavior || 'ask';
        if (behavior === 'full') return 'full';
        return 'truncate'; // Default safe option for 'ask' and 'truncate'
    }

    /**
     * Get copy of all documents (immutable for UI)
     */
    getDocuments(): DocumentItem[] {
        return this.documents.map(d => ({ ...d }));
    }

    /**
     * Get document by ID
     */
    private getDocumentById(docId: string): DocumentItem | undefined {
        return this.documents.find(d => d.id === docId);
    }

    /**
     * Add document from vault file
     * Deduplicates by path
     * Returns result object indicating success, duplicate, or error
     */
    addFromVault(file: TFile): AddResult {
        // Validate extension
        const ext = file.extension.toLowerCase();
        if (!ALL_DOCUMENT_EXTENSIONS.includes(ext as typeof ALL_DOCUMENT_EXTENSIONS[number])) {
            return {
                added: false,
                error: `Unsupported file type: ${ext}`
            };
        }

        // Check for duplicates by ID
        const docId = file.path;
        if (this.documents.some(d => d.id === docId)) {
            return {
                added: false,
                duplicate: true,
                error: 'Document already added'
            };
        }

        const defaultChoice = this.getDefaultTruncationChoice();

        const newDoc: DocumentItem = {
            id: docId,
            name: file.name,
            path: file.path,
            isExternal: false,
            file,
            truncationChoice: defaultChoice,
            charCount: 0,
            isProcessing: false
        };

        this.documents.push(newDoc);
        return { added: true };
    }

    /**
     * Add document from external URL
     * Deduplicates by normalized URL
     * Returns result object indicating success, duplicate, or error
     */
    addFromUrl(url: string): AddResult {
        // Validate URL
        try {
            const parsed = new URL(url);
            if (parsed.protocol !== 'https:') {
                return {
                    added: false,
                    error: 'Only HTTPS URLs are supported'
                };
            }
        } catch {
            return {
                added: false,
                error: 'Invalid URL'
            };
        }

        // Check for duplicates by normalized URL
        const docId = DocumentHandlingController.normalizeUrl(url);
        if (this.documents.some(d => d.id === docId)) {
            return {
                added: false,
                duplicate: true,
                error: 'URL already added'
            };
        }

        // Extract filename from URL
        const filename = url.split('/').pop() || 'document';

        const defaultChoice = this.getDefaultTruncationChoice();

        const newDoc: DocumentItem = {
            id: docId,
            name: filename,
            isExternal: true,
            url,
            truncationChoice: defaultChoice,
            charCount: 0,
            isProcessing: false
        };

        this.documents.push(newDoc);
        return { added: true };
    }

    /**
     * Detect documents from note content
     * Returns detected documents without adding to internal list
     */
    detectFromContent(content: string): DocumentItem[] {
        const activeFile = this.app.workspace.getActiveFile();
        const detectedContent = detectEmbeddedDocuments(this.app, content, activeFile || undefined);

        const defaultChoice = this.getDefaultTruncationChoice();

        return detectedContent
            .filter(doc => doc.resolvedFile)
            .map(doc => {
                const file = doc.resolvedFile!;
                return {
                    id: file.path,
                    name: doc.displayName,
                    path: file.path,
                    isExternal: false,
                    file,
                    truncationChoice: defaultChoice,
                    charCount: 0,
                    isProcessing: false
                };
            });
    }

    /**
     * Detect documents from content and add to internal list
     * Deduplicates against existing documents
     * Returns array of results for each detected document
     */
    addDetectedFromContent(content: string): AddResult[] {
        const detected = this.detectFromContent(content);
        const results: AddResult[] = [];

        for (const doc of detected) {
            if (!this.documents.some(d => d.id === doc.id)) {
                this.documents.push(doc);
                results.push({ added: true });
            } else {
                results.push({
                    added: false,
                    duplicate: true,
                    error: 'Document already added'
                });
            }
        }

        return results;
    }

    /**
     * Set truncation choice for a specific document
     * Returns success/error result
     */
    setTruncationChoice(docId: string, choice: TruncationChoice): { success: boolean; error?: string } {
        const doc = this.getDocumentById(docId);
        if (!doc) {
            return {
                success: false,
                error: 'Document not found'
            };
        }

        doc.truncationChoice = choice;

        // Re-apply truncation if content is already cached
        if (doc.fullText) {
            this.applyTruncation(doc);
        }

        return { success: true };
    }

    /**
     * Apply truncation choice to all oversized documents
     */
    applyTruncationToAll(choice: TruncationChoice): void {
        const oversized = this.getOversizedDocuments();
        for (const doc of oversized) {
            doc.truncationChoice = choice;
            if (doc.fullText) {
                this.applyTruncation(doc);
            }
        }
    }

    /**
     * Get documents that exceed the character limit
     */
    getOversizedDocuments(): DocumentItem[] {
        const maxChars = this.getMaxChars();
        return this.documents.filter(d => d.charCount > maxChars);
    }

    /**
     * Remove document by ID
     * Returns true if found and removed, false otherwise
     */
    removeDocument(docId: string): boolean {
        const index = this.documents.findIndex(d => d.id === docId);
        if (index === -1) {
            return false;
        }

        this.documents.splice(index, 1);
        this.contentCache.delete(docId);
        return true;
    }

    /**
     * Extract text from a specific document
     * Updates charCount during extraction
     * Applies truncation based on current choice
     */
    async extractDocument(docId: string): Promise<{ success: boolean; error?: string }> {
        const doc = this.getDocumentById(docId);
        if (!doc) {
            return {
                success: false,
                error: 'Document not found'
            };
        }

        if (doc.isProcessing) {
            return {
                success: false,
                error: 'Document is already being processed'
            };
        }

        doc.isProcessing = true;
        doc.error = undefined;

        try {
            let text: string;

            if (doc.isExternal && doc.url) {
                // Extract from external URL
                const result = await this.documentService.extractFromUrl(doc.url);
                if (!result.success || !result.text) {
                    throw new Error(result.error || 'Failed to extract from URL');
                }
                text = result.text;
            } else if (doc.file) {
                // Extract from vault file
                const result = await this.documentService.extractText(doc.file);
                if (!result.success || !result.text) {
                    throw new Error(result.error || 'Failed to extract from file');
                }
                text = result.text;
            } else {
                throw new Error('No valid source for extraction');
            }

            // Cache full content and populate charCount
            doc.fullText = text;
            doc.charCount = text.length;
            this.contentCache.set(docId, text);

            // Apply truncation based on current choice
            this.applyTruncation(doc);

            return { success: true };
        } catch (error) {
            doc.error = error instanceof Error ? error.message : 'Extraction failed';
            return {
                success: false,
                error: doc.error
            };
        } finally {
            doc.isProcessing = false;
        }
    }

    /**
     * Apply truncation choice to document
     * Uses cached full text and slices based on choice
     * Always re-slices from cache to get current choice
     */
    private applyTruncation(doc: DocumentItem): void {
        if (!doc.fullText) {
            return;
        }

        const maxChars = this.getMaxChars();

        switch (doc.truncationChoice) {
            case 'truncate':
                doc.extractedText = doc.fullText.substring(0, maxChars) + '\n\n[Truncated...]';
                doc.error = undefined;
                break;
            case 'full':
                doc.extractedText = doc.fullText;
                doc.error = undefined;
                break;
            case 'skip':
                doc.extractedText = '';
                doc.error = 'Excluded from context (user choice)';
                break;
        }
    }

    /**
     * Extract all documents that haven't been extracted yet
     * Returns result with all documents, their extracted contents, and any errors
     */
    async extractAll(): Promise<DocumentHandlingResult> {
        const errors: string[] = [];
        const extractedContents = new Map<string, string>();

        for (const doc of this.documents) {
            // Skip already extracted or errored documents
            if (doc.extractedText || doc.error) {
                if (doc.extractedText) {
                    extractedContents.set(doc.id, doc.extractedText);
                }
                continue;
            }

            const result = await this.extractDocument(doc.id);
            if (!result.success) {
                errors.push(`${doc.name}: ${result.error || 'Unknown error'}`);
            } else if (doc.extractedText) {
                extractedContents.set(doc.id, doc.extractedText);
            }
        }

        return {
            documents: this.getDocuments(),
            extractedContents,
            errors
        };
    }

    /**
     * Get all extracted text concatenated with document names
     * Excludes skipped documents
     */
    getCombinedExtractedText(): string {
        return this.documents
            .filter(doc => doc.extractedText && doc.truncationChoice !== 'skip')
            .map(doc => `### ${doc.name}\n\n${doc.extractedText}`)
            .join('\n\n---\n\n');
    }

    /**
     * Clear all documents and cache
     */
    clear(): void {
        this.documents = [];
        this.contentCache.clear();
    }

    /**
     * Get count of documents
     */
    getCount(): number {
        return this.documents.length;
    }

    /**
     * Check if any documents are currently processing
     */
    isAnyProcessing(): boolean {
        return this.documents.some(d => d.isProcessing);
    }
}
