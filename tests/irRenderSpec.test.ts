import { describe, it, expect } from 'vitest';
import { IR_RENDER_SPEC, ptToPx, inToPx, PX_PER_IN } from '../src/services/presentationIr/irRenderSpec';
import { resolveTheme } from '../src/services/export/exportTheme';
import type { ExportTheme } from '../src/services/export/exportTheme';

const theme: ExportTheme = resolveTheme('navy-gold', '', '', 'Inter', 14);
const brand: ExportTheme = { ...theme, minFont: { body: 12, caption: 14, table: 12, footer: 11 } };

describe('ptToPx / inToPx bridges', () => {
    it('ptToPx = pt × (PX_PER_IN / 72) = pt × 2 at 144 dpi', () => {
        expect(PX_PER_IN).toBe(144);
        expect(ptToPx(11)).toBe(22);
        expect(ptToPx(24)).toBe(48);
        expect(ptToPx(40)).toBe(80);
    });
    it('inToPx = round(in × PX_PER_IN)', () => {
        expect(inToPx(0.5)).toBe(72);
        expect(inToPx(0.3)).toBe(43);
        expect(inToPx(0.08)).toBe(12);
    });
});

describe('IR_RENDER_SPEC.font — typography SSOT', () => {
    it('exposes the fixed pt constants (title/chevron — no floor)', () => {
        expect(IR_RENDER_SPEC.font.heroTitlePt).toBe(40);
        expect(IR_RENDER_SPEC.font.sectionTitlePt).toBe(34);
        expect(IR_RENDER_SPEC.font.heroSubtitlePt).toBe(18);
        expect(IR_RENDER_SPEC.font.slideTitlePt).toBe(24);
        expect(IR_RENDER_SPEC.font.placeholderTitlePt).toBe(16);
        expect(IR_RENDER_SPEC.font.placeholderInlinePt).toBe(12);
        expect(IR_RENDER_SPEC.font.chevronPt).toBe(18);
    });
    it('structural fonts apply the role floor (constant when non-brand)', () => {
        expect(IR_RENDER_SPEC.font.statLabelPt(theme)).toBe(11);
        expect(IR_RENDER_SPEC.font.processStepPt(theme)).toBe(11);
        expect(IR_RENDER_SPEC.font.barLabelPt(theme)).toBe(11);
        expect(IR_RENDER_SPEC.font.barPctPt(theme)).toBe(10);
        // Brand floors clamp up: caption floor 14 > 11, footer floor 11 > 10.
        expect(IR_RENDER_SPEC.font.statLabelPt(brand)).toBe(14);
        expect(IR_RENDER_SPEC.font.barPctPt(brand)).toBe(11);
    });
    it('headingPt maps the zod-validated 1|2|3 levels exhaustively', () => {
        expect(IR_RENDER_SPEC.font.headingPt(1)).toBe(22);
        expect(IR_RENDER_SPEC.font.headingPt(2)).toBe(18);
        expect(IR_RENDER_SPEC.font.headingPt(3)).toBe(15);
    });
    it('paragraph has NO floor (raw theme.fontSize); caption + table + footer apply the floor', () => {
        expect(IR_RENDER_SPEC.font.paragraphPt(theme)).toBe(14);
        expect(IR_RENDER_SPEC.font.paragraphPt(brand)).toBe(14);            // no floor on paragraph
        expect(IR_RENDER_SPEC.font.captionPt(theme)).toBe(12);             // 14-2, no floor
        expect(IR_RENDER_SPEC.font.captionPt(brand)).toBe(14);             // clamped up to floor 14
        expect(IR_RENDER_SPEC.font.tablePt(theme)).toBe(11);              // max(9,14-3)
        expect(IR_RENDER_SPEC.font.tablePt(brand)).toBe(12);              // clamped to floor 12
        expect(IR_RENDER_SPEC.font.footerPt(theme)).toBe(10);
        expect(IR_RENDER_SPEC.font.footerPt(brand)).toBe(11);             // clamped to floor 11
    });
    it('statValueFontPt stays top-level (unchanged path) and shrinks by card count', () => {
        expect(IR_RENDER_SPEC.statValueFontPt(6)).toBe(16);
        expect(IR_RENDER_SPEC.statValueFontPt(4)).toBe(18);
        expect(IR_RENDER_SPEC.statValueFontPt(3)).toBe(22);
        // NOT relocated under font
        expect((IR_RENDER_SPEC.font as Record<string, unknown>).statValueFontPt).toBeUndefined();
    });
});

describe('IR_RENDER_SPEC.geometry — geometry SSOT', () => {
    it('exposes the radii/gaps/indents + media aspects', () => {
        expect(IR_RENDER_SPEC.geometry.cardRadiusIn).toBe(0.08);
        expect(IR_RENDER_SPEC.geometry.stepRadiusIn).toBe(0.06);
        expect(IR_RENDER_SPEC.geometry.placeholderRadiusIn).toBe(0.1);
        expect(IR_RENDER_SPEC.geometry.blockGapIn).toBe(0.12);
        expect(IR_RENDER_SPEC.geometry.bulletIndentIn).toBe(0.3);
        expect(IR_RENDER_SPEC.geometry.colSubGapIn).toBe(0.1);
        expect(IR_RENDER_SPEC.geometry.media.imageAspect).toBe(0.5);
        expect(IR_RENDER_SPEC.geometry.media.svgAspect).toBe(0.45);
    });
});
