/**
 * RAG (Retrieval-Augmented Generation) Service
 * Retrieves relevant context from vector store and formats for LLM prompts
 */

import { TFile } from 'obsidian';
import { IVectorStore, SearchResult, VectorDocument } from './vector/types';
import { IEmbeddingService } from './embeddings/types';
import { AIOrganiserSettings } from '../core/settings';

export interface RAGContext {
    chunks: SearchResult[];
    formattedContext: string;
    sources: string[];  // Unique file paths
    totalChunks: number;
}

export interface RAGOptions {
    maxChunks?: number;
    includeMetadata?: boolean;
    minSimilarity?: number;
    excludeCurrentFile?: boolean;
}

/** Default minimum similarity score for filtering search results. */
const DEFAULT_MIN_SIMILARITY = 0.5;
/** Maximum characters to use from note content when querying for related notes. */
const MAX_QUERY_CHARS = 30000;

/**
 * Service for retrieving and formatting context for RAG
 */
export class RAGService {
    private vectorStore: IVectorStore;
    private settings: AIOrganiserSettings;
    private embeddingService: IEmbeddingService | null;

    constructor(
        vectorStore: IVectorStore,
        settings: AIOrganiserSettings,
        embeddingService?: IEmbeddingService | null
    ) {
        this.vectorStore = vectorStore;
        this.settings = settings;
        this.embeddingService = embeddingService || null;
    }

    /**
     * Retrieve relevant context for a query
     */
    public async retrieveContext(
        query: string,
        currentFile?: TFile,
        options: RAGOptions = {}
    ): Promise<RAGContext> {
        const {
            maxChunks = this.settings.ragContextChunks || 5,
            includeMetadata = this.settings.ragIncludeMetadata ?? true,
            minSimilarity = DEFAULT_MIN_SIMILARITY,
            excludeCurrentFile = false
        } = options;

        try {
            // Get embedding service from vector store and search
            const results = await this.vectorStore.searchByContent(
                query,
                this.embeddingService,
                maxChunks * 2 // Get more results for filtering
            );

            // Filter results
            let filteredResults = results.filter((r: SearchResult) => r.score >= minSimilarity);

            // Exclude current file if requested
            if (excludeCurrentFile && currentFile) {
                filteredResults = filteredResults.filter(
                    (r: SearchResult) => r.document.filePath !== currentFile.path
                );
            }

            // Limit to max chunks
            const selectedChunks = filteredResults.slice(0, maxChunks);

            // Format context for LLM
            const formattedContext = this.formatContextForPrompt(
                selectedChunks,
                includeMetadata
            );

            // Get unique sources
            const sources = Array.from(
                new Set(selectedChunks.map((r: SearchResult) => r.document.filePath))
            ) as string[];

            return {
                chunks: selectedChunks,
                formattedContext,
                sources,
                totalChunks: selectedChunks.length
            };
        } catch (error) {
            console.error('Error retrieving RAG context:', error);
            return {
                chunks: [],
                formattedContext: '',
                sources: [],
                totalChunks: 0
            };
        }
    }

    /**
     * Format retrieved chunks into a context string for LLM prompt
     */
    private formatContextForPrompt(
        chunks: SearchResult[],
        includeMetadata: boolean
    ): string {
        if (chunks.length === 0) {
            return '';
        }

        const contextParts: string[] = [
            '# Relevant Context from Vault',
            '',
            'The following information was retrieved from your vault and may be relevant to your query:',
            ''
        ];

        chunks.forEach((result, index) => {
            const doc = result.document;
            
            contextParts.push(`## Source ${index + 1}`);
            
            if (includeMetadata) {
                contextParts.push(`**File:** ${doc.filePath}`);
                contextParts.push(`**Title:** ${doc.metadata.title}`);
                contextParts.push(`**Relevance Score:** ${(result.score * 100).toFixed(1)}%`);
                contextParts.push('');
            }
            
            contextParts.push('**Content:**');
            contextParts.push(doc.content);
            contextParts.push('');
            contextParts.push('---');
            contextParts.push('');
        });

        return contextParts.join('\n');
    }

    /**
     * Build a RAG-enhanced prompt
     */
    public buildRAGPrompt(
        userQuery: string,
        context: RAGContext,
        systemPrompt?: string
    ): string {
        if (context.totalChunks === 0) {
            return userQuery;
        }

        const parts: string[] = [];

        // System instruction
        if (systemPrompt) {
            parts.push(systemPrompt);
            parts.push('');
        }

        // Context section
        parts.push(context.formattedContext);
        parts.push('');

        // Instruction
        parts.push('# Task');
        parts.push('');
        parts.push(`Based on the context above from the user's vault, please answer the following question:`);
        parts.push('');
        parts.push(userQuery);
        parts.push('');
        parts.push('**Important:**');
        parts.push('- Base your answer primarily on the provided context');
        parts.push('- If the context doesn\'t contain enough information, acknowledge this');
        parts.push('- Cite specific sources when possible (e.g., "According to [filename]...")');
        parts.push('- Be specific and provide actionable information');

        return parts.join('\n');
    }

    /**
     * Get related notes for a file
     * @param options.folderScope Restrict results to this folder (and subfolders). null = whole vault.
     */
    public async getRelatedNotes(
        file: TFile,
        content: string,
        maxResults: number = 5,
        options?: { folderScope?: string | null }
    ): Promise<SearchResult[]> {
        try {
            const queryContent = content.length > MAX_QUERY_CHARS
                ? content.substring(0, MAX_QUERY_CHARS)
                : content;

            // Build folder filter predicate (single source of truth)
            const folderScope = options?.folderScope;
            const filter = (folderScope && folderScope !== '' && folderScope !== '/')
                ? (doc: VectorDocument) => doc.filePath.startsWith(folderScope + '/')
                : undefined;

            const results = await this.vectorStore.searchByContent(
                queryContent,
                this.embeddingService,
                maxResults + 1, // Get one extra to exclude self
                filter
            );

            // Filter out the current file
            return results.filter((r: SearchResult) => r.document.filePath !== file.path).slice(0, maxResults);
        } catch (error) {
            console.error('Error getting related notes:', error);
            return [];
        }
    }

    /**
     * Format sources for display
     */
    public formatSources(sources: string[]): string {
        if (sources.length === 0) {
            return '';
        }

        return '\n\n---\n\n**Sources:**\n' + sources.map((s, i) => `${i + 1}. [[${s}]]`).join('\n');
    }

    /**
     * Check if RAG is available
     */
    public isAvailable(): boolean {
        return this.settings.enableSemanticSearch && this.vectorStore !== null;
    }
}
