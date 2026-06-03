/**
 * Generic example brand theme (plan BD-2, BD-7 — shipped public default).
 *
 * Lift-and-generalize of the brand MECHANISM (from the de-branded reference
 * `wartsilaTheme.ts`) with NEUTRAL values — no corporate palette, fonts, or
 * layout numbers. Used as the `'example'` source when on-brand is requested but
 * no vault brand file is present.
 *
 * Shaped as a parsed `BrandTheme` so it flows through `toExportTheme` exactly
 * like a real vault brand. PURE constant — no DOM, no vault I/O.
 */

import type { BrandTheme } from '../../chat/brandThemeService';
import { BRAND_MIN_FONT_DEFAULTS, BRAND_LAYOUT_DEFAULTS, BRAND_BODY_FONT_DEFAULT } from '../../chat/brandThemeService';

/** Neutral example palette (hex with leading `#`, matching the brand parse). */
const EXAMPLE_COLORS = {
    primary: '#1F2A44',
    secondary: '#2C3E50',
    accent: '#3B82F6',
    background: '#FFFFFF',
    text: '#333333',
    link: '#2563EB',
};

/**
 * Neutral degrade-target colours in the `ExportTheme` convention (6-hex, NO `#`),
 * shared with the brand → ExportTheme mapper so a malformed brand hex degrades to
 * the SAME palette as the shipped example brand (audit M8), not to an unrelated
 * navy-gold. Derived from `EXAMPLE_COLORS` (primary/accent/secondary/text) so the
 * two never drift. Defined here (the example's home) so the mapper imports DOWN.
 */
export const EXAMPLE_EXPORT_FALLBACK = {
    primary: EXAMPLE_COLORS.primary.replace(/^#/, ''),
    accent: EXAMPLE_COLORS.accent.replace(/^#/, ''),
    sectionBg: EXAMPLE_COLORS.secondary.replace(/^#/, ''),
    bodyColor: EXAMPLE_COLORS.text.replace(/^#/, ''),
} as const;

const EXAMPLE_FONT = "'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif";

/**
 * The shipped generic example brand. CSS/promptRules/auditChecklist are left
 * empty — the `'example'` source is only consumed for the ExportTheme + assets,
 * and the HTML preview keeps its own default path (`getDefaultTheme`).
 */
export const exampleBrandTheme: BrandTheme = {
    css: '',
    promptRules: '',
    auditChecklist: [],
    colors: { ...EXAMPLE_COLORS },
    font: EXAMPLE_FONT,
    fontFallback: 'Inter',
    bodyFontPt: BRAND_BODY_FONT_DEFAULT,
    minFont: { ...BRAND_MIN_FONT_DEFAULTS },
    layout: { ...BRAND_LAYOUT_DEFAULTS },
    warnings: [],
};
