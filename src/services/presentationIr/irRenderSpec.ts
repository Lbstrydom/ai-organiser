/**
 * Shared render decisions — the SINGLE source of truth for the visual choices
 * that previously drifted between `irToHtml` and `irToPptx`. Both renderers
 * import this and map the values to their medium (HTML multiplies inches by
 * PX_PER_IN for px; PPTX uses inches directly), so preview == export by
 * construction.
 *
 * Pure data + helpers keyed off `ExportTheme`. No Obsidian, no pptxgenjs.
 * Bounded to the divergent decisions ONLY (not a general token framework).
 *
 * Plan: docs/plans/presentation-renderer-fidelity.md (D2).
 */

import type { ExportTheme } from '../export/exportTheme';
import { MARGIN } from './irLayout';
import type { SlideIr } from './slideIr';
import { clampFixedFont } from './fontFloor';

/** px-per-inch at the fixed 1920×1080 ≡ 13.33×7.5in canvas: 1920/13.33 ≈ 144
 *  (≡ 1080/7.5). This is the bridge between HTML px and PPTX inches — getting it
 *  wrong makes the same element a different physical size in preview vs export. */
export const PX_PER_IN = 144;

/** pt → px at the canvas DPI (PX_PER_IN/72 = 2). The single bridge HTML uses
 *  for every spec FONT value, so a font is the same physical size in preview
 *  and export by construction (renderer-fidelity Phase 2 / D2). */
export const ptToPx = (pt: number): number => Math.round(pt * PX_PER_IN / 72);

/** inches → px. The single bridge HTML uses for every spec GEOMETRY value
 *  (radii, gaps, indents). Symmetric with `ptToPx` so HTML never repeats a bare
 *  `Math.round(x * PX_PER_IN)` (D2). */
export const inToPx = (inches: number): number => Math.round(inches * PX_PER_IN);

export type SlideBackground =
    | { kind: 'gradient'; from: string; to: string; angleDeg: 135 }
    | { kind: 'solid'; color: string };

export const IR_RENDER_SPEC = {
    /** #1 — table header fill: PRIMARY (white text reads well on it). Was accent in PPTX. */
    tableHeaderFill: (t: ExportTheme): string => t.primaryColor,

    /** #3 — hero (title/section/closing) text alignment: LEFT. Was centre in PPTX. */
    titleLayout: { align: 'left' as const, xIn: MARGIN },

    /** #2 — accent under the content-slide title. Derived from the canonical px
     *  values via PX_PER_IN (no duplicated/drifting derived state — audit M7). */
    accentUnderline: { widthIn: 130 / PX_PER_IN, heightIn: 8 / PX_PER_IN, gapBelowTitleIn: 18 / PX_PER_IN },

    /**
     * #4 — the ONE gradient-vs-solid decision both renderers branch on. Per-slide
     * `background` override → solid; title/closing → gradient; section → solid
     * sectionBg; content → white.
     */
    slideBackground(slide: SlideIr, t: ExportTheme): SlideBackground {
        if (slide.background) return { kind: 'solid', color: slide.background };
        if (slide.type === 'title' || slide.type === 'closing') {
            return { kind: 'gradient', from: t.primaryColor, to: t.sectionBg, angleDeg: 135 };
        }
        if (slide.type === 'section') return { kind: 'solid', color: t.sectionBg };
        return { kind: 'solid', color: 'FFFFFF' };
    },

    /** #6 — stat-card value font (pt) shrinks as the row gets more crowded. */
    statValueFontPt: (cardCount: number): number =>
        cardCount >= 6 ? 16 : cardCount >= 4 ? 18 : 22,

    /** #6 — left accent stripe on callouts (both renderers). */
    calloutStripe: { widthIn: 0.1 },

    /** #5 — shared icon presentation so both renderers draw the same glyph. */
    icon: {
        strokeWidth: 2,
        /** colour role — both use the theme's primary colour. */
        colorRole: 'primary' as const,
        statCardSizeIn: 0.42,
        processStepSizeIn: 0.34,
    },

    /**
     * Typography SSOT (renderer-fidelity Phase 2 / D1). PPTX consumes the pt
     * directly; HTML uses `ptToPx(...)`. Canonical = the export's existing pt,
     * so PPTX output is unchanged and HTML aligns to it. Fixed-role constants +
     * theme-derived fns (caption/table apply the floor; paragraph does not —
     * body text is the user's chosen size, matching the PPTX raw `theme.fontSize`).
     * NOTE: `statValueFontPt` stays at the top level above (unchanged path).
     */
    font: {
        heroTitlePt: 40,
        heroSubtitlePt: 18,
        slideTitlePt: 24,
        headingPt: (level: 1 | 2 | 3): number => (level === 1 ? 22 : level === 2 ? 18 : 15),
        chevronPt: 18,
        statLabelPt: 11,
        processStepPt: 11,
        barLabelPt: 11,
        barPctPt: 10,
        footerPt: (t: ExportTheme): number => clampFixedFont(t, 'footer', 10),
        // Paragraph/body text uses the user's chosen size RAW — no floor (matches
        // the PPTX paragraph path's bare `theme.fontSize`). The `'body'` min-font
        // role is for shrink-to-fit values (e.g. stat values via `fontFloor`),
        // not for body copy, so applying it here would wrongly inflate paragraphs.
        paragraphPt: (t: ExportTheme): number => t.fontSize,
        captionPt: (t: ExportTheme): number => clampFixedFont(t, 'caption', t.fontSize - 2),
        tablePt: (t: ExportTheme): number => clampFixedFont(t, 'table', Math.max(9, t.fontSize - 3)),
    },

    /**
     * Geometry SSOT (renderer-fidelity Phase 2 / D5) — inches. PPTX reads
     * inches directly; HTML uses `inToPx(...)`. Canonical = export inches (PPTX
     * unchanged; HTML radii/gaps align). `COL_GAP` deliberately stays in
     * `irLayout` (it drives the column math) — NOT duplicated here.
     */
    geometry: {
        cardRadiusIn: 0.08,
        stepRadiusIn: 0.06,
        placeholderRadiusIn: 0.1,
        blockGapIn: 0.12,
        bulletIndentIn: 0.3,
        colSubGapIn: 0.1,
        /** Width-relative media height caps — `box.w(in) * aspect` (PPTX) /
         *  `inToPx(availWidthIn * aspect)` (HTML), so full-width media match. */
        media: { imageAspect: 0.5, svgAspect: 0.45 },
    },
} as const;
