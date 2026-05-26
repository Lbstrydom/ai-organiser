/**
 * Multi-segment minutes orchestrator (D5, R3-H2, R3-M3, Gemini-G1).
 *
 * Per-segment extract → cross-segment consolidation. Reuses existing
 * chunked-extraction pipeline per segment. Cross-segment merge preserves
 * section identity end-to-end (Gemini-G1 fix — no flat extract merge).
 *
 * Notification ownership (R3-M6): this module returns data only. The
 * caller (minutesService.generateMultiSegmentMinutes) handles all user
 * notifications via the standard withProgress reporter.
 */

import type AIOrganiserPlugin from '../../main';
import { err, ok, type Result } from '../../core/result';
import { logger } from '../../utils/logger';
import { redactPII } from '../../utils/redactionUtils';
import {
    buildChunkExtractionPrompt,
    buildIntermediateMergePrompt,
    type Action,
    type Decision,
    type Risk,
    type NotablePoint,
    type OpenQuestion,
    type DeferredItem,
    type MinutesJSON,
    type Participant,
    parseJsonWithRepair,
} from '../prompts/minutesPrompts';
import { buildSegmentConsolidationPrompt } from '../prompts/segmentConsolidationPrompts';
import type {
    MultiSegmentInput,
    MultiSegmentResult,
    SegmentExtract,
    SegmentInput,
    SegmentResult,
    SegmentSection,
} from './minutesTypes';
import { chunkPlainTextAsync } from '../../utils/textChunker';
import { CHUNK_TOKEN_LIMIT } from '../../core/constants';
import type { SummarizeOptions } from '../types';

export interface MultiSegmentOpts {
    signal?: AbortSignal;
    /**
     * Fires per-segment to drive the UI progress indicator.
     * (current, total, segmentName)
     */
    onProgress?: (current: number, total: number, segmentName: string) => void;
}

/** Total chars threshold above which we hierarchical-reduce instead of one-shot consolidation. */
const CONSOLIDATION_BUDGET_CHARS = 120_000;
/** Max segments per batch in hierarchical reduce. */
const REDUCE_BATCH_SIZE = 4;

/** Per-field cap applied to each section's extract BEFORE consolidation. */
const PER_FIELD_ITEM_CAP = 50;

const EXTRACTION_OPTIONS: SummarizeOptions = { maxTokens: 8192, disableThinking: true, timeoutMs: 120_000 };
const MERGE_OPTIONS: SummarizeOptions = { maxTokens: 12288, disableThinking: true, timeoutMs: 180_000 };
const CONSOLIDATION_OPTIONS: SummarizeOptions = { maxTokens: 16384, disableThinking: true, timeoutMs: 600_000 };

export async function runMultiSegmentExtraction(
    plugin: AIOrganiserPlugin,
    input: MultiSegmentInput,
    opts: MultiSegmentOpts = {},
): Promise<Result<MultiSegmentResult>> {
    if (!input.segments || input.segments.length === 0) {
        return err('no-segments');
    }

    const segmentResults: SegmentResult[] = [];
    const total = input.segments.length;

    for (let i = 0; i < total; i++) {
        const segment = input.segments[i];

        if (opts.signal?.aborted) {
            // Mark this and all remaining as cancelled
            for (let j = i; j < total; j++) {
                const s = input.segments[j];
                segmentResults.push({
                    kind: 'skipped',
                    sectionId: s.sectionId,
                    name: s.sectionName,
                    reason: 'cancelled',
                });
            }
            break;
        }

        opts.onProgress?.(i + 1, total, segment.sectionName);

        const extractRes = await extractSegment(plugin, segment, input, opts.signal);
        segmentResults.push(extractRes);
    }

    const cancelled = segmentResults.some((r) => r.kind === 'skipped' && r.reason === 'cancelled');

    // Gemini-G1: short-circuit consolidation when cancelled — caller discards
    // MultiSegmentResult.consolidated whenever .cancelled is true, so running
    // the up-to-120K-char synthesis pass would waste tokens + block the UI.
    if (cancelled) {
        return ok({
            segments: segmentResults,
            consolidated: buildEmptyConsolidation(input),
            cancelled: true,
        });
    }

    // Build consolidated MinutesJSON
    const consolidated = await consolidateAcrossSegments(plugin, input, segmentResults);
    if (!consolidated.ok) return err(consolidated.error);

    return ok({ segments: segmentResults, consolidated: consolidated.value, cancelled });
}

async function extractSegment(
    plugin: AIOrganiserPlugin,
    segment: SegmentInput,
    input: MultiSegmentInput,
    signal: AbortSignal | undefined,
): Promise<SegmentResult> {
    const transcript = (segment.transcript || '').trim();
    if (!transcript) {
        return {
            kind: 'skipped',
            sectionId: segment.sectionId,
            name: segment.sectionName,
            reason: 'empty',
        };
    }

    try {
        // H2 fix: Chunk ONLY the transcript body. Context documents are passed
        // as a separate `contextSummary` prompt field per chunk so the LLM
        // distinguishes "spoken meeting material" from "pre-read background".
        // Previously the context-docs were prepended to the transcript stream
        // and split across chunks as if they were spoken text.
        const chunks = await chunkPlainTextAsync(transcript, { maxTokens: CHUNK_TOKEN_LIMIT });
        const chunkExtracts: Array<{
            actions: Action[];
            decisions: Decision[];
            risks: Risk[];
            notable_points: NotablePoint[];
            open_questions: OpenQuestion[];
            deferred_items: DeferredItem[];
        }> = [];

        for (let idx = 0; idx < chunks.length; idx++) {
            if (signal?.aborted) throw new Error('cancelled');
            const prompt = buildChunkExtractionPrompt({
                participantsRaw: input.participantsRaw,
                outputLanguage: input.languageOverride,
                dictionaryContent: input.dictionaryContent,
                // H2 fix: docs flow via the prompt's typed `contextSummary`
                // field so the LLM sees them as background, not transcript.
                contextSummary: segment.contextDocuments || undefined,
            });
            const fullPrompt = prompt + '\n\n' + chunks[idx];
            const result = await plugin.llmService.summarizeText(fullPrompt, EXTRACTION_OPTIONS);
            if (!result.success || !result.content) {
                throw new Error(`Chunk ${idx + 1} extraction failed`);
            }
            const parsed = parseJsonWithRepair(result.content);
            chunkExtracts.push({
                actions: parsed.actions ?? [],
                decisions: parsed.decisions ?? [],
                risks: parsed.risks ?? [],
                notable_points: parsed.notable_points ?? [],
                open_questions: parsed.open_questions ?? [],
                deferred_items: parsed.deferred_items ?? [],
            });
        }

        // Per-segment merge if >1 chunk. H1/H11 fix: on merge-LLM failure or
        // empty output, fall back to DETERMINISTIC concatenation of all chunk
        // extracts (instead of silently keeping only chunk 0 and discarding
        // every later chunk's content).
        let merged = chunkExtracts[0] ?? {
            actions: [], decisions: [], risks: [], notable_points: [], open_questions: [], deferred_items: [],
        };
        if (chunkExtracts.length > 1) {
            if (signal?.aborted) throw new Error('cancelled');
            const mergePrompt = buildIntermediateMergePrompt({
                outputLanguage: input.languageOverride,
                participantsRaw: input.participantsRaw,
            });
            const fullMerge = mergePrompt + '\n\n' + JSON.stringify(chunkExtracts, null, 2);
            const mergeResult = await plugin.llmService.summarizeText(fullMerge, MERGE_OPTIONS);
            // H6/H10 fix: parseJsonWithRepair throws on unbalanced/malformed
            // JSON. Wrap in try/catch so the deterministic-concat fallback
            // actually runs on parse failure (not only on null content).
            let parsedMerge: ReturnType<typeof parseJsonWithRepair> | null = null;
            if (mergeResult.success && mergeResult.content) {
                try {
                    parsedMerge = parseJsonWithRepair(mergeResult.content);
                } catch (e) {
                    logger.warn('Minutes', `Per-segment merge JSON parse failed for "${segment.sectionName}":`, e instanceof Error ? e.message : e);
                }
            }
            if (parsedMerge && Array.isArray(parsedMerge.actions)) {
                merged = {
                    actions: parsedMerge.actions ?? merged.actions,
                    decisions: parsedMerge.decisions ?? merged.decisions,
                    risks: parsedMerge.risks ?? merged.risks,
                    notable_points: parsedMerge.notable_points ?? merged.notable_points,
                    open_questions: parsedMerge.open_questions ?? merged.open_questions,
                    deferred_items: parsedMerge.deferred_items ?? merged.deferred_items,
                };
            } else {
                logger.warn('Minutes', `Per-segment merge LLM failed for "${segment.sectionName}" — falling back to deterministic concatenation across ${chunkExtracts.length} chunks`);
                merged = {
                    actions: chunkExtracts.flatMap((c) => c.actions),
                    decisions: chunkExtracts.flatMap((c) => c.decisions),
                    risks: chunkExtracts.flatMap((c) => c.risks),
                    notable_points: chunkExtracts.flatMap((c) => c.notable_points),
                    open_questions: chunkExtracts.flatMap((c) => c.open_questions),
                    deferred_items: chunkExtracts.flatMap((c) => c.deferred_items),
                };
            }
        }

        const extract: SegmentExtract = {
            sectionId: segment.sectionId,
            sectionName: segment.sectionName,
            actions: truncateArray(merged.actions),
            decisions: truncateArray(merged.decisions),
            risks: truncateArray(merged.risks),
            notable_points: truncateArray(merged.notable_points),
            open_questions: truncateArray(merged.open_questions),
            deferred_items: truncateArray(merged.deferred_items),
        };

        return { kind: 'success', sectionId: segment.sectionId, name: segment.sectionName, extract };
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (message === 'cancelled' || signal?.aborted) {
            return {
                kind: 'skipped',
                sectionId: segment.sectionId,
                name: segment.sectionName,
                reason: 'cancelled',
            };
        }
        logger.warn('Minutes', `Segment "${segment.sectionName}" extraction failed:`, message);
        return {
            kind: 'failed',
            sectionId: segment.sectionId,
            name: segment.sectionName,
            error: redactPII(message, 200),
            rawExcerpt: redactPII(transcript, 200),
        };
    }
}

function truncateArray<T>(arr: T[]): T[] {
    return arr.slice(0, PER_FIELD_ITEM_CAP);
}

/**
 * Cross-segment consolidation. Preserves section identity end-to-end
 * (Gemini-G1 fix — uses MinutesJSON.sections[] at every reduce level,
 * never flattens into a SegmentExtract).
 */
async function consolidateAcrossSegments(
    plugin: AIOrganiserPlugin,
    input: MultiSegmentInput,
    results: SegmentResult[],
): Promise<Result<MinutesJSON>> {
    // Separate success extracts from failed/skipped (which propagate directly).
    const successes = results.filter((r): r is Extract<SegmentResult, { kind: 'success' }> => r.kind === 'success');
    const failedOrSkipped = results.filter((r) => r.kind !== 'success');

    let consolidated: MinutesJSON;

    if (successes.length === 0) {
        // All failed/cancelled — build empty consolidation with placeholder sections.
        consolidated = buildEmptyConsolidation(input);
    } else {
        const totalChars = successes.reduce((sum, r) => sum + estimateExtractChars(r.extract), 0);

        if (totalChars > CONSOLIDATION_BUDGET_CHARS || successes.length > 10) {
            // Hierarchical reduce
            consolidated = await hierarchicalReduce(plugin, input, successes.map((s) => s.extract));
        } else {
            // Single consolidation pass
            const consolidatedResult = await singleConsolidation(plugin, input, successes.map((s) => s.extract));
            if (!consolidatedResult.ok) return err(consolidatedResult.error);
            consolidated = consolidatedResult.value;
        }
    }

    // Append failed/skipped section entries
    const sections: SegmentSection[] = consolidated.sections ?? [];
    for (const r of failedOrSkipped) {
        if (r.kind === 'failed') {
            sections.push({
                kind: 'failed',
                sectionId: r.sectionId,
                name: r.name,
                sanitizedError: r.error,
                redactedExcerpt: r.rawExcerpt,
            });
        } else {
            sections.push({
                kind: 'skipped',
                sectionId: r.sectionId,
                name: r.name,
                reason: r.reason,
            });
        }
    }
    consolidated.sections = sections;

    // Preserve original segment order in sections (results array is already ordered).
    const order = new Map(results.map((r, i) => [r.sectionId, i]));
    consolidated.sections.sort((a, b) => (order.get(a.sectionId) ?? 999) - (order.get(b.sectionId) ?? 999));

    return ok(consolidated);
}

async function singleConsolidation(
    plugin: AIOrganiserPlugin,
    input: MultiSegmentInput,
    extracts: SegmentExtract[],
): Promise<Result<MinutesJSON>> {
    const prompt = buildSegmentConsolidationPrompt(extracts, {
        minutesStyle: 'standard',
        outputLanguage: input.languageOverride || 'English',
        meetingMetadata: input.metadata,
        participantsRaw: input.participantsRaw,
        useGTD: input.useGTD,
        dictionaryContent: input.dictionaryContent,
        customInstructions: input.customInstructions,
        styleReference: input.styleReference,
    });
    const result = await plugin.llmService.summarizeText(prompt, CONSOLIDATION_OPTIONS);
    if (!result.success || !result.content) {
        return err(result.error || 'Consolidation LLM call failed');
    }
    const parsed = parseJsonWithRepair(result.content);
    if (!parsed) return err('Consolidation response could not be parsed');
    return ok(parsed);
}

/**
 * Hierarchical reduce — section-provenance preserving (Gemini-G1).
 * Each batch yields a MinutesJSON with sections[]; final merge concatenates
 * sections[] arrays and rolls up flat fields deterministically (no LLM call).
 */
async function hierarchicalReduce(
    plugin: AIOrganiserPlugin,
    input: MultiSegmentInput,
    extracts: SegmentExtract[],
): Promise<MinutesJSON> {
    const batches: SegmentExtract[][] = [];
    for (let i = 0; i < extracts.length; i += REDUCE_BATCH_SIZE) {
        batches.push(extracts.slice(i, i + REDUCE_BATCH_SIZE));
    }

    const batchOutputs: MinutesJSON[] = [];
    for (const batch of batches) {
        const result = await singleConsolidation(plugin, input, batch);
        if (result.ok) batchOutputs.push(result.value);
    }

    return mergeConsolidatedBatches(input, batchOutputs);
}

function mergeConsolidatedBatches(input: MultiSegmentInput, batches: MinutesJSON[]): MinutesJSON {
    if (batches.length === 0) return buildEmptyConsolidation(input);
    if (batches.length === 1) return batches[0];

    const merged: MinutesJSON = {
        metadata: batches[0].metadata,
        participants: dedupParticipants(batches.flatMap((b) => b.participants ?? [])),
        agenda: batches[0].agenda ?? [],
        decisions: batches.flatMap((b) => b.decisions ?? []).slice(0, 30),
        actions: batches.flatMap((b) => b.actions ?? []).slice(0, 50),
        risks: batches.flatMap((b) => b.risks ?? []).slice(0, 8),
        notable_points: batches.flatMap((b) => b.notable_points ?? []).slice(0, 30),
        open_questions: batches.flatMap((b) => b.open_questions ?? []).slice(0, 20),
        deferred_items: batches.flatMap((b) => b.deferred_items ?? []).slice(0, 20),
        sections: batches.flatMap((b) => b.sections ?? []),
    };

    if (input.useGTD) {
        const gtdParts = batches.map((b) => b.gtd_processing).filter((g): g is NonNullable<typeof g> => Boolean(g));
        if (gtdParts.length > 0) {
            merged.gtd_processing = {
                next_actions: gtdParts.flatMap((g) => g.next_actions ?? []),
                waiting_for: gtdParts.flatMap((g) => g.waiting_for ?? []),
                projects: dedupStrings(gtdParts.flatMap((g) => g.projects ?? [])),
                someday_maybe: dedupStrings(gtdParts.flatMap((g) => g.someday_maybe ?? [])),
            };
        }
    }

    return merged;
}

function dedupParticipants(list: Participant[]): Participant[] {
    const seen = new Set<string>();
    const out: Participant[] = [];
    for (const p of list) {
        const key = p.name?.toLowerCase().trim();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(p);
    }
    return out;
}

function dedupStrings(list: string[]): string[] {
    return Array.from(new Set(list.map((s) => s.trim()).filter(Boolean)));
}

function estimateExtractChars(e: SegmentExtract): number {
    return JSON.stringify(e).length;
}

function buildEmptyConsolidation(input: MultiSegmentInput): MinutesJSON {
    return {
        metadata: {
            title: input.metadata.title,
            date: input.metadata.date,
            start_time: input.metadata.startTime,
            end_time: input.metadata.endTime,
            timezone: input.metadata.timezone,
            meeting_context: input.metadata.meetingContext,
            output_audience: input.metadata.outputAudience,
            confidentiality_level: input.metadata.confidentialityLevel,
            chair: input.metadata.chair,
            minute_taker: input.metadata.minuteTaker,
            location: input.metadata.location,
            quorum_present: null,
        },
        participants: [],
        agenda: input.metadata.agenda ?? [],
        decisions: [],
        actions: [],
        risks: [],
        notable_points: [],
        open_questions: [],
        deferred_items: [],
        sections: [],
    };
}
