/**
 * SummaryInsertion (Cluster C / Phase 4).
 *
 * Turns an ordered `SourceOutcome[]` into the note's `## Summary` body — single
 * passthrough, LLM synthesis of multiple summaries (with budget-aware truncation), or
 * a headers fallback — plus the "Sources Processed" checklist. Also builds the
 * all-failed checklist for the failure path. PURE except for the injected `synthesize`
 * seam (the raw-prompt summarize call); it never writes the note.
 *
 * The exact output strings mirror the legacy `handleMultiSourceResult` so the
 * `summaryParity` golden test passes byte-for-byte.
 */

import { logger } from '../../utils/logger';
import { truncateAtBoundary } from '../tokenLimits';
import type { ProcessedSource, SourceOutcome } from './multiSourceTypes';

/** Build the synthesis prompt for combining multiple summaries (pure; moved verbatim). */
export function buildSynthesisPrompt(
    summaries: string[],
    sourceLabels: string[],
    focusContext: string | undefined,
    personaPrompt: string,
): string {
    let prompt = `<task>
Synthesize the following ${summaries.length} summaries into a single, coherent summary.
Combine related information, eliminate redundancy, and organize the content logically.
${focusContext ? `Focus on: ${focusContext}` : ''}
</task>

${personaPrompt ? `<persona>${personaPrompt}</persona>` : ''}

<summaries>
`;
    for (let i = 0; i < summaries.length; i++) {
        prompt += `\n### Source: ${sourceLabels[i]}\n${summaries[i]}\n`;
    }
    prompt += `</summaries>

<output_format>
Provide a unified summary that:
1. Integrates key points from all sources
2. Highlights common themes and connections
3. Notes any contrasting perspectives
4. Is well-structured with clear organization
</output_format>`;
    return prompt;
}

/** Collapse newlines to spaces so a value can't break a single-line markdown list item (G3). */
function singleLine(value: string): string {
    return value.replace(/\r?\n/g, ' ');
}

/** Render one source's checklist line (`- [✓] Title - *error*`). Pure. */
function renderChecklistLine(source: ProcessedSource): string {
    const icon = source.success ? '✓' : '✗';
    // Sanitize title/error newlines (e.g. scraped web titles) so the list stays well-formed (G3).
    const title = singleLine(source.title);
    const status = source.success ? '' : ` - *${singleLine(source.error || 'Failed')}*`;
    const displayTitle = title.length > 60 ? title.substring(0, 57) + '...' : title;
    return `- [${icon}] ${displayTitle}${status}\n`;
}

export interface CombinedSummaryInput {
    outcomes: SourceOutcome[];
    focusContext?: string;
    personaPrompt: string;
    /** Char budget for synthesis input (provider max minus prompt overhead). */
    maxSynthesisChars: number;
    /** Threads into the synthesis `summarizeText` call so it can be aborted mid-flight (G1). */
    signal?: AbortSignal;
}

export class SummaryInsertion {
    /**
     * @param synthesize Raw-prompt summarize seam (wraps `callSummarizeService(..., isRawPrompt=true)`).
     *   Accepts an optional `AbortSignal` threaded into the underlying `summarizeText` (G1).
     */
    constructor(private readonly synthesize: (prompt: string, signal?: AbortSignal) => Promise<string | null>) {}

    /**
     * Build the combined `## Summary` body (+ checklist) for the success path. Performs
     * the synthesis LLM call when more than one summary is present, falling back to
     * per-source headers on failure.
     */
    async buildCombinedSummary(input: CombinedSummaryInput): Promise<string> {
        const { outcomes, focusContext, personaPrompt, maxSynthesisChars, signal } = input;
        const successes = outcomes.filter((o) => o.processed.success);
        const summaries = successes.map((o) => o.summary as string);
        const sourceLabels = successes.map((o) => o.label as string);
        const allSources = outcomes.map((o) => o.processed);

        let combinedOutput = '\n\n## Summary\n\n';

        if (summaries.length === 1) {
            combinedOutput += summaries[0];
        } else if (summaries.length > 1) {
            // Budget guard: proportionally truncate summaries if they exceed limits.
            const totalSummaryChars = summaries.reduce((sum, s) => sum + s.length, 0);
            let synthSummaries = summaries;
            if (totalSummaryChars > maxSynthesisChars && maxSynthesisChars > 0) {
                const ratio = maxSynthesisChars / totalSummaryChars;
                synthSummaries = summaries.map((s) => {
                    const allowedChars = Math.floor(s.length * ratio);
                    return truncateAtBoundary(s, allowedChars, '\n[Summary truncated for synthesis]');
                });
            }

            const synthesisPrompt = buildSynthesisPrompt(synthSummaries, sourceLabels, focusContext, personaPrompt);
            try {
                const synthesisResult = await this.synthesize(synthesisPrompt, signal);
                if (synthesisResult) {
                    combinedOutput += synthesisResult;
                } else {
                    combinedOutput += this.headersFallback(summaries, sourceLabels);
                }
            } catch (e) {
                logger.error('Summary', 'Failed to synthesize summaries:', e);
                combinedOutput += this.headersFallback(summaries, sourceLabels);
            }
        }

        // Append the source-processing checklist when there is more than one source.
        if (allSources.length > 1) {
            const successCount = allSources.filter((s) => s.success).length;
            const failCount = allSources.length - successCount;

            combinedOutput += '\n\n### Sources Processed\n\n';
            for (const source of allSources) {
                combinedOutput += renderChecklistLine(source);
            }
            if (failCount > 0) {
                combinedOutput += `\n*${successCount} of ${allSources.length} sources processed successfully. Failed sources may need to be added manually.*\n`;
            }
        }

        return combinedOutput;
    }

    /** Per-source headers fallback when synthesis fails / returns nothing. */
    private headersFallback(summaries: string[], sourceLabels: string[]): string {
        let out = '';
        for (let i = 0; i < summaries.length; i++) {
            out += `### ${sourceLabels[i]}\n\n${summaries[i]}\n\n`;
        }
        return out;
    }
}

/**
 * Build the all-failed status checklist for the multi-source failure path (no summary
 * could be produced for any source). Pure. Mirrors the legacy `failureOutput`.
 */
export function buildFailureChecklist(outcomes: SourceOutcome[]): string {
    let failureOutput = '\n\n## Summary\n\n*No content could be summarized.*\n\n### Sources Processed\n\n';
    for (const o of outcomes) {
        failureOutput += renderChecklistLine(o.processed);
    }
    failureOutput += '\n*0 of ' + outcomes.length + ' sources processed successfully. Please try again or process sources individually.*\n';
    return failureOutput;
}
