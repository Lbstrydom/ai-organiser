// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { App } from 'obsidian';
import type { AIOrganiserSettings } from '../src/core/settings';
import type { ExportTheme } from '../src/services/export/exportTheme';

// Mock the brand-theme loader + the font/icon asset resolvers so the context
// resolver can be exercised without a real vault.
vi.mock('../src/services/chat/brandThemeService', async () => {
    const actual = await vi.importActual<typeof import('../src/services/chat/brandThemeService')>(
        '../src/services/chat/brandThemeService',
    );
    return { ...actual, loadBrandTheme: vi.fn() };
});
vi.mock('../src/services/export/brand/brandAssets', async () => {
    const actual = await vi.importActual<typeof import('../src/services/export/brand/brandAssets')>(
        '../src/services/export/brand/brandAssets',
    );
    return {
        ...actual,
        getBrandFonts: vi.fn(),
        getBrandIcon: vi.fn(async () => null),
    };
});

import { resolveBrandRenderContext } from '../src/services/export/brand/brandRenderContext';
import { loadBrandTheme } from '../src/services/chat/brandThemeService';
import { getBrandFonts } from '../src/services/export/brand/brandAssets';
import type { BrandTheme } from '../src/services/chat/brandThemeService';

const APP = {} as App;
const SETTINGS = { brandFolderPath: '999_Brand' } as unknown as AIOrganiserSettings;
const FALLBACK: ExportTheme = {
    primaryColor: '1A3A5C', accentColor: 'F5C842', sectionBg: '1D6B4A',
    bodyColor: '2D4A5A', fontFace: 'Inter', fontSize: 14,
};

function brand(over: Partial<BrandTheme> = {}): BrandTheme {
    return {
        css: '', promptRules: '', auditChecklist: [],
        colors: { primary: '#112233', secondary: '#445566', accent: '#AABBCC', background: '#FFFFFF', text: '#222222', link: '#0000EE' },
        font: 'Noto Sans', fontFallback: 'system-ui, sans-serif', bodyFontPt: 16,
        minFont: { body: 13, caption: 10, table: 12, footer: 9 },
        layout: { headerBandIn: 1, contentTopIn: 1.95, footerBandIn: 7.23, logoReserveIn: 2.25, sideMarginIn: 0.25 },
        warnings: [], ...over,
    };
}

beforeEach(() => vi.clearAllMocks());

describe('resolveBrandRenderContext — font embedding', () => {
    it('off-brand → no font CSS, export-settings theme', async () => {
        const r = await resolveBrandRenderContext(APP, SETTINGS, false, [], FALLBACK);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.value.source).toBe('export-settings');
        expect(r.value.theme.fontFaceCss).toBeUndefined();
        expect(getBrandFonts).not.toHaveBeenCalled();
    });

    it('on-brand + fonts present → fontFaceCss populated', async () => {
        (loadBrandTheme as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, value: brand() });
        (getBrandFonts as ReturnType<typeof vi.fn>).mockResolvedValue({
            faceCss: "@font-face{font-family:'Noto Sans';}", count: 1, skipped: [],
        });
        const r = await resolveBrandRenderContext(APP, SETTINGS, true, [], FALLBACK);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.value.source).toBe('brand');
        expect(r.value.theme.fontFaceCss).toContain("@font-face");
        // Bound to the bare primary family.
        expect((getBrandFonts as ReturnType<typeof vi.fn>).mock.calls[0][2]).toBe('Noto Sans');
    });

    it('on-brand + fonts present-but-all-skipped → warning, no fontFaceCss', async () => {
        (loadBrandTheme as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, value: brand() });
        (getBrandFonts as ReturnType<typeof vi.fn>).mockResolvedValue({ faceCss: '', count: 0, skipped: ['huge.woff2'] });
        const r = await resolveBrandRenderContext(APP, SETTINGS, true, [], FALLBACK);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.value.theme.fontFaceCss).toBeUndefined();
        expect(r.value.warnings.some(w => /none embedded/i.test(w))).toBe(true);
    });

    it('on-brand + no brand file → example theme, no font CSS', async () => {
        (loadBrandTheme as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, error: 'not found' });
        const r = await resolveBrandRenderContext(APP, SETTINGS, true, [], FALLBACK);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.value.source).toBe('example');
        expect(r.value.theme.fontFaceCss).toBeUndefined();
        expect(getBrandFonts).not.toHaveBeenCalled();
    });
});
