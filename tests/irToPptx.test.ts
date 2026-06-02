// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { renderDeckToPptx } from '../src/services/presentationIr/irToPptx';
import { CONTENT_WIDTH } from '../src/services/presentationIr/irLayout';
import { IR_SCHEMA_VERSION, type SlideDeckIr } from '../src/services/presentationIr/slideIr';
import { resolveTheme } from '../src/services/export/exportTheme';
import { coffeeDeckIr } from './fixtures/coffeeDeckIr';

const theme = resolveTheme('navy-gold', '', '', 'Inter', 14);

// ── Capturing pptxgenjs stub (records primitives per slide) ──────────────────
interface Call { method: string; args: unknown[] }
class CapSlide {
    calls: Call[] = [];
    background: { color: string } | undefined;
    private failOn: Set<string>;
    constructor(failOn: Set<string>) { this.failOn = failOn; }
    private rec(method: string, args: unknown[]) {
        this.calls.push({ method, args });
        if (this.failOn.has(method)) throw new Error(`stub ${method} failure`);
    }
    addText(...a: unknown[]) { this.rec('addText', a); }
    addShape(...a: unknown[]) { this.rec('addShape', a); }
    addTable(...a: unknown[]) { this.rec('addTable', a); }
    addChart(...a: unknown[]) { this.rec('addChart', a); }
    addImage(...a: unknown[]) { this.rec('addImage', a); }
    addNotes() { /* notes pane — not asserted */ }
    count(method: string) { return this.calls.filter(c => c.method === method).length; }
}
function makeStub(failOn: string[] = []) {
    const fail = new Set(failOn);
    class CapPptx {
        layout = '';
        slides: CapSlide[] = [];
        addSlide() { const s = new CapSlide(fail); this.slides.push(s); return s; }
        async write() { return new ArrayBuffer(32); }
    }
    return CapPptx;
}

async function render(deck: SlideDeckIr, opts: Record<string, unknown> = {}) {
    const Stub = makeStub((opts.failOn as string[]) ?? []);
    const instances: InstanceType<typeof Stub>[] = [];
    // Wrap so we can read the captured instance.
    class Wrapped extends Stub { constructor() { super(); instances.push(this); } }
    const r = await renderDeckToPptx(deck, theme, {
        pptxModule: Wrapped as unknown as never,
        barChartStyle: opts.barChartStyle as 'native' | 'bars' | undefined,
    });
    return { r, slides: instances[0]?.slides ?? [] };
}

describe('renderDeckToPptx — contract', () => {
    it('returns ok with correct slideCount (stable test seam)', async () => {
        const { r } = await render(coffeeDeckIr);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.value.slideCount).toBe(coffeeDeckIr.slides.length);
        expect(r.value.buffer.byteLength).toBeGreaterThan(0);
    });

    it('returns err("empty-deck") for an empty deck', async () => {
        const r = await renderDeckToPptx({ schemaVersion: IR_SCHEMA_VERSION, slides: [] } as unknown as SlideDeckIr, theme);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toBe('empty-deck');
    });

    it('returns err when EVERY slide fails to render (H4/M10 — no false success)', async () => {
        // addText throws on every slide (titles + content titles) → 0 slides render.
        const { r } = await render(coffeeDeckIr, { failOn: ['addText'] });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toContain('every slide failed');
    });

    it('guards a malformed deck without throwing', async () => {
        const r = await renderDeckToPptx(undefined as unknown as SlideDeckIr, theme);
        expect(r.ok).toBe(false);
    });
});

describe('renderDeckToPptx — structural regression gate (not a text dump)', () => {
    it('stat-grid emits cards (shapes), not a text list', async () => {
        const { slides } = await render(coffeeDeckIr);
        expect(slides[1].count('addShape')).toBeGreaterThanOrEqual(4); // 4 stat cards
    });

    it('bar-chart emits a native chart by default', async () => {
        const { slides } = await render(coffeeDeckIr);
        expect(slides[2].count('addChart')).toBeGreaterThanOrEqual(1);
    });

    it('process-flow emits step shapes (horizontal), not a vertical list', async () => {
        const { slides } = await render(coffeeDeckIr);
        expect(slides[3].count('addShape')).toBeGreaterThanOrEqual(6); // 6 steps
    });

    it('table emits one addTable whose column widths fit on-slide (overflow regression)', async () => {
        const { slides } = await render(coffeeDeckIr);
        const tableCalls = slides[4].calls.filter(c => c.method === 'addTable');
        expect(tableCalls).toHaveLength(1);
        const opts = tableCalls[0].args[1] as { w: number; colW: number[] };
        const sum = opts.colW.reduce((a, b) => a + b, 0);
        expect(sum).toBeLessThanOrEqual(CONTENT_WIDTH + 1e-9);
        expect(sum).toBeCloseTo(opts.w, 5);
    });
});

describe('renderDeckToPptx — bar-chart strategies', () => {
    it('"bars" style draws shapes, no chart', async () => {
        const { slides } = await render(coffeeDeckIr, { barChartStyle: 'bars' });
        expect(slides[2].count('addChart')).toBe(0);
        expect(slides[2].count('addShape')).toBeGreaterThanOrEqual(6);
    });

    it('falls back to bars when native addChart throws', async () => {
        const { r, slides } = await render(coffeeDeckIr, { failOn: ['addChart'] });
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.value.downgrades.length).toBeGreaterThanOrEqual(1);
        expect(slides[2].count('addShape')).toBeGreaterThanOrEqual(6); // bars drawn
    });
});

describe('renderDeckToPptx — escape hatch + isolation', () => {
    it('svg with viewBox embeds as an image', async () => {
        const { slides } = await render(coffeeDeckIr);
        expect(slides[5].count('addImage')).toBeGreaterThanOrEqual(1);
    });

    it('custom html-only is rasterized to an image when a rasterizer is injected (G2)', async () => {
        const deck: SlideDeckIr = {
            schemaVersion: IR_SCHEMA_VERSION,
            slides: [{ id: 'c', type: 'content', title: 't', blocks: [{ kind: 'custom', html: '<b>hi</b>' }] }],
        };
        const Stub = makeStub();
        const instances: InstanceType<typeof Stub>[] = [];
        class Wrapped extends Stub { constructor() { super(); instances.push(this); } }
        const calls: { widthPx: number; heightPx: number }[] = [];
        const r = await renderDeckToPptx(deck, theme, {
            pptxModule: Wrapped as unknown as never,
            rasterize: async (input) => { calls.push({ widthPx: input.widthPx, heightPx: input.heightPx }); return 'data:image/png;base64,iVBORw0KGgo='; },
        });
        expect(r.ok).toBe(true);
        expect(calls.length).toBe(1);                 // rasterizer was invoked
        expect(calls[0].widthPx).toBeGreaterThan(0);  // target dims passed (G2)
        expect(instances[0].slides[0].count('addImage')).toBeGreaterThanOrEqual(1);
    });

    it('falls back to a placeholder when the injected rasterizer throws', async () => {
        const deck: SlideDeckIr = {
            schemaVersion: IR_SCHEMA_VERSION,
            slides: [{ id: 'c', type: 'content', title: 't', blocks: [{ kind: 'custom', html: '<b>hi</b>' }] }],
        };
        const { r, slides } = await (async () => {
            const Stub = makeStub();
            const instances: InstanceType<typeof Stub>[] = [];
            class Wrapped extends Stub { constructor() { super(); instances.push(this); } }
            const res = await renderDeckToPptx(deck, theme, {
                pptxModule: Wrapped as unknown as never,
                rasterize: async () => { throw new Error('boom'); },
            });
            return { r: res, slides: instances[0]?.slides ?? [] };
        })();
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.value.downgrades.some(d => d.includes('rasterize'))).toBe(true);
        expect(slides[0].count('addShape')).toBeGreaterThanOrEqual(1); // placeholder box
    });

    it('custom html-only renders a placeholder + emits a notice', async () => {
        const deck: SlideDeckIr = {
            schemaVersion: IR_SCHEMA_VERSION,
            slides: [{ id: 'c', type: 'content', title: 't', blocks: [
                { kind: 'custom', html: '<b>hi</b>', fallbackText: 'Custom chart' },
            ] }],
        };
        const { r, slides } = await render(deck);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.value.notices.some(n => n.blockKind === 'custom')).toBe(true);
        expect(slides[0].count('addShape')).toBeGreaterThanOrEqual(1); // placeholder box
    });

    it('a slide that fails to build degrades to a placeholder; the deck still ships (D1)', async () => {
        // addShape throws → content slides fail at the accent-underline scaffolding
        // (before flowBlocks); title/closing slides (no scaffolding addShape) survive.
        // The deck returns ok with every slide present + a build-failed notice.
        const { r } = await render(coffeeDeckIr, { failOn: ['addShape'] });
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.value.slideCount).toBe(coffeeDeckIr.slides.length);
        expect(r.value.notices.some(n => /build failed/.test(n.description))).toBe(true);
    });

    it('isolates a block whose primitive throws — deck still renders (never-throws)', async () => {
        // addImage throws → the svg slide's block fails but the deck survives.
        const { r } = await render(coffeeDeckIr, { failOn: ['addImage'] });
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.value.slideCount).toBe(coffeeDeckIr.slides.length);
        expect(r.value.notices.length).toBeGreaterThanOrEqual(1);
    });
});

describe('renderDeckToPptx — svg base64 (G1)', () => {
    it('embeds non-ASCII SVG as a UTF-8-safe base64 data-URI', async () => {
        const deck: SlideDeckIr = {
            schemaVersion: IR_SCHEMA_VERSION,
            slides: [{ id: 'g', type: 'content', title: 't', blocks: [
                { kind: 'svg', svg: '<svg viewBox="0 0 10 10"><text x="0" y="5">café 日本 €</text></svg>' },
            ] }],
        };
        const { slides } = await render(deck);
        const img = slides[0].calls.find(c => c.method === 'addImage');
        expect(img).toBeDefined();
        const data = (img!.args[0] as { data: string }).data;
        expect(data.startsWith('data:image/svg+xml;base64,')).toBe(true);
        const decoded = Buffer.from(data.split(',')[1], 'base64').toString('utf-8');
        expect(decoded).toContain('café 日本 €');
    });
});

describe('renderDeckToPptx — golden (real pptxgenjs)', () => {
    it('produces a non-empty multi-slide buffer from the coffee deck', async () => {
        const r = await renderDeckToPptx(coffeeDeckIr, theme);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.value.buffer.byteLength).toBeGreaterThan(1000);
        expect(r.value.slideCount).toBe(coffeeDeckIr.slides.length);
    });
});
