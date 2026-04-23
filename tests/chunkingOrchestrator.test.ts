/**
 * ChunkingOrchestrator unit tests — map/reduce flow, rolling context,
 * per-chunk error isolation, hierarchical reduction, single-chunk short-
 * circuit.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { orchestrateChunked, type ChunkingOptions } from '../src/services/chunkingOrchestrator';
import type { ContentAssessment } from '../src/services/contentSizePolicy';
import type { SummarizableLLMService } from '../src/services/types';

function makeLLM(responses: Array<{ success: boolean; content?: string; error?: string }>) {
    const calls: Array<{ prompt: string; options?: any }> = [];
    const fn = vi.fn().mockImplementation(async (prompt: string, options?: any) => {
        calls.push({ prompt, options });
        return responses[calls.length - 1] ?? { success: false, error: 'no more mocks' };
    });
    return {
        service: { summarizeText: fn } as unknown as SummarizableLLMService,
        calls,
    };
}

function baseOptions(overrides: Partial<ChunkingOptions> = {}): ChunkingOptions {
    return {
        contentType: 'summarization',
        mapPromptBuilder: (chunk, i, total, ctx) => {
            const base = `<task>summarize chunk ${i}/${total}</task>\n${chunk}`;
            return ctx ? `${base}\n\nPrevious context: ${ctx}` : base;
        },
        reducePromptBuilder: (parts) => `<task>synthesize</task>\n${parts.join('\n---\n')}`,
        overlapChars: 0,
        ...overrides,
    };
}

function baseAssessment(overrides: Partial<ContentAssessment> = {}): ContentAssessment {
    return {
        strategy: 'chunk',
        estimatedChunks: 2,
        qualityChunkChars: 1_000,
        ...overrides,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
});

describe('orchestrateChunked — basic flow', () => {
    it('returns empty summary on empty input', async () => {
        const { service, calls } = makeLLM([]);
        const r = await orchestrateChunked('', baseAssessment(), service, baseOptions());
        expect(r.ok).toBe(true);
        expect(r.summary).toBe('');
        expect(calls).toHaveLength(0);
    });

    it('returns empty summary on whitespace-only input', async () => {
        const { service } = makeLLM([]);
        const r = await orchestrateChunked('   \n\t\n  ', baseAssessment(), service, baseOptions());
        expect(r.ok).toBe(true);
        expect(r.summary).toBe('');
    });

    it('short-circuits on single-chunk content (no reduce call)', async () => {
        const { service, calls } = makeLLM([
            { success: true, content: 'map-result' },
        ]);
        // Assessment says strategy=direct even though we test via orchestrator
        const text = 'short text';
        const r = await orchestrateChunked(text, baseAssessment({ strategy: 'direct' }), service, baseOptions());
        expect(r.ok).toBe(true);
        expect(r.summary).toBe('map-result');
        expect(calls).toHaveLength(1);
    });
});

describe('orchestrateChunked — multi-chunk flow', () => {
    it('calls map N times + reduce once for N chunks below hierarchical threshold', async () => {
        // 2000 char input, maxChars=1000, overlap=0 → 2 chunks + 1 reduce = 3 calls
        const { service, calls } = makeLLM([
            { success: true, content: 'chunk-1-summary' },
            { success: true, content: 'chunk-2-summary' },
            { success: true, content: 'final-summary' },
        ]);
        const text = 'A'.repeat(2_000);
        const r = await orchestrateChunked(
            text,
            baseAssessment({ qualityChunkChars: 1_000, strategy: 'chunk' }),
            service,
            baseOptions(),
        );
        expect(r.ok).toBe(true);
        expect(calls.length).toBeGreaterThanOrEqual(3);
        expect(r.summary).toBe('final-summary');
    });

    it('passes continuationContext from chunk N to chunk N+1 prompt', async () => {
        const { service, calls } = makeLLM([
            { success: true, content: 'summary-of-1\n\ncontinuation_context: actors: Alice, Bob' },
            { success: true, content: 'summary-of-2' },
            { success: true, content: 'final' },
        ]);
        const text = 'A'.repeat(2_500);
        await orchestrateChunked(
            text,
            baseAssessment({ qualityChunkChars: 1_000, strategy: 'chunk' }),
            service,
            baseOptions(),
        );
        // Chunk 1 prompt has no continuation context
        expect(calls[0].prompt).not.toContain('Previous context');
        // Chunk 2 prompt should contain the continuation context extracted from chunk 1's response
        expect(calls[1].prompt).toContain('Previous context');
        expect(calls[1].prompt).toContain('actors: Alice, Bob');
    });

    it('records ChunkError for failed map call but continues remaining chunks', async () => {
        // 3000 char input, maxChars=1000, overlap=0 → 3 chunks + 1 reduce = 4 calls
        const { service } = makeLLM([
            { success: true, content: 'ok-1' },
            { success: false, error: 'network timeout' },
            { success: true, content: 'ok-3' },
            { success: true, content: 'final' },
        ]);
        const text = 'A'.repeat(3_000);
        const r = await orchestrateChunked(
            text,
            baseAssessment({ qualityChunkChars: 1_000, strategy: 'chunk' }),
            service,
            baseOptions(),
        );
        expect(r.ok).toBe(false);
        expect(r.errors).toBeDefined();
        expect(r.errors?.some(e => e.error.includes('network timeout'))).toBe(true);
        expect(r.summary).toBe('final');
    });

    it('returns {ok: false, errors: [...]} with no summary when ALL chunks fail', async () => {
        const { service } = makeLLM([
            { success: false, error: 'err-1' },
            { success: false, error: 'err-2' },
        ]);
        const text = 'A'.repeat(2_000);
        const r = await orchestrateChunked(
            text,
            baseAssessment({ qualityChunkChars: 1_000, strategy: 'chunk' }),
            service,
            baseOptions(),
        );
        expect(r.ok).toBe(false);
        expect(r.summary).toBeUndefined();
        expect(r.errors).toBeDefined();
        expect(r.errors!.length).toBeGreaterThanOrEqual(2);
    });

    it('fires onProgress for each completed chunk', async () => {
        const { service } = makeLLM([
            { success: true, content: 'a' },
            { success: true, content: 'b' },
            { success: true, content: 'final' },
        ]);
        const progressCalls: Array<{ done: number; total: number }> = [];
        const text = 'A'.repeat(2_200);
        await orchestrateChunked(
            text,
            baseAssessment({ qualityChunkChars: 1_000, strategy: 'chunk' }),
            service,
            baseOptions({
                onProgress: (done, total) => progressCalls.push({ done, total }),
            }),
        );
        expect(progressCalls.length).toBeGreaterThan(0);
        // Last progress call should show all chunks done
        const last = progressCalls[progressCalls.length - 1];
        expect(last.done).toBe(last.total);
    });
});

describe('orchestrateChunked — hierarchical reduce', () => {
    it('batches partial summaries into groups when chunk count > HIERARCHICAL_CHUNK_THRESHOLD', async () => {
        // 6000 chars / maxChars=1000 / overlap=0 → 6 chunks.
        // 6 maps + 2 intermediate-batch reduces (4+2) + 1 final = 9 calls
        const { service } = makeLLM([
            { success: true, content: 'c1' },
            { success: true, content: 'c2' },
            { success: true, content: 'c3' },
            { success: true, content: 'c4' },
            { success: true, content: 'c5' },
            { success: true, content: 'c6' },
            { success: true, content: 'intermediate-1' },
            { success: true, content: 'intermediate-2' },
            { success: true, content: 'final' },
        ]);
        const text = 'A'.repeat(6_000);
        const r = await orchestrateChunked(
            text,
            baseAssessment({
                qualityChunkChars: 1_000,
                strategy: 'hierarchical',
                estimatedChunks: 6,
            }),
            service,
            baseOptions(),
        );
        expect(r.ok).toBe(true);
        expect(r.summary).toBe('final');
    });
});

describe('orchestrateChunked — map output parsing', () => {
    it('strips continuation context from summary body', async () => {
        const { service, calls } = makeLLM([
            { success: true, content: 'real summary body\n\ncontinuation context: entities X, Y' },
            { success: true, content: 'second summary' },
            { success: true, content: 'final' },
        ]);
        const text = 'A'.repeat(2_000);
        await orchestrateChunked(
            text,
            baseAssessment({ qualityChunkChars: 1_000, strategy: 'chunk' }),
            service,
            baseOptions(),
        );
        // The reduce prompt should contain the summary-body only (not the continuation line)
        const reducePrompt = calls[calls.length - 1].prompt;
        expect(reducePrompt).toContain('real summary body');
        expect(reducePrompt).not.toContain('continuation context: entities X, Y');
    });
});
