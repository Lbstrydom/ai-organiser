import { describe, it, expect } from 'vitest';
import { toExportTheme, getSafeArea } from '../src/services/export/brand/brandExportTheme';
import type { BrandTheme } from '../src/services/chat/brandThemeService';

function makeBrand(over: Partial<BrandTheme> = {}): BrandTheme {
    return {
        css: '',
        promptRules: '',
        auditChecklist: [],
        colors: {
            primary: '#112233',
            secondary: '#445566',
            accent: '#AABBCC',
            background: '#FFFFFF',
            text: '#222222',
            link: '#0000EE',
        },
        font: "'Noto Sans', system-ui, sans-serif",
        fontFallback: 'Inter',
        bodyFontPt: 16,
        minFont: { body: 13, caption: 10, table: 12, footer: 9 },
        layout: { headerBandIn: 1.0, contentTopIn: 1.95, footerBandIn: 7.23, logoReserveIn: 2.25, sideMarginIn: 0.25 },
        warnings: [],
        ...over,
    };
}

describe('toExportTheme', () => {
    it('maps colours stripping the leading #', () => {
        const t = toExportTheme(makeBrand());
        expect(t.primaryColor).toBe('112233');
        expect(t.accentColor).toBe('AABBCC');
        expect(t.sectionBg).toBe('445566'); // secondary
        expect(t.bodyColor).toBe('222222');  // text
    });

    it('carries font + uses the NOMINAL body size (not the floor) (audit M19)', () => {
        const t = toExportTheme(makeBrand());
        expect(t.fontFace).toContain('Noto Sans');
        // bodyFontPt=16, minFont.body=13 → nominal 16 wins, distinct from the floor.
        expect(t.fontSize).toBe(16);
        expect(t.fontSize).not.toBe(t.minFont?.body);
    });

    it('clamps the nominal body size UP to the min-body floor when smaller (audit M19)', () => {
        const t = toExportTheme(makeBrand({ bodyFontPt: 10, minFont: { body: 13, caption: 10, table: 12, footer: 9 } }));
        // Nominal 10 < floor 13 → clamped up to the floor.
        expect(t.fontSize).toBe(13);
        expect(t.minFont?.body).toBe(13);
    });

    it('populates minFont from the brand floor', () => {
        const t = toExportTheme(makeBrand());
        expect(t.minFont).toEqual({ body: 13, caption: 10, table: 12, footer: 9 });
    });

    it('populates safeArea from the brand layout', () => {
        const t = toExportTheme(makeBrand());
        expect(t.safeArea).toEqual({ headerBandIn: 1.0, contentTopIn: 1.95, footerBandIn: 7.23, logoReserveIn: 2.25, sideMarginIn: 0.25 });
    });

    it('tolerates colours already without #', () => {
        const t = toExportTheme(makeBrand({ colors: { primary: 'ABCDEF', secondary: '123456', accent: '654321', background: 'FFFFFF', text: '000000', link: '0000EE' } }));
        expect(t.primaryColor).toBe('ABCDEF');
    });

    it('takes the FIRST family of a CSS-list font (audit M15)', () => {
        const t = toExportTheme(makeBrand({ font: 'Noto Sans, Inter, sans-serif' }));
        expect(t.fontFace).toBe('Noto Sans');
        expect(t.fontFace).not.toContain(',');
    });

    it('strips CSS quotes from the first family (audit M18)', () => {
        const t = toExportTheme(makeBrand({ font: "'Inter', sans-serif" }));
        expect(t.fontFace).toBe('Inter');
        expect(t.fontFace).not.toContain("'");
        // Double-quoted variant too.
        expect(toExportTheme(makeBrand({ font: '"Noto Sans", system-ui' })).fontFace).toBe('Noto Sans');
    });

    it('degrades a malformed brand hex to the EXAMPLE-brand colour — never NaN (audit M8/H3/M6)', () => {
        const t = toExportTheme(makeBrand({
            colors: { primary: 'not-a-hex', secondary: '#zzzzzz', accent: '#AABBCC', background: '#FFFFFF', text: '12', link: '#0000EE' },
        }));
        // Bad primary/secondary/text → the SHIPPED example-brand role colours
        // (EXAMPLE_EXPORT_FALLBACK), uppercased — consistent with the example brand
        // rather than an unrelated navy-gold.
        expect(t.primaryColor).toBe('1F2A44'); // example primary
        expect(t.sectionBg).toBe('2C3E50');    // example secondary
        expect(t.bodyColor).toBe('333333');    // example text
        // Valid accent survives, uppercased.
        expect(t.accentColor).toBe('AABBCC');
        // No NaN anywhere.
        for (const c of [t.primaryColor, t.accentColor, t.sectionBg, t.bodyColor]) {
            expect(c).not.toMatch(/NaN/i);
        }
    });
});

describe('getSafeArea', () => {
    it('returns the layout zones verbatim', () => {
        expect(getSafeArea(makeBrand())).toEqual({
            headerBandIn: 1.0, contentTopIn: 1.95, footerBandIn: 7.23, logoReserveIn: 2.25, sideMarginIn: 0.25,
        });
    });
});

describe('composeFontStack (M1 — fontStack leads with the embedded primary)', () => {
    it('leads fontStack with the brand primary, then fallbacks, ending in a generic', () => {
        const t = toExportTheme(makeBrand({ font: 'Noto Sans', fontFallback: 'Inter' }));
        expect(t.fontStack).toBe("'Noto Sans', 'Inter', sans-serif");
        expect(t.fontStack!.startsWith("'Noto Sans'")).toBe(true); // NOT the fallback first
        expect(t.fontFace).toBe('Noto Sans'); // bare first family for PPTX
    });
    it('does not drop the primary when fontFallback is a generic-only string', () => {
        const t = toExportTheme(makeBrand({ font: 'Noto Sans', fontFallback: 'system-ui, sans-serif' }));
        expect(t.fontStack).toBe("'Noto Sans', system-ui, sans-serif");
    });
    it('quotes the embedded family exactly once (no double-quote, R3-H1)', () => {
        const t = toExportTheme(makeBrand({ font: "'Noto Sans'", fontFallback: 'sans-serif' }));
        expect(t.fontStack).not.toContain("''");
        expect(t.fontStack).toContain("'Noto Sans'");
    });
});
