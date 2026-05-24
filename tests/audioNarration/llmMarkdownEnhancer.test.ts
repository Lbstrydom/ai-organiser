/**
 * llmMarkdownEnhancer unit tests — splitter robustness, concurrency,
 * graceful degradation, retry semantics.
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { enhanceMarkdown, splitByH2 } from '../../src/services/audioNarration/llmMarkdownEnhancer';
import type {
    EnhancerCallOutcome,
    LlmEnhancementProvider,
} from '../../src/services/audioNarration/llmEnhancerProvider';

const FIXTURE = readFileSync(
    join(__dirname, '..', 'fixtures', 'llmEnhancer', 'input-mermaid-heavy.md'),
    'utf-8',
);

function makeProvider(impl: LlmEnhancementProvider['enhance']): LlmEnhancementProvider {
    return {
        id: 'gemini',
        displayName: 'Test Gemini',
        modelSentinel: 'latest-flash',
        costPerMTokensInput: 0.075,
        costPerMTokensOutput: 0.30,
        enhance: impl,
    };
}

function okOutcome(text: string, cost = 0.001): EnhancerCallOutcome {
    return {
        ok: true,
        value: { enhancedMarkdown: text, decisions: [], actualCostUsd: cost },
        metadata: { httpStatus: 200, retryable: false },
    };
}

const makeApp = (): any => ({ vault: {} });

describe('splitByH2 — fence and structure awareness', () => {
    it('returns one chunk for a note with no H2', () => {
        const chunks = splitByH2('# Title\n\nJust a paragraph.');
        expect(chunks).toHaveLength(1);
        expect(chunks[0].title).toBe('Introduction');
    });

    it('strips frontmatter before splitting', () => {
        const note = '---\ntags: x\n---\n# T\n\nIntro.\n\n## Real H2\n\nBody.';
        const chunks = splitByH2(note);
        expect(chunks).toHaveLength(2);
        expect(chunks[0].title).toBe('Introduction');
        expect(chunks[1].title).toBe('Real H2');
    });

    it('does NOT split on ## inside a fenced code block', () => {
        const note = '# T\n\n## Real\n\n```\n## fake-h2-in-code\n```\n\n## Another';
        const chunks = splitByH2(note);
        expect(chunks.map(c => c.title)).toEqual(['Introduction', 'Real', 'Another']);
    });

    it('does NOT split on ## inside a mermaid block', () => {
        const note = '# T\n\n## A\n\n```mermaid\n## not-a-header\nflowchart TD\n```\n\n## B';
        const chunks = splitByH2(note);
        expect(chunks.map(c => c.title)).toEqual(['Introduction', 'A', 'B']);
    });

    it('does NOT split on ## inside an obsidian callout', () => {
        const note = '# T\n\n## A\n\n> [!note] Heading\n> ## not-real\n> body\n\n## B';
        const chunks = splitByH2(note);
        expect(chunks.map(c => c.title)).toEqual(['Introduction', 'A', 'B']);
    });

    it('splits the fixture into expected sections', () => {
        const chunks = splitByH2(FIXTURE);
        expect(chunks.map(c => c.title)).toEqual([
            'Introduction',
            'Introduction', // The "## Introduction" H2 is also "Introduction"
            'Decision tree',
            'Maturity table',
        ]);
        // The mermaid block should be inside the "Decision tree" chunk, not split out
        const dtChunk = chunks.find((c, i) => c.title === 'Decision tree' && i === 2);
        expect(dtChunk?.body).toContain('flowchart TD');
    });
});

describe('enhanceMarkdown — orchestration', () => {
    it('returns err for empty / frontmatter-only notes', async () => {
        const provider = makeProvider(async () => okOutcome('x'));
        const r = await enhanceMarkdown(makeApp(), '', provider, 'k');
        expect(r.ok).toBe(false);
    });

    it('calls provider.enhance exactly N times for N chunks', async () => {
        const spy = vi.fn(async (): Promise<EnhancerCallOutcome> => okOutcome('out'));
        const provider = makeProvider(spy);
        const r = await enhanceMarkdown(makeApp(), FIXTURE, provider, 'k');
        expect(r.ok).toBe(true);
        const expectedChunks = splitByH2(FIXTURE).length;
        expect(spy).toHaveBeenCalledTimes(expectedChunks);
    });

    it('respects concurrency cap', async () => {
        let inflight = 0;
        let peak = 0;
        const provider = makeProvider(async () => {
            inflight++;
            peak = Math.max(peak, inflight);
            await new Promise(r => setTimeout(r, 10));
            inflight--;
            return okOutcome('out');
        });
        // 8 chunks, cap of 2
        const note = '# T\n\n' + Array.from({ length: 8 }, (_, i) => `## H${i}\nbody${i}`).join('\n\n');
        await enhanceMarkdown(makeApp(), note, provider, 'k', { concurrency: 2 });
        expect(peak).toBeLessThanOrEqual(2);
    });

    it('accumulates total cost across chunks', async () => {
        let n = 0;
        const provider = makeProvider(async () => { n++; return okOutcome(`out${n}`, 0.005); });
        const r = await enhanceMarkdown(makeApp(), FIXTURE, provider, 'k');
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.value.totalCostUsd).toBeCloseTo(splitByH2(FIXTURE).length * 0.005, 5);
    });

    it('graceful degradation — failed chunk falls back to original markdown + warning', async () => {
        let n = 0;
        const provider = makeProvider(async () => {
            n++;
            if (n === 2) {
                // Non-retryable failure (avoid retry loop)
                return {
                    ok: false,
                    code: 'malformed-response',
                    metadata: { retryable: false },
                } as EnhancerCallOutcome;
            }
            return okOutcome(`enhanced-${n}`);
        });
        const r = await enhanceMarkdown(makeApp(), FIXTURE, provider, 'k');
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.value.failedChunkTitles).toHaveLength(1);
        // Original markdown for chunk 2 should appear in the joined output
        const chunk2Body = splitByH2(FIXTURE)[1].body;
        expect(r.value.enhancedMarkdown).toContain(chunk2Body);
    });

    it('total failure (every chunk fails) → returns err so caller falls back to literal', async () => {
        const provider = makeProvider(async () => ({
            ok: false,
            code: 'malformed-response',
            metadata: { retryable: false },
        } as EnhancerCallOutcome));
        const r = await enhanceMarkdown(makeApp(), FIXTURE, provider, 'k');
        expect(r.ok).toBe(false);
    });

    it('pre-aborted signal returns aborted', async () => {
        const ctrl = new AbortController();
        ctrl.abort();
        const provider = makeProvider(async () => okOutcome('out'));
        const r = await enhanceMarkdown(makeApp(), FIXTURE, provider, 'k', {}, ctrl.signal);
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.error).toBe('aborted');
    });

    it('onChunkComplete fires once per chunk', async () => {
        const onChunkComplete = vi.fn();
        const provider = makeProvider(async () => okOutcome('out'));
        await enhanceMarkdown(makeApp(), FIXTURE, provider, 'k', { onChunkComplete });
        const total = splitByH2(FIXTURE).length;
        expect(onChunkComplete).toHaveBeenCalledTimes(total);
        const lastCall = onChunkComplete.mock.calls[onChunkComplete.mock.calls.length - 1];
        expect(lastCall).toEqual([total, total]);
    });

    it('audit-code M16: onChunkComplete that throws does NOT break the pipeline', async () => {
        const provider = makeProvider(async () => okOutcome('out'));
        const onChunkComplete = vi.fn(() => { throw new Error('host bug'); });
        const r = await enhanceMarkdown(makeApp(), FIXTURE, provider, 'k', { onChunkComplete });
        expect(r.ok).toBe(true); // pipeline still completes despite throwing callback
        expect(onChunkComplete).toHaveBeenCalled();
    });

    it('audit-code H7: mid-run abort drops queued chunks without invoking provider further', async () => {
        const ctrl = new AbortController();
        let calls = 0;
        const provider = makeProvider(async () => {
            calls++;
            if (calls === 1) ctrl.abort(); // abort after first chunk starts
            await new Promise(r => setTimeout(r, 5));
            return okOutcome('out');
        });
        // 6 chunks, concurrency 1 so the abort takes effect before chunk 2 starts
        const note = '# T\n\n' + Array.from({ length: 6 }, (_, i) => `## H${i}\nbody${i}`).join('\n\n');
        const r = await enhanceMarkdown(makeApp(), note, provider, 'k', { concurrency: 1 }, ctrl.signal);
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.error).toBe('aborted');
        // Provider invoked at most a couple of times (chunk 1 + maybe in-flight #2)
        expect(calls).toBeLessThan(6);
    });

    it('preserves chunk order in joined output', async () => {
        const provider = makeProvider(async (_app, body) => {
            // Echo the original chunk H2 line so we can verify order. The
            // intro chunk (pre-first-H2) has no ## line; tag it INTRO.
            const h2 = body.match(/^##\s+(.+)$/m)?.[1] ?? 'INTRO';
            return okOutcome(`OUT:${h2}`);
        });
        const r = await enhanceMarkdown(makeApp(), FIXTURE, provider, 'k');
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        const outputOrder = r.value.enhancedMarkdown.split('\n\n').map(s => s.replace(/^OUT:/, ''));
        // The first chunk is the H1 intro (no H2 → INTRO marker);
        // remaining chunks follow the fixture's H2 order.
        expect(outputOrder).toEqual(['INTRO', 'Introduction', 'Decision tree', 'Maturity table']);
    });
});
