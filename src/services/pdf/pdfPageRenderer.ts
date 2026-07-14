/**
 * PDF page renderer / inspector over Obsidian's bundled pdf.js (`window.pdfjsLib`).
 *
 * Three capabilities for the visual-search lane (plan Phases 4/6):
 *  - `getPageText(page)`     — un-defers PDF *text* so it rides the Phase-1 attachment
 *                              text index (C21: page-iterating + bounded, never
 *                              whole-PDF-extract-then-truncate).
 *  - `detectFigurePages()`   — D6/C7 figure-bearing-page detection from DIRECTLY-available
 *                              pdf.js signals only (image XObjects / vector op count /
 *                              text density). Hard-capped per attachment (G3 denial-of-wallet).
 *  - `renderPageImage(page)` — bounded PNG/JPEG data URI, rendered LAZILY by the embed
 *                              batch (C25) and discarded immediately after the request.
 *
 * Lifecycle (C6): a handle owns the `PDFDocumentProxy`; `dispose()` destroys it. G1: Obsidian
 * lazy-loads pdf.js only when a PDF is opened in the UI, so we force `loadPdfJs()` first —
 * `pdfjs-unavailable` means a genuine platform gap (caller records `needs-retry`, not done).
 *
 * Dependency-injected (pdfjs loader / binary reader / canvas factory) so the logic is unit
 * testable without a real canvas or pdf.js (happy-dom has neither).
 */
import type { TFile } from 'obsidian';
import type { Result } from '../../core/result';
import { ok, err } from '../../core/result';
import { logger } from '../../utils/logger';

// ── Bounds (C6/C7/C21/C25) ───────────────────────────────────────────────────
export const MAX_PAGE_IMAGE_PIXELS = 1_600_000;   // ~1400×1140 — caps render cost/memory
export const FIGURE_IMAGE_MIN_PX = 200;           // intrinsic image dim → filters icons/logos
export const FIGURE_VECTOR_OP_MIN = 40;           // path-op count → a real vector diagram
export const FIGURE_TEXT_DENSITY_MAX = 220;       // chars/page below which a fig signal wins
export const MAX_PDF_TEXT_PAGES = 50;             // C21 WORK cap on text extraction
export const MAX_PAGES_PER_PDF = 200;             // figure-scan ceiling
export const DEFAULT_MAX_VISUAL_PAGES_PER_ATTACHMENT = 20; // G3 embed cap

export type PdfRenderErrorCode = 'encrypted' | 'corrupt' | 'pdfjs-unavailable';

/** Which cheap signal flagged a page (stored for tests + UI diagnostics, C7). */
export interface FigureSignals {
    image: boolean;        // an image XObject ≥ FIGURE_IMAGE_MIN_PX
    vectorOps: number;     // path-painting op count
    textDensityLow: boolean;
}
export interface FigurePage { page: number; signals: FigureSignals; }

export interface DetectFiguresResult {
    pages: FigurePage[];
    /** True when more figure pages existed than `maxVisualPages` (G3 truncation). */
    capped: boolean;
}

export interface PdfHandle {
    readonly numPages: number;
    /** Page text (1-based). Empty string on a text-less page. */
    getPageText(page: number): Promise<string>;
    /** Figure-bearing pages (highest-signal first), truncated to `maxVisualPages` (G3). */
    detectFigurePages(maxVisualPages?: number): Promise<DetectFiguresResult>;
    /** Bounded raster of a page as a data URI; never holds it — caller embeds + discards (C25). */
    renderPageImage(page: number, maxPx?: number): Promise<Result<string>>;
    /** Destroys the PDFDocumentProxy. Idempotent. */
    dispose(): void;
}

/** Injected collaborators (production wiring lives in the visual-lane services). */
export interface PdfRendererDeps {
    /** Force-load + return pdf.js (Obsidian's `loadPdfJs`). May reject / return null. */
    loadPdfJs: () => Promise<unknown>;
    /** Read the PDF bytes (Obsidian's `vault.readBinary`). */
    readBinary: (file: TFile) => Promise<ArrayBuffer>;
    /** Make an offscreen 2D canvas for rendering. Optional — render fails gracefully without. */
    createCanvas?: (w: number, h: number) => { canvas: unknown; context: unknown } | null;
}

// pdf.js operator codes we care about for figure detection. Resolved off the live lib so
// we don't hardcode numeric codes (they're stable, but this is robust to minor versions).
interface PdfJsLib {
    getDocument(src: { data: ArrayBuffer | Uint8Array }): { promise: Promise<PdfDocumentProxy> };
    OPS?: Record<string, number>;
}
interface PdfDocumentProxy {
    numPages: number;
    getPage(n: number): Promise<PdfPageProxy>;
    destroy(): Promise<void> | void;
}
interface PdfPageProxy {
    getTextContent(): Promise<{ items: Array<{ str?: string }> }>;
    getOperatorList(): Promise<{ fnArray: number[]; argsArray: unknown[][] }>;
    getViewport(opts: { scale: number }): { width: number; height: number };
    render(opts: { canvasContext: unknown; viewport: unknown }): { promise: Promise<void> };
    objs?: { get(name: string, cb?: (o: unknown) => void): unknown };
    commonObjs?: { get(name: string, cb?: (o: unknown) => void): unknown };
    cleanup?: () => void;
}

/** Map a pdf.js load/parse exception to a typed error code. */
function classifyLoadError(e: unknown): PdfRenderErrorCode {
    const name = (e as { name?: string })?.name ?? '';
    const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
    if (name === 'PasswordException' || msg.includes('password') || msg.includes('encrypt')) return 'encrypted';
    return 'corrupt';
}

/** The image-XObject + vector-op signals for one page's operator list (C7). */
function scanOperatorList(
    ops: { fnArray: number[]; argsArray: unknown[][] },
    OPS: Record<string, number>,
    page: PdfPageProxy,
): { image: boolean; vectorOps: number } {
    const paintImage = new Set<number>(
        [OPS.paintImageXObject, OPS.paintJpegXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject]
            .filter((n): n is number => typeof n === 'number'),
    );
    const pathPaint = new Set<number>(
        [OPS.fill, OPS.stroke, OPS.fillStroke, OPS.eoFill, OPS.eoFillStroke, OPS.closeFillStroke, OPS.constructPath]
            .filter((n): n is number => typeof n === 'number'),
    );
    let image = false;
    let vectorOps = 0;
    for (let i = 0; i < ops.fnArray.length; i++) {
        const fn = ops.fnArray[i];
        if (paintImage.has(fn)) {
            // Filter tiny icons: inspect the image's intrinsic size when cheaply available.
            if (intrinsicImageBigEnough(ops.argsArray[i], page)) image = true;
        } else if (pathPaint.has(fn)) {
            vectorOps++;
        }
    }
    return { image, vectorOps };
}

/** Best-effort intrinsic-size check for a painted image; permissive when unknown. */
function intrinsicImageBigEnough(args: unknown[] | undefined, page: PdfPageProxy): boolean {
    try {
        const name = Array.isArray(args) ? args[0] : undefined;
        if (typeof name === 'string' && page.objs?.get) {
            const obj = page.objs.get(name) as { width?: number; height?: number } | undefined;
            if (obj && typeof obj.width === 'number' && typeof obj.height === 'number') {
                return obj.width >= FIGURE_IMAGE_MIN_PX && obj.height >= FIGURE_IMAGE_MIN_PX;
            }
        }
    } catch { /* objs may not be resolved during a bare op-list scan */ }
    return true; // unknown size → don't drop a potential figure (false-negatives are worse)
}

class PdfHandleImpl implements PdfHandle {
    private disposed = false;
    constructor(
        private readonly pdf: PdfDocumentProxy,
        private readonly lib: PdfJsLib,
        private readonly deps: PdfRendererDeps,
    ) {}

    get numPages(): number { return this.pdf.numPages; }

    async getPageText(page: number): Promise<string> {
        const p = await this.pdf.getPage(page);
        try {
            const tc = await p.getTextContent();
            return tc.items.map((it) => it.str ?? '').join(' ').replace(/\s+/g, ' ').trim();
        } finally {
            p.cleanup?.();
        }
    }

    async detectFigurePages(maxVisualPages = DEFAULT_MAX_VISUAL_PAGES_PER_ATTACHMENT): Promise<DetectFiguresResult> {
        const OPS = this.lib.OPS ?? {};
        const scanTo = Math.min(this.pdf.numPages, MAX_PAGES_PER_PDF);
        const found: Array<FigurePage & { score: number }> = [];
        for (let n = 1; n <= scanTo; n++) {
            const p = await this.pdf.getPage(n);
            try {
                const [opList, tc] = await Promise.all([p.getOperatorList(), p.getTextContent()]);
                const { image, vectorOps } = scanOperatorList(opList, OPS, p);
                const textLen = tc.items.reduce((a, it) => a + (it.str?.length ?? 0), 0);
                const textDensityLow = textLen < FIGURE_TEXT_DENSITY_MAX;
                // A page is figure-bearing on a strong image/vector signal, OR a weaker
                // signal combined with low text density (filters logos on text pages).
                const strong = image || vectorOps >= FIGURE_VECTOR_OP_MIN;
                const weakWithSparseText = textDensityLow && (image || vectorOps >= Math.floor(FIGURE_VECTOR_OP_MIN / 2));
                if (strong || weakWithSparseText) {
                    const score = (image ? 1_000_000 : 0) + vectorOps + (textDensityLow ? 100 : 0);
                    found.push({ page: n, signals: { image, vectorOps, textDensityLow }, score });
                }
            } finally {
                p.cleanup?.();
            }
        }
        found.sort((a, b) => b.score - a.score);
        const capped = found.length > maxVisualPages;
        const pages = found.slice(0, maxVisualPages)
            .map(({ page, signals }) => ({ page, signals }))
            .sort((a, b) => a.page - b.page); // page order for stable downstream indexing
        return { pages, capped };
    }

    async renderPageImage(page: number, maxPx = MAX_PAGE_IMAGE_PIXELS): Promise<Result<string>> {
        if (!this.deps.createCanvas) return err('render-unavailable: no canvas factory');
        const p = await this.pdf.getPage(page);
        try {
            const base = p.getViewport({ scale: 1 });
            const scale = Math.min(1, Math.sqrt(Math.max(1, maxPx) / Math.max(1, base.width * base.height)));
            const vp = p.getViewport({ scale });
            const made = this.deps.createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
            if (!made || !made.context) return err('render-unavailable: canvas creation failed');
            await p.render({ canvasContext: made.context, viewport: vp }).promise;
            const canvas = made.canvas as { toDataURL?: (t?: string, q?: number) => string };
            const url = canvas.toDataURL?.('image/jpeg', 0.82) ?? '';
            return url.startsWith('data:image/') ? ok(url) : err('render-failed: empty data url');
        } catch (e) {
            return err(`render-failed: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
            p.cleanup?.();
        }
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        try { void this.pdf.destroy(); } catch (e) { logger.warn('Search', `pdf destroy failed: ${e instanceof Error ? e.message : String(e)}`); }
    }
}

/** Module-level pdf.js cache — force-loaded once (G1). null after a genuine load failure. */
let pdfjsLibCache: PdfJsLib | null = null;
let pdfjsLoadAttempted = false;

async function ensurePdfJs(deps: PdfRendererDeps): Promise<PdfJsLib | null> {
    if (pdfjsLibCache) return pdfjsLibCache;
    try {
        const lib = (await deps.loadPdfJs()) as PdfJsLib | null;
        const resolved = lib ?? ((window as { pdfjsLib?: PdfJsLib }).pdfjsLib ?? null);
        pdfjsLoadAttempted = true;
        if (resolved && typeof resolved.getDocument === 'function') {
            pdfjsLibCache = resolved;
            return resolved;
        }
        return null;
    } catch {
        pdfjsLoadAttempted = true;
        return null;
    }
}

/** Test-only: reset the module pdf.js cache. */
export function __resetPdfJsCacheForTests(): void { pdfjsLibCache = null; pdfjsLoadAttempted = false; }
/** Whether a load was attempted (helps the caller decide `needs-retry` vs permanent). */
export function pdfJsLoadAttempted(): boolean { return pdfjsLoadAttempted; }

/**
 * Load a PDF into a disposable handle. `pdfjs-unavailable` ⇒ the caller records `needs-retry`
 * (NOT cached-as-done, G1) so a later session (after pdf.js loads) re-attempts the file.
 */
export async function loadPdf(file: TFile, deps: PdfRendererDeps): Promise<Result<PdfHandle>> {
    const lib = await ensurePdfJs(deps);
    if (!lib) return err('pdfjs-unavailable');
    let bytes: ArrayBuffer;
    try {
        bytes = await deps.readBinary(file);
    } catch (e) {
        logger.warn('Search', `readBinary failed for ${file.path}: ${e instanceof Error ? e.message : String(e)}`);
        return err('corrupt');
    }
    try {
        const pdf = await lib.getDocument({ data: new Uint8Array(bytes) }).promise;
        return ok(new PdfHandleImpl(pdf, lib, deps));
    } catch (e) {
        return err(classifyLoadError(e));
    }
}

/**
 * C21 bounded PDF text extraction for the attachment-text lane: load ONE handle, append page
 * text until the char budget OR `MAX_PDF_TEXT_PAGES`, then dispose. Returns the typed error
 * code as the `error` string (`pdfjs-unavailable` ⇒ the indexer records `needs-retry`, G1).
 * A WORK cap, not a storage cap — we never whole-PDF-extract-then-truncate.
 */
export async function extractPdfTextBounded(
    file: TFile,
    deps: PdfRendererDeps,
    budgetChars: number,
): Promise<{ ok: boolean; text?: string; error?: string }> {
    const handle = await loadPdf(file, deps);
    if (!handle.ok) return { ok: false, error: handle.error };
    const h = handle.value;
    try {
        const limitPages = Math.min(h.numPages, MAX_PDF_TEXT_PAGES);
        const budget = Math.max(0, budgetChars);
        const parts: string[] = [];
        let used = 0;
        for (let n = 1; n <= limitPages && used < budget; n++) {
            const t = (await h.getPageText(n)).trim();
            if (!t) continue;
            const remaining = budget - used;
            const slice = t.length > remaining ? t.slice(0, remaining) : t;
            parts.push(slice);
            used += slice.length;
        }
        const text = parts.join('\n\n').trim();
        return text ? { ok: true, text } : { ok: false, error: 'empty' };
    } finally {
        h.dispose();
    }
}
