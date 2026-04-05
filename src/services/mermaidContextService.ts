/**
 * MermaidContextService — Phase 4
 * Gathers enriched context (note headings, backlinks, RAG chunks, sibling diagrams)
 * to enhance Mermaid chat LLM prompts.
 */

import { App, TFile } from 'obsidian';
import type AIOrganiserPlugin from '../main';
import { RAGService } from './ragService';
import { getMaxContentCharsForModel } from './tokenLimits';
import { extractMermaidNodeLabels, findAllMermaidBlocks } from '../utils/mermaidUtils';

// Character-budget allocation (as fractions of available context window)
export const BUDGET_NOTE_PCT     = 0.40;   // Note headings
export const BUDGET_SIBLING_PCT  = 0.15;   // Sibling diagram labels
export const BUDGET_BACKLINK_PCT = 0.25;   // Backlinked note titles
export const BUDGET_RAG_PCT      = 0.20;   // RAG retrieved chunks
export const PROMPT_OVERHEAD_CHARS = 2000; // Reserved for XML wrappers + system prompt

export interface GatheredContext {
    noteContext: string;       // Heading hierarchy of the active note
    siblingDiagrams: string[]; // Node labels extracted from other diagrams in the note
    backlinkContext: string;   // Titles of notes that link to this note
    ragContext: string;        // Formatted semantic-search chunks from the vault
}

export class MermaidContextService {
    private readonly app: App;
    private readonly plugin: AIOrganiserPlugin;

    constructor(app: App, plugin: AIOrganiserPlugin) {
        this.app = app;
        this.plugin = plugin;
    }

    /**
     * Gather all enabled context sources for the given file.
     * Returns empty strings for disabled / unavailable sources.
     */
    async gatherContext(file: TFile, currentDiagramCode: string): Promise<GatheredContext> {
        const settings = this.plugin.settings;

        // Resolve provider + model for token-budget calculation
        const provider = settings.serviceType === 'cloud'
            ? (settings.cloudServiceType ?? 'openai')
            : settings.serviceType;
        const model = settings.serviceType === 'cloud' ? settings.cloudModel : settings.localModel;
        const totalBudget = getMaxContentCharsForModel(provider, model);
        const available = Math.max(0, totalBudget - PROMPT_OVERHEAD_CHARS);

        const content = await this.app.vault.cachedRead(file);

        // Fire all sources in parallel
        const [siblingLabels, backlinkText, ragText] = await Promise.all([
            Promise.resolve(this.gatherSiblingDiagrams(content, currentDiagramCode)),
            settings.mermaidChatIncludeBacklinks
                ? Promise.resolve(this.gatherBacklinkContext(file))
                : Promise.resolve(''),
            (settings.mermaidChatIncludeRAG &&
             this.plugin.vectorStore &&
             this.plugin.embeddingService)
                ? this.gatherRAGContext(currentDiagramCode, file)
                : Promise.resolve(''),
        ]);

        const result: GatheredContext = {
            noteContext: '',
            siblingDiagrams: [],
            backlinkContext: '',
            ragContext: '',
        };

        // Note headings context
        if (settings.mermaidChatIncludeNoteContext) {
            const headings = this.extractHeadings(content);
            const budget = Math.floor(available * BUDGET_NOTE_PCT);
            result.noteContext = headings.slice(0, budget);
        }

        // Sibling diagram labels
        const siblingBudget = Math.floor(available * BUDGET_SIBLING_PCT);
        const siblingStr = siblingLabels.join(', ');
        if (siblingStr.length > 0) {
            // Truncate labels list to budget
            const truncated = siblingStr.slice(0, siblingBudget);
            result.siblingDiagrams = truncated.split(', ').filter(Boolean);
        }

        // Backlink context
        if (backlinkText) {
            const budget = Math.floor(available * BUDGET_BACKLINK_PCT);
            result.backlinkContext = backlinkText.slice(0, budget);
        }

        // RAG context
        if (ragText) {
            const budget = Math.floor(available * BUDGET_RAG_PCT);
            result.ragContext = ragText.slice(0, budget);
        }

        return result;
    }

    /** Extract the heading hierarchy of a note as a multi-line string. */
    private extractHeadings(content: string): string {
        return content
            .split('\n')
            .filter(l => /^#{1,6}\s/.test(l))
            .map(l => l.trimEnd())
            .join('\n');
    }

    /** Extract unique node labels from all sibling Mermaid blocks (skipping current). */
    gatherSiblingDiagrams(content: string, currentCode: string): string[] {
        const blocks = findAllMermaidBlocks(content);
        const seen = new Set<string>();
        for (const block of blocks) {
            if (block.code.trim() === currentCode.trim()) continue;
            for (const label of extractMermaidNodeLabels(block.code)) {
                seen.add(label);
            }
        }
        return [...seen];
    }

    /** Fetch the basenames of notes that link back to this file. */
    private gatherBacklinkContext(file: TFile): string {
        try {
            const resolvedLinks = this.app.metadataCache.resolvedLinks;
            const titles: string[] = [];
            for (const [sourcePath, links] of Object.entries(resolvedLinks)) {
                if (file.path in links) {
                    const sourceFile = this.app.vault.getAbstractFileByPath(sourcePath);
                    if (sourceFile instanceof TFile) {
                        titles.push(sourceFile.basename);
                    }
                }
            }
            return titles.slice(0, 30).join(', ');
        } catch {
            return '';
        }
    }

    /** Retrieve relevant vault chunks via RAGService semantic search. */
    private async gatherRAGContext(query: string, file: TFile): Promise<string> {
        try {
            if (!this.plugin.vectorStore || !this.plugin.embeddingService) return '';
            const ragService = new RAGService(
                this.plugin.vectorStore,
                this.plugin.settings,
                this.plugin.embeddingService,
            );
            const { formattedContext } = await ragService.retrieveContext(query, file, {
                maxChunks: this.plugin.settings.mermaidChatRAGChunks ?? 3,
                minSimilarity: 0.65,
                excludeCurrentFile: true,
            });
            return formattedContext ?? '';
        } catch {
            return '';
        }
    }
}
