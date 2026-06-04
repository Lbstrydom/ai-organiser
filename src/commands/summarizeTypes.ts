/**
 * Shared summarize types — extracted so collaborators (the multi-source orchestrator)
 * can import them without a circular dependency on the large `summarizeCommands.ts`
 * module. Runtime-free (types only). `summarizeCommands.ts` re-exports these for
 * backward compatibility with existing import sites.
 */

import type { PdfContent } from '../services/pdfService';

/** Result of the unified PDF summarization workflow. */
export interface PdfSummarizationResult {
    success: boolean;
    summary?: string;
    pdfContent?: PdfContent;
    error?: string;
}

/** Options for PDF summarization. */
export interface PdfSummarizationOptions {
    personaPrompt: string;
    userContext?: string;
    /** Current file for resolving vault links. */
    currentFilePath?: string;
}
