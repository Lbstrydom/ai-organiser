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

/** px-per-inch at the fixed 1920×1080 ≡ 13.33×7.5in canvas: 1920/13.33 ≈ 144
 *  (≡ 1080/7.5). This is the bridge between HTML px and PPTX inches — getting it
 *  wrong makes the same element a different physical size in preview vs export. */
export const PX_PER_IN = 144;

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
} as const;
