/**
 * Tests for refineDeckIrSelective — layered validation + splice contract +
 * size guard + abort. Each case names the layer it exercises (plan §9.1).
 */
import { describe, it, expect, vi } from 'vitest';
import {
    refineDeckIrSelective,
    parseRefineErrorCode,
    buildSelectivePrompt,
} from '../src/services/chat/refineDeckIrSelective';
import type { LLMFacadeContext, LLMCallResult } from '../src/services/llmFacade';
import { coffeeDeckIr } from './fixtures/coffeeDeckIr';
import type { SlideDeckIr, SlideIr } from '../src/services/presentationIr/slideIr';
import { IR_SCHEMA_VERSION } from '../src/services/presentationIr/slideIr';

type Stub = (prompt: string, opts?: unknown) => Promise<LLMCallResult>;

function makeCtx(stub: Stub, provider = 'claude'): { ctx: LLMFacadeContext; fn: ReturnType<typeof vi.fn> } {
    const fn = vi.fn(stub);
    const ctx: LLMFacadeContext = {
        llmService: { summarizeText: fn } as never,
        settings: { serviceType: 'cloud', cloudServiceType: provider },
    };
    return { ctx, fn };
}

/** A valid content slide with the given id (id is force-preserved on splice). */
function contentSlide(id: string, title: string): SlideIr {
    return { id, type: 'content', title, blocks: [{ kind: 'paragraph', text: `polished ${title}` }] };
}

function jsonResponse(slices: Array<{ slideIndex: number; slide: unknown }>): LLMCallResult {
    return { success: true, content: JSON.stringify({ slices }) };
}

describe('refineDeckIrSelective — pre-LLM validation', () => {
    it('empty-selections → err, no LLM call', async () => {
        const { ctx, fn } = makeCtx(async () => jsonResponse([]));
        const res = await refineDeckIrSelective(ctx, { currentDeck: coffeeDeckIr, selections: [] });
        expect(res.ok).toBe(false);
        expect(!res.ok && parseRefineErrorCode(res.error)).toBe('empty-selections');
        expect(fn).not.toHaveBeenCalled();
    });

    it('duplicate-selection-index → err, no LLM call', async () => {
        const { ctx, fn } = makeCtx(async () => jsonResponse([]));
        const res = await refineDeckIrSelective(ctx, {
            currentDeck: coffeeDeckIr,
            selections: [{ slideIndex: 1, instruction: 'a' }, { slideIndex: 1, instruction: 'b' }],
        });
        expect(!res.ok && parseRefineErrorCode(res.error)).toBe('duplicate-selection-index');
        expect(fn).not.toHaveBeenCalled();
    });

    it('selection-out-of-range → err, no LLM call', async () => {
        const { ctx, fn } = makeCtx(async () => jsonResponse([]));
        const res = await refineDeckIrSelective(ctx, {
            currentDeck: coffeeDeckIr,
            selections: [{ slideIndex: 99, instruction: 'a' }],
        });
        expect(!res.ok && parseRefineErrorCode(res.error)).toBe('selection-out-of-range');
        expect(fn).not.toHaveBeenCalled();
    });

    it('deck-too-large → err, no LLM call', async () => {
        const { ctx, fn } = makeCtx(async () => jsonResponse([]), 'local'); // small budget
        const big = 'x'.repeat(2000);
        const largeDeck = {
            schemaVersion: IR_SCHEMA_VERSION,
            slides: Array.from({ length: 12 }, (_, i) => ({
                id: `s${i}`, type: 'content', title: 't',
                blocks: [{ kind: 'paragraph', text: big }],
                notes: 'y'.repeat(4000),
            })),
        } as unknown as SlideDeckIr;
        const res = await refineDeckIrSelective(ctx, {
            currentDeck: largeDeck,
            selections: [{ slideIndex: 0, instruction: 'a' }],
        });
        expect(!res.ok && parseRefineErrorCode(res.error)).toBe('deck-too-large');
        expect(fn).not.toHaveBeenCalled();
    });

    it('aborted pre-LLM → err, no LLM call', async () => {
        const { ctx, fn } = makeCtx(async () => jsonResponse([]));
        const controller = new AbortController();
        controller.abort();
        const res = await refineDeckIrSelective(ctx, {
            currentDeck: coffeeDeckIr,
            selections: [{ slideIndex: 1, instruction: 'a' }],
            signal: controller.signal,
        });
        expect(!res.ok && parseRefineErrorCode(res.error)).toBe('aborted');
        expect(fn).not.toHaveBeenCalled();
    });
});

describe('refineDeckIrSelective — post-LLM validation + splice', () => {
    const selections = [{ slideIndex: 1, instruction: 'tighten' }, { slideIndex: 3, instruction: 'shorten' }];

    it('happy path → ok with all-or-nothing splice + structural sharing', async () => {
        const r1 = { ...contentSlide(coffeeDeckIr.slides[1].id, 'Polished slide two') };
        const r3 = { ...contentSlide(coffeeDeckIr.slides[3].id, 'Polished slide four') };
        const { ctx } = makeCtx(async () => jsonResponse([
            { slideIndex: 1, slide: r1 },
            { slideIndex: 3, slide: r3 },
        ]));
        const res = await refineDeckIrSelective(ctx, { currentDeck: coffeeDeckIr, selections });
        expect(res.ok).toBe(true);
        if (!res.ok) return;
        // Unselected slides deep-equal the input.
        expect(res.value.slides[0]).toEqual(coffeeDeckIr.slides[0]);
        expect(res.value.slides[2]).toEqual(coffeeDeckIr.slides[2]);
        expect(res.value.slides[4]).toEqual(coffeeDeckIr.slides[4]);
        // Selected slides deep-equal the stub output (ids match → id-force is a no-op).
        expect(res.value.slides[1]).toEqual(r1);
        expect(res.value.slides[3]).toEqual(r3);
        // New top-level object + new array (immutability convention).
        expect(res.value).not.toBe(coffeeDeckIr);
        expect(res.value.slides).not.toBe(coffeeDeckIr.slides);
    });

    it('force-preserves the original slide.id even when the LLM changes it', async () => {
        const r1 = contentSlide('hallucinated-id', 'Polished');
        const { ctx } = makeCtx(async () => jsonResponse([{ slideIndex: 1, slide: r1 }]));
        const res = await refineDeckIrSelective(ctx, {
            currentDeck: coffeeDeckIr,
            selections: [{ slideIndex: 1, instruction: 'x' }],
        });
        expect(res.ok).toBe(true);
        if (!res.ok) return;
        expect(res.value.slides[1].id).toBe(coffeeDeckIr.slides[1].id);
    });

    it('shape-mismatch (extra) → err, no splice', async () => {
        const { ctx } = makeCtx(async () => jsonResponse([
            { slideIndex: 1, slide: contentSlide('s2', 'a') },
            { slideIndex: 3, slide: contentSlide('s4', 'b') },
            { slideIndex: 4, slide: contentSlide('s5', 'c') },
        ]));
        const res = await refineDeckIrSelective(ctx, { currentDeck: coffeeDeckIr, selections });
        expect(!res.ok && parseRefineErrorCode(res.error)).toBe('shape-mismatch');
    });

    it('shape-mismatch (missing) → err', async () => {
        const { ctx } = makeCtx(async () => jsonResponse([{ slideIndex: 1, slide: contentSlide('s2', 'a') }]));
        const res = await refineDeckIrSelective(ctx, { currentDeck: coffeeDeckIr, selections });
        expect(!res.ok && parseRefineErrorCode(res.error)).toBe('shape-mismatch');
    });

    it('duplicate-returned-index → err', async () => {
        const { ctx } = makeCtx(async () => jsonResponse([
            { slideIndex: 1, slide: contentSlide('s2', 'a') },
            { slideIndex: 1, slide: contentSlide('s2', 'b') },
        ]));
        const res = await refineDeckIrSelective(ctx, { currentDeck: coffeeDeckIr, selections });
        expect(!res.ok && parseRefineErrorCode(res.error)).toBe('duplicate-returned-index');
    });

    it('index-set-mismatch → err', async () => {
        const { ctx } = makeCtx(async () => jsonResponse([
            { slideIndex: 2, slide: contentSlide('s3', 'a') },
            { slideIndex: 4, slide: contentSlide('s5', 'b') },
        ]));
        const res = await refineDeckIrSelective(ctx, { currentDeck: coffeeDeckIr, selections });
        expect(!res.ok && parseRefineErrorCode(res.error)).toBe('index-set-mismatch');
    });

    it('malformed-json → err', async () => {
        const { ctx } = makeCtx(async () => ({ success: true, content: '<not json>' }));
        const res = await refineDeckIrSelective(ctx, { currentDeck: coffeeDeckIr, selections });
        expect(!res.ok && parseRefineErrorCode(res.error)).toBe('malformed-json');
    });

    it('invalid-slide-schema → err (missing required field)', async () => {
        const { ctx } = makeCtx(async () => jsonResponse([
            { slideIndex: 1, slide: { type: 'content' } }, // no id, no blocks
            { slideIndex: 3, slide: contentSlide('s4', 'ok') },
        ]));
        const res = await refineDeckIrSelective(ctx, { currentDeck: coffeeDeckIr, selections });
        expect(!res.ok && parseRefineErrorCode(res.error)).toBe('invalid-slide-schema');
    });

    it('invalid-deck-after-splice → err (per-slice valid, deck invariant fails)', async () => {
        // title slide with blocks: passes SlideIrSchema, fails deck superRefine.
        const badTitle = { id: 's2', type: 'title', title: 'x', blocks: [{ kind: 'paragraph', text: 'y' }] };
        const { ctx } = makeCtx(async () => jsonResponse([
            { slideIndex: 1, slide: badTitle },
            { slideIndex: 3, slide: contentSlide('s4', 'ok') },
        ]));
        const res = await refineDeckIrSelective(ctx, { currentDeck: coffeeDeckIr, selections });
        expect(!res.ok && parseRefineErrorCode(res.error)).toBe('invalid-deck-after-splice');
    });

    it('llm-call-failed → err when service returns unsuccessful', async () => {
        const { ctx } = makeCtx(async () => ({ success: false, error: 'boom' }));
        const res = await refineDeckIrSelective(ctx, { currentDeck: coffeeDeckIr, selections });
        expect(!res.ok && parseRefineErrorCode(res.error)).toBe('llm-call-failed');
    });

    it('recovers via a single repair when the first response miscounts (shape-mismatch → ok)', async () => {
        // First call returns 3 slices for 2 requested (e.g. it "split" a slide);
        // the repair returns the correct 2 → ok.
        const bad = jsonResponse([
            { slideIndex: 1, slide: contentSlide('s2', 'a') },
            { slideIndex: 3, slide: contentSlide('s4', 'b') },
            { slideIndex: 3, slide: contentSlide('extra', 'c') },
        ]);
        const good = jsonResponse([
            { slideIndex: 1, slide: contentSlide(coffeeDeckIr.slides[1].id, 'Polished two') },
            { slideIndex: 3, slide: contentSlide(coffeeDeckIr.slides[3].id, 'Polished four') },
        ]);
        const fn = vi.fn()
            .mockResolvedValueOnce(bad)
            .mockResolvedValueOnce(good);
        const ctx: LLMFacadeContext = {
            llmService: { summarizeText: fn } as never,
            settings: { serviceType: 'cloud', cloudServiceType: 'claude' },
        };
        const res = await refineDeckIrSelective(ctx, { currentDeck: coffeeDeckIr, selections });
        expect(res.ok).toBe(true);
        expect(fn).toHaveBeenCalledTimes(2); // original + one repair
    });

    it('does NOT retry more than once (repair still bad → original error)', async () => {
        const bad = jsonResponse([{ slideIndex: 1, slide: contentSlide('s2', 'a') }]); // 1 for 2 requested
        const fn = vi.fn().mockResolvedValue(bad);
        const ctx: LLMFacadeContext = {
            llmService: { summarizeText: fn } as never,
            settings: { serviceType: 'cloud', cloudServiceType: 'claude' },
        };
        const res = await refineDeckIrSelective(ctx, { currentDeck: coffeeDeckIr, selections });
        expect(!res.ok && parseRefineErrorCode(res.error)).toBe('shape-mismatch');
        expect(fn).toHaveBeenCalledTimes(2); // original + exactly one repair, no more
    });

    it('aborted mid-LLM → err, no splice', async () => {
        let resolveStub: (v: LLMCallResult) => void = () => {};
        const { ctx } = makeCtx(() => new Promise<LLMCallResult>(r => { resolveStub = r; }));
        const controller = new AbortController();
        const p = refineDeckIrSelective(ctx, {
            currentDeck: coffeeDeckIr,
            selections: [{ slideIndex: 1, instruction: 'x' }],
            signal: controller.signal,
        });
        controller.abort();
        resolveStub(jsonResponse([{ slideIndex: 1, slide: contentSlide('s2', 'a') }]));
        const res = await p;
        expect(!res.ok && parseRefineErrorCode(res.error)).toBe('aborted');
    });
});

describe('parseRefineErrorCode', () => {
    it('extracts a known code prefix', () => {
        expect(parseRefineErrorCode('deck-too-large: 50000 chars')).toBe('deck-too-large');
    });
    it('returns null for an unknown prefix', () => {
        expect(parseRefineErrorCode('totally-made-up: detail')).toBe(null);
    });
    it('returns null when there is no colon', () => {
        expect(parseRefineErrorCode('no code here')).toBe(null);
    });
});

describe('buildSelectivePrompt', () => {
    it('includes 0-based slideIndex keys + minified deck context', () => {
        const prompt = buildSelectivePrompt(
            coffeeDeckIr,
            [{ slideIndex: 1, instruction: 'tighten the subtitle' }],
            [],
        );
        expect(prompt).toContain('<selected_slides>');
        expect(prompt).toContain('slideIndex: 1');
        expect(prompt).toContain('tighten the subtitle');
        expect(prompt).toContain('"slices"');
        // Minified (no 2-space pretty-print of the deck JSON).
        expect(prompt).toContain(JSON.stringify(coffeeDeckIr));
    });

    it('renders deck-wide findings when present, "(none)" otherwise', () => {
        const withFindings = buildSelectivePrompt(coffeeDeckIr, [{ slideIndex: 0, instruction: '' }], [
            { issue: 'palette drift', suggestion: 'unify accent', severity: 'MEDIUM' },
        ]);
        expect(withFindings).toContain('palette drift');
        const without = buildSelectivePrompt(coffeeDeckIr, [{ slideIndex: 0, instruction: '' }], []);
        expect(without).toContain('(none)');
    });
});
