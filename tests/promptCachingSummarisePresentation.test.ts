/**
 * Prompt caching rollout — summarise map phase and the presentation iterate loop.
 *
 * Byte identity is asserted against `tests/fixtures/prompt-caching-baseline`
 * (prompts rendered before the rollout), so the oracle does not depend on the
 * code under test.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import baseline from './fixtures/prompt-caching-baseline/baseline.json';
import { SUMMARY_CASES, IR_LANGUAGES, IR_REFINE_REQUESTS, IR_SELECTIONS } from './fixtures/prompt-caching-baseline/cases';
import { coffeeDeckIr } from './fixtures/coffeeDeckIr';
import { buildSummaryPrompt, buildSummaryPromptParts, insertContentIntoPrompt } from '../src/services/prompts/summaryPrompts';
import { joinPromptParts } from '../src/services/prompts/promptParts';
import { orchestrateChunked, resolveMapCall, type ChunkingOptions } from '../src/services/chunkingOrchestrator';
import type { ContentAssessment } from '../src/services/contentSizePolicy';
import { refineDeckIr, generateDeckIr } from '../src/services/chat/presentationHtmlService';
import { refineDeckIrSelective } from '../src/services/chat/refineDeckIrSelective';
import { buildIrSystemPrompt } from '../src/services/presentationIr/irPrompts';
import type { LLMFacadeContext } from '../src/services/llmFacade';
import type { SummarizableLLMService, SummarizeOptions } from '../src/services/types';

const fixture = baseline as Record<string, string>;

// ── Summarise: persona head as a cacheable prefix ───────────────────────────

describe('summary prompt — byte identity with the pre-rollout baseline', () => {
    for (const [name, c] of Object.entries(SUMMARY_CASES)) {
        it(`buildSummaryPrompt and join(parts) match the baseline: ${name}`, () => {
            const expected = fixture[`summary:${name}`];
            expect(expected).toBeTruthy();
            expect(insertContentIntoPrompt(buildSummaryPrompt(c.options), c.content)).toBe(expected);
            const parts = buildSummaryPromptParts(c.options);
            expect(insertContentIntoPrompt(joinPromptParts(parts.stablePrefix, parts.prompt), c.content)).toBe(expected);
            // The content placeholder lives in the volatile tail, so per-chunk fill never touches the head.
            expect(insertContentIntoPrompt(parts.prompt, c.content)).toContain(c.content);
        });
    }
});

describe('summary prompt — the persona head is byte-stable across chunks', () => {
    const persona = SUMMARY_CASES['persona-detailed-lang-ctx'].options;

    it('differs only in the tail for different chunk positions and previous-context text', () => {
        const a = buildSummaryPromptParts({ ...persona, chunkIndex: 1, chunkTotal: 4, userContext: 'Focus' });
        const b = buildSummaryPromptParts({ ...persona, chunkIndex: 3, chunkTotal: 4, userContext: 'Focus\n\nPrevious context: something new' });
        expect(a.stablePrefix).toBeTruthy();
        expect(a.stablePrefix).toBe(b.stablePrefix);
        expect(a.prompt).not.toBe(b.prompt);
    });

    it('the head carries no chunk position, language, user context or placeholder', () => {
        const parts = buildSummaryPromptParts({ ...persona, chunkIndex: 2, chunkTotal: 9, userContext: 'UNIQUE-FOCUS' });
        for (const volatile of ['part 2 of 9', 'UNIQUE-FOCUS', 'French', 'CONTENT_PLACEHOLDER']) {
            expect(parts.stablePrefix).not.toContain(volatile);
        }
    });

    it('without a persona nothing is split (the fixed head is too small to cache)', () => {
        expect(buildSummaryPromptParts(SUMMARY_CASES['basic-standard'].options).stablePrefix).toBeUndefined();
    });
});

// ── Chunk orchestrator ──────────────────────────────────────────────────────

describe('resolveMapCall', () => {
    it('a string builder result leaves the options untouched (legacy callers)', () => {
        const base = { stablePrefix: 'OPT', maxTokens: 5 };
        expect(resolveMapCall('whole prompt', base)).toEqual({ prompt: 'whole prompt', options: base });
        expect(resolveMapCall('whole prompt', undefined)).toEqual({ prompt: 'whole prompt', options: undefined });
    });

    it('a split result with no option prefix sends the builder head as stablePrefix', () => {
        const r = resolveMapCall({ stablePrefix: 'B', prompt: 'tail' }, { maxTokens: 5 });
        expect(r).toEqual({ prompt: 'tail', options: { maxTokens: 5, stablePrefix: 'B' } });
    });

    it('an option-supplied prefix is never overwritten: it leads, then the builder head', () => {
        const r = resolveMapCall({ stablePrefix: 'B', prompt: 'tail' }, { stablePrefix: 'OPT' });
        expect(r.options?.stablePrefix).toBe('OPT\n\nB');
        expect(joinPromptParts(r.options?.stablePrefix, r.prompt)).toBe('OPT\n\nB\n\ntail');
    });

    it('a split result without a head keeps the option prefix', () => {
        expect(resolveMapCall({ prompt: 'tail' }, { stablePrefix: 'OPT' })).toEqual({ prompt: 'tail', options: { stablePrefix: 'OPT' } });
    });
});

describe('orchestrateChunked prefix handling', () => {
    const assessment = { strategy: 'chunk', qualityChunkChars: 120, estimatedChunks: 3 } as unknown as ContentAssessment;
    const longText = Array.from({ length: 8 }, (_v, i) => `Paragraph ${i} ${'word '.repeat(20)}`).join('\n\n');

    // The async chunker yields via `window.setTimeout`.
    let hadWindow = false;
    let originalWindow: unknown;
    beforeEach(() => {
        hadWindow = Object.prototype.hasOwnProperty.call(globalThis, 'window');
        originalWindow = (globalThis as unknown as { window?: unknown }).window;
        (globalThis as unknown as { window: unknown }).window = globalThis;
    });
    afterEach(() => {
        if (hadWindow) (globalThis as unknown as { window?: unknown }).window = originalWindow;
        else delete (globalThis as unknown as { window?: unknown }).window;
    });

    const run = async (builder: ChunkingOptions['mapPromptBuilder'], mapOptions?: SummarizeOptions, text = longText) => {
        const calls: Array<{ prompt: string; options?: SummarizeOptions }> = [];
        const llm = {
            summarizeText: vi.fn(async (prompt: string, options?: SummarizeOptions) => {
                calls.push({ prompt, options });
                return { success: true, content: 'summary' };
            }),
        } as unknown as SummarizableLLMService;
        await orchestrateChunked(text, assessment, llm, {
            contentType: 'summarization',
            mapPromptBuilder: builder,
            reducePromptBuilder: () => '<task>reduce</task>',
            mapOptions,
            overlapChars: 0,
        });
        return calls;
    };

    const split: ChunkingOptions['mapPromptBuilder'] = (chunk) => ({ stablePrefix: 'HEAD', prompt: `<task>map</task> ${chunk.slice(0, 8)}` });

    it('multi-chunk: every map call carries the head as stablePrefix; the reduce call does not', async () => {
        const calls = await run(split);
        const maps = calls.slice(0, -1);
        expect(maps.length).toBeGreaterThan(1);
        for (const c of maps) {
            expect(c.options?.stablePrefix).toBe('HEAD');
            expect(c.prompt).not.toContain('HEAD');
        }
        expect(calls[calls.length - 1].options?.stablePrefix).toBeUndefined();
    });

    it('multi-chunk: an option-supplied prefix survives a split builder', async () => {
        const calls = await run(split, { stablePrefix: 'OPT' });
        expect(calls[0].options?.stablePrefix).toBe('OPT\n\nHEAD');
    });

    it('multi-chunk: a string builder keeps its option-supplied prefix', async () => {
        const calls = await run((chunk) => `<task>map</task> ${chunk.slice(0, 8)}`, { stablePrefix: 'OPT' });
        expect(calls[0].options?.stablePrefix).toBe('OPT');
    });

    it('single chunk (one-shot): the head is joined into the prompt, not marked', async () => {
        const calls = await run(split, undefined, 'short text');
        expect(calls).toHaveLength(1);
        expect(calls[0].options?.stablePrefix).toBeUndefined();
        expect(calls[0].prompt).toBe('HEAD\n\n<task>map</task> short te');
    });

    it('single chunk: an option prefix still leads, and the builder head is joined into the prompt', async () => {
        const calls = await run(split, { stablePrefix: 'OPT' }, 'short text');
        expect(calls[0].options?.stablePrefix).toBe('OPT');
        expect(calls[0].prompt).toBe('HEAD\n\n<task>map</task> short te');
    });
});

// ── Presentation iterate loop ───────────────────────────────────────────────

describe('presentation refine / polish send the IR system prompt as the cacheable prefix', () => {
    const calls: Array<{ prompt: string; options?: SummarizeOptions }> = [];
    const context = (content: string): LLMFacadeContext => ({
        settings: { serviceType: 'cloud', cloudServiceType: 'claude' },
        llmService: {
            summarizeText: vi.fn(async (prompt: string, options?: SummarizeOptions) => {
                calls.push({ prompt, options });
                return { success: true, content };
            }),
        } as unknown as SummarizableLLMService,
    });
    beforeEach(() => { calls.length = 0; });

    for (const lang of IR_LANGUAGES) {
        it(`refineDeckIr (${lang ?? 'no language'}): prefix = system prompt; joined text equals the pre-rollout prompt`, async () => {
            const res = await refineDeckIr(context(JSON.stringify(coffeeDeckIr)), {
                currentDeck: coffeeDeckIr, userRequest: IR_REFINE_REQUESTS[0], outputLanguage: lang,
            });
            expect(res.ok).toBe(true);
            expect(calls).toHaveLength(1);
            expect(calls[0].options?.stablePrefix).toBe(buildIrSystemPrompt({ outputLanguage: lang }));
            expect(calls[0].options?.label).toBe('presentation-refine');
            expect(joinPromptParts(calls[0].options?.stablePrefix, calls[0].prompt)).toBe(fixture[`irRefine:${lang ?? 'none'}:0`]);
        });

        it(`refineDeckIrSelective (${lang ?? 'no language'}): prefix = system prompt; joined text equals the pre-rollout prompt`, async () => {
            await refineDeckIrSelective(context('not a deck'), {
                currentDeck: coffeeDeckIr, selections: IR_SELECTIONS, outputLanguage: lang,
            });
            expect(calls.length).toBeGreaterThanOrEqual(1);
            expect(calls[0].options?.stablePrefix).toBe(buildIrSystemPrompt({ outputLanguage: lang }));
            expect(calls[0].options?.label).toBe('presentation-polish');
            expect(joinPromptParts(calls[0].options?.stablePrefix, calls[0].prompt)).toBe(fixture[`irSelective:${lang ?? 'none'}`]);
            // a repair retry, if one happens, reuses the very same prefix
            for (const c of calls) expect(c.options?.stablePrefix).toBe(calls[0].options?.stablePrefix);
        });
    }

    it('refine and polish share one prefix for the same language (one cache entry)', async () => {
        await refineDeckIr(context(JSON.stringify(coffeeDeckIr)), { currentDeck: coffeeDeckIr, userRequest: 'x', outputLanguage: 'French' });
        await refineDeckIrSelective(context('not a deck'), { currentDeck: coffeeDeckIr, selections: IR_SELECTIONS, outputLanguage: 'French' });
        expect(calls[0].options?.stablePrefix).toBeTruthy();
        expect(calls[0].options?.stablePrefix).toBe(calls[calls.length - 1].options?.stablePrefix);
    });

    it('generateDeckIr is not marked: its prefix carries the slide count and a repair is rare', async () => {
        await generateDeckIr(context(JSON.stringify(coffeeDeckIr)), { userQuery: 'make a deck', noteContent: 'note', outputLanguage: 'English' } as never);
        expect(calls[0].options?.stablePrefix).toBeUndefined();
        expect(calls[0].prompt).toContain('You are a presentation designer');
    });
});
