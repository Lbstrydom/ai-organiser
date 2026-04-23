/**
 * Chunking Orchestrator — hierarchical map-reduce for long-form text.
 *
 * Generalises the minutes map-reduce pattern. Replaces the flat
 * `summarizeContentInChunks()` in `summarizeCommands.ts` with:
 *   - Rolling continuation context between map chunks (better continuity)
 *   - Fast-model map + main-model reduce (cheaper + faster)
 *   - Hierarchical intermediate reduce for >4 chunks (better synthesis)
 *   - Per-chunk error isolation (one bad chunk doesn't kill the whole run)
 *
 * Not used by minutesService — that has its own optimised structured-JSON
 * path with dedup + dictionary injection. This orchestrator targets
 * plain-text summarization (articles, PDFs, audio transcripts-as-text,
 * multi-source docs).
 *
 * See docs/plans/large-content-ingestion.md for context.
 */

import { chunkPlainTextAsync } from '../utils/textChunker';
import { logger } from '../utils/logger';
import type { SummarizableLLMService, SummarizeOptions } from './types';
import type { ContentAssessment, ContentType } from './contentSizePolicy';
import { HIERARCHICAL_CHUNK_THRESHOLD } from './contentSizePolicy';

export interface ChunkError {
    chunkIndex: number;
    error: string;
}

export interface ChunkingResult {
    ok: boolean;
    summary?: string;
    /** Populated whenever any map chunk failed; absent on full success. */
    errors?: ChunkError[];
}

export interface ChunkingOptions {
    contentType: ContentType;
    /** Build the prompt for a single map chunk. Receives optional
     *  `continuationContext` from the previous chunk's MapChunkOutput. */
    mapPromptBuilder: (
        chunk: string,
        chunkIndex: number,
        total: number,
        continuationContext?: string,
    ) => string;
    /** Build the final (or intermediate) reduce prompt from partial summaries. */
    reducePromptBuilder: (partialSummaries: string[]) => string;
    /** Options for map-phase LLM calls (fast model + tight budget). */
    mapOptions?: SummarizeOptions;
    /** Options for reduce-phase LLM calls (main model + larger budget). */
    reduceOptions?: SummarizeOptions;
    onProgress?: (done: number, total: number) => void;
    /** Overlap between chunks — default 1000 chars. */
    overlapChars?: number;
}

/** Parsed output from each map call. Orchestrator attempts to read a
 *  `continuationContext:` line out of the response; if absent, passes
 *  empty context to the next chunk. Prompt authors are expected to ask
 *  for that line explicitly when they want continuity. */
interface MapChunkOutput {
    summary: string;
    continuationContext?: string;
}

/** Cap map output so the reduce phase stays manageable. */
const MAP_OUTPUT_CHAR_CAP = 3_500;
const CONTINUATION_CONTEXT_CAP = 400;

export async function orchestrateChunked(
    text: string,
    assessment: ContentAssessment,
    llmService: SummarizableLLMService,
    options: ChunkingOptions,
): Promise<ChunkingResult> {
    if (!text || text.trim().length === 0) {
        return { ok: true, summary: '' };
    }

    const chunks = await chunkPlainTextAsync(text, {
        maxChars: assessment.qualityChunkChars,
        overlapChars: options.overlapChars ?? 1_000,
    });

    if (chunks.length === 0) {
        return { ok: true, summary: '' };
    }

    // Short-circuit: single chunk after splitting — skip the reduce pass.
    if (chunks.length === 1) {
        return runSingleChunk(chunks[0], llmService, options);
    }

    // Debug-mode XML prompt contract check (best effort).
    const firstMapPrompt = options.mapPromptBuilder(chunks[0], 1, chunks.length);
    if (!/<task>/i.test(firstMapPrompt)) {
        logger.debug('ChunkingOrchestrator', 'map prompt does not contain <task> tag — XML prompt contract violated (not fatal)');
    }

    const { mapResults, errors } = await executeMapPhase(chunks, llmService, options);

    if (mapResults.length === 0) {
        return { ok: false, errors };
    }

    // Hierarchical reduce when many chunks — mirrors minutesService pattern.
    let summary: string | undefined;
    if (assessment.strategy === 'hierarchical' && mapResults.length > HIERARCHICAL_CHUNK_THRESHOLD) {
        summary = await hierarchicalReduce(mapResults, llmService, options);
    } else {
        summary = await singleReduce(mapResults, llmService, options);
    }

    if (!summary) {
        // Reduce phase silently returned undefined. Append a synthetic
        // ChunkError so the reduce failure is surfaced in `errors` — map-
        // phase errors alone would hide it (Gemini final-review fix). */
        const reduceError: ChunkError = { chunkIndex: -1, error: 'Reduce phase returned empty' };
        return { ok: false, errors: [...errors, reduceError] };
    }

    return {
        ok: errors.length === 0,
        summary,
        errors: errors.length > 0 ? errors : undefined,
    };
}

/** Single-chunk short-circuit: content fits in one chunk after splitting,
 *  so skip the reduce pass entirely.
 *
 *  - Uses reduceOptions (not mapOptions) because this call produces the
 *    FINAL user-visible output, not an intermediate partial — so we want
 *    the main/strong model, matching the quality of the direct
 *    summarization path (R2-M6 fix).
 *  - Runs parseMapOutput so any continuation-context metadata the
 *    builder emitted is stripped — otherwise single-chunk output leaks
 *    metadata that the multi-chunk path correctly strips (R2-M4 fix).
 *  - Wraps in try/catch so exceptions normalise into ChunkingResult
 *    rather than propagating out of the orchestrator (R2-M5/M7 fix). */
async function runSingleChunk(
    chunk: string,
    llmService: SummarizableLLMService,
    options: ChunkingOptions,
): Promise<ChunkingResult> {
    const prompt = options.mapPromptBuilder(chunk, 1, 1);
    const singleOpts = options.reduceOptions ?? options.mapOptions;
    try {
        const response = await llmService.summarizeText(prompt, singleOpts);
        if (!response.success || !response.content) {
            return {
                ok: false,
                errors: [{ chunkIndex: 0, error: response.error || 'Empty response' }],
            };
        }
        const parsed = parseMapOutput(response.content);
        return { ok: true, summary: (parsed.summary || response.content).trim() };
    } catch (e) {
        return {
            ok: false,
            errors: [{ chunkIndex: 0, error: e instanceof Error ? e.message : String(e) }],
        };
    }
}

/** Run the map phase over all chunks, accumulating successful summaries
 *  and per-chunk errors. Extracted from orchestrateChunked to keep that
 *  function under the SonarQube cognitive-complexity threshold. */
async function executeMapPhase(
    chunks: string[],
    llmService: SummarizableLLMService,
    options: ChunkingOptions,
): Promise<{ mapResults: string[]; errors: ChunkError[] }> {
    const mapResults: string[] = [];
    const errors: ChunkError[] = [];
    let continuationContext: string | undefined;

    for (let i = 0; i < chunks.length; i++) {
        const prompt = options.mapPromptBuilder(chunks[i], i + 1, chunks.length, continuationContext);
        try {
            const response = await llmService.summarizeText(prompt, options.mapOptions);
            if (!response.success || !response.content) {
                errors.push({ chunkIndex: i, error: response.error || 'Empty response' });
                continuationContext = undefined;
            } else {
                const parsed = parseMapOutput(response.content);
                mapResults.push(capString(parsed.summary, MAP_OUTPUT_CHAR_CAP));
                continuationContext = parsed.continuationContext;
            }
        } catch (e) {
            errors.push({ chunkIndex: i, error: e instanceof Error ? e.message : String(e) });
            continuationContext = undefined;
        }
        options.onProgress?.(i + 1, chunks.length);
    }

    return { mapResults, errors };
}

async function singleReduce(
    partialSummaries: string[],
    llmService: SummarizableLLMService,
    options: ChunkingOptions,
): Promise<string | undefined> {
    const prompt = options.reducePromptBuilder(partialSummaries);
    try {
        const response = await llmService.summarizeText(prompt, options.reduceOptions);
        if (!response.success || !response.content) return undefined;
        return response.content.trim();
    } catch (e) {
        // Normalise thrown exceptions into a soft failure so the orchestrator
        // can surface a structured ChunkingResult (R2-M5 fix).
        logger.warn('ChunkingOrchestrator', 'singleReduce threw — treating as empty reduce result', e);
        return undefined;
    }
}

const MAX_HIERARCHICAL_DEPTH = 5;

async function hierarchicalReduce(
    partialSummaries: string[],
    llmService: SummarizableLLMService,
    options: ChunkingOptions,
): Promise<string | undefined> {
    // Recursively collapse partials into groups of HIERARCHICAL_CHUNK_THRESHOLD
    // until the count fits in a single final reduce. The previous version
    // did exactly ONE intermediate pass + one final, which meant prompt size
    // at the final reduce still grew linearly with chunk count and could
    // overflow at very large inputs (R2-H2 audit finding 2026-04-23).
    //
    // With threshold=4, recursion handles any chunk count:
    //   16 → 4 → 1  (depth 2)
    //   64 → 16 → 4 → 1  (depth 3)
    //  256 → 64 → 16 → 4 → 1  (depth 4)
    // Depth capped at MAX_HIERARCHICAL_DEPTH as a safety net against
    // pathological inputs that never collapse (shouldn't happen given the
    // input chunk cap, but defensive).
    let current = partialSummaries;
    let depth = 0;
    while (current.length > HIERARCHICAL_CHUNK_THRESHOLD && depth < MAX_HIERARCHICAL_DEPTH) {
        current = await reduceOneLayer(current, llmService, options);
        if (current.length === 0) return undefined;
        depth++;
    }

    return singleReduce(current, llmService, options);
}

/** One pass of hierarchical reduction: batch by HIERARCHICAL_CHUNK_THRESHOLD,
 *  merge multi-item batches via LLM, pass-through single-item batches.
 *  Failed intermediate merges preserve the batch's inputs individually
 *  rather than silently dropping them (R1-H1 fix). */
async function reduceOneLayer(
    partialSummaries: string[],
    llmService: SummarizableLLMService,
    options: ChunkingOptions,
): Promise<string[]> {
    const batches: string[][] = [];
    for (let i = 0; i < partialSummaries.length; i += HIERARCHICAL_CHUNK_THRESHOLD) {
        batches.push(partialSummaries.slice(i, i + HIERARCHICAL_CHUNK_THRESHOLD));
    }

    const out: string[] = [];
    for (const batch of batches) {
        if (batch.length === 1) {
            out.push(batch[0]);
            continue;
        }
        const merged = await mergeBatch(batch, llmService, options);
        for (const part of merged) out.push(part);
    }
    return out;
}

/** Merge a batch of 2+ partials via LLM call. On success returns a single-
 *  element array with the merged summary; on failure (empty response OR
 *  thrown) returns the original batch inputs so no content is dropped. */
async function mergeBatch(
    batch: string[],
    llmService: SummarizableLLMService,
    options: ChunkingOptions,
): Promise<string[]> {
    const intermediatePrompt = options.reducePromptBuilder(batch);
    try {
        const response = await llmService.summarizeText(intermediatePrompt, options.reduceOptions);
        if (response.success && response.content) {
            return [capString(response.content.trim(), MAP_OUTPUT_CHAR_CAP * 2)];
        }
        logger.warn('ChunkingOrchestrator', `Intermediate merge failed for batch of ${batch.length}; preserving inputs`, response.error);
        return batch;
    } catch (e) {
        logger.warn('ChunkingOrchestrator', `Intermediate merge threw for batch of ${batch.length}; preserving inputs`, e);
        return batch;
    }
}

/** Parse a map response. Looks for a TRAILING line that starts with
 *  `continuation context:` or `continuation_context:` (case-insensitive)
 *  and extracts it. Everything before the last such line is summary.
 *
 *  Uses the LAST match (not first) so a summary that legitimately
 *  discusses "continuation context" as a topic in the body doesn't get
 *  silently truncated at the first occurrence (R2-M2 audit finding
 *  2026-04-23). Convention is that the marker line is a trailing footer
 *  emitted by the prompt author. */
function parseMapOutput(raw: string): MapChunkOutput {
    const re = /^[ \t]*continuation[_ ]?context[ \t]*[:=][ \t]*(.+)$/gim;
    let lastMatch: RegExpExecArray | null = null;
    for (let m = re.exec(raw); m !== null; m = re.exec(raw)) lastMatch = m;
    if (!lastMatch) return { summary: raw.trim() };

    const continuationContext = lastMatch[1].trim().slice(0, CONTINUATION_CONTEXT_CAP);
    const summary = raw.slice(0, lastMatch.index).trim();
    return { summary, continuationContext };
}

function capString(s: string, maxLen: number): string {
    if (s.length <= maxLen) return s;
    // Trim to last sentence boundary within limit if possible.
    const truncated = s.slice(0, maxLen);
    const lastPeriod = truncated.lastIndexOf('. ');
    return lastPeriod > maxLen * 0.7 ? truncated.slice(0, lastPeriod + 1) : truncated;
}
