/**
 * LLM Markdown Enhancer — orchestrator.
 *
 * Splits the raw note at H2 boundaries (fence-aware per R1 M2), enhances
 * each chunk in parallel (concurrency cap 4) with retry on 429/503
 * (Gemini G2-M3 thunk pattern), joins the enhanced chunks back together.
 *
 * Per-chunk failure degrades gracefully: failed chunk passes through with
 * its original markdown so the user still gets the deterministic-transform
 * output for that section (#16 graceful degradation). Total failure
 * surfaces as `Result.err` and the caller falls back to literal-mode.
 */

import { err, ok, type Result } from '../../core/result';
import { logger } from '../../utils/logger';
import { retryWithBackoff, DEFAULT_TTS_RETRY, type RetryPolicy } from '../tts/ttsRetry';
import { mapWithConcurrency } from '../../utils/mapWithConcurrency';
import type { App } from 'obsidian';
import type { EnhancementContext } from './llmEnhancerPrompts';
import type {
    EnhancementDecision,
    LlmEnhancementProvider,
} from './llmEnhancerProvider';

const DEFAULT_CONCURRENCY = 4;

export interface ChunkingOptions {
    concurrency: number;
    timeoutMs: number;
    retryConfig?: RetryPolicy;
    /** Per-chunk completion callback for withProgress wiring */
    onChunkComplete?: (completed: number, total: number) => void;
}

export interface EnhanceMarkdownResult {
    enhancedMarkdown: string;
    totalCostUsd: number;
    decisions: EnhancementDecision[];
    /** Chunks that fell back to original markdown — surfaced as a warning */
    failedChunkTitles: string[];
}

export interface H2Chunk {
    title: string;
    body: string;
    startLine: number;
    endLine: number;
}

/** Strip YAML frontmatter (between leading --- markers). */
function stripFrontmatter(raw: string): string {
    if (!raw.startsWith('---\n') && !raw.startsWith('---\r\n')) return raw;
    const m = raw.match(/^---\r?\n[\s\S]*?\n---\r?\n?/);
    return m ? raw.slice(m[0].length) : raw;
}

/**
 * Fence-aware H2 splitter. Skips `## ` inside:
 *   - fenced code blocks (``` and ~~~)
 *   - mermaid blocks (a special case of code fence)
 *   - obsidian callouts (block starting with `> [!...]`)
 *
 * Returns ordered chunks. The pre-H2 intro (between H1 and first H2)
 * becomes its own "Introduction" chunk so the LLM can do a clean opening
 * read of the executive-summary content.
 */
export function splitByH2(rawMarkdown: string): H2Chunk[] {
    const stripped = stripFrontmatter(rawMarkdown);
    const lines = stripped.split('\n');
    const chunks: H2Chunk[] = [];
    let current: { title: string; bodyLines: string[]; startLine: number } = {
        title: 'Introduction',
        bodyLines: [],
        startLine: 0,
    };
    let inFence = false;
    let fenceMarker: '`' | '~' | null = null;
    let inCallout = false;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trimStart();

        // Fence tracking — only ``` and ~~~ open/close a fence
        const fenceMatch = trimmed.match(/^(`{3,}|~{3,})/);
        if (fenceMatch) {
            const char = fenceMatch[1][0] as '`' | '~';
            if (!inFence) { inFence = true; fenceMarker = char; }
            else if (char === fenceMarker) { inFence = false; fenceMarker = null; }
        }

        // Callout tracking — `> [!...]` opens, a blank line or non-`>` closes
        if (!inFence) {
            if (/^>\s*\[!/.test(trimmed)) inCallout = true;
            else if (trimmed === '' || !trimmed.startsWith('>')) inCallout = false;
        }

        const isH2 = !inFence && !inCallout && /^##\s+/.test(trimmed);
        if (isH2) {
            // Flush previous chunk
            if (current.bodyLines.length > 0) {
                chunks.push({
                    title: current.title,
                    body: current.bodyLines.join('\n').trim(),
                    startLine: current.startLine,
                    endLine: i - 1,
                });
            }
            const title = trimmed.replace(/^##\s+/, '').trim();
            current = { title, bodyLines: [line], startLine: i };
        } else {
            current.bodyLines.push(line);
        }
    }
    if (current.bodyLines.length > 0) {
        chunks.push({
            title: current.title,
            body: current.bodyLines.join('\n').trim(),
            startLine: current.startLine,
            endLine: lines.length - 1,
        });
    }
    return chunks.filter(c => c.body.length > 0);
}

/** Extract note H1 from the raw markdown — for the EnhancementContext title. */
function extractH1(rawMarkdown: string): string {
    const stripped = stripFrontmatter(rawMarkdown);
    const m = stripped.match(/^#\s+(.+?)$/m);
    return m ? m[1].trim() : 'Note';
}

/**
 * Enhance the full note markdown via the configured LLM provider.
 *
 * Returns the joined enhanced markdown + accumulated cost + decisions
 * + the list of chunk titles that fell back to original markdown (for the
 * `llm-enhancement-partial` warning).
 *
 * Total failure (zero chunks succeeded, or input was empty) returns
 * `Result.err` so the caller falls back to literal-mode.
 */
export async function enhanceMarkdown(
    app: App,
    rawMarkdown: string,
    provider: LlmEnhancementProvider,
    apiKey: string,
    options: Partial<ChunkingOptions> = {},
    signal?: AbortSignal,
): Promise<Result<EnhanceMarkdownResult>> {
    // Audit-code H7: pre-aborted signal returns immediately, before any
    // worker can pick up a chunk.
    if (signal?.aborted) return err('aborted');
    const noteTitle = extractH1(rawMarkdown);
    const chunks = splitByH2(rawMarkdown);
    if (chunks.length === 0) {
        return err('empty-note');
    }
    const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
    const retryConfig = options.retryConfig ?? DEFAULT_TTS_RETRY;
    let completedCount = 0;

    const outcomes = await mapWithConcurrency(chunks, concurrency, async (chunk, idx) => {
        const ctx: EnhancementContext = {
            noteTitle,
            chunkIndex: idx + 1,
            chunkTotal: chunks.length,
            prevSectionTitle: idx > 0 ? chunks[idx - 1].title : '',
            nextSectionTitle: idx < chunks.length - 1 ? chunks[idx + 1].title : '',
            timeoutMs: options.timeoutMs,
        };
        try {
            // Gemini G2-M3: thunk-wrapped retry — retryWithBackoff invokes
            // each attempt fresh. Retryable errors throw to trigger backoff;
            // non-retryable errors return the outcome directly.
            const outcome = await retryWithBackoff(
                async () => {
                    const o = await provider.enhance(app, chunk.body, apiKey, ctx, signal);
                    if (!o.ok && o.metadata.retryable) {
                        const e = new Error(o.code) as Error & { retryAfterMs?: number };
                        e.retryAfterMs = o.metadata.retryAfterMs;
                        throw e;
                    }
                    return o;
                },
                retryConfig,
                signal,
                (attempt, delayMs, e) => logger.warn(
                    'LlmEnhancer',
                    `Chunk ${idx + 1}/${chunks.length} attempt ${attempt} failed (${e instanceof Error ? e.message : String(e)}); retrying in ${delayMs}ms`,
                ),
            );
            return outcome;
        } catch (e) {
            // retryWithBackoff exhausted retries OR aborted
            const message = e instanceof Error ? e.message : String(e);
            if (/abort/i.test(message)) {
                return { ok: false as const, code: 'aborted' as const, metadata: { retryable: false } };
            }
            return { ok: false as const, code: message as never, metadata: { retryable: false } };
        } finally {
            completedCount++;
            // Audit-code M16: progress callback must never break the pipeline.
            // If the host's onChunkComplete throws, swallow it and continue.
            try { options.onChunkComplete?.(completedCount, chunks.length); }
            catch (e) { logger.warn('LlmEnhancer', `onChunkComplete threw: ${e instanceof Error ? e.message : String(e)}`); }
        }
    }, signal);

    // Was caller cancellation hit?
    if (signal?.aborted) return err('aborted');

    // Build the joined output. Failed chunks pass through their original markdown.
    const enhancedSections: string[] = [];
    const accumulatedDecisions: EnhancementDecision[] = [];
    let totalCost = 0;
    const failedTitles: string[] = [];

    outcomes.forEach((outcome, idx) => {
        // Audit-code H7 follow-through: unstarted chunks (worker exited on
        // abort before reaching this index) leave undefined entries. Treat
        // as graceful fallback — keep original markdown, no warning (the
        // top-level signal.aborted check covers user-visible cancellation).
        if (!outcome) {
            enhancedSections.push(chunks[idx].body);
            return;
        }
        if (outcome.ok) {
            enhancedSections.push(outcome.value.enhancedMarkdown);
            accumulatedDecisions.push(...outcome.value.decisions);
            totalCost += outcome.value.actualCostUsd;
        } else {
            failedTitles.push(chunks[idx].title);
            enhancedSections.push(chunks[idx].body); // graceful: pass-through original
        }
    });

    // If EVERY chunk failed, surface as total failure → caller falls back to literal
    if (failedTitles.length === chunks.length) {
        return err('all-chunks-failed');
    }

    return ok({
        enhancedMarkdown: enhancedSections.join('\n\n'),
        totalCostUsd: totalCost,
        decisions: accumulatedDecisions,
        failedChunkTitles: failedTitles,
    });
}
