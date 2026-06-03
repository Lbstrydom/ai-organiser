/**
 * Export theme contract — shared by the Markdown PPTX generator and the
 * structured-IR presentation renderers.
 *
 * Extracted from `markdownPptxGenerator.ts` so the presentation IR module does
 * not depend on Markdown-export internals (plan M2). `markdownPptxGenerator.ts`
 * re-exports these symbols for backward compatibility — no behaviour change.
 *
 * Pure module, no Obsidian dependencies. Hex values carry no `#` prefix
 * (pptxgenjs convention).
 */

// ── Export Theme ─────────────────────────────────────────────────────────────

/** Per-role minimum font floor (points). Optional on ExportTheme — present only
 *  for brand exports; absent → renderers keep their literal sizes. */
export interface ExportMinFont {
    body: number;
    caption: number;
    table: number;
    footer: number;
}

/** Safe-area geometry (inches on the 13.33×7.5in 16:9 canvas). Optional on
 *  ExportTheme — present only for brand exports; absent → renderers keep their
 *  current layout. */
export interface ExportSafeArea {
    headerBandIn: number;
    contentTopIn: number;
    footerBandIn: number;
    logoReserveIn: number;
    sideMarginIn: number;
}

export interface ExportTheme {
    primaryColor: string;  // Heading / title text + title slide bg (hex, no #)
    accentColor: string;   // Accent bar + table header fill
    sectionBg: string;     // Section-divider slide background
    bodyColor: string;     // Body text color
    fontFace: string;
    fontSize: number;      // Body font size in points
    /** Min-font floor per role (brand exports only; absent → no floor). */
    minFont?: ExportMinFont;
    /** Safe-area zones (brand exports only; absent → current layout). */
    safeArea?: ExportSafeArea;
}

export const COLOR_SCHEMES: Record<string, Omit<ExportTheme, 'fontFace' | 'fontSize'>> = {
    'navy-gold':          { primaryColor: '1A3A5C', accentColor: 'F5C842', sectionBg: '1D6B4A', bodyColor: '2D4A5A' },
    'forest-amber':       { primaryColor: '1B4F2A', accentColor: 'E8921A', sectionBg: '1A4A2F', bodyColor: '2D4B3A' },
    'slate-coral':        { primaryColor: '2D3748', accentColor: 'E05252', sectionBg: '374151', bodyColor: '4A5568' },
    'burgundy-champagne': { primaryColor: '6B1A2A', accentColor: 'F0D9A0', sectionBg: '4A1A22', bodyColor: '5C2C35' },
    'charcoal-sky':       { primaryColor: '1F2937', accentColor: '38BDF8', sectionBg: '111827', bodyColor: '374151' },
};

export function hexToRgb(hex: string): [number, number, number] {
    const h = hex.replace('#', '');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
export function rgbToHex(r: number, g: number, b: number): string {
    return [r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}
export function darkenHex(hex: string, amt: number): string {
    const [r, g, b] = hexToRgb(hex);
    return rgbToHex(r * (1 - amt), g * (1 - amt), b * (1 - amt));
}
export function lightenHex(hex: string, amt: number): string {
    const [r, g, b] = hexToRgb(hex);
    return rgbToHex(r + (255 - r) * amt, g + (255 - g) * amt, b + (255 - b) * amt);
}

/** Universal min-font floor defaults (points). The footer (slide-number strip)
 *  is auto-placed and is NOT user-editable — it stays a code constant. */
const MIN_FONT_FLOOR_DEFAULTS = { body: 12, caption: 10, table: 11, footer: 9 } as const;

/**
 * Build the universal min-font floor from the (optional) user settings. Applied
 * to EVERY export — not just the brand path — so all exports get a floor. A brand
 * file can still override per-role downstream (see `toExportTheme`). The three
 * content roles are user-set; the footer is the one auto-placed exception.
 */
function resolveMinFont(body?: number, caption?: number, table?: number): ExportMinFont {
    const pick = (v: number | undefined, fallback: number): number =>
        Number.isFinite(v) ? (v as number) : fallback;
    return {
        body: pick(body, MIN_FONT_FLOOR_DEFAULTS.body),
        caption: pick(caption, MIN_FONT_FLOOR_DEFAULTS.caption),
        table: pick(table, MIN_FONT_FLOOR_DEFAULTS.table),
        footer: MIN_FONT_FLOOR_DEFAULTS.footer,
    };
}

/** Resolve settings into a full ExportTheme. Falls back to navy-gold if scheme unknown.
 *  The optional min-font args set a universal floor on ALL (non-brand) exports. */
export function resolveTheme(
    scheme: string,
    primaryColor: string,
    accentColor: string,
    fontFace: string,
    fontSize: number,
    minFontBody?: number,
    minFontCaption?: number,
    minFontTable?: number,
): ExportTheme {
    const minFont = resolveMinFont(minFontBody, minFontCaption, minFontTable);
    if (scheme === 'custom') {
        const p = primaryColor || '1A3A5C';
        return {
            primaryColor: p,
            accentColor: accentColor || 'F5C842',
            sectionBg: darkenHex(p, 0.10),
            bodyColor: lightenHex(p, 0.20),
            fontFace,
            fontSize,
            minFont,
        };
    }
    const preset = COLOR_SCHEMES[scheme] ?? COLOR_SCHEMES['navy-gold'];
    return { ...preset, fontFace, fontSize, minFont };
}
