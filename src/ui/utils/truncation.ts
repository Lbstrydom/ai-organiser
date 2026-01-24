/**
 * Truncation Utilities
 * Shared utilities for document truncation UI components
 * 
 * Used by:
 * - MinutesCreationModal
 * - MultiSourceModal (when document support added)
 * 
 * Purpose: DRY principle - single source of truth for truncation labels and tooltips
 */

import { TruncationChoice } from '../../core/constants';

export interface TruncationOption {
    label: string;
    tooltip: string;
}

/**
 * Get truncation options with labels and tooltips
 * Single source of truth for truncation UI text
 * 
 * @param t - Translation object from plugin.t.minutes or plugin.t.multiSource
 * @returns Record mapping each TruncationChoice to its label and tooltip
 * 
 * Usage:
 * ```typescript
 * const options = getTruncationOptions(plugin.t.minutes);
 * console.log(options.truncate.label); // "Truncate"
 * console.log(options.full.tooltip); // "Use entire document..."
 * ```
 */
export function getTruncationOptions(t: any): Record<TruncationChoice, TruncationOption> {
    return {
        truncate: {
            label: t?.truncateOption || 'Truncate',
            tooltip: t?.truncateTooltip || 'Keep first 50k chars - safe for most LLMs'
        },
        full: {
            label: t?.useFullOption || 'Use Full',
            tooltip: t?.useFullTooltip || 'Use entire document - may exceed LLM token limits and increase costs'
        },
        skip: {
            label: t?.skipOption || 'Exclude',
            tooltip: t?.skipTooltip || 'Exclude this document from context'
        }
    };
}
