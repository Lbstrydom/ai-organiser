/**
 * Brand → ExportTheme mapper (plan §5, NEW `brandExportTheme.ts`).
 *
 * PURE — no DOM, no vault I/O, no Obsidian imports. Maps a parsed `BrandTheme`
 * (colours + font + min-font + layout zones, from `brandThemeService`) into the
 * renderer-facing `ExportTheme` contract plus a `SafeArea`. Keeps
 * `brandThemeService` from owning export concerns (SRP; plan M2).
 *
 * Colours arrive from the brand parse as `#RRGGBB`; `ExportTheme` uses the
 * pptxgenjs convention (6-hex, no `#`), so we strip the prefix here.
 */

import type { BrandTheme } from '../../chat/brandThemeService';
import type { ExportTheme, ExportMinFont, ExportSafeArea } from '../exportTheme';
import { safeHex } from '../../presentationIr/themeSafe';
import { EXAMPLE_EXPORT_FALLBACK } from './exampleBrandTheme';

/** Re-exported shapes (plan §3 asks brandExportTheme to export these names). */
export type SafeArea = ExportSafeArea;
export type MinFont = ExportMinFont;

/**
 * Validate a brand colour → pptxgenjs 6-hex (no `#`). A malformed brand hex
 * degrades to the role default rather than emitting `NaN`/`NaNNaNNaN` downstream
 * (audit H3/M6). Wraps the shared `safeHex` boundary validator.
 */
function safeColor(hex: string, fallback: string): string {
    return safeHex(hex, fallback).hex;
}

/** Take the FIRST declared family of a (possibly CSS-list) brand font
 *  ("Noto Sans, Inter, sans-serif" → "Noto Sans"). Strips CSS quotes so a quoted
 *  stack ("'Inter', sans-serif" → "Inter", not "'Inter'") yields a bare family
 *  name (audit M18). Empty → empty (the renderer's `safeFont` supplies a system
 *  fallback). */
function firstFontFamily(font: string): string {
    return (font ?? '')
        .split(',')[0]
        .trim()
        .replace(/^['"]+|['"]+$/g, '')
        .trim();
}

/** Build the `SafeArea` shape from the brand's parsed layout zones. */
export function getSafeArea(brand: BrandTheme): SafeArea {
    return {
        headerBandIn: brand.layout.headerBandIn,
        contentTopIn: brand.layout.contentTopIn,
        footerBandIn: brand.layout.footerBandIn,
        logoReserveIn: brand.layout.logoReserveIn,
        sideMarginIn: brand.layout.sideMarginIn,
    };
}

/**
 * Map a parsed `BrandTheme` to an `ExportTheme`.
 *
 * - `primaryColor` ← brand primary (heading / title bg)
 * - `accentColor`  ← brand accent (bars / table headers)
 * - `sectionBg`    ← brand secondary (section-divider bg)
 * - `bodyColor`    ← brand text
 * - `fontFace`     ← brand font family (first declared name)
 * - `fontSize`     ← brand NOMINAL body size (`bodyFontPt`), floored at min body
 * - `minFont`      ← brand min-font floor (per role)
 * - `safeArea`     ← brand layout zones
 */
export function toExportTheme(brand: BrandTheme): ExportTheme {
    return {
        // Validate every colour through the shared boundary validator — a bad
        // brand hex degrades to the shipped EXAMPLE-brand role colour (audit M8),
        // never NaN (audit H3/M6), so the fallback matches the example default.
        primaryColor: safeColor(brand.colors.primary, EXAMPLE_EXPORT_FALLBACK.primary),
        accentColor: safeColor(brand.colors.accent, EXAMPLE_EXPORT_FALLBACK.accent),
        sectionBg: safeColor(brand.colors.secondary, EXAMPLE_EXPORT_FALLBACK.sectionBg),
        bodyColor: safeColor(brand.colors.text, EXAMPLE_EXPORT_FALLBACK.bodyColor),
        // ExportTheme carries the bare/FIRST family — a brand file may declare a
        // CSS stack ("Noto Sans, Inter, sans-serif"); take the first (audit M15).
        // The renderers still run it through `safeFont`, which tolerates a stack.
        fontFace: firstFontFamily(brand.font),
        // fontSize is the NOMINAL body size, NOT the floor (audit M19): use the
        // brand's parsed `bodyFontPt`, then clamp UP to the min-body floor so text
        // is never set below it. The floor stays separate in `minFont.body`.
        fontSize: Math.max(brand.bodyFontPt, brand.minFont.body),
        minFont: {
            body: brand.minFont.body,
            caption: brand.minFont.caption,
            table: brand.minFont.table,
            footer: brand.minFont.footer,
        },
        safeArea: getSafeArea(brand),
    };
}
