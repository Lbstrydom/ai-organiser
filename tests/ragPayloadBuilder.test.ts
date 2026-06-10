/**
 * RagPayloadBuilder (Phase 7 / DP-1 / C5 / C18) — the gates live in CODE:
 * synthesis-image consent (C5, default false), page-text consent (C18 #2 — false omits
 * visual items ENTIRELY), model capability, synthesis budget, render-failure degrade.
 */
import { describe, it, expect, vi } from 'vitest';
import { buildRagParts, parseImageDataUrl, DEFAULT_SYNTHESIS_BUDGET, type RagPayloadOptions } from '../src/services/ragPayloadBuilder';
import type { RagContextItem } from '../src/services/ragContextMerger';
import { ok, err, type Result } from '../src/core/result';

const PNG_URL = `data:image/png;base64,${'A'.repeat(400)}`;

function pageItem(page: number, pdf = 'deck.pdf', host = 'n.md'): RagContextItem {
    return {
        kind: 'attachment-page',
        filePath: host,
        sourceAttachment: { name: pdf, path: pdf, contentHash: 'h' },
        page,
        chunkIndex: page,
        text: `text of page ${page}`,
        score: 0.9,
        renderRef: { pdfPath: pdf, page },
    };
}

function textItem(path = 'a.md'): RagContextItem {
    return { kind: 'text', filePath: path, chunkIndex: 0, text: 'body', score: 0.8, title: path };
}

function opts(over: Partial<RagPayloadOptions> = {}): RagPayloadOptions {
    return {
        allowVisualSynthesisImages: true,
        allowVisualPageTextInRag: true,
        modelCapability: 'image+document',
        ...over,
    };
}

const okRender = { renderPage: vi.fn(async () => ok(PNG_URL)) };

describe('the C5 / C18 / capability gates', () => {
    it('vision-capable + both consents → image parts (caption + image), within budget', async () => {
        const r = await buildRagParts([textItem(), pageItem(1)], opts(), okRender);
        expect(r.imagesIncluded).toBe(1);
        expect(r.degradedToText).toBe(0);
        const types = r.parts.map((p) => p.type);
        expect(types).toEqual(['text', 'text', 'image']); // note text, caption, image
        const img = r.parts.find((p) => p.type === 'image');
        if (img && img.type === 'image') {
            expect(img.mediaType).toBe('image/png');
            expect(img.data).not.toContain('data:'); // raw base64, no URI prefix
        }
    });

    it('C5: allowVisualSynthesisImages=false → NO images even on a vision model (text fallback)', async () => {
        const render = { renderPage: vi.fn(async () => ok(PNG_URL)) };
        const r = await buildRagParts([pageItem(1)], opts({ allowVisualSynthesisImages: false }), render);
        expect(r.imagesIncluded).toBe(0);
        expect(r.degradedToText).toBe(1);
        expect(render.renderPage).not.toHaveBeenCalled(); // never even materialised
        expect(r.parts[0].type).toBe('text');
        if (r.parts[0].type === 'text') expect(r.parts[0].text).toContain('text of page 1');
    });

    it('non-vision model → text fallback even with consent', async () => {
        const r = await buildRagParts([pageItem(1)], opts({ modelCapability: 'text-only' }), okRender);
        expect(r.imagesIncluded).toBe(0);
        expect(r.degradedToText).toBe(1);
    });

    it('C18 #2: allowVisualPageTextInRag=false → visual items OMITTED ENTIRELY (not even text)', async () => {
        const r = await buildRagParts([textItem(), pageItem(1)], opts({ allowVisualPageTextInRag: false }), okRender);
        expect(r.omittedVisual).toBe(1);
        expect(r.parts).toHaveLength(1); // only the note text part
        expect(JSON.stringify(r.parts)).not.toContain('text of page 1');
    });
});

describe('budget + failure degradation (DP-1: deterministic truncation BEFORE the call)', () => {
    it('image-count budget: items beyond maxImages degrade to page text', async () => {
        const items = [pageItem(1), pageItem(2), pageItem(3)];
        const r = await buildRagParts(items, opts({ budget: { maxImages: 2, maxImageBytes: 10_000_000 } }), okRender);
        expect(r.imagesIncluded).toBe(2);
        expect(r.degradedToText).toBe(1);
    });

    it('byte budget: an image that would exceed maxImageBytes degrades to text', async () => {
        const r = await buildRagParts([pageItem(1)], opts({ budget: { maxImages: 4, maxImageBytes: 10 } }), okRender);
        expect(r.imagesIncluded).toBe(0);
        expect(r.degradedToText).toBe(1);
    });

    it('render failure degrades that item to text — never a provider rejection', async () => {
        const render = { renderPage: vi.fn(async (): Promise<Result<string>> => err('render-failed: no canvas')) };
        const r = await buildRagParts([pageItem(1)], opts(), render);
        expect(r.imagesIncluded).toBe(0);
        expect(r.degradedToText).toBe(1);
        expect(r.parts[0].type).toBe('text');
    });

    it('a non-image data URI from the renderer degrades to text (no bad parts)', async () => {
        const render = { renderPage: vi.fn(async () => ok('data:text/plain;base64,AAAA')) };
        const r = await buildRagParts([pageItem(1)], opts(), render);
        expect(r.imagesIncluded).toBe(0);
        expect(r.degradedToText).toBe(1);
    });

    it('default budget constants are sane', () => {
        expect(DEFAULT_SYNTHESIS_BUDGET.maxImages).toBeGreaterThan(0);
        expect(DEFAULT_SYNTHESIS_BUDGET.maxImageBytes).toBeGreaterThan(100_000);
    });
});

describe('parseImageDataUrl', () => {
    it('parses an image URI into mediaType + raw base64 + size estimate', () => {
        const p = parseImageDataUrl('data:image/jpeg;base64,QUJDRA==');
        expect(p).toMatchObject({ mediaType: 'image/jpeg', data: 'QUJDRA==' });
        expect(p!.approxBytes).toBe(6);
    });

    it('rejects non-image and malformed URIs', () => {
        expect(parseImageDataUrl('data:text/plain;base64,AAAA')).toBeNull();
        expect(parseImageDataUrl('https://example.com/x.png')).toBeNull();
        expect(parseImageDataUrl('data:image/png,notbase64')).toBeNull();
    });
});

describe('text parts carry provenance', () => {
    it('note text parts name the file; degraded page parts name attachment + page + host', async () => {
        const r = await buildRagParts(
            [textItem('notes/a.md'), pageItem(7, 'figs.pdf', 'notes/b.md')],
            opts({ modelCapability: 'text-only' }),
            okRender,
        );
        const texts = r.parts.map((p) => (p.type === 'text' ? p.text : ''));
        expect(texts[0]).toContain('notes/a.md');
        expect(texts[1]).toContain('figs.pdf');
        expect(texts[1]).toContain('page 7');
        expect(texts[1]).toContain('notes/b.md');
    });
});
