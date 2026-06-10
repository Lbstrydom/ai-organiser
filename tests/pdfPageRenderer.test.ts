import { describe, it, expect, beforeEach } from 'vitest';
import {
    loadPdf, extractPdfTextBounded, __resetPdfJsCacheForTests,
    FIGURE_VECTOR_OP_MIN, MAX_PDF_TEXT_PAGES,
    type PdfRendererDeps,
} from '../src/services/pdf/pdfPageRenderer';

// ── Mock pdf.js ──────────────────────────────────────────────────────────────
const OPS = {
    paintImageXObject: 85, paintJpegXObject: 82, paintInlineImageXObject: 86, paintImageMaskXObject: 83,
    fill: 22, stroke: 20, fillStroke: 23, eoFill: 24, eoFillStroke: 25, closeFillStroke: 26, constructPath: 91,
};

interface MockPageSpec { text: string; ops?: number[]; imgBig?: boolean; }
function mockLib(pages: MockPageSpec[], opts: { throwOnGet?: string } = {}) {
    const doc = {
        numPages: pages.length,
        destroy: () => { /* noop */ },
        getPage: async (n: number) => {
            const spec = pages[n - 1];
            return {
                getTextContent: async () => ({ items: spec.text ? spec.text.split(' ').map((s) => ({ str: s })) : [] }),
                getOperatorList: async () => ({ fnArray: spec.ops ?? [], argsArray: (spec.ops ?? []).map(() => ['img']) }),
                getViewport: ({ scale }: { scale: number }) => ({ width: 1000 * scale, height: 1400 * scale }),
                render: () => ({ promise: Promise.resolve() }),
                objs: { get: () => (spec.imgBig === false ? { width: 10, height: 10 } : { width: 500, height: 500 }) },
                cleanup: () => { /* noop */ },
            };
        },
    };
    return {
        OPS,
        getDocument: (_src: unknown) => {
            if (opts.throwOnGet) {
                const e = new Error(opts.throwOnGet);
                (e as { name?: string }).name = opts.throwOnGet === 'password' ? 'PasswordException' : 'InvalidPDFException';
                return { promise: Promise.reject(e) };
            }
            return { promise: Promise.resolve(doc) };
        },
    };
}

const file = { path: 'deck.pdf', basename: 'deck' } as never;
function deps(lib: unknown, withCanvas = false): PdfRendererDeps {
    return {
        loadPdfJs: async () => lib,
        readBinary: async () => new ArrayBuffer(8),
        createCanvas: withCanvas
            ? (_w, _h) => ({ canvas: { toDataURL: () => 'data:image/jpeg;base64,AAAA' }, context: {} })
            : undefined,
    };
}

beforeEach(() => __resetPdfJsCacheForTests());

describe('loadPdf — lifecycle + typed errors', () => {
    it('returns pdfjs-unavailable when loadPdfJs yields null (G1 — caller records needs-retry)', async () => {
        const r = await loadPdf(file, deps(null));
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toBe('pdfjs-unavailable');
    });
    it('classifies an encrypted PDF', async () => {
        const r = await loadPdf(file, deps(mockLib([], { throwOnGet: 'password' })));
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toBe('encrypted');
    });
    it('classifies a corrupt PDF', async () => {
        const r = await loadPdf(file, deps(mockLib([], { throwOnGet: 'bad xref' })));
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toBe('corrupt');
    });
});

describe('getPageText + detectFigurePages (C7/D6 signals)', () => {
    it('extracts + normalises page text', async () => {
        const r = await loadPdf(file, deps(mockLib([{ text: 'hello   world' }])));
        expect(r.ok).toBe(true);
        if (r.ok) expect(await r.value.getPageText(1)).toBe('hello world');
    });
    it('flags an image page and a vector-heavy page; skips a pure-text page', async () => {
        const lib = mockLib([
            { text: 'plain text page with lots of words '.repeat(20) },               // text-only → not figure
            { text: 'x', ops: [OPS.paintImageXObject] },                                // image → figure
            { text: 'y', ops: Array(FIGURE_VECTOR_OP_MIN + 5).fill(OPS.fill) },         // vectors → figure
        ]);
        const r = await loadPdf(file, deps(lib));
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        const res = await r.value.detectFigurePages(10);
        expect(res.pages.map((p) => p.page)).toEqual([2, 3]);
        expect(res.capped).toBe(false);
    });
    it('caps figure pages to maxVisualPages (G3 truncation, highest-signal first)', async () => {
        const pages = Array.from({ length: 6 }, () => ({ text: 'z', ops: [OPS.paintImageXObject] }));
        const r = await loadPdf(file, deps(mockLib(pages)));
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        const res = await r.value.detectFigurePages(3);
        expect(res.pages).toHaveLength(3);
        expect(res.capped).toBe(true);
    });
});

describe('renderPageImage — bounded data URI', () => {
    it('returns a data URI when a canvas factory is provided', async () => {
        const r = await loadPdf(file, deps(mockLib([{ text: 'a' }]), true));
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        const img = await r.value.renderPageImage(1);
        expect(img.ok).toBe(true);
        if (img.ok) expect(img.value.startsWith('data:image/')).toBe(true);
    });
    it('fails gracefully with no canvas factory (text-only deps)', async () => {
        const r = await loadPdf(file, deps(mockLib([{ text: 'a' }]), false));
        if (r.ok) {
            const img = await r.value.renderPageImage(1);
            expect(img.ok).toBe(false);
        }
    });
});

describe('extractPdfTextBounded (C21 — page-iterating work cap)', () => {
    it('concatenates page text up to the char budget then stops', async () => {
        const lib = mockLib([{ text: 'aaaa' }, { text: 'bbbb' }, { text: 'cccc' }]);
        const r = await extractPdfTextBounded(file, deps(lib), 6);
        expect(r.ok).toBe(true);
        expect((r.text ?? '').replace(/\s/g, '').length).toBeLessThanOrEqual(6);
    });
    it('stops at MAX_PDF_TEXT_PAGES even with budget remaining', async () => {
        const pages = Array.from({ length: MAX_PDF_TEXT_PAGES + 10 }, (_, i) => ({ text: `p${i}` }));
        const r = await extractPdfTextBounded(file, deps(mockLib(pages)), 1_000_000);
        expect(r.ok).toBe(true);
        // Only the first MAX_PDF_TEXT_PAGES pages contribute.
        expect((r.text ?? '').includes(`p${MAX_PDF_TEXT_PAGES + 5}`)).toBe(false);
    });
    it('surfaces pdfjs-unavailable for the needs-retry path', async () => {
        const r = await extractPdfTextBounded(file, deps(null), 1000);
        expect(r.ok).toBe(false);
        expect(r.error).toBe('pdfjs-unavailable');
    });
});
