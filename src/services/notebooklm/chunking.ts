/**
 * Chunking utilities for NotebookLM Source Packs
 *
 * NOTE: With PDF-based export, chunking is no longer needed.
 * This file re-exports the generic text chunker for potential future use.
 */

export { chunkPlainTextAsync, chunkSegmentsAsync, TextChunkerOptions } from '../../utils/textChunker';

// Stub exports for compatibility - these are no longer used with PDF export
export function estimateModuleCount(): number {
    return 0;
}

export function autoSelectExportMode(): string {
    return 'pdf';
}

export function validateExportParameters(): string[] {
    return [];
}

export function checkModuleLimits(): string | null {
    return null;
}

export function checkModuleWordLimit(): string | null {
    return null;
}
