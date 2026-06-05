/**
 * IR → PPTX renderer. Deterministic, never throws — returns `Result`. No DOM
 * parsing: every slide is composed from native pptxgenjs primitives
 * (text boxes, shapes, tables, charts, images) placed by the pure geometry in
 * `irLayout.ts`. This is the core fix for the HTML-reverse-engineering defect.
 *
 * Test/DI seam (plan M3): `opts.pptxModule` injects a pptxgenjs stub so tests
 * can assert which primitives each slide emitted without parsing the .pptx zip,
 * and can force per-block failures to prove isolation.
 *
 * Phase A renders synchronously, so the `custom`/`svg` escape hatch degrades to
 * a labelled placeholder. Phase B injects a canvas/iframe rasterizer (see
 * `RasterizeFn`) to turn those into images. Plan:
 * docs/plans/presentation-structured-ir.md
 */

import type { Result } from '../../core/result';
import { ok, err } from '../../core/result';
import { logger } from '../../utils/logger';
import type { ExportTheme } from '../export/exportTheme';
import { sanitizeSvgMarkup } from '../../utils/svgSanitize';
import {
    CANVAS, MARGIN, CONTENT_TOP, CONTENT_WIDTH, FOOTER_Y,
    splitColumns, gridColumns, estimateTextHeight, tableColumnWidths,
} from './irLayout';
import type { Block, FidelityNotice, LeafBlock, SlideDeckIr, SlideIr } from './slideIr';
import { contrastTextColor, stripBulletPrefix } from './slideIr';
import { IR_RENDER_SPEC } from './irRenderSpec';
import { fontFloor } from './fontFloor';
import { resolvePresentationIcon } from './iconRegistry';
import {
    createSvgAssetCache, gradientSvgMarkup, renderIconSvgMarkup, addSvgImageSafe,
    type SvgAssetCache,
} from './svgAsset';
import { slideFailureNotice, DEFAULT_PLACEHOLDER_LABEL } from './renderIsolation';
import { sanitizeExportTheme } from './themeSafe';
// Type-only — erased at compile, so the pure renderer keeps NO runtime
// dependency on the Obsidian-bound brand-asset module (plan M6).
import type { ResolvedBrandAssets } from '../export/brand/brandRenderContext';

// ── Injected pptxgenjs surface (structural typing — avoids `any`) ────────────

interface SlideLike {
    background?: { color: string };
    addText(text: unknown, opts: Record<string, unknown>): void;
    addShape(shape: string, opts: Record<string, unknown>): void;
    addTable(rows: unknown[], opts: Record<string, unknown>): void;
    addChart(type: unknown, data: unknown, opts: Record<string, unknown>): void;
    addImage(opts: Record<string, unknown>): void;
    addNotes(notes: string): void;
}
interface PptxLike {
    layout: string;
    addSlide(): SlideLike;
    write(opts: { outputType: string }): Promise<unknown>;
}
type PptxCtor = new () => PptxLike;

/** Escape-hatch rasterizer (plan H4/G2). Input markup is ALREADY sanitized;
 *  target pixel dims let it wrap text + match aspect ratio. Returns a raster
 *  data-URI. Injected app-side (Phase B); absent in the pure core. */
export type RasterizeFn = (input: { html?: string; svg?: string; widthPx: number; heightPx: number }) => Promise<string>;

export interface RenderPptxOptions {
    barChartStyle?: 'native' | 'bars';
    /** Escape-hatch rasterizer for `custom.html` / fallback `svg` (plan H4). */
    rasterize?: RasterizeFn;
    /** Test seam — inject a pptxgenjs stub/class. Defaults to the real module. */
    pptxModule?: PptxCtor;
    /** Localised label for a slide that fails to render (caller injects via
     *  plugin.t — the renderer stays Obsidian-free). Default English. */
    placeholderLabel?: string;
    /** Pre-resolved brand assets (icons by concept, both variants). When a slide
     *  references an icon concept present here, the variant PNG matching the
     *  slide background is used; else the existing Lucide path. Absent → Lucide
     *  only (byte-identical to today). */
    brandAssets?: ResolvedBrandAssets;
    // NOTE(brand): a centred-logo draw on closing slides is deferred. The inert
    // `drawLogo?: boolean` option was removed (audit M14 — no shipped no-op flag);
    // logos still RESOLVE via `brandAssets.logoLightPng/logoDarkPng` for future
    // use. Re-introduce the option only when the actual draw is implemented.
}

export interface PptxRenderOutput {
    buffer: ArrayBuffer;
    slideCount: number;
    notices: FidelityNotice[];
    downgrades: string[];
}

const hx = (hex: string): string => hex.replace('#', '');

interface RenderState {
    barStyle: 'native' | 'bars';
    theme: ExportTheme;
    rasterize?: RasterizeFn;
    notices: FidelityNotice[];
    downgrades: string[];
    /** Per-export-pass dedup cache for generated SVG assets (icons/gradients). */
    svgCache: SvgAssetCache;
    /** Localised placeholder label for a failed slide (default English). */
    placeholderLabel: string;
    /** Footer-band Y for the CURRENT slide (safe-area aware). Block-flow helpers
     *  clip against this instead of the module `FOOTER_Y` constant. Reset per
     *  slide; defaults to the module constant when no safe-area is set. */
    footerY: number;
    /** Pre-resolved brand icon assets (absent → Lucide only). */
    brandAssets?: ResolvedBrandAssets;
    /** Whether the CURRENT slide's background is dark — selects the icon variant
     *  (dark bg → light icon, light bg → dark icon). Reset per slide. */
    slideBgDark: boolean;
}

const RASTER_PX_PER_IN = 96;   // rasteriser pixel hint — NOT the 144 canvas density (debt D6)

/** Icon fill colour from the shared spec (primary | accent). */
const iconColor = (theme: ExportTheme): string =>
    IR_RENDER_SPEC.icon.colorRole === 'primary' ? theme.primaryColor : theme.accentColor;

/**
 * Draw a resolved icon at `rect`, preferring a brand-asset PNG over the Lucide
 * vector (plan §5a G2 / §6).
 *
 * Lookup: the resolved Lucide name doubles as the brand concept key (both are
 * lowercase-hyphen normalised). When `brandAssets.icons` has the concept, the
 * variant PNG matching the slide background is used; on a miss (or no assets) we
 * fall back to the existing Lucide SVG path. `onFail` fires only if the Lucide
 * fallback itself fails (brand-PNG failure silently falls through to Lucide).
 */
function drawIcon(
    s: SlideLike, iconName: string, rect: { x: number; y: number; w: number; h: number },
    st: RenderState, onFail: () => void,
): void {
    const brand = st.brandAssets?.icons.get(iconName);
    if (brand) {
        // dark bg → light icon; light bg → dark icon.
        const png = st.slideBgDark ? brand.lightPng : brand.darkPng;
        if (png) {
            try { s.addImage({ data: png, x: rect.x, y: rect.y, w: rect.w, h: rect.h }); return; }
            catch (e) {
                // Fidelity downgrade — surface it instead of silently falling back
                // to the generic Lucide vector (audit M9/M13).
                logger.warn('Brand', `brand icon raster failed, using Lucide fallback for "${iconName}"`, e);
            }
        }
    }
    addSvgImageSafe(s, renderIconSvgMarkup(iconName, iconColor(st.theme)), rect, onFail, st.svgCache);
}

// Min-font floor helpers (`clampFixedFont`/`fontFloor`/`MinFontRole`) now live in
// `./fontFloor` — the shared home so the spec + both renderers apply identical
// floors (renderer-fidelity Phase 2). Imported above.

// ── Safe-area geometry (plan §7) ─────────────────────────────────────────────
// When `theme.safeArea` is present (brand exports), the content layout rectangle
// is derived from the brand's POTX zones; absent → the current module constants
// (CONTENT_TOP / FOOTER_Y / MARGIN / CONTENT_WIDTH) — byte-identical to today.

/** Resolved content rectangle for a slide (inches on the 13.33×7.5 canvas). */
interface SlideGeometry { left: number; top: number; width: number; footerY: number }

/** Default geometry = the existing module constants (no safe-area). */
const DEFAULT_GEOMETRY: SlideGeometry = { left: MARGIN, top: CONTENT_TOP, width: CONTENT_WIDTH, footerY: FOOTER_Y };

/**
 * Compute the content rectangle for `slideType` from the theme's safe-area.
 *
 * - content / title carry the master logo → reserve `logoReserveIn` on the right.
 * - section / closing centre their own content → logo reserve N/A; footer band
 *   still reserved.
 *
 * Absent `safeArea` → the unchanged default geometry.
 */
function geometryFor(theme: ExportTheme, slideType: SlideIr['type']): SlideGeometry {
    const sa = theme.safeArea;
    if (!sa) return DEFAULT_GEOMETRY;
    const left = sa.sideMarginIn;
    const carriesLogo = slideType === 'content' || slideType === 'title';
    const rightInset = carriesLogo ? sa.logoReserveIn : 0;
    const width = Math.max(0.5, CANVAS.w - left - sa.sideMarginIn - rightInset);
    return { left, top: sa.contentTopIn, width, footerY: sa.footerBandIn };
}

export async function renderDeckToPptx(
    deck: SlideDeckIr,
    theme: ExportTheme,
    opts: RenderPptxOptions = {},
): Promise<Result<PptxRenderOutput>> {
    // Defensive guard (audit M1) — dereference safely before the main try.
    if (!deck || !Array.isArray(deck.slides) || deck.slides.length === 0) return err('empty-deck');

    const notices: FidelityNotice[] = [];
    // D2 — validate the theme ONCE at the boundary (config-sourced, not Zod).
    const safeTheme = sanitizeExportTheme(theme, f =>
        notices.push({ slideIndex: 0, blockKind: 'paragraph', severity: 'info', description: `theme.${f} invalid; using fallback` }));
    const state: RenderState = { barStyle: opts.barChartStyle ?? 'native', theme: safeTheme, rasterize: opts.rasterize, notices, downgrades: [], svgCache: createSvgAssetCache(), placeholderLabel: opts.placeholderLabel ?? DEFAULT_PLACEHOLDER_LABEL, footerY: FOOTER_Y, brandAssets: opts.brandAssets, slideBgDark: false };

    let pres: PptxLike;
    try {
        const Ctor: PptxCtor = opts.pptxModule ?? ((await import('pptxgenjs')).default as unknown as PptxCtor);
        pres = new Ctor();
        pres.layout = 'LAYOUT_WIDE';
    } catch (e) {
        return err(`fatal: pptxgenjs init failed: ${msg(e)}`);
    }

    // D1 — every slide is added; one that fails to render degrades to a VISIBLE
    // placeholder card (+ notice) instead of either sinking the deck or shipping
    // a silent partial slide. Direct rendering preserves the per-OP fallbacks
    // (native-chart→bars, svg-image→solid) that need a synchronous throw — a
    // buffer-then-commit recorder would defer those throws past their try/catch.
    // Blocks are already isolated per-block in flowBlocks; this catches the rare
    // uncaught scaffolding error.
    const slideCount = deck.slides.length;
    let builtCount = 0;
    for (let i = 0; i < deck.slides.length; i++) {
        // Guard addSlide too (audit H2) — if pptxgenjs rejects it, record a
        // notice and skip rather than letting it escape the never-throws contract.
        let s: SlideLike;
        try {
            s = pres.addSlide();
        } catch (e) {
            state.notices.push(slideFailureNotice(i, 'build', e));
            continue;
        }
        try {
            await renderSlide(s, deck.slides[i], i, state);
            builtCount++;
        } catch (e) {
            state.notices.push(slideFailureNotice(i, 'build', e));
            try { buildPptxPlaceholder(s, state); } catch { /* never throw */ }
        }
    }

    // Nothing rendered → don't hand back an all-placeholder deck as success
    // (audit H4/M10).
    if (builtCount === 0) return err('fatal: every slide failed to render');

    try {
        const out = await pres.write({ outputType: 'arraybuffer' });
        const buffer = toArrayBuffer(out);
        if (!buffer) return err('fatal: pptxgenjs returned unexpected output type');
        return ok({ buffer, slideCount, notices: state.notices, downgrades: state.downgrades });
    } catch (e) {
        return err(`fatal: pptx write failed: ${msg(e)}`);
    }
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function toArrayBuffer(out: unknown): ArrayBuffer | null {
    if (out instanceof ArrayBuffer) return out;
    if (out instanceof Uint8Array) {
        const copy = new ArrayBuffer(out.byteLength);
        new Uint8Array(copy).set(out);
        return copy;
    }
    return null;
}

interface Box { x: number; y: number; w: number }

async function renderSlide(s: SlideLike, slide: SlideIr, index: number, st: RenderState): Promise<void> {
    const { theme } = st;
    // Safe-area geometry for this archetype (no-op when theme.safeArea absent).
    const geom = geometryFor(theme, slide.type);
    st.footerY = geom.footerY;
    // Slide background darkness drives the brand-icon variant (dark bg → light
    // icon). Content slides are white unless a per-slide background overrides it;
    // title/section/closing carry a dark brand bg. Mirrors IR_RENDER_SPEC.
    st.slideBgDark = slide.background
        ? contrastTextColor(slide.background) === 'ffffff'
        : slide.type !== 'content';

    if (slide.type === 'title' || slide.type === 'section' || slide.type === 'closing') {
        // #4 — gradient via a full-bleed SVG image (a single vector fill, no
        // banding seams — pptxgenjs 4.0.1 has no per-shape gradient fill). The
        // image is the FIRST add on the slide so the title text sits on top of
        // it (Gemini draw-order); on failure it falls back to a solid fill.
        const sb = IR_RENDER_SPEC.slideBackground(slide, theme);
        const fg = slide.background ? contrastTextColor(slide.background) : 'FFFFFF';
        if (sb.kind === 'gradient') {
            const markup = gradientSvgMarkup({ from: sb.from, to: sb.to, angleDeg: sb.angleDeg, w: 1333, h: 750 });
            addSvgImageSafe(s, markup, { x: 0, y: 0, w: CANVAS.w, h: CANVAS.h }, () => {
                s.background = { color: hx(sb.from) };
                st.notices.push({ slideIndex: index, blockKind: 'paragraph', severity: 'info', description: 'gradient image failed; solid-fill fallback.' });
            }, st.svgCache);
        } else {
            s.background = { color: hx(sb.color) };
        }
        const heroAlign = IR_RENDER_SPEC.titleLayout.align;   // #3 — left (matches HTML hero)
        s.addText(slide.title ?? '', {
            x: geom.left, y: CANVAS.h / 2 - 1, w: geom.width, h: 1.4,
            fontFace: theme.fontFace, fontSize: slide.type === 'title' ? IR_RENDER_SPEC.font.heroTitlePt : IR_RENDER_SPEC.font.sectionTitlePt,
            color: fg, bold: true, align: heroAlign, valign: 'middle',
        });
        if (slide.subtitle) {
            s.addText(slide.subtitle, {
                x: geom.left, y: CANVAS.h / 2 + 0.5, w: geom.width, h: 0.9,
                fontFace: theme.fontFace, fontSize: IR_RENDER_SPEC.font.heroSubtitlePt, color: fg, align: heroAlign, valign: 'middle',
            });
        }
        if (slide.notes) s.addNotes(slide.notes);
        return;
    }

    // Content slide: title + accent UNDERLINE (motif shared with HTML — #2) + blocks.
    // (The old full-width top bar was a PPTX-only motif that diverged from the
    // preview; both now draw a short underline beneath the title.)
    if (slide.title) {
        s.addText(slide.title, { x: geom.left, y: 0.35, w: geom.width, h: 0.6, fontFace: theme.fontFace, fontSize: IR_RENDER_SPEC.font.slideTitlePt, bold: true, color: hx(theme.primaryColor) });
        const u = IR_RENDER_SPEC.accentUnderline;
        s.addShape('rect', { x: geom.left, y: 0.35 + 0.6 + u.gapBelowTitleIn * 0.5, w: u.widthIn, h: u.heightIn, fill: { color: hx(theme.accentColor) }, line: { width: 0 } });
    }
    await flowBlocks(s, slide.blocks, { x: geom.left, y: geom.top, w: geom.width }, index, st);
    if (slide.notes) s.addNotes(slide.notes);
}

/** Render the user-visible placeholder card for a slide that failed to build
 *  (D1). Label is the caller-injected localised string (default English). */
function buildPptxPlaceholder(s: SlideLike, st: RenderState): void {
    const { theme } = st;
    s.background = { color: 'FFFFFF' };
    s.addShape('roundRect', { x: 1.5, y: 2.75, w: CANVAS.w - 3, h: 2, rectRadius: IR_RENDER_SPEC.geometry.placeholderRadiusIn, fill: { color: 'F1F5F9' }, line: { color: hx(theme.bodyColor), width: 0.5, dashType: 'dash' } });
    s.addText(st.placeholderLabel, { x: 1.5, y: 2.75, w: CANVAS.w - 3, h: 2, fontFace: theme.fontFace, fontSize: IR_RENDER_SPEC.font.placeholderTitlePt, italic: true, color: hx(theme.bodyColor), align: 'center', valign: 'middle' });
}

/** Place blocks top-to-bottom within a column box, advancing a y cursor. */
async function flowBlocks(s: SlideLike, blocks: Block[], box: Box, slideIndex: number, st: RenderState): Promise<void> {
    let y = box.y;
    for (const block of blocks) {
        if (y >= st.footerY) {
            st.notices.push({ slideIndex, blockKind: block.kind, severity: 'substantive', description: `block "${block.kind}" clipped — content exceeds slide.` });
            continue;
        }
        try {
            y += await renderBlock(s, block, { x: box.x, y, w: box.w }, slideIndex, st) + IR_RENDER_SPEC.geometry.blockGapIn;
        } catch (e) {
            st.notices.push({ slideIndex, blockKind: block.kind, severity: 'substantive', description: `block "${block.kind}" failed: ${msg(e)}` });
        }
    }
}

/** Clamp a block's height to the remaining content zone so it never runs off
 *  the slide; emit a clip notice when it had to be cut (audit H7). */
function clampH(natural: number, box: Box, kind: Block['kind'], slideIndex: number, st: RenderState): number {
    const remaining = st.footerY - box.y;
    if (natural > remaining) {
        st.notices.push({ slideIndex, blockKind: kind, severity: 'substantive', description: `block "${kind}" clipped to fit slide.` });
        return Math.max(0.2, remaining);
    }
    return natural;
}

/** Render one block at `box`; return the height it consumed (inches). */
async function renderBlock(s: SlideLike, block: Block, box: Box, slideIndex: number, st: RenderState): Promise<number> {
    const { theme } = st;
    switch (block.kind) {
        case 'heading': {
            const size = IR_RENDER_SPEC.font.headingPt(block.level);
            const h = clampH(estimateTextHeight(block.text, box.w, size), box, block.kind, slideIndex, st);
            s.addText(block.text, { x: box.x, y: box.y, w: box.w, h, fontFace: theme.fontFace, fontSize: size, bold: true, color: hx(theme.primaryColor), valign: 'top' });
            return h;
        }
        case 'paragraph': {
            const para = IR_RENDER_SPEC.font.paragraphPt(theme);
            const h = clampH(estimateTextHeight(block.text, box.w, para), box, block.kind, slideIndex, st);
            s.addText(block.text, { x: box.x, y: box.y, w: box.w, h, fontFace: theme.fontFace, fontSize: para, bold: Boolean(block.emphasis), color: hx(theme.bodyColor), valign: 'top' });
            return h;
        }
        case 'caption': {
            // Shrink-to-fit derivation (body − 2), lower-bounded at the caption floor.
            const captionSize = IR_RENDER_SPEC.font.captionPt(theme);
            const h = clampH(estimateTextHeight(block.text, box.w, captionSize), box, block.kind, slideIndex, st);
            s.addText(block.text, { x: box.x, y: box.y, w: box.w, h, fontFace: theme.fontFace, fontSize: captionSize, italic: true, color: hx(theme.bodyColor), valign: 'top' });
            return h;
        }
        case 'bullets': {
            const lines = block.items.map(it => ({ text: stripBulletPrefix(it), options: { bullet: block.ordered ? { type: 'number' as const } : true } }));
            // Measure each item's WRAPPED height instead of a flat 0.32"/item — a
            // long multi-line bullet otherwise under-measures, so the next block
            // (or the footer) overlaps the overflow. Bullet glyph + indent ≈ 0.3".
            const natural = block.items.reduce(
                (acc, it) => acc + estimateTextHeight(stripBulletPrefix(it), Math.max(0.5, box.w - IR_RENDER_SPEC.geometry.bulletIndentIn), theme.fontSize) + 0.04,
                0.1);
            const h = clampH(Math.max(0.4, natural), box, block.kind, slideIndex, st);
            s.addText(lines, { x: box.x, y: box.y, w: box.w, h, fontFace: theme.fontFace, fontSize: theme.fontSize, color: hx(theme.bodyColor), valign: 'top' });
            return h;
        }
        case 'callout': {
            const h = clampH(estimateTextHeight(block.text, box.w - 0.4, theme.fontSize) + 0.3, box, block.kind, slideIndex, st);
            const stripe = IR_RENDER_SPEC.calloutStripe.widthIn;   // #6 — left accent stripe (matches HTML border-left)
            s.addShape('rect', { x: box.x, y: box.y, w: box.w, h, fill: { color: lighten(theme.accentColor) }, line: { color: hx(theme.accentColor), width: 0.5 } });
            s.addShape('rect', { x: box.x, y: box.y, w: stripe, h, fill: { color: hx(theme.accentColor) }, line: { width: 0 } });
            s.addText(block.text + (block.cite ? `  — ${block.cite}` : ''), { x: box.x + stripe + 0.12, y: box.y + 0.1, w: box.w - stripe - 0.24, h: h - 0.2, fontFace: theme.fontFace, fontSize: theme.fontSize, color: hx(theme.bodyColor), valign: 'middle' });
            return h;
        }
        case 'stat-grid': {
            const cols = gridColumns(block.cards.length);
            const scale = box.w / CONTENT_WIDTH;
            const labelFont = IR_RENDER_SPEC.font.statLabelPt(theme);
            // Region above the label (icon + value). Card height GROWS to fit the
            // tallest wrapped label instead of a fixed 1.3" that clipped long
            // labels and made the next block overlap the overflow.
            const LABEL_TOP = 0.92;
            const cardW = (cols[0]?.w ?? CONTENT_WIDTH / Math.max(1, block.cards.length)) * scale;
            const labelH = Math.max(
                0.38,
                ...block.cards.map(c => estimateTextHeight(c.label, Math.max(0.5, cardW - 0.16), labelFont)),
            );
            // Tight card: top region + label + small pad; never run past the footer band.
            const h = Math.min(
                Math.max(1.3, LABEL_TOP + labelH + 0.12),
                Math.max(1.3, st.footerY - box.y),
            );
            block.cards.forEach((card, i) => {
                const col = cols[i];
                const x = box.x + (col.x - MARGIN) * scale;
                const w = col.w * scale;
                s.addShape('roundRect', { x, y: box.y, w, h, rectRadius: IR_RENDER_SPEC.geometry.cardRadiusIn, fill: { color: lighten(theme.accentColor) }, line: { color: hx(theme.accentColor), width: 1 } });
                // #5 — vector icon above the value (resolved symmetrically with HTML);
                // value carries NO emoji. #6 — value font shrinks as the row crowds.
                const ic = resolvePresentationIcon(card.icon);
                let valueY = box.y + 0.18;
                if (ic.kind === 'svg') {
                    const isz = IR_RENDER_SPEC.icon.statCardSizeIn;
                    drawIcon(s, ic.name, { x: x + (w - isz) / 2, y: box.y + 0.1, w: isz, h: isz }, st, () => { st.notices.push({ slideIndex, blockKind: 'stat-grid', severity: 'info', description: `icon "${ic.name}" image failed; omitted.` }); });
                    valueY = box.y + 0.1 + isz + 0.02;
                }
                // Stat value shrinks as the row crowds — lower-bound at body floor.
                const statValueSize = Math.max(fontFloor(theme, 'body'), IR_RENDER_SPEC.statValueFontPt(block.cards.length));
                s.addText(card.value, { x, y: valueY, w, h: 0.5, fontFace: theme.fontFace, fontSize: statValueSize, bold: true, color: hx(theme.primaryColor), align: 'center', valign: 'middle' });
                // Label box fills the rest of the (now content-sized) card so multi-line
                // labels wrap inside it instead of being clipped at a fixed 0.38".
                s.addText(card.label, { x, y: box.y + LABEL_TOP, w, h: Math.max(0.3, h - LABEL_TOP - 0.08), fontFace: theme.fontFace, fontSize: labelFont, color: hx(theme.bodyColor), align: 'center', valign: 'top' });
            });
            return h;
        }
        case 'bar-chart':
            return renderBarChart(s, block, box, slideIndex, st);
        case 'process-flow': {
            const n = block.steps.length;
            // Widened from 0.15 → 0.28 to fit a chevron in each inter-step gap.
            const gap = 0.28;
            const stepW = (box.w - gap * (n - 1)) / n;
            const stepFont = IR_RENDER_SPEC.font.processStepPt(theme);
            const iconH = block.steps.some(st2 => resolvePresentationIcon(st2.icon).kind === 'svg')
                ? IR_RENDER_SPEC.icon.processStepSizeIn + 0.12 : 0;
            // Card height grows to fit the tallest step text (title + sub) instead
            // of a fixed 1.0" that clipped long steps + overlapped the next block.
            const maxStepTextH = Math.max(
                0.5,
                ...block.steps.map(s2 => estimateTextHeight(
                    s2.title + (s2.sub ? `\n${s2.sub}` : ''), Math.max(0.5, stepW - 0.12), stepFont)),
            );
            const h = Math.min(
                Math.max(1.0, iconH + maxStepTextH + 0.2),
                Math.max(1.0, st.footerY - box.y),
            );
            const chevW = 0.28;
            block.steps.forEach((step, i) => {
                const x = box.x + i * (stepW + gap);
                s.addShape('roundRect', { x, y: box.y, w: stepW, h, rectRadius: IR_RENDER_SPEC.geometry.stepRadiusIn, fill: { color: lighten(theme.accentColor) }, line: { color: hx(theme.accentColor), width: 1 } });
                // #5 — vector icon at the top of the step (resolved symmetrically with HTML).
                const ic = resolvePresentationIcon(step.icon);
                let textY = box.y; let textH = h; let textValign: 'top' | 'middle' = 'middle';
                if (ic.kind === 'svg') {
                    const isz = IR_RENDER_SPEC.icon.processStepSizeIn;
                    drawIcon(s, ic.name, { x: x + (stepW - isz) / 2, y: box.y + 0.08, w: isz, h: isz }, st, () => { st.notices.push({ slideIndex, blockKind: 'process-flow', severity: 'info', description: `icon "${ic.name}" image failed; omitted.` }); });
                    textY = box.y + 0.08 + isz; textH = h - (0.08 + isz); textValign = 'top';
                }
                s.addText(step.title + (step.sub ? `\n${step.sub}` : ''), { x, y: textY, w: stepW, h: textH, fontFace: theme.fontFace, fontSize: stepFont, bold: true, color: hx(theme.primaryColor), align: 'center', valign: textValign });
                // Flow chevron in the gap, matching the HTML's yellow `▶` indicator.
                // Vertically centred against the step cards, accent-coloured.
                if (i < n - 1) {
                    s.addText('▶', {
                        x: x + stepW + (gap - chevW) / 2,
                        y: box.y + (h - 0.4) / 2,
                        w: chevW, h: 0.4,
                        fontFace: theme.fontFace, fontSize: IR_RENDER_SPEC.font.chevronPt, bold: true,
                        color: hx(theme.accentColor), align: 'center', valign: 'middle',
                    });
                }
            });
            return h;
        }
        case 'table':
            return renderTable(s, block, box, slideIndex, st);
        case 'image': {
            const h = Math.min(st.footerY - box.y, box.w * IR_RENDER_SPEC.geometry.media.imageAspect);
            s.addImage({ data: block.dataUri, x: box.x, y: box.y, w: box.w, h });
            return h;
        }
        case 'svg':
            return renderSvg(s, block, box, slideIndex, st);
        case 'two-column': {
            // TODO(brand): splitColumns() uses absolute MARGIN-based x, so a
            // two-column slide does not shift with the safe-area side margin /
            // logo reserve. Single-column + grid paths (which derive x from
            // box.x) already honour the safe area; column math is left for a
            // follow-up to avoid reworking the shared layout helper here.
            const { left, right } = splitColumns();
            await renderColumn(s, block.left, { x: left.x, y: box.y, w: left.w }, slideIndex, st);
            await renderColumn(s, block.right, { x: right.x, y: box.y, w: right.w }, slideIndex, st);
            return st.footerY - box.y;     // columns consume the remaining zone
        }
        case 'custom':
            return renderCustom(s, block, box, slideIndex, st);
    }
}

async function renderColumn(s: SlideLike, blocks: LeafBlock[], box: Box, slideIndex: number, st: RenderState): Promise<void> {
    let y = box.y;
    for (const block of blocks) {
        if (y >= st.footerY) {
            st.notices.push({ slideIndex, blockKind: block.kind, severity: 'substantive', description: `column block "${block.kind}" clipped.` });
            continue;
        }
        try {
            y += await renderBlock(s, block, { x: box.x, y, w: box.w }, slideIndex, st) + IR_RENDER_SPEC.geometry.colSubGapIn;
        } catch (e) {
            st.notices.push({ slideIndex, blockKind: block.kind, severity: 'substantive', description: `column block "${block.kind}" failed: ${msg(e)}` });
        }
    }
}

function renderBarChart(s: SlideLike, block: Extract<Block, { kind: 'bar-chart' }>, box: Box, slideIndex: number, st: RenderState): number {
    const { theme } = st;
    const h = Math.min(st.footerY - box.y, Math.max(1.5, block.bars.length * 0.45));
    let drawn = false;
    if (st.barStyle === 'native') {
        try {
            // PPT bar charts (horizontal `barDir: 'bar'`) plot the first label
            // at the BOTTOM of the chart by default; HTML preview reads the
            // other way (first label on TOP). `catAxisOrderReverse` is not in
            // pptxgenjs 4.0.x's type surface and is silently ignored — so
            // instead we reverse the data arrays ourselves before passing them
            // to addChart. Provider-agnostic, version-stable.
            const orderedBars = [...block.bars].reverse();
            s.addChart('bar', [{ name: 'Share', labels: orderedBars.map(b => b.label), values: orderedBars.map(b => b.pct) }], {
                x: box.x, y: box.y, w: box.w, h, barDir: 'bar', showLegend: false, showValue: true,
                // Labels INSIDE the end of the bar, matching the HTML preview's
                // `padding-left: 20px` placement. PPT default is `outEnd`.
                dataLabelPosition: 'inEnd',
                dataLabelFontSize: 11, dataLabelColor: 'FFFFFF', dataLabelFontBold: true,
                // Per-data-point colours from the IR. With a single series + N
                // bars, pptxgenjs maps `chartColors[i]` to the i-th bar, which
                // reproduces the HTML's light→dark green progression. Reversed
                // to match the reversed labels/values above.
                chartColors: orderedBars.map(b => (b.color ? hx(b.color) : hx(theme.accentColor))),
            });
            drawn = true;
        } catch (e) {
            st.downgrades.push(`bar-chart native→bars fallback: ${msg(e)}`);
            st.notices.push({ slideIndex, blockKind: 'bar-chart', severity: 'info', description: 'native chart unavailable; rendered as shapes.' });
        }
    }
    if (!drawn) {
        // Deterministic manual bars (also the native-fallback target).
        const rowH = Math.min(0.36, (h - 0.1) / block.bars.length);
        const labelW = 1.2;
        block.bars.forEach((bar, i) => {
            const y = box.y + i * (rowH + 0.06);
            s.addText(bar.label, { x: box.x, y, w: labelW, h: rowH, fontFace: theme.fontFace, fontSize: IR_RENDER_SPEC.font.barLabelPt(theme), bold: true, color: hx(theme.primaryColor), align: 'right', valign: 'middle' });
            const trackX = box.x + labelW + 0.1;
            const trackW = box.w - labelW - 0.1;
            s.addShape('rect', { x: trackX, y, w: trackW, h: rowH, fill: { color: 'EEEEEE' }, line: { width: 0 } });
            s.addShape('rect', { x: trackX, y, w: Math.max(0.02, trackW * (bar.pct / 100)), h: rowH, fill: { color: bar.color ? hx(bar.color) : hx(theme.accentColor) }, line: { width: 0 } });
            s.addText(`${bar.pct}%`, { x: trackX + 0.05, y, w: trackW, h: rowH, fontFace: theme.fontFace, fontSize: IR_RENDER_SPEC.font.barPctPt(theme), bold: true, color: 'FFFFFF', valign: 'middle' });
        });
    }
    // #3 chart credibility: axis-label/units + source footnote below the chart.
    let extra = 0;
    if (block.axisLabel) {
        s.addText(block.axisLabel, { x: box.x, y: box.y + h + extra, w: box.w, h: 0.3, fontFace: theme.fontFace, fontSize: IR_RENDER_SPEC.font.captionPt(theme), color: hx(theme.bodyColor), valign: 'top' });
        extra += 0.3;
    }
    if (block.source) {
        s.addText(block.source, { x: box.x, y: box.y + h + extra, w: box.w, h: 0.25, fontFace: theme.fontFace, fontSize: IR_RENDER_SPEC.font.footerPt(theme), italic: true, color: hx(theme.bodyColor), valign: 'top' });
        extra += 0.25;
    }
    return h + extra;
}

const TABLE_ROW_H = 0.35;

function renderTable(s: SlideLike, block: Extract<Block, { kind: 'table' }>, box: Box, slideIndex: number, st: RenderState): number {
    const theme = st.theme;
    const available = st.footerY - box.y;
    // Slice rows to those that actually fit (G3) — drawing N rows into a
    // too-small height squashes them illegibly. +1 for the header row.
    const maxBodyRows = Math.max(1, Math.floor(available / TABLE_ROW_H) - 1);
    const shown = block.rows.slice(0, maxBodyRows);
    if (shown.length < block.rows.length) {
        st.notices.push({ slideIndex, blockKind: 'table', severity: 'substantive', description: `table truncated to ${shown.length}/${block.rows.length} rows to fit the slide.` });
    }
    const colW = tableColumnWidths(block.headers, shown, box.w);
    const header = block.headers.map(hh => ({ text: hh, options: { bold: true, color: 'FFFFFF', fill: { color: hx(IR_RENDER_SPEC.tableHeaderFill(theme)) } } }));
    const body = shown.map(r => r.map(c => ({ text: c, options: { color: hx(theme.bodyColor) } })));
    const h = Math.min(available, (body.length + 1) * TABLE_ROW_H);
    s.addTable([header, ...body], {
        x: box.x, y: box.y, w: box.w, colW,
        // Shrink-to-fit (body − 3, hard floor 9), lower-bounded at the table floor.
        fontFace: theme.fontFace, fontSize: IR_RENDER_SPEC.font.tablePt(theme),
        border: { type: 'solid', pt: 0.5, color: 'DDDDDD' }, autoPage: false, valign: 'middle',
    });
    return h;
}

async function renderSvg(s: SlideLike, block: Extract<Block, { kind: 'svg' }>, box: Box, slideIndex: number, st: RenderState): Promise<number> {
    const h = Math.min(st.footerY - box.y, box.w * IR_RENDER_SPEC.geometry.media.svgAspect);
    const clean = sanitizeSvgMarkup(block.svg);
    // Proactively validate root attrs (G2) — pptxgenjs won't throw on a bad
    // base64 SVG, so we decide up-front whether to embed or fall back.
    const hasDims = /viewbox\s*=/i.test(clean) || (/\bwidth\s*=/i.test(clean) && /\bheight\s*=/i.test(clean));
    if (clean && hasDims) {
        s.addImage({ data: `data:image/svg+xml;base64,${base64(clean)}`, x: box.x, y: box.y, w: box.w, h });
        return h;
    }
    // No safe vector — rasterize the cleaned SVG if a rasterizer is injected.
    if (clean && st.rasterize) {
        const dataUri = await tryRasterize(st, { svg: clean, widthPx: box.w * RASTER_PX_PER_IN, heightPx: h * RASTER_PX_PER_IN });
        if (dataUri) { s.addImage({ data: dataUri, x: box.x, y: box.y, w: box.w, h }); return h; }
    }
    placeholder(s, block.alt ?? 'Diagram', box, h, st.theme);
    st.notices.push({ slideIndex, blockKind: 'svg', severity: 'substantive', description: clean ? 'SVG lacks viewBox/width+height; rendered as placeholder.' : 'SVG could not be sanitized.' });
    return h;
}

async function renderCustom(s: SlideLike, block: Extract<Block, { kind: 'custom' }>, box: Box, slideIndex: number, st: RenderState): Promise<number> {
    const h = Math.min(st.footerY - box.y, box.w * IR_RENDER_SPEC.geometry.media.svgAspect);
    // Precedence IDENTICAL to HTML (plan G3): image wins.
    if (block.image) {
        s.addImage({ data: block.image, x: box.x, y: box.y, w: box.w, h });
        return h;
    }
    // html-only: rasterize when a rasterizer is injected (Phase B), else placeholder.
    if (block.html && st.rasterize) {
        const dataUri = await tryRasterize(st, { html: block.html, widthPx: box.w * RASTER_PX_PER_IN, heightPx: h * RASTER_PX_PER_IN });
        if (dataUri) { s.addImage({ data: dataUri, x: box.x, y: box.y, w: box.w, h }); return h; }
    }
    placeholder(s, block.fallbackText ?? 'Custom block (see HTML preview)', box, h, st.theme);
    st.notices.push({ slideIndex, blockKind: 'custom', severity: 'substantive', description: 'custom block rendered as placeholder (no rasterizer).' });
    return h;
}

/** Invoke the injected rasterizer, swallowing failures so the caller can fall
 *  back to a placeholder rather than dropping the block. */
async function tryRasterize(st: RenderState, input: { html?: string; svg?: string; widthPx: number; heightPx: number }): Promise<string | null> {
    if (!st.rasterize) return null;
    try {
        const uri = await st.rasterize(input);
        return uri && uri.startsWith('data:image/') ? uri : null;
    } catch (e) {
        st.downgrades.push(`rasterize failed: ${msg(e)}`);
        return null;
    }
}

function placeholder(s: SlideLike, label: string, box: Box, h: number, theme: ExportTheme): void {
    s.addShape('roundRect', { x: box.x, y: box.y, w: box.w, h, rectRadius: IR_RENDER_SPEC.geometry.stepRadiusIn, fill: { color: 'F1F5F9' }, line: { color: hx(theme.bodyColor), width: 0.5, dashType: 'dash' } });
    s.addText(label, { x: box.x, y: box.y, w: box.w, h, fontFace: theme.fontFace, fontSize: IR_RENDER_SPEC.font.placeholderInlinePt, italic: true, color: hx(theme.bodyColor), align: 'center', valign: 'middle' });
}

function lighten(hex: string): string {
    const h = hex.replace('#', '');
    const mix = (c: number) => Math.round(c + (255 - c) * 0.85);
    const r = mix(parseInt(h.slice(0, 2), 16));
    const g = mix(parseInt(h.slice(2, 4), 16));
    const b = mix(parseInt(h.slice(4, 6), 16));
    return [r, g, b].map(c => c.toString(16).padStart(2, '0')).join('');
}


/** UTF-8-safe base64 (G1) — encodes to UTF-8 bytes BEFORE base64 so non-ASCII
 *  SVG content isn't corrupted. Prefers Node `Buffer` (Obsidian/Electron),
 *  falls back to a TextEncoder + btoa path in a pure browser. */
function base64(s: string): string {
    if (typeof Buffer !== 'undefined') return Buffer.from(s, 'utf-8').toString('base64');
    const bytes = new TextEncoder().encode(s);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
}
